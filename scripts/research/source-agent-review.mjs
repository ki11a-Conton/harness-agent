#!/usr/bin/env node
// Baseline research probes, not a production test suite or a model-quality eval.
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const root = fileURLToPath(new URL("../../", import.meta.url));
const args = process.argv.slice(2);
if (args.length > 0 && (args.length !== 2 || args[0] !== "--out")) {
  throw new Error("Usage: node scripts/research/source-agent-review.mjs [--out <json-path>]");
}
const manifest = JSON.parse(await readFile(resolve(root, "docs/evidence/source-agent-review-20261002.json"), "utf8"));
for (const entry of manifest.sourceFingerprints.filter((item) => item.repository === "harness-agent")) {
  const digest = createHash("sha256").update(await readFile(resolve(root, entry.path))).digest("hex");
  if (digest !== entry.sha256) {
    throw new Error(`Baseline source changed: ${entry.path}. Use regression tests to accept a fix; do not label this run baseline.`);
  }
}

const probes = [
  ["output-boundary", "source-review-codex.mjs"],
  ["provider-and-eol", "source-review-pi.mjs"],
  ["steering-and-prefetch", "source-review-hermes.mjs"],
  ["skill-refresh", "source-review-claude.mjs"],
  ["edit-concurrency", "source-review-edit.mjs"],
  ["verification-feedback", "source-review-verification.mjs"],
];
const results = [];
for (const [id, filename] of probes) {
  const child = spawnSync(process.execPath, [resolve(root, "scripts/research", filename)], {
    cwd: root,
    encoding: "utf8",
    timeout: 30_000,
    maxBuffer: 4 * 1024 * 1024,
  });
  if (child.error || child.status !== 0) {
    throw new Error(`Research probe ${id} did not complete: ${child.error?.message ?? child.stderr}`);
  }
  results.push({ id, script: `scripts/research/${filename}`, observation: JSON.parse(child.stdout) });
}
const output = {
  schemaVersion: 1,
  purpose: "Baseline defect observations. Exit 0 means reproduction completed, not that defects were fixed or quality improved.",
  harnessSourceCommit: manifest.harness_commit,
  collectionCommit: manifest.collection_commit,
  reproducedAt: new Date().toISOString(),
  environment: { node: process.version, platform: process.platform, arch: process.arch },
  baselineSourceFingerprintsVerified: true,
  results,
};
if (args.length === 2) {
  const out = resolve(root, args[1]);
  await mkdir(dirname(out), { recursive: true });
  await writeFile(out, `${JSON.stringify(output, null, 2)}\n`);
}
console.log(JSON.stringify(output, null, 2));
