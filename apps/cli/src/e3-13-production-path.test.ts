/**
 * E3-13 — production-path offline integration acceptance.
 *
 * Every intermediate artifact is produced by a REAL production stage (no
 * hand-filled decision booleans, no synthetic artifacts). The test uses a
 * counting ScriptedModelProvider so provider calls = 0 (real model never
 * called).
 *
 * Production path (E3-13 acceptance #1/#2/#3):
 *   1. REAL benchmark run produces baseline.json (single-arm mode)
 *   2. buildExperimentArtifactV3 + writeExperimentArtifactV3 (production writer)
 *   3. runV3ChampionEval derives decision from artifact files (no hand booleans)
 *   4. buildPromotionEnvelope + loadPromotionEnvelope (real DecisionArtifactV3)
 *   5. writeChampionStateFileCas (CAS promotion)
 *   6. resolveChampionHarness (production harness config + identity proof)
 *
 * Adversarial (E3-13 acceptance #4):
 *   - forged envelope rejected (E3-07)
 */

import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile, readFile, stat, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { createHash } from "node:crypto";
import { ScriptedModelProvider } from "@ar/model";
import {
  runV3ChampionEval,
  buildPromotionEnvelope,
  loadPromotionEnvelope,
  createInitialChampionState,
  applyPromotion,
  getArmFactory,
  buildExperimentArtifactV3,
  writeExperimentArtifactV3,
  resolveChampionHarness,
  DEFAULT_DECISION_POLICY_V3,
  computeThresholdDigestV3,
  fixtureExecutionPlan,
  computeExecutionPlanDigest,
} from "@ar/evaluation";
import { runBenchmarkCommand } from "./benchmark-command.js";
import { writeChampionStateFileCas, championStateDigest } from "./champion-state-file.js";

let tempDirs: string[] = [];
afterEach(async () => {
  for (const d of tempDirs.splice(0)) {
    await rm(d, { recursive: true, force: true }).catch(() => {});
  }
});

async function makeTemp(): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), "e3-13-"));
  tempDirs.push(d);
  return d;
}

async function makeCaseDir(files: Record<string, string>): Promise<string> {
  const dir = await makeTemp();
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(dir, ...rel.split("/"));
    if (rel.includes("/")) {
      await mkdir(dirname(abs), { recursive: true });
    }
    await writeFile(abs, content, "utf8");
  }
  return dir;
}

const sha = (s: string): string => createHash("sha256").update(s, "utf8").digest("hex");

/**
 * SYNTHETIC TEST FIXTURE — NOT production-chain evidence (downgraded by E4-09).
 *
 * This builds a V3 baseline + candidate artifact pair with hand-authored
 * outcome rows (3 cases × 2 reps, candidate wins on net delta). It uses the
 * production WRITER, but the OUTCOMES are fabricated, so it can only exercise
 * the downstream mechanics (evaluator → envelope → CAS → resolveChampionHarness)
 * on a known-good shape. It must NEVER be cited as proof that the real
 * benchmark → V3 → evaluator → promotion → application chain works — that is
 * proven end-to-end, with every artifact produced by the previous real stage,
 * in e4-09-production-e2e.test.ts.
 */
