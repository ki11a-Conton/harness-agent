#!/usr/bin/env node
/**
 * Offline frozen-artifact verifier/extractor for the complete DeepSeek client.
 * Run --verify for release validation, or --extract --output <new-directory>
 * to reconstruct every unmodified published asset from the committed npm tars.
 * Maintainers may run --seal after reviewing changes to the local carrier or
 * notices; --seal --regenerate-boot repairs only the Host-generated upstream
 * combo-resource graph. Sealing independently checks every published browser asset
 * against its pinned original tar; it cannot bless a modified upstream bundle.
 * No npm install, source checkout, CDN, or build-time network is required.
 */
import { createHash } from "node:crypto";
import { gunzipSync } from "node:zlib";
import { readFile, readdir, mkdir, writeFile, stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { expectedBrandFiles, applyBrandGraph, brandedModules, brandRoot } from "./web-branding-lib.mjs";

const repository = fileURLToPath(new URL("../../", import.meta.url));
const argv = process.argv.slice(2);
function option(name, fallback) {
  const i = argv.indexOf(name);
  if (i === -1) return fallback;
  if (!argv[i + 1] || argv[i + 1].startsWith("--")) throw new Error(`${name} requires a value`);
  return path.resolve(argv[i + 1]);
}
const publicRoot = option("--public", path.join(repository, "apps/web/public"));
const vendorRoot = path.join(publicRoot, "deepseek");
const output = option("--output");
const extract = argv.includes("--extract");
const sealing = argv.includes("--seal");
const regenerateBoot = argv.includes("--regenerate-boot");
if (regenerateBoot && !sealing) throw new Error("--regenerate-boot is a reviewed maintenance operation and requires --seal");
if ([extract, sealing, argv.includes("--verify")].filter(Boolean).length !== 1) throw new Error("Use one of --verify, --seal, or --extract --output <new-directory>");
if (extract && (!output || output === vendorRoot || output.startsWith(vendorRoot + path.sep))) {
  throw new Error("--extract requires a new output directory outside the frozen vendor directory");
}
const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");
const integrity = bytes => "sha512-" + createHash("sha512").update(bytes).digest("base64");
const sha1 = bytes => createHash("sha1").update(bytes).digest("hex");
const assert = (condition, message) => { if (!condition) throw new Error(message); };
const safePath = name => {
  assert(typeof name === "string" && !name.startsWith("/") && !name.includes("\\") &&
    !/[\x00-\x1f:]/.test(name) && name.split("/").every(part => part !== "" && part !== "." && part !== ".."), `Unsafe archive path: ${name}`);
  return name;
};
const field = bytes => bytes.toString("utf8").replace(/\0.*$/s, "");
function untar(compressed) {
  const tar = gunzipSync(compressed);
  const files = new Map();
  for (let offset = 0; offset + 512 <= tar.length;) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every(byte => byte === 0)) break;
    const expected = Number.parseInt(field(header.subarray(148, 156)).trim(), 8);
    let checksum = 0;
    for (let i = 0; i < 512; i++) checksum += i >= 148 && i < 156 ? 32 : header[i];
    assert(expected === checksum, "Archive header checksum mismatch");
    const prefix = field(header.subarray(345, 500));
    const type = String.fromCharCode(header[156]);
    const rawName = (prefix ? prefix + "/" : "") + field(header.subarray(0, 100));
    const name = safePath(type === "5" ? rawName.replace(/\/$/, "") : rawName);
    const size = Number.parseInt(field(header.subarray(124, 136)).trim() || "0", 8);
    assert(Number.isSafeInteger(size) && size >= 0 && offset + 512 + size <= tar.length, "Archive entry exceeds its archive");
    if (type === "0" || type === "\0") {
      assert(!files.has(name), `Duplicate archive member: ${name}`);
      files.set(name, tar.subarray(offset + 512, offset + 512 + size));
    } else {
      assert(type === "5" || type === "x" || type === "g", `Unsupported archive entry type ${type}: ${name}`);
    }
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  return files;
}
async function allFiles(root, prefix = "") {
  const results = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const name = prefix + entry.name;
    if (entry.isDirectory()) results.push(...await allFiles(path.join(root, entry.name), name + "/"));
    else { assert(entry.isFile(), `Nonregular vendor entry: ${name}`); results.push(name); }
  }
  return results.sort();
}
async function createReviewedManifest() {
  const releases = JSON.parse(await readFile(path.join(vendorRoot, "provenance/npm-releases.json"), "utf8"));
  const releaseArtifacts = [];
  const published = new Map();
  for (const release of releases) {
    assert(/^@deepseek-ai\/dsh-[a-z0-9-]+$/.test(release.name), "Unexpected published package name");
    const stem = release.name.slice("@deepseek-ai/".length);
    const artifactPath = `tarballs/${stem}.tgz`;
    const bytes = await readFile(path.join(vendorRoot, artifactPath));
    assert(bytes.length === release.bytes && sha256(bytes) === release.sha256 &&
      integrity(bytes) === release.integrity && sha1(bytes) === release.shasum, `${release.name}: pinned registry artifact mismatch`);
    const contents = untar(bytes);
    const mappings = [];
    for (const [member, data] of contents) {
      let destination;
      if (member === "package/package.json" || member === "package/LICENSE") destination = `licenses/${stem}/${member.slice("package/".length)}`;
      else if (stem === "dsh-web-frontend" && member.startsWith("package/dist/")) {
        destination = member === "package/dist/index.html" ? "provenance/published-frontend-index.html"
          : member === "package/dist/manifest.webmanifest" ? "provenance/published-manifest.webmanifest"
            : member.slice("package/dist/".length);
      } else if (/^package\/lib\/client(?:\.[a-z0-9-]+)?\.js$/.test(member)) {
        destination = `plugins/${stem}/${member.slice("package/lib/".length)}`;
      }
      if (destination === undefined) continue;
      const installed = await readFile(path.join(vendorRoot, safePath(destination)));
      assert(installed.equals(data), `${destination}: original published asset was modified or omitted`);
      published.set(destination, data);
      mappings.push({ member, path: destination, bytes: data.length, sha256: sha256(data) });
    }
    assert(mappings.some(item => item.member === "package/LICENSE") && mappings.some(item => item.member === "package/package.json"), `${release.name}: missing published identity/notices`);
    releaseArtifacts.push({ ...release, path: artifactPath, files: mappings });
  }
  if (regenerateBoot) {
    // ClientModuleSystem.chunkUrl requires the upstream combo-resource URL,
    // including the owner id and revision; a plain file URL cannot load chunks.
    // Only Host-generated graph bytes change. Every published asset was checked
    // against its original npm member above before this maintenance write.
    const graphPath = path.join(vendorRoot, "boot-manifest.json");
    const graph = JSON.parse(await readFile(graphPath, "utf8"));
    const packages = new Map(releaseArtifacts.map(item => [item.name, item]));
    for (const row of graph.entries) {
      const entry = packages.get(row.id)?.files.find(item => item.member === "package/lib/client.js");
      assert(entry !== undefined, `Missing pinned client entry: ${row.id}`);
      row.rev = entry.sha256.slice(0, 12);
      row.url = `/deepseek/plugins/??${row.id}/client.js&rev=${row.rev}`;
    }
    const rows = new Map(graph.entries.map(item => [item.id, item]));
    for (const batch of graph.batches) {
      assert(batch.entries.length === 1, "Reviewed offline graph batches each address one published entry");
      const row = rows.get(batch.entries[0]);
      assert(row !== undefined, "Boot batch references an undeclared entry");
      batch.url = row.url; batch.rev = row.rev;
    }
    applyBrandGraph(graph, published, expectedBrandFiles(published));
    await writeFile(graphPath, JSON.stringify(graph, null, 2) + "\n");
    await writeFile(path.join(vendorRoot, "boot-manifest.js"), "window.__DSH_BOOT__=" + JSON.stringify(graph) + ";\n");
  }
  const inventory = (await allFiles(vendorRoot)).filter(file => file !== "provenance.json");
  const files = [];
  for (const file of inventory) {
    const bytes = await readFile(path.join(vendorRoot, safePath(file)));
    files.push({ path: file, bytes: bytes.length, sha256: sha256(bytes) });
  }
  return { schemaVersion: 1, defaultClientCount: 66,
    publishedArtifactPolicy: "Original browser JS/CSS/fonts/images remain byte-identical to pinned npm artifacts. Six explicitly marked Harness Agent presentation derivatives and two independent SVG assets are deterministically verified separately under harness-brand/. HTML, PWA, boot, carrier and notices are reviewed adaptations; original HTML/PWA inputs and copyrights remain preserved.",
    sourceRelationship: "npm gitHead is absent; the separately frozen Git source reference does not establish release/source equivalence.",
    rootIndexSha256: sha256(await readFile(path.join(publicRoot, "index.html"))), releaseArtifacts, files };
}
const manifest = sealing ? await createReviewedManifest() : JSON.parse(await readFile(path.join(vendorRoot, "provenance.json"), "utf8"));
assert(manifest.schemaVersion === 1, "Unsupported frontend provenance version");
assert(manifest.defaultClientCount === 66 && manifest.releaseArtifacts.length === 67, "Default client closure changed without review");
const mapped = new Map();
let publishedBytes = 0;
for (const artifact of manifest.releaseArtifacts) {
  const bytes = await readFile(path.join(vendorRoot, safePath(artifact.path)));
  assert(bytes.length === artifact.bytes && sha256(bytes) === artifact.sha256, `${artifact.name}: tar SHA256 mismatch`);
  assert(integrity(bytes) === artifact.integrity && sha1(bytes) === artifact.shasum, `${artifact.name}: npm integrity mismatch`);
  const contents = untar(bytes);
  const pkg = JSON.parse(contents.get("package/package.json").toString("utf8"));
  assert(pkg.name === artifact.name && pkg.version === artifact.version && pkg.license === "MIT", `${artifact.name}: package identity/license mismatch`);
  assert(artifact.gitHead === null, `${artifact.name}: unreviewed release/source claim`);
  for (const mapping of artifact.files) {
    const data = contents.get(safePath(mapping.member));
    assert(data !== undefined, `${artifact.name}: missing ${mapping.member}`);
    assert(data.length === mapping.bytes && sha256(data) === mapping.sha256, `${artifact.name}: original member hash mismatch`);
    const installed = await readFile(path.join(vendorRoot, safePath(mapping.path)));
    assert(installed.equals(data), `${mapping.path}: published asset was modified`);
    assert(!mapped.has(mapping.path), `Duplicated published asset: ${mapping.path}`);
    mapped.set(mapping.path, data);
    publishedBytes += data.length;
  }
}
const source = JSON.parse(await readFile(path.join(vendorRoot, "provenance/source-reference.json"), "utf8"));
const sourceArchive = await readFile(path.join(vendorRoot, safePath(source.archive)));
assert(sha256(sourceArchive) === source.archiveSha256, "Source reference archive mismatch");
assert(source.gitRevision === "5badb15009ae1756c3afe0ae0cef1faafc290ccc", "Source reference revision changed without review");
const sourceFiles = untar(sourceArchive);
assert(sourceFiles.size === source.files.length, "Source reference file count mismatch");
for (const item of source.files) {
  const bytes = sourceFiles.get(item.path);
  assert(bytes !== undefined && bytes.length === item.bytes && sha256(bytes) === item.sha256, `Source reference mismatch: ${item.path}`);
}
const actual = await allFiles(vendorRoot);
const expected = manifest.files.map(item => item.path).sort();
assert(JSON.stringify(actual.filter(file => file !== "provenance.json")) === JSON.stringify(expected), "Vendor file inventory differs from frozen provenance");
for (const item of manifest.files) {
  const bytes = await readFile(path.join(vendorRoot, safePath(item.path)));
  assert(bytes.length === item.bytes && sha256(bytes) === item.sha256, `Frozen asset mismatch: ${item.path}`);
}
const boot = JSON.parse(await readFile(path.join(vendorRoot, "boot-manifest.json"), "utf8"));
const branded = expectedBrandFiles(mapped);
for (const [name, bytes] of branded) {
  assert((await readFile(path.join(vendorRoot, name))).equals(bytes), `Brand derivative differs from reviewed transformation: ${name}`);
}
assert(JSON.stringify(actual.filter(name => name.startsWith(brandRoot + "/")).sort()) === JSON.stringify([...branded.keys()].sort()),
  "Brand derivative inventory differs from reviewed transformations");
