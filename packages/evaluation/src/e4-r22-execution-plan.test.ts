/**
 * E4-R22 (F02) — executionPlan must be a COMPLETE, digest-bound, cross-bound
 * protocol object, not "any non-null object".
 *
 * Pre-fix repro (plan 20260911-013142 §2 F02): a promotion-eligible pair whose
 * candidate manifest carries `executionPlan: {}` (everything else genuine:
 * three cases × two repetitions, full security refs, activation refs,
 * runComplete=true, correct expected sample keys, digests recomputed by the
 * real writer) still produced:
 *
 * ```json
 * {"id":"EMPTY_EXECUTION_PLAN","decision":"ACCEPT","promotion":{"accepted":true}}
 * ```
 *
 * Both the real evaluator (runV3ChampionEval → deriveV3Decision) and the real
 * promotion loader (loadPromotionEnvelope) only checked
 * `typeof plan === "object" && plan !== null && !Array.isArray(plan)`.
 * Every fixture here is offline: no provider, no network, no paid calls.
 */
import { describe, expect, it } from "vitest";
import { mkdtemp, mkdir, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import {
  buildExperimentArtifactV3,
  writeExperimentArtifactV3,
  computeContentDigestV3,
  runV3ChampionEval,
  buildPromotionEnvelope,
  loadPromotionEnvelope,
  DEFAULT_DECISION_POLICY_V3,
  computeThresholdDigestV3,
  stableStringify,
} from "@ar/evaluation";
import type { CaseOutcomeV3, SecurityOutcomeV3, ExperimentArtifactV3 } from "@ar/evaluation";

const sha = (s: string): string => createHash("sha256").update(s, "utf8").digest("hex");
const GIT = "c".repeat(40);
const CAND = "b".repeat(64);
const TD = computeThresholdDigestV3(DEFAULT_DECISION_POLICY_V3);
/** The plan digest protocol: sha256 over the canonical stable serialization
 *  (the same serializer the CLI's computeBenchmarkPlanDigest uses). */
const planDigestOf = (plan: object): string => sha(stableStringify(plan));

const CASES = ["ho-01", "ho-02", "ho-03"];
const REPS = [1, 2];
const GRID = CASES.flatMap((c) => REPS.map((r) => `holdout\u0000${c}\u0000${r}`));

/** A COMPLETE e4-01 execution plan matching the fixture's manifest/provenance
 *  facts (suite holdout, judge 1.0.0, provider fake / model m, git GIT). */
function fullPlan(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: "e4-01",
    suite: "holdout",
    caseIds: [...CASES],
    caseFingerprints: Object.fromEntries(CASES.map((c) => [c, sha(c)])),
    limit: 100,
    repeat: 2,
    interleave: true,
    shuffle: false,
    seed: 7,
    candidate: "cand-x",
    billingClass: "offline",
    maxLogicalRuns: 100,
    maxModelCalls: 100,
    maxEstimatedTokens: 1_000_000,
    maxEstimatedCostUsd: 1,
    estimateStatus: "bounded",
    isolationBackendId: "fixture-strong",
    isolationStrength: "strong",
    promotionEligible: true,
    providerId: "fake",
    modelId: "m",
    judgeVersion: "1.0.0",
    sourceSha: GIT,
    // E4-R27: a promotion-grade plan is confirmed on a CLEAN tree (null = clean;
    // a non-null CLI fingerprint means the tree was dirty).
    treeFingerprint: null,
    decisionPolicy: { ...DEFAULT_DECISION_POLICY_V3 },
    thresholdDigest: TD,
    effectiveModelParams: { budgetTokens: 8192 },
    ...overrides,
  };
}

function outcome(caseId: string, armId: "baseline" | "candidate", rep: number, order: number, passed: boolean): CaseOutcomeV3 {
  return {
    caseId, suite: "holdout", armId, attempt: 1, repetition: rep, order,
    passed, grade: passed ? "good" : "poor", verificationPassed: passed,
    terminationReason: "verified_complete", failureCategory: null,
    inputTokens: 1000, outputTokens: 500, costUsd: 0.01, latencyMs: 100, toolCalls: 3,
    recoveryDecisions: [], activationRef: armId === "candidate" ? `act-${rep}-${caseId}` : null,
    securityOutcomeRef: `holdout\u0000${caseId}\u0000${rep}\u0000${armId}`,
    outputDigest: null, workspaceDigest: null, judgeVersion: "1.0.0",
    evaluationContextHash: "a".repeat(64), candidateConfigHash: armId === "candidate" ? CAND : null,
  } as unknown as CaseOutcomeV3;
}