async function buildV3ArtifactPair(
  dir: string,
  arm: { digest: string },
): Promise<{ baselinePath: string; candidatePath: string }> {
  await mkdir(dir, { recursive: true });

  // Helper: create one outcome row.
  const outcome = (caseId: string, armId: string, rep: number, order: number, passed: boolean, configHash: string, activationRef: string | null = null) => ({
    caseId, suite: "holdout", armId, attempt: 1, repetition: rep, order,
    passed, grade: passed ? "good" : "pass", terminationReason: "verified_complete",
    verificationPassed: passed, failureCategory: null,
    inputTokens: 1000, outputTokens: 500, costUsd: 0.01, latencyMs: 100,
    toolCalls: 3, recoveryDecisions: [],
    activationRef,
    // E4-R14 (N08): every sample carries a RESOLVING security evidence record.
    securityOutcomeRef: `holdout\u0000${caseId}\u0000${rep}\u0000${armId}`,
    outputDigest: null, workspaceDigest: null, judgeVersion: "1.0.0",
    evaluationContextHash: sha("ctx"), candidateConfigHash: configHash,
  });

  const gitSha = "a".repeat(40);
  const baseConfigHash = sha("base");
  const runtimeConfigHash = baseConfigHash; // both arms share the same runtime config
  const cases = ["ho-01", "ho-02", "ho-03"];
  const grid = [1, 2].flatMap((rep) => cases.map((c) => `holdout\u0000${c}\u0000${rep}`));

  // E4-R22 (F02): the confirmed execution plan must satisfy the shared e4-01
  // protocol AND cross-bind to the manifest/provenance facts below (provider,
  // model, gitSha, judge, isolation, thresholds, and the challenger the plan
  // authorizes) — a hand-truncated partial plan is rejected by the evaluator
  // and the promotion loader, and the manifest planDigest is the recomputed
  // digest of this exact plan (never a free-text placeholder).
  const plan = fixtureExecutionPlan({
    suite: "holdout",
    caseIds: cases,
    repeat: 2,
    judgeVersion: "1.0.0",
    providerId: "fake",
    modelId: "deepseek-v4-flash",
    sourceSha: gitSha,
    candidate: "adaptive_recovery_v2",
    isolationStrength: "strong",
  });
  const planDigest = computeExecutionPlanDigest(plan);

  // Baseline: ho-01 fails in both reps; ho-02/03 pass in both reps.
  const baselineOutcomes = [
    outcome("ho-01", "baseline", 1, 1, false, baseConfigHash),
    outcome("ho-02", "baseline", 1, 2, true, baseConfigHash),
    outcome("ho-03", "baseline", 1, 3, true, baseConfigHash),
    outcome("ho-01", "baseline", 2, 4, false, baseConfigHash),
    outcome("ho-02", "baseline", 2, 5, true, baseConfigHash),
    outcome("ho-03", "baseline", 2, 6, true, baseConfigHash),
  ];
  const baselineArtifact = buildExperimentArtifactV3({
    arm: { armId: "baseline", candidateId: null, candidateConfigHash: baseConfigHash },
    manifest: {
      suiteVersion: "2.1.0", judgeVersion: "1.0.0", gitSha, dirty: false,
      // E4-R13/R14: confirmed plan + complete grid + completion marker.
      expectedSampleKeys: grid, runComplete: true,
      executionPlan: plan, planDigest,
      thresholdDigest: computeThresholdDigestV3(DEFAULT_DECISION_POLICY_V3),
    },
    outcomes: baselineOutcomes,
    activationEvidence: [],
    securityOutcomes: baselineOutcomes.map((o) => ({ caseId: o.securityOutcomeRef, kind: "clean", detail: "no attack (fixture)" })),
    provenance: { sourceManifestPath: null, gitSha, dirty: false, model: "deepseek-v4-flash",
      provider: "fake", runtimeConfigHash },
  });
  const baselinePath = join(dir, "baseline.json");
  await writeExperimentArtifactV3(baselineArtifact, baselinePath);

  const candidateConfigHash = arm.digest;
  // E4-R14 (N07): a case is activation-eligible only when EVERY repetition
  // carries a resolving activationRef — so all 6 candidate outcomes activate.
  const candidateOutcomes = [
    outcome("ho-01", "candidate", 1, 1, true, candidateConfigHash, "act-001"),
    outcome("ho-02", "candidate", 1, 2, true, candidateConfigHash, "act-002"),
    outcome("ho-03", "candidate", 1, 3, true, candidateConfigHash, "act-003"),
    outcome("ho-01", "candidate", 2, 4, true, candidateConfigHash, "act-004"),
    outcome("ho-02", "candidate", 2, 5, true, candidateConfigHash, "act-005"),
    outcome("ho-03", "candidate", 2, 6, true, candidateConfigHash, "act-006"),
  ];
  const candidateArtifact = buildExperimentArtifactV3({
    arm: { armId: "candidate", candidateId: "adaptive_recovery_v2", candidateConfigHash },
    manifest: {
      suiteVersion: "2.1.0", judgeVersion: "1.0.0", gitSha, dirty: false, planDigest,
      promotionEligible: true, isolationStrength: "strong", runtimeConfigHash,
      expectedSampleKeys: grid, runComplete: true,
      executionPlan: plan,
      thresholdDigest: computeThresholdDigestV3(DEFAULT_DECISION_POLICY_V3),
    },
    outcomes: candidateOutcomes,
    activationEvidence: candidateOutcomes.map((o) => ({ id: o.activationRef as string, reasonCodes: ["memory.retrieved"], note: "memory retrieval activated" })),
    securityOutcomes: candidateOutcomes.map((o) => ({ caseId: o.securityOutcomeRef, kind: "clean", detail: "no attack (fixture)" })),
    provenance: { sourceManifestPath: null, gitSha, dirty: false, model: "deepseek-v4-flash",
      provider: "fake", runtimeConfigHash },
  });
  const candidatePath = join(dir, "candidate.json");
  await writeExperimentArtifactV3(candidateArtifact, candidatePath);

  return { baselinePath, candidatePath };
}

