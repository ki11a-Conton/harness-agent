/**
 * E4-R38 (J03) — execution-plan CAPACITY boundary, accepted through the REAL
 * evaluator and the REAL promotion loader.
 *
 * R33 fixed the parser (spread-free copy, O(1) membership, capacity guard before
 * any per-case work) and added an evaluator negative. What it did NOT have was a
 * VALID POSITIVE: R33-f's manifest recorded `planDigest: "0".repeat(64)` (a
 * placeholder) and its "positive control" only asserted the ABSENCE of one
 * issue — it never proved that a fully-bound plan reaches ACCEPT, nor that the
 * promotion loader accepts it. A test that cannot fail for the reason it claims
 * to test is not evidence.
 *
 * This suite closes that gap:
 *
 *   1. a COMPLETE, cross-bound baseline pair (real `computeExecutionPlanDigest`
 *      digest, real identity/provenance binding, real sample grid, real
 *      activation + security evidence, real pre-registered policy) reaches a
 *      real `ACCEPT` and a real `loader.ok === true`;
 *   2. the negative is DERIVED from that same valid pair by changing ONLY the
 *      capacity factor (`repeat`), with the digest re-derived from the modified
 *      plan — so the refusal cannot come from a placeholder digest, a wrong
 *      candidate, or the grid not being materialised;
 *   3. both boundaries (evaluator AND promotion loader) report the CALIBRATED
 *      capacity condition, and the evaluator reports NOTHING else — the gate
 *      fires before the 1,000,005-sample grid is ever expanded.
 *
 * Offline and hermetic: scripted/in-memory artifacts only, no provider call, no
 * real champion promotion, no paid benchmark.
 */

import { describe, it, expect, afterEach } from "vitest";
import { mkdtemp, mkdir, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";

import { buildExperimentArtifactV3 } from "./artifact-v3/index.js";
import type { ExperimentArtifactV3, CaseOutcomeV3, SecurityOutcomeV3 } from "./artifact-v3/types.js";
import { runV3ChampionEval } from "./champion-eval-v3.js";
import { buildPromotionEnvelope, loadPromotionEnvelope, type PromotionEnvelope } from "./promotion-envelope.js";
import { DEFAULT_DECISION_POLICY_V3, computeThresholdDigestV3 } from "./decision-policy-v3.js";
import { fixtureExecutionPlan, fixtureExecutionPlanDigest } from "./fixtures.js";
import {
  parseExecutionPlan,
  computeExecutionPlanDigest,
  expectedSampleKeysFromExecutionPlan,
  EXECUTION_PLAN_MAX_PLANNED_SAMPLES,
  type ExecutionPlanV1,
} from "./execution-plan.js";

const sha = (s: string): string => createHash("sha256").update(s, "utf8").digest("hex");
const GIT = "c".repeat(40);
const CAND = "b".repeat(64);
const TD = computeThresholdDigestV3(DEFAULT_DECISION_POLICY_V3);
const MODEL = "deepseek-v4-flash";
const CASES = ["ho-01", "ho-02", "ho-03"];
const REPS = [1, 2];
const GRID = REPS.flatMap((rep) => CASES.map((c) => `holdout\u0000${c}\u0000${rep}`));

/** The complete plan-construction arguments for a promotion-grade fixture. */
const PLAN_ARGS = { suite: "holdout", caseIds: CASES, repeat: 2, modelId: MODEL } as const;

const createdDirs: string[] = [];
async function tempDir(): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), "e4-r38-"));
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
 * One arm, built EXACTLY like the production writer: the plan is stored
 * verbatim and `manifest.planDigest` is the RECOMPUTED digest of that very plan
 * (never a placeholder). The overall outcome rows are the real 6 samples
 * (3 cases × 2 repetitions) — the negative below deliberately does NOT
 * materialise a 1,000,005-sample grid, which is the whole point of the gate.
 */