/** Build one arm artifact; `plan` is written verbatim into the manifest and its
 *  digest recorded as manifest.planDigest (the production writer's contract). */
function armArtifact(
  armId: "baseline" | "candidate",
  plan: Record<string, unknown> | undefined,
): ExperimentArtifactV3 {
  const rows: CaseOutcomeV3[] = [];
  let order = 1;
  for (const rep of REPS) {
    for (const c of CASES) {
      rows.push(outcome(c, armId, rep, order++, armId === "candidate"));
    }
  }
  const securityOutcomes: SecurityOutcomeV3[] = rows.map((o) => ({
    caseId: o.securityOutcomeRef as string,
    kind: "clean",
    detail: "no attack (fixture)",
  }));
  return buildExperimentArtifactV3({
    arm: { armId, candidateId: armId === "candidate" ? "cand-x" : null, candidateConfigHash: armId === "candidate" ? CAND : null },
    manifest: {
      suiteVersion: "2.1.0", judgeVersion: "1.0.0", gitSha: GIT, dirty: false,
      planDigest: planDigestOf(plan ?? {}),
      promotionEligible: true, isolationStrength: "strong", runtimeConfigHash: CAND,
      expectedSampleKeys: GRID, runComplete: true,
      ...(plan !== undefined ? { executionPlan: plan } : {}),
      thresholdDigest: TD,
    },
    outcomes: rows,
    activationEvidence: armId === "candidate"
      ? rows.map((o) => ({ id: o.activationRef as string, reasonCodes: ["memory.retrieved"], note: "activated" }))
      : [],
    securityOutcomes,
    provenance: { sourceManifestPath: null, gitSha: GIT, dirty: false, model: "m", provider: "fake", runtimeConfigHash: CAND },
  });
}

/** Write a full promotion bundle (baseline + candidate + decision artifact +
 *  envelope) with the given candidate executionPlan, using the REAL writer /
 *  evaluator / envelope builder — never hand-forged booleans. */
async function buildBundle(dir: string, plan: Record<string, unknown> | undefined): Promise<string> {
  const baselinePath = join(dir, "baseline.json");
  const candidatePath = join(dir, "candidate.json");
  await writeExperimentArtifactV3(armArtifact("baseline", plan), baselinePath);
  await writeExperimentArtifactV3(armArtifact("candidate", plan), candidatePath);
  const evalResult = await runV3ChampionEval({ baselinePath, candidatePath, candidateId: "cand-x" });
  const decisionArtifactPath = join(dir, "decision-artifact.json");
  const decisionText = JSON.stringify(evalResult.decisionArtifact);
  await writeFile(decisionArtifactPath, decisionText, "utf8");
  const env = buildPromotionEnvelope({
    generatedBy: "e4-r22",
    decisionEnvelopeDigest: sha("stats"),
    candidateId: "cand-x",
    parentLevel: "C0",
    parentStateDigest: sha("c0-state"),
    decisionArtifactPath: "decision-artifact.json",
    decisionArtifactDigest: sha(decisionText),
    artifactRefs: [
      { role: "baseline", path: "baseline.json", digest: sha(await readFile(baselinePath, "utf8")) },
      { role: "candidate", path: "candidate.json", digest: sha(await readFile(candidatePath, "utf8")) },
    ],
    sourceSha: GIT,
  });
  const envPath = join(dir, "envelope.json");
  await writeFile(envPath, JSON.stringify(env), "utf8");
  return envPath;
}

async function tempDir(): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), "e4-r22-"));
  await mkdir(d, { recursive: true });
  return d;
}

