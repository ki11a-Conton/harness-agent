/** Portable raw evidence: bounded streaming gzip, explicit namespaces and hashes.
 * Never consult a provider, accept a symlink, overwrite a file or restore a path
 * outside a fresh extraction root. The old manifest-only format stays readable. */
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream, existsSync } from "node:fs";
import { mkdir, open, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGzip, createGunzip } from "node:zlib";
import { StringDecoder } from "node:string_decoder";
import { pathToFileURL } from "node:url";
import { assert, filesIn, freshDirectory, readJson, REPO, stable, verifyIndex, writeJson } from "./execution-common.mjs";

const FORMAT = "n7-portable-raw-v1";
const MAX_RAW_BYTES = 2 * 1024 ** 3, MAX_FILES = 100000, MAX_LINE = 128 * 1024;
const safePath = path => typeof path === "string" && /^(campaign|judge)\//.test(path)
  && !/[\\:\0]/.test(path) && path.split("/").every(p => p !== "" && p !== "." && p !== "..");
function validateManifest(files) {
  assert(Array.isArray(files) && files.length > 0 && files.length <= MAX_FILES, "RAW_BUNDLE_MANIFEST_INVALID");
  const seen = new Set(); let total = 0;
  for (const f of files) {
    assert(safePath(f.path) && !seen.has(f.path) && Number.isSafeInteger(f.bytes) && f.bytes >= 0 && /^[0-9a-f]{64}$/.test(f.sha256), "RAW_BUNDLE_MANIFEST_INVALID");
    seen.add(f.path); total += f.bytes;
    assert(total <= MAX_RAW_BYTES, "RAW_BUNDLE_TOO_LARGE");
  }
  return total;
}

export async function packRawBundle(archive, campaign, judge) {
  const manifest = readJson(join(archive, "RAW-MANIFEST.json"));
  const totalRawBytes = validateManifest(manifest.files);
  const { detectSecrets } = await import(pathToFileURL(join(REPO, "packages/security/dist/index.js")).href);
  const file = "raw-evidence.ndjson.gz";
  async function* records() {
    yield `${JSON.stringify({ format: FORMAT })}\n`;
    for (const entry of manifest.files) {
      yield `${JSON.stringify({ type: "file", ...entry })}\n`;
      const root = entry.path.startsWith("campaign/") ? campaign : judge;
      const path = join(root, ...entry.path.split("/").slice(1));
      const hash = createHash("sha256"); let bytes = 0;
      let tail = "";
      for await (const chunk of createReadStream(path, { highWaterMark: 48 * 1024 })) {
        const content = tail + chunk.toString("utf8");
        // Preserve original hashes. Refuse publication rather than silently
        // redact immutable bytes and then pretend the old digest still holds.
        assert(!detectSecrets(content).hasSecret, "SECRET_RAW_EVIDENCE_REFUSED");
        tail = content.slice(-4096);
        hash.update(chunk); bytes += chunk.length;
        yield `${JSON.stringify({ type: "chunk", data: chunk.toString("base64") })}\n`;
      }
      assert(bytes === entry.bytes && hash.digest("hex") === entry.sha256, "RAW_BUNDLE_SOURCE_DRIFT");
      yield '{"type":"end"}\n';
    }
  }
  try { await pipeline(Readable.from(records()), createGzip(), createWriteStream(join(archive, file), { flags: "wx" })); }
  catch (error) { await rm(join(archive, file), { force: true }); throw error; }
  const packed = filesIn(archive).find(f => f.path === file);
  const descriptor = { schemaVersion: FORMAT, ...packed, totalRawBytes, files: manifest.files.length };
  writeJson(join(archive, "RAW-BUNDLE.json"), descriptor);
  return descriptor;
}

async function* boundedLines(stream) {
  let pending = "", inflated = 0;
  const decoder = new StringDecoder("utf8");
  for await (const chunk of stream) {
    inflated += chunk.length;
    assert(inflated <= MAX_RAW_BYTES * 2 + MAX_FILES * 1024, "RAW_BUNDLE_TOO_LARGE");
    pending += decoder.write(chunk);
    let newline;
    while ((newline = pending.indexOf("\n")) !== -1) {
      assert(newline <= MAX_LINE, "RAW_BUNDLE_LINE_TOO_LARGE");
      yield pending.slice(0, newline); pending = pending.slice(newline + 1);
    }
    assert(pending.length <= MAX_LINE, "RAW_BUNDLE_LINE_TOO_LARGE");
  }
  pending += decoder.end();
  assert(pending.length === 0, "RAW_BUNDLE_TRUNCATED");
}