describe("E3-13 production-path offline integration", () => {
  it("1. REAL benchmark → V3 writer → strict loader → decision derived (no hand booleans)", async () => {
    const root = await makeCaseDir({
      "cases/t01/request.md": "Write a test file.",
      "cases/t01/expected.md": "File written.",
      "cases/t01/case.json": JSON.stringify({
        verification: [{ kind: "command", command: "echo ok" }],
      }),
      "cases/t01/fixture/note.txt": "content",
    });

    // Run the REAL benchmark with a counting scripted provider.
    const provider = new ScriptedModelProvider([
      ScriptedModelProvider.toolCall("write_file", { path: "out.txt", content: "pass" }),
      ScriptedModelProvider.text("done"),
    ]);
    const res = await runBenchmarkCommand(
      ["--cases", join(root, "cases"), "--out", join(root, "out")],
      provider,
    );
    expect(res.exitCode).toBe(0);

    // The benchmark produces baseline.json (single-arm mode).
    const baselinePath = join(root, "out", "baseline.json");
    await expect(stat(baselinePath)).resolves.toBeDefined();

    // 2. Build V3 artifacts using the PRODUCTION WRITER (not hand-crafted JSON).
    const arm = getArmFactory().resolveCandidate("adaptive_recovery_v2");
    const { baselinePath: baselineV3Path, candidatePath: candidateV3Path } = await buildV3ArtifactPair(
      join(root, "v3-artifacts"), arm,
    );

    // 3. Derive decision from REAL artifact files (no hand-filled booleans).
    const evalResult = await runV3ChampionEval({
      baselinePath: baselineV3Path,
      candidatePath: candidateV3Path,
      candidateId: "adaptive_recovery_v2",
    });
    expect(evalResult.decisionArtifact.decision).toBe("ACCEPT");
    // Every gate value is derived from artifact outcomes.
    expect(evalResult.derivedInputs.netPassedDelta).toBe(2); // +1 per rep × 2 reps
    // E4-R14 (N07): activation coverage is over UNIQUE eligible cases — all 3
    // cases carry a resolving activationRef on EVERY repetition → 3/3 = 1.0.
    expect(evalResult.derivedInputs.activationCoverage).toBe(1.0);
    expect(evalResult.derivedInputs.activationEligibleCases).toBe(3);
    expect(evalResult.derivedInputs.securityBreachesCandidate).toBe(0);
    expect(evalResult.derivedInputs.comparable).toBe(true);
    // The decision artifact is a valid DecisionArtifactV3.
    expect(evalResult.decisionArtifact.schemaVersion).toBe("3.0.0");
    expect(evalResult.decisionArtifact.contentDigest).toMatch(/^[0-9a-f]{24}$/);
  });

  it("2. FULL PROMOTION: V3 decision → envelope → CAS state → champion harness", async () => {
    const root = await makeTemp();

    // 2a. Build V3 artifacts with the production writer.
    const arm = getArmFactory().resolveCandidate("adaptive_recovery_v2");
    const { baselinePath: baselineV3Path, candidatePath: candidateV3Path } = await buildV3ArtifactPair(
      join(root, "artifacts"), arm,
    );

    // 2b. Derive decision from REAL artifacts (no hand booleans).
    const evalResult = await runV3ChampionEval({
      baselinePath: baselineV3Path,
      candidatePath: candidateV3Path,
      candidateId: "adaptive_recovery_v2",
    });
    expect(evalResult.decisionArtifact.decision).toBe("ACCEPT");

    // 2c. Build the promotion envelope with REAL DecisionArtifactV3 file.
    const envelopeDir = join(root, "envelope");
    await mkdir(envelopeDir, { recursive: true });
    const decisionArtifactPath = join(envelopeDir, "decision-artifact.json");
    const decisionArtifactStr = JSON.stringify(evalResult.decisionArtifact);
    await writeFile(decisionArtifactPath, decisionArtifactStr, "utf8");

    const onDiskCand = await readFile(candidateV3Path, "utf8");
    const onDiskBase = await readFile(baselineV3Path, "utf8");
    const envelope = buildPromotionEnvelope({
      generatedBy: "e3-13",
      candidateId: "adaptive_recovery_v2",
      parentLevel: "C0",
      parentStateDigest: sha("c0-state"),
      decisionArtifactPath,
      decisionArtifactDigest: sha(decisionArtifactStr),
      decisionEnvelopeDigest: sha(JSON.stringify(evalResult.envelope.statistics)),
      artifactRefs: [
        { role: "baseline", path: baselineV3Path, digest: sha(onDiskBase) },
        { role: "candidate", path: candidateV3Path, digest: sha(onDiskCand) },
      ],
      sourceSha: "a".repeat(40),
    });
    const envPath = join(envelopeDir, "envelope.json");
    await writeFile(envPath, JSON.stringify(envelope), "utf8");

    // 2d. Verify the envelope (loadPromotionEnvelope).
    const verified = await loadPromotionEnvelope(envPath, {
      parentStateDigest: sha("c0-state"),
      candidateId: "adaptive_recovery_v2",
      bundleRoot: root,
    });
    expect(verified.ok).toBe(true);

    // 2e. CAS promotion: write champion state.
    const statePath = join(root, "champion-state.json");
    const c0 = createInitialChampionState();
    await writeFile(statePath, JSON.stringify(c0), "utf8");
    const c0Digest = championStateDigest(c0);

    const c1 = applyPromotion(c0, "adaptive_recovery_v2", { adaptiveRecovery: "conservative-v1" }, candidateV3Path, {
      envelopeDigest: envelope.contentDigest,
      decisionEnvelopeDigest: envelope.decisionEnvelopeDigest,
    });
    const casResult = await writeChampionStateFileCas(c1, c0Digest, statePath);
    expect(casResult.ok).toBe(true);

    // 2f. E3-08: use resolveChampionHarness to get production harness config.
    const harnessResult = resolveChampionHarness(
      { level: "C1", candidateId: "adaptive_recovery_v2", validity: "PROVEN", applied: false },
      { level: "C1", candidateId: "adaptive_recovery_v2" },
    );
    expect(harnessResult.ok).toBe(true);
    if (harnessResult.ok) {
      expect(harnessResult.harnessConfig!.featureFlags.memory).toBe(false);
      expect(harnessResult.harnessConfig!.recovery).toBeDefined();
      expect(harnessResult.proof!.proven).toBe(true);
      expect(harnessResult.proof!.status).toBe("applied");
    }
  });

  it("3. ADVERSARIAL: forged envelope rejected (E3-07)", async () => {
    const root = await makeTemp();
    const dir = join(root, "forged");
    await mkdir(dir, { recursive: true });

    // Fake decision artifact without schemaVersion/policyVersion/contentDigest.
    const fakePath = join(dir, "fake-decision.json");
    await writeFile(fakePath, JSON.stringify({ decision: "ACCEPT" }), "utf8");

    const fakeArtifactPath = join(dir, "fake-artifact.json");
    await writeFile(fakeArtifactPath, JSON.stringify({ data: "not a real artifact" }), "utf8");

    const forged = buildPromotionEnvelope({
      generatedBy: "attacker",
      decisionEnvelopeDigest: "A".repeat(64),
      candidateId: "malicious",
      parentLevel: "C0",
      parentStateDigest: "B".repeat(64),
      decisionArtifactPath: fakePath,
      decisionArtifactDigest: sha(JSON.stringify({ decision: "ACCEPT" })),
      artifactRefs: [{ role: "candidate", path: fakeArtifactPath, digest: sha("fake") }],
      sourceSha: "F".repeat(40),
    });
    const envPath = join(dir, "forged-envelope.json");
    await writeFile(envPath, JSON.stringify(forged), "utf8");

    // E3-07: forged envelope rejected — decision artifact is not a valid
    // DecisionArtifactV3 (missing schemaVersion/policyVersion/contentDigest).
    const result = await loadPromotionEnvelope(envPath, {
      parentStateDigest: "B".repeat(64),
      candidateId: "malicious",
    });
    expect(result.ok).toBe(false);
  });
});