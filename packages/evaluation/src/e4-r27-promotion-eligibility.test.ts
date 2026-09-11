/**
 * E4-R27 (G01) — promotion ISOLATION ELIGIBILITY semantics.
 *
 * The confirmed execution plan's fields can be INTERNALLY CONSISTENT and still
 * describe something the protocol forbids: a plan and manifest that BOTH say
 * `isolationStrength="insecure-local"` and BOTH say `promotionEligible=true`
 * agree with each other, so every pre-existing cross-binding check passed and
 * the evaluator returned ACCEPT while the promotion loader returned ok=true.
 * Field consistency is a NECESSARY condition, never a SUFFICIENT one.
 *
 * This suite drives the REAL production entry points — `runV3ChampionEval`
 * (evaluator) and `loadPromotionEnvelope` (promotion loader) — plus the writer
 * (`buildV3ArtifactsFromPaired`) and the shared semantic validator, and proves:
 *
 *   - a strong + clean + complete + candidated pair still ACCEPTs and loads;
 *   - `insecure-local` and `none` can NEVER promote, even when both the plan and
 *     the manifest agree on the posture and every digest is recomputed;
 *   - a dirty-source plan (non-null CLI tree fingerprint) cannot promote;
 *   - a plan that OMITS an eligibility fact cannot bypass the contract;
 *   - the existing rejections (partial run, wrong grid, wrong policy,
 *     candidateless) still hold.
 *
 * All offline; no provider call, no paid benchmark. The isolation here is a
 * FIXTURE STAND-IN for an OS sandbox: it proves the WIRING of the eligibility
 * contract, never that a real OS containment was exercised.
 */

