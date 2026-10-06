/**
 * P 轮 — freeze the INDEPENDENT-HOLDOUT pre-registration artifact for
 * `verified_completion_gate_v1`.
 *
 * The holdout re-verifies the challenger against the CURRENT production champion,
 * so its comparison arm may never be assumed: this script RESOLVES the champion
 * from the real state file and records where it came from (source path, level,
 * candidateId, state digest). A champion change invalidates the plan, because the
 * arm digest and the provenance are both inside `preregistrationDigest`.
 *
 * Interaction recorded honestly: the baseline arm's resolved snapshot lists every
 * registered candidate as OFF, so this artifact binds the registry snapshot as of
 * the freeze. Registering a FUTURE candidate moves that digest and requires a
 * re-freeze (the same class of event as documented in
 * docs/evidence/agent-p-20261006/P-COMPLETION.md §4.1).
 *
 * Power: the holdout keeps its own frozen 24-case corpus → 24 × 4 × 2 = 192
 * logical ARM RUNS.
 *
 * Usage:
 *   node scripts/research/agent-p-20261006/freeze-p-holdout-preregistration.mjs
 *   node scripts/research/agent-p-20261006/freeze-p-holdout-preregistration.mjs --check
 *
 * Makes ZERO provider calls. The credential is never read and never written.
 */

import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "..", "..", "..");
const EVIDENCE_DIR = join(REPO, "docs", "evidence", "agent-p-20261006");
const MANIFEST_PATH = join(REPO, "docs", "evidence", "agent-next7-20261006", "holdout-case-manifest.json");
const ARTIFACT_PATH = join(EVIDENCE_DIR, "holdout-preregistration.json");
const CHAMPION_STATE_PATH = join(REPO, "docs", "evolution", "champion-state.json");

const sha256 = (text) => createHash("sha256").update(text, "utf8").digest("hex");

const evaluation = await import(pathToFileURL(join(REPO, "packages", "evaluation", "dist", "index.js")).href);
const {
  buildVerifiedCompletionGatePreregistration,
  contextSafeCaseEntriesFromManifest,
  dryRunVerifiedCompletionGatePreregistration,
  getArmFactory,
  VERIFIED_COMPLETION_GATE_CANDIDATE_ID,
  VERIFIED_COMPLETION_GATE_HOLDOUT_CASES,
  VERIFIED_COMPLETION_GATE_HOLDOUT_LOGICAL_RUNS,
} = evaluation;

const manifest = JSON.parse(readFileSync(MANIFEST_PATH, "utf8"));
const factory = getArmFactory();

if (manifest.cases.length !== VERIFIED_COMPLETION_GATE_HOLDOUT_CASES) {
  process.stderr.write(
    `holdout freeze REFUSED: the holdout manifest carries ${manifest.cases.length} case(s), the P holdout plan requires ${VERIFIED_COMPLETION_GATE_HOLDOUT_CASES}\n`,
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
    candidateSourceSha: "e6fc818c4c6ccf026c63dc73af25d99f462f93f3",
    baselineArmDigest: championArm.digest,
    candidateArmDigest: factory.resolveArm(VERIFIED_COMPLETION_GATE_CANDIDATE_ID).digest,
    runtimeConfigDigest: factory.resolveArm(VERIFIED_COMPLETION_GATE_CANDIDATE_ID).digest,
    championProvenance: provenance,
  },
  provider: {
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
  schedule: { orderSeed: 20_261_010 },
  budget: {
    maxModelCallsPerRun: 30,
    maxToolCalls: 600,
    maxDurationMs: 1_800_000,
    maxInputTokens: 3_000_000,
    maxOutputTokens: 400_000,
    maxTotalTokens: 4_000_000,
    maxUsdMicros: 100_000_000_000,
  },
};

const artifact = buildVerifiedCompletionGatePreregistration(options);
const report = dryRunVerifiedCompletionGatePreregistration(artifact);
if (!report.ok) {
  process.stderr.write(`P holdout dry run REFUSED:\n  ${report.problems.join("\n  ")}\n`);
  process.exit(1);
}
if (report.logicalRuns !== VERIFIED_COMPLETION_GATE_HOLDOUT_LOGICAL_RUNS) {
  process.stderr.write(
    `P holdout REFUSED: dry run derived ${report.logicalRuns} logical arm runs, expected ${VERIFIED_COMPLETION_GATE_HOLDOUT_LOGICAL_RUNS}\n`,
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
    process.stderr.write(`P holdout check FAILED: ${ARTIFACT_PATH} is missing\n`);
    process.exit(1);
  }
  if (current.replace(/\r\n/g, "\n") !== text.replace(/\r\n/g, "\n")) {
    process.stderr.write(
      "P holdout check FAILED: the committed artifact differs from a fresh build (a champion change or a new " +
        "candidate registration moves the baseline arm digest — re-freeze and re-approve)\n",
    );
    process.exit(1);
  }
  process.stdout.write(
    `P holdout check PASS: ${artifact.preregistrationDigest} (champion arm ${championArm.digest.slice(0, 12)}…, ` +
      `${report.logicalRuns} logical arm runs, ab=${report.abCount} ba=${report.baCount}, paid calls=${report.paidProviderCalls})\n`,
  );
} else {
  mkdirSync(dirname(ARTIFACT_PATH), { recursive: true });
  writeFileSync(ARTIFACT_PATH, text, "utf8");
  process.stdout.write(
    `P holdout pre-registration frozen: ${artifact.preregistrationDigest}\n` +
      `  champion: level=${provenance.level} candidateId=${String(provenance.candidateId)} arm=${championArm.digest}\n` +
      `  provenance: ${provenance.source}\n` +
      `  cases=${report.cases} repetitions=${report.repetitions} logicalRuns=${report.logicalRuns} ` +
      `ab=${report.abCount} ba=${report.baCount} worstCaseModelCalls=${report.campaignWorstCaseModelCalls}\n` +
      `  modelQuality=${report.modelQuality} promotion=${report.promotion} paidProviderCalls=${report.paidProviderCalls}\n`,
  );
}
