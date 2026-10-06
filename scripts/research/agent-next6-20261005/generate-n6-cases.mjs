/**
 * N6 / N2 — case generator for the `context_safe_tool_call_efficiency_v1` main
 * experiment.
 *
 * The cases are AUTHORED in `n6-evidence-cases.mjs` and EMITTED here, so the
 * frozen bytes on disk can always be re-derived (and `--check` refuses any
 * silent drift after the pre-registration has been frozen).
 *
 * Usage:
 *   node scripts/research/agent-next6-20261005/generate-n6-cases.mjs            # write
 *   node scripts/research/agent-next6-20261005/generate-n6-cases.mjs --check    # verify only
 *
 * Emits:
 *   benchmarks/n6-evidence/<caseId>/{case.json,request.md,expected.md,fixture/**}
 *   docs/evidence/agent-next6-20261005/case-manifest.json   (the frozen catalog)
 *
 * The manifest carries, per case, the condition class, the case-local context
 * budget, the content digest (sha256 over every emitted byte), the verifier
 * digest, the reference fix used to PROVE the verifier discriminates, and the
 * eligibility statement. It is the input the pre-registration builder consumes;
 * a case whose bytes change changes both digests and therefore the whole plan
 * identity.
 *
 * Zero provider calls, zero network. Pure filesystem work.
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { CASES, EXPECTED_COMPOSITION } from "./n6-evidence-cases.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "..", "..", "..");
const CASE_ROOT = join(REPO, "benchmarks", "n6-evidence");
const MANIFEST_PATH = join(REPO, "docs", "evidence", "agent-next6-20261005", "case-manifest.json");

export const MANIFEST_SCHEMA = "n6-evidence-case-manifest-v1";
export const SUITE_DIR = "n6-evidence";

const sha256 = (input) => createHash("sha256").update(input, "utf8").digest("hex");

/** Canonical, platform-independent line endings for emitted text. */
const lf = (text) => text.replace(/\r\n/g, "\n");

function caseJsonOf(definition) {
  return {
    expected: { status: "completed" },
    suite: "regression",
    tags: definition.tags,
    ...(definition.contextBudgetTokens !== undefined
      ? { contextBudgetTokens: definition.contextBudgetTokens }
      : {}),
    verification: [
      { kind: "command", command: definition.verifier.command, args: definition.verifier.args },
    ],
  };
}

/** Every file an emitted case directory must contain: path -> bytes. */
function filesOf(definition) {
  const files = {
    "case.json": `${JSON.stringify(caseJsonOf(definition), null, 2)}\n`,
    "request.md": `${lf(definition.request).trim()}\n`,
    "expected.md": `${lf(definition.expected).trim()}\n`,
  };
  for (const [rel, content] of Object.entries(definition.fixture)) {
    files[`fixture/${rel}`] = `${lf(content)}`;
  }
  return files;
}

/** sha256 over every emitted byte, in sorted path order (order-independent). */
function contentDigestOf(files) {
  const parts = Object.keys(files)
    .sort()
    .map((rel) => `${rel}\u0000${sha256(files[rel])}`);
  return sha256(parts.join("\n"));
}

function verifierDigestOf(definition) {
  return sha256(
    JSON.stringify({ command: definition.verifier.command, args: definition.verifier.args }),
  );
}

function writeCase(definition, files) {
  const dir = join(CASE_ROOT, definition.id);
  rmSync(dir, { recursive: true, force: true });
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(dir, ...rel.split("/"));
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content, "utf8");
  }
  return dir;
}

/** Walk an emitted case directory into the same path -> bytes shape. */
function readCaseDir(dir) {
  const out = {};
  const walk = (current) => {
    for (const entry of readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const abs = join(current, entry.name);
      if (entry.isDirectory()) walk(abs);
      else out[relative(dir, abs).split("\\").join("/")] = readFileSync(abs, "utf8");
    }
  };
  walk(dir);
  return out;
}

