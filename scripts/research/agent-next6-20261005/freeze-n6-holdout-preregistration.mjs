/**
 * N6 / N2 — freeze the INDEPENDENT-HOLDOUT pre-registration artifact.
 *
 * The holdout exists to re-verify the winner against the CURRENT production
 * champion, so its comparison arm may never be assumed to be C0: this script
 * RESOLVES the champion from the real state file and records where it came from
 * (source path, level, candidateId, validity, state digest). The resolved arm
 * digest is the real ArmFactory digest for that candidate — for an unresolvable
 * id the factory refuses and this script fails closed.
 *
 * Re-run it whenever the champion changes: the baseline arm digest and the
 * provenance are both inside `preregistrationDigest`, so a new champion can
 * never ride on an old approval.
 *
 * Usage:
 *   node scripts/research/agent-next6-20261005/freeze-n6-holdout-preregistration.mjs
 *   node scripts/research/agent-next6-20261005/freeze-n6-holdout-preregistration.mjs --check
 *
 * Makes ZERO provider calls.
 */

import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "..", "..", "..");
const EVIDENCE_DIR = join(REPO, "docs", "evidence", "agent-next6-20261005");
const MANIFEST_PATH = join(EVIDENCE_DIR, "holdout-case-manifest.json");
const ARTIFACT_PATH = join(EVIDENCE_DIR, "holdout-preregistration.json");
const CHAMPION_STATE_PATH = join(REPO, "docs", "evolution", "champion-state.json");

const sha256 = (text) => createHash("sha256").update(text, "utf8").digest("hex");

const evaluation = await import(pathToFileURL(join(REPO, "packages", "evaluation", "dist", "index.js")).href);
const {
  buildContextSafePreregistration,
  contextSafeCaseEntriesFromManifest,
  dryRunContextSafePreregistration,
  getArmFactory,
  CONTEXT_SAFE_CANDIDATE_ID,
} = evaluation;

const manifest = JSON.parse(readFileSync(MANIFEST_PATH, "utf8"));
const factory = getArmFactory();

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
    candidateSourceSha: "8ca36433226d96c52f4480735576ec3c6c15e4bc",
    baselineArmDigest: championArm.digest,
    candidateArmDigest: factory.resolveArm(CONTEXT_SAFE_CANDIDATE_ID).digest,
    runtimeConfigDigest: factory.resolveArm(CONTEXT_SAFE_CANDIDATE_ID).digest,
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
  // A different order seed from the main experiment: the two schedules are
  // independent, and neither seed is a model seed.
  schedule: { orderSeed: 20_261_006 },
  budget: {
    maxModelCallsPerRun: 30,
    maxToolCalls: 600,
    maxDurationMs: 1_800_000,
    maxInputTokens: 3_000_000,
    maxOutputTokens: 400_000,
    maxTotalTokens: 4_000_000,
    // The SAME hard ceiling for the holdout experiment: $100,000.
    maxUsdMicros: 100_000_000_000,
  },
};

const artifact = buildContextSafePreregistration(options);
const report = dryRunContextSafePreregistration(artifact);
if (!report.ok) {
  process.stderr.write(`holdout pre-registration dry run REFUSED:\n  ${report.problems.join("\n  ")}\n`);
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
    process.stderr.write(`holdout pre-registration check FAILED: ${ARTIFACT_PATH} is missing\n`);
    process.exit(1);
  }
  if (current.replace(/\r\n/g, "\n") !== text.replace(/\r\n/g, "\n")) {
    process.stderr.write("holdout pre-registration check FAILED: the committed artifact differs from a fresh build\n");
    process.exit(1);
  }
  process.stdout.write(
    `holdout pre-registration check PASS: ${artifact.preregistrationDigest} (champion arm ${championArm.digest.slice(0, 12)}…, ` +
      `${report.logicalRuns} logical arm runs, ab=${report.abCount} ba=${report.baCount}, paid calls=${report.paidProviderCalls})\n`,
  );
} else {
  mkdirSync(dirname(ARTIFACT_PATH), { recursive: true });
  writeFileSync(ARTIFACT_PATH, text, "utf8");
  process.stdout.write(
    `holdout pre-registration frozen: ${artifact.preregistrationDigest}\n` +
      `  champion: level=${provenance.level} candidateId=${String(provenance.candidateId)} arm=${championArm.digest}\n` +
      `  provenance: ${provenance.source}\n` +
      `  cases=${report.cases} repetitions=${report.repetitions} logicalRuns=${report.logicalRuns} ` +
      `ab=${report.abCount} ba=${report.baCount} worstCaseModelCalls=${report.campaignWorstCaseModelCalls}\n` +
      `  modelQuality=${report.modelQuality} promotion=${report.promotion} paidProviderCalls=${report.paidProviderCalls}\n`,
  );
}