const roster = JSON.parse(await readFile(path.join(vendorRoot, "provenance/default-client-roster.json"), "utf8"));
const declared = roster.filter(item => item.client).map(item => item.name).sort();
assert(JSON.stringify(boot.entries.map(item => item.id).sort()) === JSON.stringify(declared), "Default plugin roster differs from upstream reference");
for (const item of boot.entries) {
  assert(/^@deepseek-ai\/dsh-[a-z0-9-]+$/.test(item.id) && /^[a-f0-9]{12}$/.test(item.rev), `Invalid boot entry identity: ${item.id}`);
  assert(item.url === `/deepseek/plugins/??${item.id}/client.js&rev=${item.rev}`,
    `Boot plugin URL does not support upstream lazy chunks: ${item.id}`);
  const stem = item.id.slice("@deepseek-ai/".length);
  const overridden = brandedModules.includes(stem);
  assert(overridden ? item.brandOverride === true : item.brandOverride === undefined, `Invalid brand override: ${item.id}`);
  const bytes = overridden ? branded.get(`${brandRoot}/plugins/${stem}/client.js`) : mapped.get(`plugins/${stem}/client.js`);
  assert(bytes !== undefined && sha256(bytes).startsWith(item.rev), `Boot plugin revision mismatch: ${item.id}`);
}
assert(new Set(boot.entries.map(item => item.id)).size === boot.entries.length, "Duplicate boot entry");
assert(boot.batches.length === boot.entries.length, "Boot batches omit default entries");
for (const batch of boot.batches) {
  assert(batch.entries.length === 1, "Offline boot batch must address one published entry");
  const row = boot.entries.find(item => item.id === batch.entries[0]);
  assert(row !== undefined && batch.url === row.url && batch.rev === row.rev, "Boot batch resource or revision differs from its entry");
}
assert(new Set(boot.batches.map(item => item.entries[0])).size === boot.entries.length, "Duplicate boot batch");
assert(boot.rev === sha256(Buffer.from(JSON.stringify({ entries: boot.entries, batches: boot.batches }))).slice(0, 12), "Boot graph revision mismatch");
assert(await readFile(path.join(vendorRoot, "boot-manifest.js"), "utf8") === "window.__DSH_BOOT__=" + JSON.stringify(boot) + ";\n", "Boot browser graph differs from Host JSON graph");
const index = await readFile(path.join(publicRoot, "index.html"));
assert(sha256(index) === manifest.rootIndexSha256, "Root frontend entry mismatch");
assert(!/https?:\/\//.test(index.toString("utf8")), "Frontend entry references an external URL");
assert(!(await readFile(path.join(vendorRoot, "transport.js"), "utf8")).includes("__DSH_MOCK_PROOF__"), "Mock carrier cannot be released");
if (sealing) await writeFile(path.join(vendorRoot, "provenance.json"), JSON.stringify(manifest, null, 2) + "\n");
if (extract) {
  try { await stat(output); throw new Error("Output directory already exists; choose a new directory"); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
  for (const file of actual) {
    const destination = path.join(output, safePath(file));
    await mkdir(path.dirname(destination), { recursive: true });
    await writeFile(destination, mapped.get(file) ?? await readFile(path.join(vendorRoot, file)));
  }
}
console.log(JSON.stringify({ status: "PASS", mode: extract ? "offline-extract" : sealing ? "reviewed-offline-seal" : "offline-verify",
  defaultClientCount: boot.entries.length, npmTarballs: manifest.releaseArtifacts.length,
  publishedFiles: mapped.size, publishedBytes, frozenFiles: manifest.files.length,
  sourceReferenceFiles: source.files.length, sourceRevision: source.gitRevision,
  npmGitHead: "absent; source equivalence not asserted", ...(extract ? { output } : {}) }, null, 2));
