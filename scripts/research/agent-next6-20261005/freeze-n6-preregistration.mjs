/**
 * N6 / N2 — freeze the MAIN-experiment pre-registration artifact.
 *
 * The frozen inputs live HERE and only here on the script side; the test
 * `context-safe-tool-call-efficiency-preregistration.test.ts` rebuilds the same
 * artifact from the same numbers and asserts the committed JSON equals it, so a
 * hand-edited artifact (or a drifted input) is refused instead of silently
 * changing what was pre-registered.
 *
 * Usage:
 *   node scripts/research/agent-next6-20261005/freeze-n6-preregistration.mjs
 *   node scripts/research/agent-next6-20261005/freeze-n6-preregistration.mjs --check
 *
 * Makes ZERO provider calls.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "..", "..", "..");
const MANIFEST_PATH = join(REPO, "docs", "evidence", "agent-next6-20261005", "case-manifest.json");
const ARTIFACT_PATH = join(REPO, "docs", "evidence", "agent-next6-20261005", "main-preregistration.json");

const evaluation = await import(pathToFileURL(join(REPO, "packages", "evaluation", "dist", "index.js")).href);
const {
  buildContextSafePreregistration,
  contextSafeCaseEntriesFromManifest,
  dryRunContextSafePreregistration,
  getArmFactory,
  CONTEXT_SAFE_CANDIDATE_ID,
  CONTEXT_SAFE_COMPARISON_ARM_ID,
} = evaluation;

const manifest = JSON.parse(readFileSync(MANIFEST_PATH, "utf8"));
const factory = getArmFactory();

// ---- the frozen inputs (identical to the test's frozenOptions()) ------------
const options = {
  subject: {
    // Bound to the real tested source at execution time; 40-hex by contract.
    // The REAL tested source (the commit carrying the provider-parser fix the
    // approved endpoint requires) and the candidate arm's REAL config digest.
    candidateSourceSha: "29ba9546bc4c3d515a46058c5cf69046f0e82e57",
    baselineArmDigest: factory.resolveArm(CONTEXT_SAFE_COMPARISON_ARM_ID).digest,
    candidateArmDigest: factory.resolveArm(CONTEXT_SAFE_CANDIDATE_ID).digest,
    runtimeConfigDigest: factory.resolveArm(CONTEXT_SAFE_CANDIDATE_ID).digest,
  },
  provider: {
    // The APPROVED execution configuration (bound before any experiment result).
    // The endpoint is stored as a normalized digest inside the artifact, never
    // as a raw URL, and the credential is never written anywhere.
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
  schedule: { orderSeed: 20_261_005 },
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

const artifact = buildContextSafePreregistration(options);
const report = dryRunContextSafePreregistration(artifact);
if (!report.ok) {
  process.stderr.write(`pre-registration dry run REFUSED:\n  ${report.problems.join("\n  ")}\n`);
  process.exit(1);
}

const text = `${JSON.stringify(artifact, null, 2)}\n`;
const check = process.argv.includes("--check");

if (check) {
  let current = null;
  try {
    current = readFileSync(ARTIFACT_PATH, "utf8");
  } catch {
    current = null;
  }
  if (current === null) {
    process.stderr.write(`pre-registration check FAILED: ${ARTIFACT_PATH} is missing\n`);
    process.exit(1);
  }
  if (current.replace(/\r\n/g, "\n") !== text.replace(/\r\n/g, "\n")) {
    process.stderr.write("pre-registration check FAILED: the committed artifact differs from a fresh build\n");
    process.exit(1);
  }
  process.stdout.write(
    `pre-registration check PASS: ${artifact.preregistrationDigest} (${report.logicalRuns} logical arm runs, ` +
      `ab=${report.abCount} ba=${report.baCount}, paid calls=${report.paidProviderCalls})\n`,
  );
} else {
  mkdirSync(dirname(ARTIFACT_PATH), { recursive: true });
  writeFileSync(ARTIFACT_PATH, text, "utf8");
  process.stdout.write(
    `pre-registration frozen: ${artifact.preregistrationDigest}\n` +
      `  cases=${report.cases} repetitions=${report.repetitions} logicalRuns=${report.logicalRuns} ` +
      `ab=${report.abCount} ba=${report.baCount} worstCaseModelCalls=${report.campaignWorstCaseModelCalls}\n` +
      `  modelQuality=${report.modelQuality} promotion=${report.promotion} paidProviderCalls=${report.paidProviderCalls}\n`,
  );
}