function buildManifest() {
  const counts = {};
  for (const c of CASES) counts[c.condition] = (counts[c.condition] ?? 0) + 1;
  for (const [condition, expected] of Object.entries(EXPECTED_COMPOSITION)) {
    if (condition === "total") continue;
    if ((counts[condition] ?? 0) !== expected) {
      throw new Error(`composition drift: ${condition} has ${counts[condition] ?? 0} case(s), expected ${expected}`);
    }
  }
  if (CASES.length !== EXPECTED_COMPOSITION.total) {
    throw new Error(`composition drift: ${CASES.length} case(s), expected ${EXPECTED_COMPOSITION.total}`);
  }

  // The anti-rename rule: no two cases may share fixture bytes or task text.
  const byDigest = new Map();
  const byRequest = new Map();
  for (const c of CASES) {
    const files = filesOf(c);
    const digest = contentDigestOf(files);
    if (byDigest.has(digest)) throw new Error(`${c.id} duplicates the fixture content of ${byDigest.get(digest)}`);
    byDigest.set(digest, c.id);
    const request = lf(c.request).trim();
    if (byRequest.has(request)) throw new Error(`${c.id} duplicates the task text of ${byRequest.get(request)}`);
    byRequest.set(request, c.id);
  }

  const cases = CASES.map((c) => {
    const files = filesOf(c);
    return {
      caseId: c.id,
      suite: SUITE_DIR,
      condition: c.condition,
      tags: c.tags,
      ...(c.contextBudgetTokens !== undefined ? { contextBudgetTokens: c.contextBudgetTokens } : {}),
      contentDigest: contentDigestOf(files),
      verifierDigest: verifierDigestOf(c),
      eligibility:
        c.condition === "compact-drop" || c.condition === "rehydrate" || c.condition === "partial"
          ? "case-local context budget makes the context compact after the authoritative spec was read; the required text is then absent while the original command verifier still applies"
          : c.condition === "preview"
            ? "the authoritative value sits in the middle of a file larger than the 16 KiB inline budget, so it is absent from the model-visible head/tail preview while the original command verifier still applies"
            : c.condition === "changed"
              ? "a setup command rewrites the target file before the fix, so the original command verifier judges the post-change state"
              : c.condition === "diagnostic"
                ? "the workspace ships a failing check that can be rerun for diagnostics and is also the command verifier"
                : "everything the fix needs stays visible; the original command verifier applies unchanged",
      referenceFix: c.referenceFix,
      referenceRun: c.referenceRun ?? [],
      request: c.request,
      expected: c.expected,
    };
  });

  return {
    schemaVersion: MANIFEST_SCHEMA,
    candidateId: "context_safe_tool_call_efficiency_v1",
    suite: { id: SUITE_DIR, version: "1.0.0", caseRoot: `benchmarks/${SUITE_DIR}` },
    composition: { ...EXPECTED_COMPOSITION, ...counts },
    cases,
    manifestDigest: sha256(
      JSON.stringify(
        cases.map((c) => ({ caseId: c.caseId, suite: c.suite, contentDigest: c.contentDigest, verifierDigest: c.verifierDigest })),
      ),
    ),
  };
}

function main() {
  const check = process.argv.includes("--check");
  const manifest = buildManifest();
  const problems = [];

  for (const c of CASES) {
    const expectedFiles = filesOf(c);
    const dir = join(CASE_ROOT, c.id);
    if (!existsSync(dir)) {
      problems.push(`${c.id}: case directory is missing`);
      continue;
    }
    const actual = readCaseDir(dir);
    for (const [rel, content] of Object.entries(expectedFiles)) {
      const got = actual[rel];
      if (got === undefined) problems.push(`${c.id}: ${rel} is missing`);
      else if (lf(got) !== lf(content)) problems.push(`${c.id}: ${rel} differs from the generated bytes`);
    }
    for (const rel of Object.keys(actual)) {
      if (expectedFiles[rel] === undefined) problems.push(`${c.id}: unexpected file ${rel}`);
    }
  }

  // Stale directories that are no longer authored cases must not linger.
  if (existsSync(CASE_ROOT)) {
    for (const entry of readdirSync(CASE_ROOT, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      if (!CASES.some((c) => c.id === entry.name)) problems.push(`${entry.name}: stale case directory`);
    }
  }

  const manifestText = `${JSON.stringify(manifest, null, 2)}\n`;
  if (existsSync(MANIFEST_PATH)) {
    const current = readFileSync(MANIFEST_PATH, "utf8");
    if (lf(current) !== lf(manifestText)) problems.push("case-manifest.json differs from the generated manifest");
  } else {
    problems.push("case-manifest.json is missing");
  }

  if (check) {
    if (problems.length > 0) {
      process.stderr.write(`n6 case check FAILED (${problems.length} problem(s)):\n`);
      for (const p of problems.slice(0, 40)) process.stderr.write(`  - ${p}\n`);
      process.exit(1);
    }
    process.stdout.write(`n6 case check PASS: ${CASES.length} case(s), manifest ${manifest.manifestDigest}\n`);
    return;
  }

  rmSync(CASE_ROOT, { recursive: true, force: true });
  for (const c of CASES) writeCase(c, filesOf(c));
  mkdirSync(dirname(MANIFEST_PATH), { recursive: true });
  writeFileSync(MANIFEST_PATH, manifestText, "utf8");
  const bytes = CASES.reduce(
    (acc, c) =>
      acc +
      Object.values(filesOf(c)).reduce((inner, text) => inner + Buffer.byteLength(text, "utf8"), 0),
    0,
  );
  process.stdout.write(
    `n6 cases written: ${CASES.length} case(s) into benchmarks/${SUITE_DIR}, ${bytes} bytes, manifest ${manifest.manifestDigest}\n`,
  );
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  main();
}