function armArtifact(armId: "baseline" | "candidate", plan: ExecutionPlanV1): ExperimentArtifactV3 {
  const rows: CaseOutcomeV3[] = [];
  let order = 1;
  for (const rep of REPS) for (const c of CASES) rows.push(outcome(c, armId, rep, order++, armId === "candidate"));
  const securityOutcomes: SecurityOutcomeV3[] = rows.map((o) => ({
    caseId: o.securityOutcomeRef as string, kind: "clean", detail: "no attack (fixture)",
  }));
  return buildExperimentArtifactV3({
    arm: { armId, candidateId: armId === "candidate" ? "cand-x" : null, candidateConfigHash: armId === "candidate" ? CAND : null },
    manifest: {
      suiteVersion: "2.1.0", judgeVersion: "1.0.0", gitSha: GIT, dirty: false,
      planDigest: computeExecutionPlanDigest(plan),   // REAL digest of the REAL plan
      promotionEligible: true, isolationStrength: plan.isolationStrength,
      runtimeConfigHash: CAND, expectedSampleKeys: GRID, runComplete: true,
      executionPlan: plan, thresholdDigest: TD,
    },
    outcomes: rows,
    activationEvidence: armId === "candidate"
      ? rows.map((o) => ({ id: o.activationRef as string, reasonCodes: ["memory.retrieved"], note: "activated" }))
      : [],
    securityOutcomes,
    provenance: { sourceManifestPath: null, gitSha: GIT, dirty: false, model: MODEL, provider: "fake", runtimeConfigHash: CAND },
  });
}

/** Drive BOTH real production entry points over one plan. */
async function driveRealChain(dir: string, plan: ExecutionPlanV1): Promise<{
  decision: string;
  violations: string[];
  loader: Awaited<ReturnType<typeof loadPromotionEnvelope>>;
}> {
  const baselinePath = join(dir, "baseline.json");
  const candidatePath = join(dir, "candidate.json");
  await writeFile(baselinePath, JSON.stringify(armArtifact("baseline", plan), null, 2), "utf8");
  await writeFile(candidatePath, JSON.stringify(armArtifact("candidate", plan), null, 2), "utf8");

  const evalResult = await runV3ChampionEval({ baselinePath, candidatePath, candidateId: "cand-x" });
  const decisionArtifactPath = join(dir, "decision-artifact.json");
  const decisionText = JSON.stringify(evalResult.decisionArtifact);
  await writeFile(decisionArtifactPath, decisionText, "utf8");

  const env: PromotionEnvelope = buildPromotionEnvelope({
    generatedBy: "e4-r38",
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
    parentStateDigest: sha("c0-state"), candidateId: "cand-x", bundleRoot: dir,
  });
  const violations = (evalResult.derivedInputs as unknown as { pairingViolations?: string[] }).pairingViolations ?? [];
  return { decision: evalResult.envelope.decision, violations, loader };
}

