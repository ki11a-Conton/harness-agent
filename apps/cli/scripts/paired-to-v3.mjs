/**
 * E3-14 post-benchmark: convert paired-experiment.json finalizedPairs
 * into V3 baseline + candidate artifacts using the PRODUCTION writer.
 *
 * Run from workspace root:
 *   node apps/cli/scripts/paired-to-v3.mjs [outDirName] [model] [provider]
 *   (defaults: e3-14-r4, deepseek-v4-flash-free, r4codes)
 *
 * Reads:  .ci/<outDirName>/paired-experiment.json
 * Writes: .ci/<outDirName>/v3-baseline.json, .ci/<outDirName>/v3-candidate.json
 * Prints: JSON with artifact paths.
 */
import { createHash } from "node:crypto";
import { execSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// Resolve paths: script is at apps/cli/scripts/paired-to-v3.mjs
// E3-14: outDir / model / provider are overridable via argv so the same script
// works for the b.ai partial run (.ci/e3-14) and the r4.codes full re-run
// (.ci/e3-14-r4). Usage: node paired-to-v3.mjs [outDirName] [model] [provider]
const __dirname = dirname(fileURLToPath(import.meta.url));
const workspaceRoot = join(__dirname, "..", "..", "..");
const outDirName = process.argv[2] ?? "e3-14-r4";
const outDir = join(workspaceRoot, ".ci", outDirName);
const pairedPath = join(outDir, "paired-experiment.json");

// Import production writer from @ar/evaluation (resolves via apps/cli/node_modules)
const { buildExperimentArtifactV3, writeExperimentArtifactV3 } = await import("@ar/evaluation");

async function main() {
  // 1. Read paired experiment
  const raw = JSON.parse(await readFile(pairedPath, "utf8"));
  const { finalizedPairs, planDigest, candidate } = raw;

  if (!finalizedPairs || finalizedPairs.length === 0) {
    console.error("No finalizedPairs found in", pairedPath);
    process.exit(1);
  }

  // 2. Derive git identity
  let gitSha = "unknown";
  let dirty = true;
  try {
    gitSha = execSync("git rev-parse HEAD", { encoding: "utf8", cwd: workspaceRoot }).trim();
    const status = execSync("git status --porcelain", { encoding: "utf8", cwd: workspaceRoot }).trim();
    dirty = status.length > 0;
  } catch { /* not a git repo */ }

  const model = process.argv[3] ?? "deepseek-v4-flash-free";
  const provider = process.argv[4] ?? "r4codes";
  const runtimeConfigHash = "e3-14-run";

  // 3. Build activation evidence array and collect baseline/candidate outcomes
  const activationEvidence = [];
  const baselineOutcomes = [];
  const candidateOutcomes = [];
  // E4-04: real security evidence per arm (was hardcoded []).
  const baselineSecurity = [];
  const candidateSecurity = [];

  // Map the V2 SecurityOutcomeV2 kind to the V3 artifact kind, preserving the
  // E4-04 #3 distinction between "no evidence" (not_observed) and "clean".
  const v2KindToV3 = (kind) => ({
    CONTAINED: "blocked",
    ESCAPE: "escaped",
    INVALID: "classifier_error",
    MISSING_EXPECTED_EVENT: "not_observed",
    NO_ATTACK_ATTEMPT: "clean",
    UNKNOWN_LEGACY: "legacy",
  }[kind] ?? "not_observed");

  const securityEntry = (sec, caseId) => ({
    caseId,
    kind: v2KindToV3(sec.kind),
    detail: sec.facts && sec.facts.length > 0
      ? `${sec.kind}: ${sec.facts.map((f) => f.type).join(",")}`
      : sec.kind,
  });

  let pairIndex = 0;
  for (const pair of finalizedPairs) {
    pairIndex += 1;
    const baseOutcome = pair.baseline.outcome;
    const candOutcome = pair.candidate.outcome;

    // Collect activation evidence from either outcome
    const aeSource = candOutcome.activationEvidence ?? baseOutcome.activationEvidence;
    let activationRef = null;
    if (aeSource) {
      const mech = aeSource.mechanism ?? "adaptive_recovery";
      const state = aeSource.activated ? "activated" : "not-activated";
      const aeId = `${pair.caseId}:${mech}:${state}`;
      activationEvidence.push({
        id: aeId,
        reasonCodes: [...(aeSource.reasonCodes ?? []), state].filter(Boolean),
        note: aeSource.detail ?? "",
      });
      activationRef = aeId;
    }

    // E4-04: collect the real per-arm security outcome and reference it.
    let baseSecRef = null;
    let candSecRef = null;
    if (baseOutcome.securityOutcome) {
      baselineSecurity.push(securityEntry(baseOutcome.securityOutcome, pair.caseId));
      baseSecRef = pair.caseId;
    }
    if (candOutcome.securityOutcome) {
      candidateSecurity.push(securityEntry(candOutcome.securityOutcome, pair.caseId));
      candSecRef = pair.caseId;
    }

    const metrics = (o) => o.metrics ?? {};
    const toV3 = (outcome, armId, ref, secRef) => ({
      caseId: outcome.caseId,
      suite: outcome.suite ?? "holdout",
      armId,
      attempt: 1,
      repetition: pair.repetition,
      order: pairIndex,
      passed: outcome.status === "passed",
      grade: outcome.grade ?? null,
      verificationPassed: outcome.status === "passed" ? true : (outcome.actualStatus === "completed" ? true : null),
      terminationReason: outcome.terminationReason ?? null,
      failureCategory: outcome.failureCategory ?? null,
      inputTokens: metrics(outcome).tokens_input ?? 0,
      outputTokens: metrics(outcome).tokens_output ?? 0,
      costUsd: metrics(outcome).estimated_cost ?? null,
      latencyMs: metrics(outcome).duration_ms ?? 0,
      toolCalls: metrics(outcome).tool_call_count ?? 0,
      recoveryDecisions: [],
      activationRef: ref,
      securityOutcomeRef: secRef,
      outputDigest: null,
      workspaceDigest: null,
      judgeVersion: outcome.judgeVersion ?? "2.1.0",
      evaluationContextHash: outcome.evaluationContextHash ?? null,
      candidateConfigHash: armId === "candidate" ? (outcome.candidateConfigHash ?? null) : null,
    });

    baselineOutcomes.push(toV3(baseOutcome, "baseline", null, baseSecRef));
    candidateOutcomes.push(toV3(candOutcome, "candidate", activationRef, candSecRef));
  }

  // 4. Build manifest and provenance
  const manifest = {
    suiteVersion: "2.1.0",
    judgeVersion: "2.1.0",
    gitSha,
    dirty,
  };
  const provenance = {
    sourceManifestPath: null,
    gitSha,
    dirty,
    model,
    provider,
    runtimeConfigHash,
  };

  // 5. Build V3 baseline artifact
  const baselineArtifact = buildExperimentArtifactV3({
    arm: { armId: "baseline", candidateId: null, candidateConfigHash: null },
    manifest,
    outcomes: baselineOutcomes,
    activationEvidence: activationEvidence.length > 0 ? activationEvidence : undefined,
    securityOutcomes: baselineSecurity,
    provenance,
  });

  // 6. Build V3 candidate artifact
  const candidateArtifact = buildExperimentArtifactV3({
    arm: { armId: "candidate", candidateId: candidate, candidateConfigHash: runtimeConfigHash },
    manifest: { ...manifest, planDigest: planDigest ?? null },
    outcomes: candidateOutcomes,
    activationEvidence: activationEvidence.length > 0 ? activationEvidence : undefined,
    securityOutcomes: candidateSecurity,
    provenance,
  });

  // 7. Write atomically via production writer
  const baselinePath = join(outDir, "v3-baseline.json");
  const candidatePath = join(outDir, "v3-candidate.json");
  await writeExperimentArtifactV3(baselineArtifact, baselinePath);
  await writeExperimentArtifactV3(candidateArtifact, candidatePath);

  console.log(JSON.stringify({
    baselinePath,
    candidatePath,
    pairs: finalizedPairs.length,
    baselineOutcomes: baselineOutcomes.length,
    candidateOutcomes: candidateOutcomes.length,
    activationEvidence: activationEvidence.length,
    gitSha,
    dirty,
  }));
}

main().catch((err) => {
  console.error("paired-to-v3:", err);
  process.exit(1);
});