describe("E4-R22 (F02) executionPlan strict protocol + cross-binding", () => {
  it("control: a COMPLETE confirmed plan → evaluator ACCEPT and promotion bundle loads OK", async () => {
    const dir = await tempDir();
    try {
      const envPath = await buildBundle(dir, fullPlan());
      const evalAgain = await runV3ChampionEval({
        baselinePath: join(dir, "baseline.json"),
        candidatePath: join(dir, "candidate.json"),
        candidateId: "cand-x",
      });
      expect(evalAgain.decisionArtifact.decision).toBe("ACCEPT");
      const result = await loadPromotionEnvelope(envPath, {
        parentStateDigest: sha("c0-state"),
        candidateId: "cand-x",
        bundleRoot: dir,
      });
      expect(result.ok).toBe(true);
      expect(result.issues).toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("EMPTY_EXECUTION_PLAN: executionPlan:{} must be INVALID and never promote (pre-fix repro: ACCEPT + accepted)", async () => {
    const dir = await tempDir();
    try {
      const envPath = await buildBundle(dir, {});
      const evalResult = await runV3ChampionEval({
        baselinePath: join(dir, "baseline.json"),
        candidatePath: join(dir, "candidate.json"),
        candidateId: "cand-x",
      });
      expect(evalResult.decisionArtifact.decision).toBe("INVALID");
      expect(
        (evalResult.derivedInputs as unknown as { pairingViolations?: string[] }).pairingViolations
          ?.some((v) => /executionPlan/i.test(v)),
      ).toBe(true);
      const result = await loadPromotionEnvelope(envPath, {
        parentStateDigest: sha("c0-state"),
        candidateId: "cand-x",
        bundleRoot: dir,
      });
      expect(result.ok).toBe(false);
      expect(result.issues.some((i) => i.code === "CANDIDATE_NOT_ELIGIBLE")).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("an ARRAY executionPlan and an UNKNOWN schemaVersion are both INVALID (never ACCEPT)", async () => {
    const dir = await tempDir();
    try {
      for (const [name, plan] of [
        ["array", [] as unknown as Record<string, unknown>],
        ["unknown-version", fullPlan({ schemaVersion: "e4-99" })],
      ] as const) {
        const envPath = await buildBundle(dir, plan);
        const evalResult = await runV3ChampionEval({
          baselinePath: join(dir, "baseline.json"),
          candidatePath: join(dir, "candidate.json"),
          candidateId: "cand-x",
        });
        expect(evalResult.decisionArtifact.decision, name).toBe("INVALID");
        const result = await loadPromotionEnvelope(envPath, {
          parentStateDigest: sha("c0-state"),
          candidateId: "cand-x",
          bundleRoot: dir,
        });
        expect(result.ok, name).toBe(false);
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("a plan field changed while keeping the OLD planDigest is rejected (digest recompute)", async () => {
    const dir = await tempDir();
    try {
      // The manifest records the digest of the ORIGINAL plan, but the plan's
      // content was changed afterwards (here: seed tampered).
      const original = fullPlan();
      const tampered = fullPlan({ seed: 999 });
      await buildBundle(dir, tampered);
      // Patch BOTH manifests' planDigest back to the ORIGINAL plan's digest
      // (the attacker keeps the recorded digest while changing the plan), and
      // refresh the artifact's own contentDigest so the tamper under test is
      // ONLY the planDigest↔plan-content mismatch (CONTENT_DIGEST_MISMATCH would
      // mask it earlier in the chain).
      for (const f of ["baseline.json", "candidate.json"]) {
        const p = join(dir, f);
        const parsed = JSON.parse(await readFile(p, "utf8")) as ExperimentArtifactV3;
        parsed.manifest.planDigest = planDigestOf(original);
        parsed.contentDigest = computeContentDigestV3(parsed);
        await writeExperimentArtifactV3(parsed, p);
      }
      // Refresh the envelope's artifact refs to the patched bytes so the ONLY
      // violation under test is the planDigest ↔ plan-content mismatch.
      const daText = await readFile(join(dir, "decision-artifact.json"), "utf8");
      const refreshed = buildPromotionEnvelope({
        generatedBy: "e4-r22",
        decisionEnvelopeDigest: sha("stats"),
        candidateId: "cand-x",
        parentLevel: "C0",
        parentStateDigest: sha("c0-state"),
        decisionArtifactPath: "decision-artifact.json",
        decisionArtifactDigest: sha(daText),
        artifactRefs: [
          { role: "baseline", path: "baseline.json", digest: sha(await readFile(join(dir, "baseline.json"), "utf8")) },
          { role: "candidate", path: "candidate.json", digest: sha(await readFile(join(dir, "candidate.json"), "utf8")) },
        ],
        sourceSha: GIT,
      });
      const envPath = join(dir, "envelope.json");
      await writeFile(envPath, JSON.stringify(refreshed), "utf8");
      const evalResult = await runV3ChampionEval({
        baselinePath: join(dir, "baseline.json"),
        candidatePath: join(dir, "candidate.json"),
        candidateId: "cand-x",
      });
      expect(evalResult.decisionArtifact.decision).toBe("INVALID");
      const result = await loadPromotionEnvelope(envPath, {
        parentStateDigest: sha("c0-state"),
        candidateId: "cand-x",
        bundleRoot: dir,
      });
      expect(result.ok).toBe(false);
      expect(result.issues.some((i) => /planDigest/i.test(`${i.code} ${i.detail}`))).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("the applied policy differing from the PLAN's policy is rejected even with the decision's own digest recomputed", async () => {
    const dir = await tempDir();
    try {
      // Plan pre-registers a DIFFERENT policy than the one the evaluator
      // applies (manifest.decisionPolicy absent → evaluator default ≠ plan).
      const plan = fullPlan({
        decisionPolicy: { ...DEFAULT_DECISION_POLICY_V3, minConclusiveNetDelta: 9 },
        thresholdDigest: sha(stableStringify({ ...DEFAULT_DECISION_POLICY_V3, minConclusiveNetDelta: 9 })),
      });
      const envPath = await buildBundle(dir, plan);
      const evalResult = await runV3ChampionEval({
        baselinePath: join(dir, "baseline.json"),
        candidatePath: join(dir, "candidate.json"),
        candidateId: "cand-x",
      });
      expect(evalResult.decisionArtifact.decision).toBe("INVALID");
      expect(
        (evalResult.derivedInputs as unknown as { pairingViolations?: string[] }).pairingViolations
          ?.some((v) => /policy/i.test(v)),
      ).toBe(true);
      const result = await loadPromotionEnvelope(envPath, {
        parentStateDigest: sha("c0-state"),
        candidateId: "cand-x",
        bundleRoot: dir,
      });
      expect(result.ok).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("candidate/model/judge/isolation/source cross-binding violations are rejected with stable reasons", async () => {
    const dir = await tempDir();
    try {
      const cases: Array<[string, Record<string, unknown>, RegExp]> = [
        ["judgeVersion", { judgeVersion: "9.9.9" }, /judge/i],
        ["modelId", { modelId: "other-model" }, /model/i],
        ["providerId", { providerId: "other-provider" }, /provider/i],
        ["isolationStrength", { isolationStrength: "none" }, /isolation/i],
        ["sourceSha", { sourceSha: "d".repeat(40) }, /source/i],
        ["candidate", { candidate: "impostor-candidate" }, /candidate/i],
      ];
      for (const [name, override, needle] of cases) {
        const envPath = await buildBundle(dir, fullPlan(override));
        const evalResult = await runV3ChampionEval({
          baselinePath: join(dir, "baseline.json"),
          candidatePath: join(dir, "candidate.json"),
          candidateId: "cand-x",
        });
        expect(evalResult.decisionArtifact.decision, name).toBe("INVALID");
        expect(
          (evalResult.derivedInputs as unknown as { pairingViolations?: string[] }).pairingViolations
            ?.some((v) => needle.test(v)),
          name,
        ).toBe(true);
        const result = await loadPromotionEnvelope(envPath, {
          parentStateDigest: sha("c0-state"),
          candidateId: "cand-x",
          bundleRoot: dir,
        });
        expect(result.ok, name).toBe(false);
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("expectedSampleKeys disagreeing with the plan-derived grid is rejected (the plan derives the grid)", async () => {
    const dir = await tempDir();
    try {
      // Both arms drop ONE case from outcomes AND from expectedSampleKeys, and
      // the manifest planDigest is recomputed for the narrowed plan — an
      // internally consistent-looking pair whose grid no longer matches the
      // plan's caseIds. (Single-factor change from the control.)
      const narrowedPlan = fullPlan({ caseIds: ["ho-01", "ho-02"] });
      const envPath = await buildBundle(dir, narrowedPlan);
      const evalResult = await runV3ChampionEval({
        baselinePath: join(dir, "baseline.json"),
        candidatePath: join(dir, "candidate.json"),
        candidateId: "cand-x",
      });
      // The outcomes still cover THREE cases but the plan only planned two →
      // unplanned samples / grid mismatch → INVALID.
      expect(evalResult.decisionArtifact.decision).toBe("INVALID");
      const result = await loadPromotionEnvelope(envPath, {
        parentStateDigest: sha("c0-state"),
        candidateId: "cand-x",
        bundleRoot: dir,
      });
      expect(result.ok).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
