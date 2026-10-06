/**
 * N7 — case generator for both `context_safe_tool_call_efficiency_v2`
 * experiments (the 64-case main set and the 24-case independent holdout).
 *
 * The cases are AUTHORED in `n7-evidence-cases-a.mjs` (20 compact-drop + 12
 * preview), `n7-evidence-cases-b.mjs` (10 rehydrate + 6 partial + 16 control) and
 * `n7-holdout-cases.mjs` (24 independent cases) and EMITTED here, so the frozen
 * bytes on disk can always be re-derived and `--check` refuses any silent drift
 * after a pre-registration has been frozen.
 *
 * Usage:
 *   node scripts/research/agent-next7-20261006/generate-n7-cases.mjs [--set=main|holdout|all] [--check]
 *
 * Emits, per set:
 *   benchmarks/<suite>/<caseId>/{case.json,request.md,expected.md,fixture/**}
 *   docs/evidence/agent-next7-20261006/<manifest>.json   (the frozen catalog)
 *
 * The manifest carries, per case, the condition class, the case-local context
 * budget, the content digest (sha256 over every emitted byte), the verifier
 * digest, the reference fix used to PROVE the verifier discriminates, and the
 * eligibility statement. A case whose bytes change changes both digests and
 * therefore the whole pre-registration identity.
 *
 * Zero provider calls, zero network. Pure filesystem work.
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { CASES_A } from "./n7-evidence-cases-a.mjs";
import { CASES_B } from "./n7-evidence-cases-b.mjs";
import { HOLDOUT_CASES } from "./n7-holdout-cases.mjs";
import { N7_HOLDOUT_COMPOSITION, N7_MAIN_COMPOSITION } from "./n7-case-helpers.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "..", "..", "..");
const EVIDENCE_DIR = join(REPO, "docs", "evidence", "agent-next7-20261006");

/**
 * The two frozen sets. `caseJsonSuite` stays inside the loader's canonical
 * four-value union (`baseline.ts` validates it) while the DIRECTORY names the
 * real suite the selection resolver walks — the same convention
 * `benchmarks/r98-fixtures` and the N6 sets already use.
 */
export const SETS = {
  main: {
    key: "main",
    suiteId: "n7-evidence",
    manifestSchema: "n7-evidence-case-manifest-v1",
    manifestFile: "case-manifest.json",
    caseJsonSuite: "regression",
    cases: [...CASES_A, ...CASES_B],
    composition: N7_MAIN_COMPOSITION,
  },
  holdout: {
    key: "holdout",
    suiteId: "n7-holdout",
    manifestSchema: "n7-holdout-case-manifest-v1",
    manifestFile: "holdout-case-manifest.json",
    caseJsonSuite: "holdout",
    cases: HOLDOUT_CASES,
    composition: N7_HOLDOUT_COMPOSITION,
  },
};

const sha256 = (input) => createHash("sha256").update(input, "utf8").digest("hex");

/** Canonical, platform-independent line endings for emitted text. */
const lf = (text) => text.replace(/\r\n/g, "\n");

function caseRootOf(set) {
  return join(REPO, "benchmarks", set.suiteId);
}

function manifestPathOf(set) {
  return join(EVIDENCE_DIR, set.manifestFile);
}

