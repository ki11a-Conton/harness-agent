/**
 * N7 / N7-3 — freeze the INDEPENDENT-HOLDOUT pre-registration artifact for
 * `context_safe_tool_call_efficiency_v2`.
 *
 * The holdout re-verifies the challenger against the CURRENT production champion,
 * so its comparison arm may never be assumed to be C0: this script RESOLVES the
 * champion from the real state file and records where it came from (source path,
 * level, candidateId, state digest). The resolved arm digest is the real
 * ArmFactory digest for that candidate — for an unresolvable id the factory
 * refuses and this script fails closed.
 *
 * Re-run it whenever the champion changes: the baseline arm digest and the
 * provenance are both inside `preregistrationDigest`, so a new champion can never
 * ride on an old approval.
 *
 * Power: the holdout keeps its own frozen 24-case corpus → 24 × 4 × 2 = 192
 * logical ARM RUNS (the plan's "512 runs/实验" is arithmetically the main-set
 * figure 2×64×4; the holdout is never inflated to match a slogan).
 *
 * Usage:
 *   node scripts/research/agent-next7-20261006/freeze-n7-holdout-preregistration.mjs
 *   node scripts/research/agent-next7-20261006/freeze-n7-holdout-preregistration.mjs --check
 *
 * Makes ZERO provider calls. The credential is never read and never written.
 */

import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "..", "..", "..");
const EVIDENCE_DIR = join(REPO, "docs", "evidence", "agent-next7-20261006");
const MANIFEST_PATH = join(EVIDENCE_DIR, "holdout-case-manifest.json");
const ARTIFACT_PATH = join(EVIDENCE_DIR, "holdout-preregistration.json");
const CHAMPION_STATE_PATH = join(REPO, "docs", "evolution", "champion-state.json");

const sha256 = (text) => createHash("sha256").update(text, "utf8").digest("hex");

const evaluation = await import(pathToFileURL(join(REPO, "packages", "evaluation", "dist", "index.js")).href);
const {
  buildContextSafeV2Preregistration,
  contextSafeCaseEntriesFromManifest,
  dryRunContextSafeV2Preregistration,
  getArmFactory,
  CONTEXT_SAFE_V2_CANDIDATE_ID,
  CONTEXT_SAFE_V2_HOLDOUT_CASES,
  CONTEXT_SAFE_V2_HOLDOUT_LOGICAL_RUNS,
} = evaluation;

const manifest = JSON.parse(readFileSync(MANIFEST_PATH, "utf8"));
const factory = getArmFactory();

if (manifest.cases.length !== CONTEXT_SAFE_V2_HOLDOUT_CASES) {
  process.stderr.write(
    `holdout freeze REFUSED: the holdout manifest carries ${manifest.cases.length} case(s), the v2 holdout plan requires ${CONTEXT_SAFE_V2_HOLDOUT_CASES}\n`,
  );
  process.exit(1);
}

// ---- resolve the CURRENT production champion (never assumed) ---------------
let stateText = null;
try {
  stateText = readFileSync(CHAMPION_STATE_PATH, "utf8");
} catch {
  stateText = null;
}
if (stateText === null) {
  process.stderr.write(
    `holdout freeze REFUSED: no champion state at ${CHAMPION_STATE_PATH}; the comparison arm must be a RESOLVED champion, not an assumption\n`,
  );
  process.exit(1);
}
const state = JSON.parse(stateText);
const championCandidateId = state.candidateId ?? null;
const championArm = factory.resolveArm(championCandidateId);
const provenance = {
  source:
    `docs/evolution/champion-state.json (level=${String(state.level)}, ` +
    `candidateId=${championCandidateId === null ? "null" : championCandidateId}, ` +
    `validity=${String(state.validity)}, applied=${String(state.applied)})`,
  level: String(state.level),
  candidateId: championCandidateId,
  stateDigest: sha256(stateText.replace(/\r\n/g, "\n")),
};