describe("E4-R38 (J03) execution-plan capacity boundary through the REAL chain", () => {
  it("R38-a (valid positive): a complete, cross-bound baseline pair reaches a real ACCEPT and a real loader.ok=true", async () => {
    const dir = await tempDir();
    const plan = fixtureExecutionPlan(PLAN_ARGS);
    // The digest protocol is unchanged: the fixture digest IS the recomputed one.
    expect(computeExecutionPlanDigest(plan)).toBe(fixtureExecutionPlanDigest(PLAN_ARGS));
    expect(plan.promotionEligible).toBe(true);
    expect(plan.isolationStrength).toBe("strong");
    expect(plan.sourceSha).toBe(GIT);
    expect(plan.treeFingerprint).toBeNull();

    const { decision, violations, loader } = await driveRealChain(dir, plan);
    // Direct evidence of validity — NOT merely "some error is absent".
    expect(violations).toEqual([]);
    expect(decision).toBe("ACCEPT");
    expect(loader.ok).toBe(true);
    expect(loader.issues).toEqual([]);
  }, 30_000);

  it("R38-b (derived negative): the SAME valid pair with only `repeat` over the cap is refused by the EVALUATOR for the capacity reason alone", async () => {
    const dir = await tempDir();
    const plan = fixtureExecutionPlan(PLAN_ARGS);
    const overCapPlan: ExecutionPlanV1 = { ...plan, repeat: EXECUTION_PLAN_MAX_PLANNED_SAMPLES + 5 };
    const expectedProduct = (EXECUTION_PLAN_MAX_PLANNED_SAMPLES + 5) * plan.caseIds.length;

    // The modified plan is honestly re-digested (its digest differs from the
    // valid one — so nothing here can be refused by a stale/placeholder digest).
    expect(computeExecutionPlanDigest(overCapPlan)).not.toBe(computeExecutionPlanDigest(plan));

    const { decision, violations, loader } = await driveRealChain(dir, overCapPlan);
    expect(decision).toBe("INVALID");
    // The CALIBRATED capacity condition, with the real numbers.
    const cap = violations.filter((v) => v.includes("planned-sample cap"));
    expect(cap.length).toBe(1);
    expect(cap[0]).toContain(`repeat(${EXECUTION_PLAN_MAX_PLANNED_SAMPLES + 5})`);
    expect(cap[0]).toContain(`caseCount(${plan.caseIds.length})`);
    expect(cap[0]).toContain(String(expectedProduct));
    expect(cap[0]).toContain("refuse before expansion");
    // No runtime failure leaked, and NOTHING unrelated fired: the capacity gate
    // returned before the per-case traversal, so the (unmaterialised) grid was
    // never compared, and the digest/candidate/eligibility bindings — which are
    // all still valid — report nothing.
    expect(violations.some((v) => /RangeError|Maximum call stack/i.test(v))).toBe(false);
    expect(violations.some((v) => v.includes("planDigest"))).toBe(false);
    expect(violations.some((v) => v.includes("expectedSampleKeys"))).toBe(false);
    expect(violations.some((v) => v.includes("ELIGIBILITY_"))).toBe(false);
    expect(violations.some((v) => v.includes("candidateId") || v.includes("executionPlan.candidate"))).toBe(false);
    expect(violations).toHaveLength(1); // the capacity issue is the ONLY reason

    // …and the PROMOTION LOADER refuses the same artifact for the same reason.
    expect(loader.ok).toBe(false);
    const loaderText = loader.issues.map((i) => `${i.code}: ${i.detail}`).join("\n");
    expect(loaderText).toContain("planned-sample cap");
    expect(loaderText).toContain(String(expectedProduct));
    expect(loaderText).not.toContain("CROSS_BINDING_MISMATCH");
    expect(loaderText).not.toContain("ELIGIBILITY_");
    // Exactly TWO loader issues, and both are explained by the one capacity
    // refusal: (1) the candidate's plan fails the confirmed-plan protocol for
    // the cap, and (2) the decision artifact is therefore not ACCEPT. No third,
    // unrelated reason exists.
    expect(loader.issues.map((i) => i.code)).toEqual(["CANDIDATE_NOT_ELIGIBLE", "DECISION_ARTIFACT_INVALID"]);
    const planIssue = loader.issues[0]!;
    expect(planIssue.detail).toContain("fails the confirmed-plan protocol");
    expect(planIssue.detail).toContain("planned-sample cap");
    expect(loader.issues[1]!.detail).toContain('decision="INVALID" is not ACCEPT');
  }, 30_000);

  it("R38-c: the parser still accepts a 130,000-case `limit=null` plan and the small-plan digest protocol is unchanged", () => {
    const small = fixtureExecutionPlan(PLAN_ARGS);
    expect(computeExecutionPlanDigest(small)).toBe(fixtureExecutionPlanDigest(PLAN_ARGS));
    expect(expectedSampleKeysFromExecutionPlan(small)).toHaveLength(6);

    const ids = Array.from({ length: 130_000 }, (_, i) => `case-${i}`);
    const fps: Record<string, string> = {};
    for (const id of ids) fps[id] = "a".repeat(64);
    const big = { ...small, caseIds: ids, caseFingerprints: fps, limit: null, repeat: 1 };
    const parsed = parseExecutionPlan(big);
    expect(parsed.issues).toEqual([]);
    expect(parsed.plan).not.toBeNull();
    expect(expectedSampleKeysFromExecutionPlan(parsed.plan!)).toHaveLength(130_000);
  }, 30_000);
});