export async function unpackRawBundle(archive, destination) {
  verifyIndex(archive);
  assert(existsSync(join(archive, "RAW-BUNDLE.json")), "RAW_BUNDLE_MISSING: this legacy archive only indexes private raw roots; supply both --campaign and --judge");
  const manifest = readJson(join(archive, "RAW-MANIFEST.json"));
  const totalRawBytes = validateManifest(manifest.files);
  const descriptor = readJson(join(archive, "RAW-BUNDLE.json"));
  assert(descriptor.schemaVersion === FORMAT && descriptor.path === "raw-evidence.ndjson.gz"
    && descriptor.files === manifest.files.length && descriptor.totalRawBytes === totalRawBytes, "RAW_BUNDLE_DESCRIPTOR_INVALID");
  const compressed = createReadStream(join(archive, descriptor.path));
  const hash = createHash("sha256"); let compressedBytes = 0;
  for await (const chunk of compressed) { hash.update(chunk); compressedBytes += chunk.length; }
  assert(compressedBytes === descriptor.bytes && hash.digest("hex") === descriptor.sha256, "RAW_BUNDLE_DRIFT");
  freshDirectory(destination);
  const input = createReadStream(join(archive, descriptor.path)); const gunzip = createGunzip();
  const decompress = pipeline(input, gunzip);
  // Attach immediately: corrupt compression must not become an unhandled rejection.
  void decompress.catch(() => {});
  let handle, active, fileHash, fileBytes = 0, index = 0, first = true;
  try {
    for await (const line of boundedLines(gunzip)) {
      const record = JSON.parse(line);
      if (first) { first = false; assert(record.format === FORMAT, "RAW_BUNDLE_FORMAT_INVALID"); continue; }
      if (record.type === "file") {
        assert(!handle && index < manifest.files.length, "RAW_BUNDLE_ORDER_INVALID");
        const { type, ...entry } = record;
        assert(stable(entry) === stable(manifest.files[index]), "RAW_BUNDLE_MANIFEST_DRIFT");
        active = entry; fileBytes = 0; fileHash = createHash("sha256");
        const path = join(destination, ...entry.path.split("/"));
        await mkdir(dirname(path), { recursive: true }); handle = await open(path, "wx");
      } else if (record.type === "chunk") {
        assert(handle && typeof record.data === "string" && /^[A-Za-z0-9+/]*={0,2}$/.test(record.data), "RAW_BUNDLE_CHUNK_INVALID");
        const bytes = Buffer.from(record.data, "base64");
        assert(bytes.toString("base64") === record.data, "RAW_BUNDLE_CHUNK_INVALID");
        fileBytes += bytes.length; assert(fileBytes <= active.bytes, "RAW_BUNDLE_SIZE_DRIFT");
        fileHash.update(bytes); await handle.writeFile(bytes);
      } else if (record.type === "end") {
        assert(handle && fileBytes === active.bytes && fileHash.digest("hex") === active.sha256, "RAW_BUNDLE_CONTENT_DRIFT");
        await handle.close(); handle = undefined; index++;
      } else assert(false, "RAW_BUNDLE_RECORD_INVALID");
    }
    await decompress;
    assert(!first && !handle && index === manifest.files.length, "RAW_BUNDLE_TRUNCATED");
    const actual = ["campaign", "judge"].flatMap(namespace => filesIn(join(destination, namespace)).map(f => ({ ...f, path: `${namespace}/${f.path}` })));
    assert(stable(actual) === stable(manifest.files), "RAW_BUNDLE_CONTENT_DRIFT");
    return { campaign: join(destination, "campaign"), judge: join(destination, "judge"), descriptor };
  } catch (error) {
    input.destroy(); gunzip.destroy(); await decompress.catch(() => {});
    await handle?.close(); await rm(destination, { recursive: true, force: true }); throw error;
  }
}