const options = {
  role: "holdout",
  subject: {
    candidateSourceSha: "a251af1daf7991280277a99d70bf3a3a6201c66d",
    baselineArmDigest: championArm.digest,
    candidateArmDigest: factory.resolveArm(CONTEXT_SAFE_V2_CANDIDATE_ID).digest,
    runtimeConfigDigest: factory.resolveArm(CONTEXT_SAFE_V2_CANDIDATE_ID).digest,
    championProvenance: provenance,
  },
  provider: {
    // The APPROVED execution configuration, bound identically for both arms of
    // the holdout re-verification (the champion arm gets no extra budget).
    providerId: "openai",
    modelId: "workbuddy-deepseek-v4.1-flash",
    endpointBaseUrl: "http://127.0.0.1:8317/v1",
    requestProfile: { budgetTokens: 32_000, temperature: null, stallPolicy: "benchmark-default" },
  },
  cases: contextSafeCaseEntriesFromManifest(manifest.cases),
  suite: { id: manifest.suite.id, version: manifest.suite.version, caseRoot: manifest.suite.caseRoot },
  holdoutPolicy:
    "holdout per-case data is never read into an artifact; this plan IS the holdout experiment and never participates in prompt tuning",
  selectionProvenanceDigest: manifest.manifestDigest,
  evaluation: { scorerDigest: "c".repeat(64), judgeId: "task-verifier", judgeDigest: "d".repeat(64) },
  // A different frozen order seed from the main experiment: the two schedules are
  // independent, and neither seed is a model seed.
  schedule: { orderSeed: 20_261_008 },
  budget: {
    maxModelCallsPerRun: 30,
    maxToolCalls: 600,
    // AMENDED 2026-10-07 (operator-approved): measured throughput is ~0.83 min/arm,
    // so the 512-arm campaign needs ~7.1h; the original 30-minute cap made the frozen
    // campaign unfinishable. ONLY this duration changes — gates, cases, arms,
    // repetitions, seeds and the token/tool/USD caps are untouched. See
    // docs/evidence/agent-next7-20261006/BUDGET-AMENDMENT.md.
    maxDurationMs: 43_200_000,
    maxInputTokens: 3_000_000,
    maxOutputTokens: 400_000,
    maxTotalTokens: 4_000_000,
    // The SAME hard ceiling for the holdout experiment: $100,000.
    maxUsdMicros: 100_000_000_000,
  },
};

const artifact = buildContextSafeV2Preregistration(options);
const report = dryRunContextSafeV2Preregistration(artifact);
if (!report.ok) {
  process.stderr.write(`holdout v2 pre-registration dry run REFUSED:\n  ${report.problems.join("\n  ")}\n`);
  process.exit(1);
}
if (report.logicalRuns !== CONTEXT_SAFE_V2_HOLDOUT_LOGICAL_RUNS) {
  process.stderr.write(
    `holdout v2 pre-registration REFUSED: dry run derived ${report.logicalRuns} logical arm runs, expected ${CONTEXT_SAFE_V2_HOLDOUT_LOGICAL_RUNS}\n`,
  );
  process.exit(1);
}

const text = `${JSON.stringify(artifact, null, 2)}\n`;
if (process.argv.includes("--check")) {
  let current = null;
  try {
    current = readFileSync(ARTIFACT_PATH, "utf8");
  } catch {
    current = null;
  }
  if (current === null) {
    process.stderr.write(`holdout v2 pre-registration check FAILED: ${ARTIFACT_PATH} is missing\n`);
    process.exit(1);
  }
  if (current.replace(/\r\n/g, "\n") !== text.replace(/\r\n/g, "\n")) {
    process.stderr.write(
      "holdout v2 pre-registration check FAILED: the committed artifact differs from a fresh build " +
        "(a champion change or a registry change moves the baseline arm digest — re-freeze and re-approve)\n",
    );
    process.exit(1);
  }
  process.stdout.write(
    `holdout v2 pre-registration check PASS: ${artifact.preregistrationDigest} (champion arm ${championArm.digest.slice(0, 12)}…, ` +
      `${report.logicalRuns} logical arm runs, ab=${report.abCount} ba=${report.baCount}, paid calls=${report.paidProviderCalls})\n`,
  );
} else {
  mkdirSync(dirname(ARTIFACT_PATH), { recursive: true });
  writeFileSync(ARTIFACT_PATH, text, "utf8");
  process.stdout.write(
    `holdout v2 pre-registration frozen: ${artifact.preregistrationDigest}\n` +
      `  champion: level=${provenance.level} candidateId=${String(provenance.candidateId)} arm=${championArm.digest}\n` +
      `  provenance: ${provenance.source}\n` +
      `  cases=${report.cases} repetitions=${report.repetitions} logicalRuns=${report.logicalRuns} ` +
      `ab=${report.abCount} ba=${report.baCount} worstCaseModelCalls=${report.campaignWorstCaseModelCalls}\n` +
      `  modelQuality=${report.modelQuality} promotion=${report.promotion} paidProviderCalls=${report.paidProviderCalls}\n`,
  );
}
