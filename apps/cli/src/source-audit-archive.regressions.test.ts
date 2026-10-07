import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { gzipSync } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";
const scripts = join(process.cwd(), "scripts/research/agent-next7-20261006");
const common = await import(pathToFileURL(join(scripts, "execution-common.mjs")).href);
const bundle = await import(pathToFileURL(join(scripts, "raw-bundle.mjs")).href);
const historical = await import(pathToFileURL(join(scripts, "historical-archive.mjs")).href);
const roots: string[] = [];
const temp = () => { const root = mkdtempSync(join(tmpdir(), "audit-archive-")); roots.push(root); return root; };
const hash = (data: Buffer | string) => createHash("sha256").update(data).digest("hex");
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
async function fixture() {
  const root = temp(), archive = join(root, "archive"), campaign = join(root, "campaign"), judge = join(root, "judge");
  for (const dir of [archive, campaign, judge]) mkdirSync(dir);
  writeFileSync(join(campaign, "empty"), "");
  writeFileSync(join(campaign, "raw.bin"), Buffer.from([0, 1, 255, 128]));
  writeFileSync(join(judge, "judge-result.json"), '{"verdict":"NOT_PROVEN"}');
  const files = [common.filesIn(campaign).map((f: any) => ({ ...f, path: `campaign/${f.path}` })),
    common.filesIn(judge).map((f: any) => ({ ...f, path: `judge/${f.path}` }))].flat();
  common.writeJson(join(archive, "RAW-MANIFEST.json"), { schemaVersion: "n7-raw-manifest-v1", experiment: "main", files });
  await bundle.packRawBundle(archive, campaign, judge); common.writeIndex(archive);
  return { root, archive, campaign, judge };
}
function reindex(archive: string) { rmSync(join(archive, "artifact-index.json")); common.writeIndex(archive); }
describe("source audit: portable archive integrity", () => {
  it("refuses secret-bearing raw bytes without altering or republishing the original", async () => {
    const root = temp(), campaign = join(root, "campaign"), judge = join(root, "judge"), archive = join(root, "archive");
    for (const path of [campaign, judge, archive]) mkdirSync(path);
    const secret = "ghp_" + "X".repeat(36); writeFileSync(join(campaign, "unsafe"), secret); writeFileSync(join(judge, "safe"), "safe");
    common.writeJson(join(archive, "RAW-MANIFEST.json"), { files: [
      ...common.filesIn(campaign).map((f: any) => ({ ...f, path: `campaign/${f.path}` })),
      ...common.filesIn(judge).map((f: any) => ({ ...f, path: `judge/${f.path}` })),
    ] });
    await expect(bundle.packRawBundle(archive, campaign, judge)).rejects.toThrow("SECRET_RAW_EVIDENCE_REFUSED");
    expect(readFileSync(join(campaign, "unsafe"), "utf8")).toBe(secret);
    expect(() => readFileSync(join(archive, "raw-evidence.ndjson.gz"))).toThrow();
  });
  it("restores exact binary/empty bytes without the original private roots", async () => {
    const f = await fixture(); rmSync(f.campaign, { recursive: true }); rmSync(f.judge, { recursive: true });
    const out = await bundle.unpackRawBundle(f.archive, join(f.root, "restored"));
    expect(readFileSync(join(out.campaign, "raw.bin"))).toEqual(Buffer.from([0, 1, 255, 128]));
    expect(readFileSync(join(out.campaign, "empty")).length).toBe(0);
  });
  it.each(["campaign/../escape", "campaign/C:/escape", "campaign/a\\..\\escape"])("refuses traversal %s even after reindexing", async path => {
    const f = await fixture(); const manifest = common.readJson(join(f.archive, "RAW-MANIFEST.json")); manifest.files[0].path = path;
    writeFileSync(join(f.archive, "RAW-MANIFEST.json"), JSON.stringify(manifest)); reindex(f.archive);
    await expect(bundle.unpackRawBundle(f.archive, join(f.root, "out"))).rejects.toThrow("MANIFEST_INVALID");
  });
  it.each(["corrupt-gzip", "missing-end", "forged-byte"])("rejects %s with refreshed outer hashes, removing partial extraction", async mode => {
    const f = await fixture(); const manifest = common.readJson(join(f.archive, "RAW-MANIFEST.json"));
    const first = manifest.files[0];
    const data = mode === "corrupt-gzip" ? Buffer.from("not gzip") : gzipSync(Buffer.from(JSON.stringify({ format: "n7-portable-raw-v1" }) + "\n"
      + JSON.stringify({ type: "file", ...first }) + "\n"
      + (mode === "forged-byte" ? JSON.stringify({ type: "chunk", data: "eA==" }) + "\n" : "")));
    writeFileSync(join(f.archive, "raw-evidence.ndjson.gz"), data);
    const descriptor = common.readJson(join(f.archive, "RAW-BUNDLE.json")); descriptor.bytes = data.length; descriptor.sha256 = hash(data);
    writeFileSync(join(f.archive, "RAW-BUNDLE.json"), JSON.stringify(descriptor)); reindex(f.archive);
    await expect(bundle.unpackRawBundle(f.archive, join(f.root, "out"))).rejects.toThrow();
    expect(() => readFileSync(join(f.root, "out", "campaign", "empty"))).toThrow();
  });
  it("a manifest-only historical archive explicitly requires the absent raw roots", async () => {
    const f = await fixture(); rmSync(join(f.archive, "RAW-BUNDLE.json")); rmSync(join(f.archive, "raw-evidence.ndjson.gz")); reindex(f.archive);
    await expect(bundle.unpackRawBundle(f.archive, join(f.root, "out"))).rejects.toThrow("RAW_BUNDLE_MISSING");
  });
  it("uses a recorded commit's own rebuilt verifier and refuses altered build bytes (tiny synthetic repository)", async () => {
    const root = temp(), repo = join(root, "repo"), archive = join(root, "archive"); mkdirSync(repo); mkdirSync(archive);
    const git = (args: string[]) => execFileSync("git", args, { cwd: repo, encoding: "utf8", stdio: "pipe" }).trim();
    const relative = "scripts/research/agent-next7-20261006/campaign-evidence.mjs";
    mkdirSync(join(repo, "scripts/research/agent-next7-20261006"), { recursive: true });
    writeFileSync(join(repo, relative), 'export async function verifyArchive(){return {verdict:"SYNTHETIC_CHECK_ONLY",modelQuality:"NOT_RUN",promotion:"NOT_ELIGIBLE"}}\n');
    writeFileSync(join(repo, "package.json"), JSON.stringify({ name: "historical-synthetic", private: true, type: "module", packageManager: "pnpm@11.21.0",
      scripts: { build: "node build.mjs" } }));
    writeFileSync(join(repo, "build.mjs"), 'import {mkdirSync,writeFileSync} from "node:fs";mkdirSync("dist",{recursive:true});writeFileSync("dist/proof","own frozen build");\n');
    writeFileSync(join(repo, ".gitignore"), "node_modules/\ndist/\n.ci/\n");
    writeFileSync(join(repo, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n\nsettings:\n  autoInstallPeers: true\n  excludeLinksFromLockfile: false\n\nimporters:\n\n  .: {}\n");
    git(["init"]); git(["-c", "core.autocrlf=false", "add", "."]);
    git(["-c", "user.name=Audit Fixture", "-c", "user.email=audit@example.invalid", "commit", "-m", "synthetic source"]);
    const sha = git(["rev-parse", "HEAD"]), sourceFiles = common.filesIn(repo).filter((f: any) => !f.path.startsWith(".git/"));
    const binding = { source: { sourceSha: sha, sourceFiles, buildFiles: [{ path: "dist/proof", bytes: 16, sha256: hash("own frozen build") }] } };
    common.writeJson(join(archive, "execution-binding.json"), binding); common.writeIndex(archive);
    const result = await historical.verifyHistoricalArchive({ role: "main", archive, campaign: root, judge: root, sourceRepo: repo });
    expect(result).toMatchObject({ sourceSha: sha, paidCalls: 0, judgment: { verdict: "SYNTHETIC_CHECK_ONLY" } });
    binding.source.buildFiles[0]!.sha256 = "0".repeat(64); writeFileSync(join(archive, "execution-binding.json"), JSON.stringify(binding)); reindex(archive);
    await expect(historical.verifyHistoricalArchive({ role: "main", archive, campaign: root, judge: root, sourceRepo: repo })).rejects.toThrow("HISTORICAL_BUILD_BYTES_DRIFT");
    expect(git(["status", "--porcelain"])).toBe(""); expect(git(["rev-parse", "HEAD"])).toBe(sha);
  }, 30000);
});