import { describe, it, expect, afterEach } from "vitest";
import { mkdtemp, mkdir, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";

import { buildExperimentArtifactV3 } from "./artifact-v3/index.js";
import type { ExperimentArtifactV3, CaseOutcomeV3, SecurityOutcomeV3 } from "./artifact-v3/types.js";
import { runV3ChampionEval } from "./champion-eval-v3.js";
import {
  buildPromotionEnvelope,
  loadPromotionEnvelope,
  type PromotionEnvelope,
} from "./promotion-envelope.js";
import { DEFAULT_DECISION_POLICY_V3, computeThresholdDigestV3 } from "./decision-policy-v3.js";
import { fixtureExecutionPlan, fixtureExecutionPlanDigest } from "./fixtures.js";
import {
  validatePromotionEligibility,
  computeExecutionPlanDigest,
  type ExecutionPlanV1,
} from "./execution-plan.js";
import { buildV3ArtifactsFromPaired, type PairedV3Facts } from "./paired-v3-builder.js";
import type { PairedFinalizedPair } from "./paired-executor.js";

const sha = (s: string): string => createHash("sha256").update(s, "utf8").digest("hex");
const GIT = "c".repeat(40);
const CAND = "b".repeat(64);
const TD = computeThresholdDigestV3(DEFAULT_DECISION_POLICY_V3);
const CASES = ["ho-01", "ho-02", "ho-03"];
const REPS = [1, 2];
const GRID = REPS.flatMap((rep) => CASES.map((c) => `holdout\u0000${c}\u0000${rep}`));

const PLAN_ARGS = { suite: "holdout", caseIds: CASES, repeat: 2, modelId: "deepseek-v4-flash" };

const createdDirs: string[] = [];
async function tempDir(): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), "e4-r27-"));
  createdDirs.push(d);
  await mkdir(d, { recursive: true });
  return d;
}
afterEach(async () => {
  await Promise.all(createdDirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

function outcome(caseId: string, armId: "baseline" | "candidate", rep: number, order: number, passed: boolean): CaseOutcomeV3 {
  return {
    caseId, suite: "holdout", armId, attempt: 1, repetition: rep, order,
    passed, grade: passed ? "good" : "poor", verificationPassed: passed,
    terminationReason: "verified_complete", failureCategory: null,
    inputTokens: 1000, outputTokens: 500, costUsd: 0.01, latencyMs: 100, toolCalls: 3,
    recoveryDecisions: [],
    activationRef: armId === "candidate" ? `act-${rep}-${caseId}` : null,
    securityOutcomeRef: `holdout\u0000${caseId}\u0000${rep}\u0000${armId}`,
    outputDigest: null, workspaceDigest: null, judgeVersion: "1.0.0",
    evaluationContextHash: "a".repeat(64),
    candidateConfigHash: armId === "candidate" ? CAND : null,
  } as unknown as CaseOutcomeV3;
}

/**
 * Build ONE arm of the pair.
 *
 * `plan` is written VERBATIM into the manifest and its recomputed digest is
 * recorded as manifest.planDigest, exactly like the production writer — so the
 * only thing a negative case changes is the single fact under test, and the
 * fixture never fails early for an unrelated missing field.
 */
function armArtifact(
  armId: "baseline" | "candidate",
  plan: ExecutionPlanV1 | undefined,
  manifestExtra: Record<string, unknown> = {},
): ExperimentArtifactV3 {
  const rows: CaseOutcomeV3[] = [];
  let order = 1;
  for (const rep of REPS) {
    for (const c of CASES) rows.push(outcome(c, armId, rep, order++, armId === "candidate"));
  }
  const securityOutcomes: SecurityOutcomeV3[] = rows.map((o) => ({
    caseId: o.securityOutcomeRef as string,
    kind: "clean",
    detail: "no attack (fixture)",
  }));
  const planIsolation = plan === undefined ? "strong" : plan.isolationStrength;
  return buildExperimentArtifactV3({
    arm: { armId, candidateId: armId === "candidate" ? "cand-x" : null, candidateConfigHash: armId === "candidate" ? CAND : null },
    manifest: {
      suiteVersion: "2.1.0", judgeVersion: "1.0.0", gitSha: GIT, dirty: false,
      planDigest: plan === undefined ? "0".repeat(64) : computeExecutionPlanDigest(plan),
      promotionEligible: true, isolationStrength: planIsolation, runtimeConfigHash: CAND,
      expectedSampleKeys: GRID, runComplete: true,
      ...(plan !== undefined ? { executionPlan: plan } : {}),
      thresholdDigest: TD,
      ...manifestExtra,
    },
    outcomes: rows,
    activationEvidence: armId === "candidate"
      ? rows.map((o) => ({ id: o.activationRef as string, reasonCodes: ["memory.retrieved"], note: "activated" }))
      : [],
    securityOutcomes,
    provenance: { sourceManifestPath: null, gitSha: GIT, dirty: false, model: "deepseek-v4-flash", provider: "fake", runtimeConfigHash: CAND },
  });
}

/** Write a real pair + decision artifact + envelope (production entry points). */
async function buildBundle(
  dir: string,
  planOpts: Parameters<typeof fixtureExecutionPlan>[0] = PLAN_ARGS,
  manifestExtra: { baseline?: Record<string, unknown>; candidate?: Record<string, unknown> } = {},
): Promise<{ envPath: string; evalDecision: string; loader: Awaited<ReturnType<typeof loadPromotionEnvelope>> }> {
  const plan = fixtureExecutionPlan(planOpts);
  const baselinePath = join(dir, "baseline.json");
  const candidatePath = join(dir, "candidate.json");
  await writeFile(baselinePath, JSON.stringify(armArtifact("baseline", plan, manifestExtra.baseline), null, 2), "utf8");
  await writeFile(candidatePath, JSON.stringify(armArtifact("candidate", plan, manifestExtra.candidate), null, 2), "utf8");

  const evalResult = await runV3ChampionEval({ baselinePath, candidatePath, candidateId: "cand-x" });
  const decisionArtifactPath = join(dir, "decision-artifact.json");
  const decisionText = JSON.stringify(evalResult.decisionArtifact);
  await writeFile(decisionArtifactPath, decisionText, "utf8");

  const env: PromotionEnvelope = buildPromotionEnvelope({
    generatedBy: "e4-r27",
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

  const loader = await loadPromotionEnvelope(envPath, {
    parentStateDigest: sha("c0-state"),
    candidateId: "cand-x",
    bundleRoot: dir,
  });
  return { envPath, evalDecision: evalResult.envelope.decision, loader };
}

// ---------------------------------------------------------------------------

describe("E4-R27 (G01) promotion isolation eligibility", () => {
  it("POSITIVE: strong + clean + complete + candidated pair still ACCEPTs and promotes", async () => {
    const dir = await tempDir();
    const { evalDecision, loader } = await buildBundle(dir);
    expect(evalDecision).toBe("ACCEPT");
    expect(loader.ok).toBe(true);
    expect(loader.issues).toEqual([]);
  });

  it("G01 REPRO: insecure-local agreed by BOTH plan and manifest is INVALID and cannot promote", async () => {
    const dir = await tempDir();
    const { evalDecision, loader } = await buildBundle(dir, { ...PLAN_ARGS, isolationStrength: "insecure-local" });
    // The evaluator must NOT accept a self-contradicting promotion claim...
    expect(evalDecision).toBe("INVALID");
    // ...and the loader must refuse it with the eligibility code, not silently.
    expect(loader.ok).toBe(false);
    expect(loader.issues.some((i) => i.code === "CANDIDATE_NOT_ELIGIBLE" && i.detail.includes("ELIGIBILITY_ISOLATION_NOT_STRONG"))).toBe(true);
  });

  it("G01: isolationStrength=\"none\" is equally refused by evaluator and loader", async () => {
    const dir = await tempDir();
    const { evalDecision, loader } = await buildBundle(dir, { ...PLAN_ARGS, isolationStrength: "none" });
    expect(evalDecision).toBe("INVALID");
    expect(loader.ok).toBe(false);
    expect(loader.issues.some((i) => i.detail.includes("ELIGIBILITY_ISOLATION_NOT_STRONG"))).toBe(true);
  });

  it("an UNKNOWN isolation backend cannot back a strong promotion claim", async () => {
    const dir = await tempDir();
    const { evalDecision, loader } = await buildBundle(dir, { ...PLAN_ARGS, isolationBackendId: "not-probed" });
    expect(evalDecision).toBe("INVALID");
    expect(loader.ok).toBe(false);
    expect(loader.issues.some((i) => i.detail.includes("ELIGIBILITY_ISOLATION_BACKEND_UNKNOWN"))).toBe(true);
  });

  it("a plan confirmed on a DIRTY tree cannot promote (CLI tree fingerprint is set)", async () => {
    const dir = await tempDir();
    const { evalDecision, loader } = await buildBundle(dir, { ...PLAN_ARGS, treeFingerprint: "d".repeat(64) });
    expect(evalDecision).toBe("INVALID");
    expect(loader.ok).toBe(false);
    expect(loader.issues.some((i) => i.detail.includes("ELIGIBILITY_SOURCE_TREE_DIRTY"))).toBe(true);
  });

  it("an UNKNOWN source sha cannot promote", async () => {
    const dir = await tempDir();
    const { evalDecision, loader } = await buildBundle(dir, { ...PLAN_ARGS, sourceSha: null });
    // The evaluator reports the eligibility violation, so the decision cannot be
    // ACCEPT (a plan whose source is unknown has no reproducibility authority).
    expect(evalDecision).toBe("INVALID");
    expect(loader.ok).toBe(false);
    expect(loader.issues.some((i) => i.detail.includes("ELIGIBILITY_SOURCE_SHA_MISSING"))).toBe(true);
  });

  it("a CANDIDATELESS plan cannot promote (nothing to promote)", async () => {
    const dir = await tempDir();
    const { evalDecision, loader } = await buildBundle(dir, { ...PLAN_ARGS, candidate: null });
    expect(evalDecision).toBe("INVALID");
    expect(loader.ok).toBe(false);
    expect(loader.issues.some((i) => i.detail.includes("ELIGIBILITY_CANDIDATE_MISSING"))).toBe(true);
  });

  it("a MISSING required fact cannot be bypassed by omitting the field", async () => {
    // Omit executionPlan entirely from BOTH arms: the promotion claim has no
    // authority at all. This is the "missing fact" bypass attempt.
    const dir = await tempDir();
    const plan = fixtureExecutionPlan(PLAN_ARGS);
    const baselinePath = join(dir, "baseline.json");
    const candidatePath = join(dir, "candidate.json");
    await writeFile(baselinePath, JSON.stringify(armArtifact("baseline", plan), null, 2), "utf8");
    await writeFile(candidatePath, JSON.stringify(armArtifact("candidate", undefined), null, 2), "utf8");
    const evalResult = await runV3ChampionEval({ baselinePath, candidatePath, candidateId: "cand-x" });
    expect(evalResult.envelope.decision).toBe("INVALID");
  });

  // --- Existing rejections must still hold (no regression from R27) ---------

  it("REGRESSION: a PARTIAL run (runComplete=false) still cannot promote", async () => {
    const dir = await tempDir();
    const { evalDecision, loader } = await buildBundle(dir, PLAN_ARGS, {
      candidate: { runComplete: false },
    });
    expect(evalDecision).toBe("INVALID");
    expect(loader.ok).toBe(false);
  });

  it("REGRESSION: a WRONG grid (unplanned sample) still cannot promote", async () => {
    const dir = await tempDir();
    const { evalDecision, loader } = await buildBundle(dir, PLAN_ARGS, {
      candidate: { expectedSampleKeys: [...GRID, "holdout\u0000ho-99\u00001"] },
    });
    expect(evalDecision).toBe("INVALID");
    expect(loader.ok).toBe(false);
  });

  it("REGRESSION: a wrong manifest isolationStrength (disagreeing with the plan) still cannot promote", async () => {
    const dir = await tempDir();
    const { evalDecision, loader } = await buildBundle(dir, PLAN_ARGS, {
      candidate: { isolationStrength: "insecure-local" },
    });
    expect(evalDecision).toBe("INVALID");
    expect(loader.ok).toBe(false);
  });

  // --- Shared validator unit contract ---------------------------------------

  it("validatePromotionEligibility: diagnostics (promotionEligible=false) are exempt", () => {
    const plan = { ...fixtureExecutionPlan({ ...PLAN_ARGS, isolationStrength: "insecure-local" }), promotionEligible: false };
    expect(validatePromotionEligibility(plan)).toEqual([]);
  });

  it("validatePromotionEligibility: a fully-qualified plan has no violations", () => {
    expect(validatePromotionEligibility(fixtureExecutionPlan(PLAN_ARGS))).toEqual([]);
  });

  it("validatePromotionEligibility: reports EVERY violation, not just the first", () => {
    const plan: ExecutionPlanV1 = {
      ...fixtureExecutionPlan(PLAN_ARGS),
      isolationStrength: "none",
      isolationBackendId: "unknown",
      sourceSha: null,
      treeFingerprint: "d".repeat(64),
      candidate: null,
    };
    const codes = validatePromotionEligibility(plan).map((v) => v.code).sort();
    expect(codes).toEqual([
      "ELIGIBILITY_CANDIDATE_MISSING",
      "ELIGIBILITY_ISOLATION_BACKEND_UNKNOWN",
      "ELIGIBILITY_ISOLATION_NOT_STRONG",
      "ELIGIBILITY_SOURCE_SHA_MISSING",
      "ELIGIBILITY_SOURCE_TREE_DIRTY",
    ]);
  });
});

// ---------------------------------------------------------------------------
// The WRITE boundary (buildV3ArtifactsFromPaired) applies the same contract,
// so a self-contradicting promotion-grade artifact is never written at all.
// ---------------------------------------------------------------------------

describe("E4-R27 write boundary: promotion-grade V3 is never written from a self-contradicting plan", () => {
  function facts(plan: ExecutionPlanV1, overrides: Partial<PairedV3Facts> = {}): PairedV3Facts {
    return {
      planDigest: computeExecutionPlanDigest(plan),
      gitSha: GIT, dirty: false, model: "deepseek-v4-flash", provider: "fake",
      runtimeConfigHash: CAND, suiteVersion: "2.1.0", judgeVersion: "1.0.0",
      candidateId: "cand-x", candidateConfigHash: CAND,
      isolationStrength: plan.isolationStrength, promotionEligible: true,
      executionPlan: plan, expectedSampleKeys: GRID, runComplete: true,
      ...overrides,
    };
  }
  const mkOutcome = (c: string, armId: "baseline" | "candidate", passed: boolean): unknown => ({
    caseId: c, suite: "holdout", armId,
    status: passed ? "passed" : "failed",
    grade: passed ? "good" : "poor",
    terminationReason: "verified_complete", failureCategory: null,
    events: [{ type: "verification.completed", payload: { passed } }],
    metrics: { tokens_input: 1000, tokens_output: 500, estimated_cost: 0.01, duration_ms: 100, tool_call_count: 3 },
    judgeVersion: "1.0.0", evaluationContextHash: "a".repeat(64),
    candidateConfigHash: armId === "candidate" ? CAND : null,
  });
  const pair = (c: string): PairedFinalizedPair => ({
    caseId: c, repetition: 0,
    baseline: { outcome: mkOutcome(c, "baseline", false) },
    candidate: { outcome: mkOutcome(c, "candidate", true) },
  } as unknown as PairedFinalizedPair);

  it("writes a strong+clean promotion-grade pair successfully (positive control)", () => {
    const plan = fixtureExecutionPlan({ suite: "holdout", caseIds: ["c1"], repeat: 1 });
    const { candidate } = buildV3ArtifactsFromPaired([pair("c1")], facts(plan, {
      expectedSampleKeys: ["holdout\u0000c1\u00001"],
    }));
    expect((candidate.manifest as Record<string, unknown>).promotionEligible).toBe(true);
  });

  it("REFUSES to write an insecure-local plan claiming promotionEligible=true", () => {
    const plan = fixtureExecutionPlan({ suite: "holdout", caseIds: ["c1"], repeat: 1, isolationStrength: "insecure-local" });
    expect(() => buildV3ArtifactsFromPaired([pair("c1")], facts(plan, {
      isolationStrength: "insecure-local",
      expectedSampleKeys: ["holdout\u0000c1\u00001"],
    }))).toThrow(/E4-R27: refusing to build promotion-grade V3[\s\S]*ELIGIBILITY_ISOLATION_NOT_STRONG/);
  });

  it("REFUSES to write a dirty-tree plan claiming promotionEligible=true", () => {
    const plan = fixtureExecutionPlan({ suite: "holdout", caseIds: ["c1"], repeat: 1, treeFingerprint: "d".repeat(64) });
    expect(() => buildV3ArtifactsFromPaired([pair("c1")], facts(plan, {
      expectedSampleKeys: ["holdout\u0000c1\u00001"],
    }))).toThrow(/ELIGIBILITY_SOURCE_TREE_DIRTY/);
  });

  it("STILL writes a DIAGNOSTIC (promotionEligible=false) artifact for any posture", () => {
    const plan = fixtureExecutionPlan({ suite: "holdout", caseIds: ["c1"], repeat: 1, isolationStrength: "insecure-local" });
    const { candidate } = buildV3ArtifactsFromPaired([pair("c1")], facts(plan, {
      isolationStrength: "insecure-local", promotionEligible: false,
      expectedSampleKeys: ["holdout\u0000c1\u00001"],
    }));
    expect((candidate.manifest as Record<string, unknown>).promotionEligible).toBe(false);
  });
});
