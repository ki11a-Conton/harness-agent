/**
 * P 轮 — freeze the MAIN-experiment pre-registration artifact for
 * `verified_completion_gate_v1`.
 *
 * The frozen inputs live HERE and only here on the script side; the test
 * `verified-completion-gate-preregistration.test.ts` rebuilds the same artifact
 * from the same numbers and asserts the committed JSON equals it, so a hand-edited
 * artifact (or a drifted input) is refused instead of silently changing what was
 * pre-registered.
 *
 * Power: 64 cases × 4 repetitions × 2 arms = 512 logical ARM RUNS.
 *
 * Usage:
 *   node scripts/research/agent-p-20261006/freeze-p-preregistration.mjs
 *   node scripts/research/agent-p-20261006/freeze-p-preregistration.mjs --check
 *
 * Makes ZERO provider calls. The credential is never read and never written.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "..", "..", "..");
const EVIDENCE_DIR = join(REPO, "docs", "evidence", "agent-p-20261006");
const MANIFEST_PATH = join(REPO, "docs", "evidence", "agent-next7-20261006", "case-manifest.json");
const ARTIFACT_PATH = join(EVIDENCE_DIR, "main-preregistration.json");

const evaluation = await import(pathToFileURL(join(REPO, "packages", "evaluation", "dist", "index.js")).href);
const {
  buildVerifiedCompletionGatePreregistration,
  contextSafeCaseEntriesFromManifest,
  dryRunVerifiedCompletionGatePreregistration,
  getArmFactory,
  VERIFIED_COMPLETION_GATE_CANDIDATE_ID,
  VERIFIED_COMPLETION_GATE_COMPARISON_ARM_ID,
  VERIFIED_COMPLETION_GATE_MAIN_CASES,
  VERIFIED_COMPLETION_GATE_LOGICAL_RUNS_PER_EXPERIMENT,
} = evaluation;

// The corpus is the FROZEN N7 corpus (authored before this candidate's text
// existed); only its manifest is read, never re-generated.
const manifest = JSON.parse(readFileSync(MANIFEST_PATH, "utf8"));
const factory = getArmFactory();

if (manifest.cases.length !== VERIFIED_COMPLETION_GATE_MAIN_CASES) {
  process.stderr.write(
    `freeze REFUSED: the corpus manifest carries ${manifest.cases.length} case(s), the P main plan requires ${VERIFIED_COMPLETION_GATE_MAIN_CASES}\n`,
  );
  process.exit(1);
}

const options = {
  subject: {
    // The freeze-time commit of this repository (40-hex by contract). The P
    // campaign is NOT executed in this round, so this records the freeze source,
    // not an executed one.
    candidateSourceSha: "e6fc818c4c6ccf026c63dc73af25d99f462f93f3",
    baselineArmDigest: factory.resolveArm(VERIFIED_COMPLETION_GATE_COMPARISON_ARM_ID).digest,
    candidateArmDigest: factory.resolveArm(VERIFIED_COMPLETION_GATE_CANDIDATE_ID).digest,
    runtimeConfigDigest: factory.resolveArm(VERIFIED_COMPLETION_GATE_CANDIDATE_ID).digest,
  },
  provider: {
    // The APPROVED execution configuration. The endpoint is stored as a normalized
    // digest inside the artifact, never as a raw URL; the credential is never
    // read and never written.
    providerId: "openai",
    modelId: "workbuddy-deepseek-v4.1-flash",
    endpointBaseUrl: "http://127.0.0.1:8317/v1",
    requestProfile: { budgetTokens: 32_000, temperature: null, stallPolicy: "benchmark-default" },
  },
  cases: contextSafeCaseEntriesFromManifest(manifest.cases),
  suite: { id: manifest.suite.id, version: manifest.suite.version, caseRoot: manifest.suite.caseRoot },
  holdoutPolicy:
    "holdout per-case data is never read into an artifact; the holdout experiment uses its own suite and never participates in prompt tuning",
  selectionProvenanceDigest: manifest.manifestDigest,
  evaluation: { scorerDigest: "c".repeat(64), judgeId: "task-verifier", judgeDigest: "d".repeat(64) },
  // A frozen order seed. It is NOT a model seed: the provider gets no seed, the
  // schedule is reproducible and AB/BA balanced.
  schedule: { orderSeed: 20_261_009 },
  budget: {
    maxModelCallsPerRun: 30,
    maxToolCalls: 600,
    maxDurationMs: 1_800_000,
    maxInputTokens: 3_000_000,
    maxOutputTokens: 400_000,
    maxTotalTokens: 4_000_000,
    // The operator's hard ceiling (integer USD micros): $100,000.
    maxUsdMicros: 100_000_000_000,
  },
};

const artifact = buildVerifiedCompletionGatePreregistration(options);
const report = dryRunVerifiedCompletionGatePreregistration(artifact);
if (!report.ok) {
  process.stderr.write(`P pre-registration dry run REFUSED:\n  ${report.problems.join("\n  ")}\n`);
  process.exit(1);
}
if (report.logicalRuns !== VERIFIED_COMPLETION_GATE_LOGICAL_RUNS_PER_EXPERIMENT) {
  process.stderr.write(
    `P pre-registration REFUSED: dry run derived ${report.logicalRuns} logical arm runs, expected ${VERIFIED_COMPLETION_GATE_LOGICAL_RUNS_PER_EXPERIMENT}\n`,
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
    process.stderr.write(`P pre-registration check FAILED: ${ARTIFACT_PATH} is missing\n`);
    process.exit(1);
  }
  if (current.replace(/\r\n/g, "\n") !== text.replace(/\r\n/g, "\n")) {
    process.stderr.write("P pre-registration check FAILED: the committed artifact differs from a fresh build\n");
    process.exit(1);
  }
  process.stdout.write(
    `P pre-registration check PASS: ${artifact.preregistrationDigest} (${report.logicalRuns} logical arm runs, ` +
      `ab=${report.abCount} ba=${report.baCount}, paid calls=${report.paidProviderCalls})\n`,
  );
} else {
  mkdirSync(dirname(ARTIFACT_PATH), { recursive: true });
  writeFileSync(ARTIFACT_PATH, text, "utf8");
  process.stdout.write(
    `P pre-registration frozen: ${artifact.preregistrationDigest}\n` +
      `  candidate  : ${artifact.prompt.candidateId} textDigest=${artifact.prompt.guidanceDigest}\n` +
      `  comparison : ${artifact.prompt.comparisonCandidateId} textDigest=${artifact.prompt.comparisonGuidanceDigest}\n` +
      `  cases=${report.cases} repetitions=${report.repetitions} logicalRuns=${report.logicalRuns} ` +
      `ab=${report.abCount} ba=${report.baCount} worstCaseModelCalls=${report.campaignWorstCaseModelCalls}\n` +
      `  modelQuality=${report.modelQuality} promotion=${report.promotion} paidProviderCalls=${report.paidProviderCalls}\n`,
  );
}
