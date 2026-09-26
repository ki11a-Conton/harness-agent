/**
 * A1 — regenerate the FROZEN, digest-bound case selection for
 * `tool_call_efficiency_v1`.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * `prereg build` must not let a JSON config self-declare its own sample set
 * (`catalog`, `eligibilityDigest`, `selectionProvenanceDigest`). The selection
 * has to be derived, read-only, from committed evidence that exists
 * independently of the artifact. This script produces that frozen artifact:
 *
 *   - it reads ONLY the attributed (non-holdout) R85 failure taxonomy
 *     (`docs/evidence/e4-r85-failure-taxonomy.json`) — holdout per-case data is
 *     never opened;
 *   - it applies ONE versioned eligibility rule and takes EVERY matching case
 *     (no cherry-picking);
 *   - it verifies each selected case directory really exists under
 *     `benchmarks/<suite>/<caseId>`;
 *   - it binds the taxonomy bytes by digest, and binds the rule + the exact
 *     case list by a canonical `selectionProvenanceDigest`.
 *
 * The loader (`selectionFromFrozenEvidence` in
 * `packages/evaluation/src/tool-call-efficiency-case-selection.ts`) recomputes
 * the SAME digests and refuses any mismatch. The generator and the loader must
 * therefore share one canonical serializer — this is a byte-for-byte copy of
 * `stableStringify` from `packages/evaluation/src/manifest.ts`.
 *
 * ZERO network, ZERO provider, ZERO cost: this reads local JSON only.
 *
 * Usage: node scripts/e4/tool-call-case-selection.mjs [--check]
 *   (default writes the frozen file; --check verifies it is up to date)
 */

import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(here, "..", "..");

const SCHEMA = "tool-call-efficiency-case-selection-v1";
const CANDIDATE_ID = "tool_call_efficiency_v1";
const SUITE_ID = "tool-call-efficiency";
const SUITE_VERSION = "1.0.0";
const RULE_VERSION = "tcce-selection-v1";

const TAXONOMY_PATH = "docs/evidence/e4-r85-failure-taxonomy.json";
const OUT_PATH = "docs/evidence/tool-call-efficiency-case-selection.json";

const SELECTION_RULE =
  "TCCE-A1 v1: from the attributed (non-holdout) R85 taxonomy, select EVERY case whose recorded " +
  "termination is agent_limit or tool_limit AND whose recorded toolFailures > 0 (a long task whose " +
  "bounded iteration budget was burned while tool calls were failing — the tool_call_efficiency_v1 " +
  "target cluster). Cases are ordered by (suite, caseId). No cherry-picking: all matching cases are included.";
const ELIGIBILITY_RULE = "termination in {agent_limit, tool_limit} AND toolFailures > 0";
const HOLDOUT_POLICY =
  "holdout per-case data is NEVER read; only the attributed suites (regression/adversarial/stress) of the " +
  "committed R85 taxonomy are used, and every selected case is re-checked to be outside benchmarks/holdout";

function stableStringify(value) {
  if (value === undefined) return "undefined";
  if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    const keys = Object.keys(value).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function sha256Hex(text) {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function eligible(record) {
  const termination = record.termination;
  const toolFailures = record.toolFailures;
  const terminationOk = termination === "agent_limit" || termination === "tool_limit";
  return terminationOk && typeof toolFailures === "number" && toolFailures > 0;
}

function main() {
  const check = process.argv.includes("--check");
  const taxonomyAbs = join(REPO_ROOT, TAXONOMY_PATH);
  const taxonomyRaw = readFileSync(taxonomyAbs, "utf8");
  const taxonomy = JSON.parse(taxonomyRaw);
  const evidenceDigest = sha256Hex(taxonomyRaw);

  const attributed = new Set(taxonomy.scope?.attributedSuites ?? []);
  const selected = [];
  for (const record of taxonomy.cases ?? []) {
    if (!attributed.has(record.suite)) continue; // never touch a non-attributed (holdout) suite
    if (record.suite === "holdout") continue;
    if (!eligible(record)) continue;
    const rel = `benchmarks/${record.suite}/${record.caseId}`;
    if (!existsSync(join(REPO_ROOT, rel))) {
      throw new Error(`selected case directory is missing: ${rel}`);
    }
    selected.push({ caseId: record.caseId, suite: record.suite });
  }
  selected.sort((a, b) => (a.suite === b.suite ? (a.caseId < b.caseId ? -1 : a.caseId > b.caseId ? 1 : 0) : a.suite < b.suite ? -1 : 1));

  if (selected.length < 5) {
    throw new Error(
      `INSUFFICIENT_ELIGIBLE_CASES: ${selected.length} eligible non-holdout case(s) < minEligibleCases=5 — do not lower the minimum`,
    );
  }

  const body = {
    schemaVersion: SCHEMA,
    candidateId: CANDIDATE_ID,
    suiteId: SUITE_ID,
    suiteVersion: SUITE_VERSION,
    ruleVersion: RULE_VERSION,
    selectionRule: SELECTION_RULE,
    eligibilityRule: ELIGIBILITY_RULE,
    holdoutPolicy: HOLDOUT_POLICY,
    evidenceKind: "e4-r85-failure-taxonomy",
    evidencePath: TAXONOMY_PATH,
    evidenceDigest,
    cases: selected,
  };
  const selectionProvenanceDigest = sha256Hex(stableStringify(body));
  const frozen = { ...body, selectionProvenanceDigest };
  const json = `${JSON.stringify(frozen, null, 2)}\n`;

  const outAbs = join(REPO_ROOT, OUT_PATH);
  if (check) {
    const current = existsSync(outAbs) ? readFileSync(outAbs, "utf8") : "";
    if (current !== json) {
      process.stdout.write(`[STALE] ${OUT_PATH} is not what the committed evidence produces — rerun without --check\n`);
      return 1;
    }
    process.stdout.write(`[OK] ${OUT_PATH} is up to date — ${selected.length} case(s), evidence ${evidenceDigest.slice(0, 12)}…\n`);
    return 0;
  }
  writeFileSync(outAbs, json, "utf8");
  process.stdout.write(
    `wrote ${OUT_PATH}: ${selected.length} eligible case(s), provenance ${selectionProvenanceDigest.slice(0, 12)}…, evidence ${evidenceDigest.slice(0, 12)}…\n`,
  );
  for (const c of selected) process.stdout.write(`  ${c.suite}/${c.caseId}\n`);
  return 0;
}

process.exitCode = main();