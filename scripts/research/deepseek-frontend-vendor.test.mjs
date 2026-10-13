/** Offline reconstruction and tamper rejection for the pinned published UI. */
import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { cp, mkdtemp, mkdir, readFile, writeFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const execute = promisify(execFile);
const repository = fileURLToPath(new URL("../../", import.meta.url));
const script = path.join(repository, "scripts/research/deepseek-frontend-vendor.mjs");
const originalPublic = path.join(repository, "apps/web/public");
let temporary;
let fixturePublic;
const run = (args = []) => execute(process.execPath, [script, "--public", fixturePublic, ...args], { maxBuffer: 1024 * 1024 });
const hash = bytes => createHash("sha256").update(bytes).digest("hex");

before(async () => {
  temporary = await mkdtemp(path.join(tmpdir(), "harness-deepseek-vendor-test-"));
  fixturePublic = path.join(temporary, "public");
  await mkdir(fixturePublic);
  await cp(path.join(originalPublic, "deepseek"), path.join(fixturePublic, "deepseek"), { recursive: true });
  await cp(path.join(originalPublic, "index.html"), path.join(fixturePublic, "index.html"));
});
after(async () => { if (temporary !== undefined) await rm(temporary, { recursive: true, force: true }); });

async function change(relative, bytes, exercise) {
  const target = path.join(fixturePublic, relative);
  const previous = await readFile(target);
  try { await writeFile(target, bytes); await exercise(); }
  finally { await writeFile(target, previous); }
}

test("verifies the full original npm closure and independently reconstructs it offline", async () => {
  const { stdout } = await run(["--verify"]);
  const verification = JSON.parse(stdout);
  assert.equal(verification.status, "PASS"); assert.equal(verification.defaultClientCount, 66);
  assert.equal(verification.npmTarballs, 67); assert.equal(verification.sourceReferenceFiles, 3181);
  const restoredPublic = path.join(temporary, "restored-public"); await mkdir(restoredPublic);
  await run(["--extract", "--output", path.join(restoredPublic, "deepseek")]);
  await cp(path.join(originalPublic, "index.html"), path.join(restoredPublic, "index.html"));
  const restored = await execute(process.execPath, [script, "--verify", "--public", restoredPublic]);
  assert.equal(JSON.parse(restored.stdout).publishedFiles, verification.publishedFiles);
});

test("rejects an altered official plugin during verification and sealing", async () => {
  const manifestPath = path.join(fixturePublic, "deepseek/provenance.json");
  const beforeHash = hash(await readFile(manifestPath));
  await change("deepseek/plugins/dsh-client-ui-chat/client.js", "malicious modified upstream bundle", async () => {
    await assert.rejects(run(["--verify"]), error => /published asset was modified/.test(error.stderr));
    await assert.rejects(run(["--seal"]), error => /original published asset was modified or omitted/.test(error.stderr));
    assert.equal(hash(await readFile(manifestPath)), beforeHash, "failed seal did not replace the frozen inventory");
  });
});

test("rejects altered original npm tar bytes", async () => {
  await change("deepseek/tarballs/dsh-client-ui-chat.tgz", "not the pinned npm tar", async () => {
    await assert.rejects(run(["--verify"]), error => /tar SHA256 mismatch/.test(error.stderr));
  });
});

test("rejects altered source reference archive bytes", async () => {
  await change("deepseek/sources/upstream-client-reference.tar.gz", "not the reviewed Git source archive", async () => {
    await assert.rejects(run(["--verify"]), error => /Source reference archive mismatch/.test(error.stderr));
  });
});

test("rejects unregistered vendor files", async () => {
  const target = path.join(fixturePublic, "deepseek/unreviewed.js");
  try {
    await writeFile(target, "unreviewed extra code");
    await assert.rejects(run(["--verify"]), error => /Vendor file inventory differs/.test(error.stderr));
  } finally { await rm(target); }
});

test("rejects a symlink in the vendor inventory", async () => {
  const target = path.join(fixturePublic, "deepseek/unreviewed-link.js");
  try {
    await symlink(path.join(fixturePublic, "index.html"), target);
    await assert.rejects(run(["--verify"]), error => /Nonregular vendor entry/.test(error.stderr));
  } finally { await rm(target, { force: true }); }
});

test("rejects modified local root HTML until explicitly reviewed and sealed", async () => {
  await change("index.html", "<html>unreviewed adaptation</html>", async () => {
    await assert.rejects(run(["--verify"]), error => /Root frontend entry mismatch/.test(error.stderr));
  });
});

test("refuses to seal plain-file boot URLs that break upstream lazy client chunks", async () => {
  const graph = JSON.parse(await readFile(path.join(fixturePublic, "deepseek/boot-manifest.json"), "utf8"));
  const row = graph.entries.find(item => item.id === "@deepseek-ai/dsh-client-ui-sidebar-terminal");
  for (const url of ["/deepseek/plugins/dsh-client-ui-sidebar-terminal/client.js",
    `/deepseek/plugins/dsh-client-ui-sidebar-terminal/client.js?rev=${row.rev}`]) {
    const altered = structuredClone(graph);
    altered.entries.find(item => item.id === row.id).url = url;
    await change("deepseek/boot-manifest.json", JSON.stringify(altered), async () => {
      await assert.rejects(run(["--seal"]), error => /does not support upstream lazy chunks/.test(error.stderr));
    });
  }
});

test("refuses to seal a mismatched combo batch or browser boot graph", async () => {
  const graph = JSON.parse(await readFile(path.join(fixturePublic, "deepseek/boot-manifest.json"), "utf8"));
  graph.batches[0].rev = "000000000000";
  await change("deepseek/boot-manifest.json", JSON.stringify(graph), async () => {
    await assert.rejects(run(["--seal"]), error => /batch resource or revision differs/.test(error.stderr));
  });
  await change("deepseek/boot-manifest.js", "window.__DSH_BOOT__={};\n", async () => {
    await assert.rejects(run(["--seal"]), error => /browser graph differs/.test(error.stderr));
  });
});

test("graph regeneration still cannot bless a modified original frontend", async () => {
  const graphPath = path.join(fixturePublic, "deepseek/boot-manifest.json");
  const beforeHash = hash(await readFile(graphPath));
  await change("deepseek/plugins/dsh-client-ui-sidebar-terminal/client.js", "altered original frontend", async () => {
    await assert.rejects(run(["--seal", "--regenerate-boot"]), error => /original published asset was modified or omitted/.test(error.stderr));
    assert.equal(hash(await readFile(graphPath)), beforeHash, "original-asset refusal precedes graph writes");
  });
});