function caseJsonOf(definition, suiteValue) {
  return {
    expected: { status: "completed" },
    suite: suiteValue,
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
function filesOf(definition, suiteValue) {
  const files = {
    "case.json": `${JSON.stringify(caseJsonOf(definition, suiteValue), null, 2)}\n`,
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

function writeCase(caseRoot, definition, files) {
  const dir = join(caseRoot, definition.id);
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

function eligibilityOf(condition) {
  return condition === "compact-drop" || condition === "rehydrate" || condition === "partial"
    ? "case-local context budget makes the context compact after the authoritative spec was read; the required text is then absent while the original command verifier still applies"
    : condition === "preview"
      ? "the authoritative value sits in the middle of a file larger than the 16 KiB inline budget, so it is absent from the model-visible head/tail preview while the original command verifier still applies"
      : condition === "changed"
        ? "a setup command rewrites the target file before the fix, so the original command verifier judges the post-change state"
        : condition === "diagnostic"
          ? "the workspace ships a failing check that can be rerun for diagnostics and is also the command verifier"
          : "everything the fix needs stays visible; the original command verifier applies unchanged";
}

function buildManifest(set) {
  const counts = {};
  for (const c of set.cases) counts[c.condition] = (counts[c.condition] ?? 0) + 1;
  for (const [condition, expected] of Object.entries(set.composition)) {
    if (condition === "total") continue;
    if ((counts[condition] ?? 0) !== expected) {
      throw new Error(
        `${set.key}: composition drift: ${condition} has ${counts[condition] ?? 0} case(s), expected ${expected}`,
      );
    }
  }
  if (set.cases.length !== set.composition.total) {
    throw new Error(`${set.key}: composition drift: ${set.cases.length} case(s), expected ${set.composition.total}`);
  }

  // The anti-rename rule: no two cases may share fixture bytes or task text.
  const byDigest = new Map();
  const byRequest = new Map();
  const byId = new Set();
  for (const c of set.cases) {
    if (byId.has(c.id)) throw new Error(`${c.id} is declared twice`);
    byId.add(c.id);
    const files = filesOf(c, set.caseJsonSuite);
    const digest = contentDigestOf(files);
    if (byDigest.has(digest)) throw new Error(`${c.id} duplicates the fixture content of ${byDigest.get(digest)}`);
    byDigest.set(digest, c.id);
    const request = lf(c.request).trim();
    if (byRequest.has(request)) throw new Error(`${c.id} duplicates the task text of ${byRequest.get(request)}`);
    byRequest.set(request, c.id);
  }

  const cases = set.cases.map((c) => {
    const files = filesOf(c, set.caseJsonSuite);
    return {
      caseId: c.id,
      suite: set.suiteId,
      condition: c.condition,
      tags: c.tags,
      ...(c.contextBudgetTokens !== undefined ? { contextBudgetTokens: c.contextBudgetTokens } : {}),
      contentDigest: contentDigestOf(files),
      verifierDigest: verifierDigestOf(c),
      eligibility: eligibilityOf(c.condition),
      referenceFix: c.referenceFix,
      referenceRun: c.referenceRun ?? [],
      request: c.request,
      expected: c.expected,
    };
  });

  return {
    schemaVersion: set.manifestSchema,
    candidateId: "context_safe_tool_call_efficiency_v2",
    suite: { id: set.suiteId, version: "1.0.0", caseRoot: `benchmarks/${set.suiteId}` },
    composition: { ...set.composition, ...counts },
    cases,
    manifestDigest: sha256(
      JSON.stringify(
        cases.map((c) => ({ caseId: c.caseId, suite: c.suite, contentDigest: c.contentDigest, verifierDigest: c.verifierDigest })),
      ),
    ),
  };
}

function problemsFor(set, manifest) {
  const caseRoot = caseRootOf(set);
  const problems = [];

  for (const c of set.cases) {
    const expectedFiles = filesOf(c, set.caseJsonSuite);
    const dir = join(caseRoot, c.id);
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
  if (existsSync(caseRoot)) {
    for (const entry of readdirSync(caseRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      if (!set.cases.some((c) => c.id === entry.name)) problems.push(`${entry.name}: stale case directory`);
    }
  }

  const manifestText = `${JSON.stringify(manifest, null, 2)}\n`;
  const manifestPath = manifestPathOf(set);
  if (existsSync(manifestPath)) {
    const current = readFileSync(manifestPath, "utf8");
    if (lf(current) !== lf(manifestText)) problems.push(`${set.manifestFile} differs from the generated manifest`);
  } else {
    problems.push(`${set.manifestFile} is missing`);
  }
  return problems;
}

function main() {
  const check = process.argv.includes("--check");
  const setArg = process.argv.find((a) => a.startsWith("--set="));
  const setName = setArg === undefined ? "all" : setArg.slice("--set=".length);
  const selected = setName === "all" ? Object.values(SETS) : [SETS[setName]];
  if (selected.some((s) => s === undefined)) {
    process.stderr.write(`unknown --set value; expected one of ${Object.keys(SETS).join("|")}|all\n`);
    process.exit(2);
  }

  const problems = [];
  const summaries = [];
  for (const set of selected) {
    const manifest = buildManifest(set);
    problems.push(...problemsFor(set, manifest).map((p) => `${set.key}: ${p}`));
    summaries.push(`${set.suiteId}: ${set.cases.length} case(s), manifest ${manifest.manifestDigest}`);
    if (!check) {
      const caseRoot = caseRootOf(set);
      rmSync(caseRoot, { recursive: true, force: true });
      for (const c of set.cases) writeCase(caseRoot, c, filesOf(c, set.caseJsonSuite));
      mkdirSync(dirname(manifestPathOf(set)), { recursive: true });
      writeFileSync(manifestPathOf(set), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    }
  }

  if (check && problems.length > 0) {
    process.stderr.write(`n7 case check FAILED (${problems.length} problem(s)):\n`);
    for (const p of problems.slice(0, 40)) process.stderr.write(`  - ${p}\n`);
    process.exit(1);
  }
  process.stdout.write(`n7 case ${check ? "check PASS" : "written"}:\n  ${summaries.join("\n  ")}\n`);
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  main();
}
