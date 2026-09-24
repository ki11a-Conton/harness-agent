/**
 * E4-R01 — the canonical V3 artifact must carry the confirmed experiment's
 * identity and its completeness, so a reader (and the promotion loader) can
 * tell WHICH experiment produced it and whether it was a complete run.
 *
 * F02 specifically: a partial/halted run must never be promotion-eligible even
 * if the subset it did finish happens to be perfectly paired.
 */

import { describe, expect, it } from "vitest";
import { buildV3ArtifactsFromPaired, type PairedV3Facts } from "./paired-v3-builder.js";
import { computeExecutionPlanDigest, DEFAULT_DECISION_POLICY_V3, computeThresholdDigestV3, type ExecutionPlanV1 } from "./index.js";
import type { PairedFinalizedPair } from "./paired-executor.js";
import type { EvalOutcome } from "./runner.js";

function outcome(caseId: string, armId: "baseline" | "candidate", rep: number, passed: boolean): EvalOutcome {
  return {
    caseId, suite: "holdout", status: passed ? "passed" : "failed", actualStatus: passed ? "completed" : "failed",
    events: [], violations: [], judgeVersion: "1.0.0", repetition: rep,
    metrics: {
      turn_count: 1, tool_call_count: 0, tokens_input: 10, tokens_output: 5, context_tokens: 0,
      compaction_count: 0, duration_ms: 1, retry_count: 0, verification_failures: 0, human_interventions: 0,
      estimated_cost: 0, usage_unknown: 0, cache_tokens_read: 0, cache_tokens_created: 0, model_call_count: 1,
    },
    evaluationContextHash: "a".repeat(64),
    candidateConfigHash: armId === "candidate" ? "b".repeat(64) : null,
  } as unknown as EvalOutcome;
}

function pair(caseId: string, rep: number, candPassed: boolean): PairedFinalizedPair {
  const mk = (armId: "baseline" | "candidate", passed: boolean) => ({
    arm: { armId, caseId, repetition: rep },
    valid: true,
    outcome: outcome(caseId, armId, rep, passed),
    modelCallAttempts: 1,
    transportRetries: 0,
  });
  return {
    pairId: `p-${caseId}`,
    caseId,
    repetition: rep,
    order: "AB",
    baseline: mk("baseline", true),
    candidate: mk("candidate", candPassed),
  } as unknown as PairedFinalizedPair;
}

/** E4-R22 (F02): promotion-grade builds require the FULL confirmed plan, whose
 *  digest is the recorded planDigest. One plan helper keeps the fixture's
 *  facts (suite/judge/provider/model/git) cross-bound. */
function fixturePlan(caseIds: string[]): ExecutionPlanV1 {
  return {
    schemaVersion: "e4-01",
    suite: "holdout",
    caseIds,
    caseFingerprints: Object.fromEntries(caseIds.map((c) => [c, "a".repeat(64)])),
    limit: 100,
    repeat: 1,
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
    isolationBackendId: "fixture-backend",
    isolationStrength: "strong",
    promotionEligible: true,
    providerId: "fake",
    modelId: "m",
    judgeVersion: "1.0.0",
    sourceSha: "d".repeat(40),
    // E4-R27: a promotion-grade plan is confirmed on a CLEAN tree — the CLI
    // encodes that as a NULL tree fingerprint (non-null = dirty tree).
    treeFingerprint: null,
    decisionPolicy: { ...DEFAULT_DECISION_POLICY_V3 },
    thresholdDigest: computeThresholdDigestV3(DEFAULT_DECISION_POLICY_V3),
    effectiveModelParams: { budgetTokens: 8192 },
  };
}

function baseFacts(caseIds: string[]): PairedV3Facts {
  const plan = fixturePlan(caseIds);
  return {
    planDigest: computeExecutionPlanDigest(plan),
    gitSha: "d".repeat(40),
    dirty: false,
    model: "m",
    provider: "fake",
    runtimeConfigHash: "e".repeat(64),
    suiteVersion: "2.1.0",
    judgeVersion: "1.0.0",
    candidateId: "cand-x",
    candidateConfigHash: "b".repeat(64),
    isolationStrength: "strong",
    promotionEligible: true,
    executionPlan: plan,
  };
}

const SAMPLE_KEYS = ["holdout\u0000c1\u00001", "holdout\u0000c2\u00001"];

describe("E4-R01 V3 carries experiment identity and completeness", () => {
  it("complete + strong run records identity, expected sample keys and completion", () => {
    const { candidate } = buildV3ArtifactsFromPaired([pair("c1", 1, true), pair("c2", 1, true)], {
      ...baseFacts(["c1", "c2"]),
      executionIdentityDigest: "f".repeat(64),
      scheduleDigest: "0".repeat(64),
      expectedSampleKeys: SAMPLE_KEYS,
      runComplete: true,
      incompleteReason: null,
    });
    const m = candidate.manifest as Record<string, unknown>;
    expect(m.executionIdentityDigest).toBe("f".repeat(64));
    expect(m.scheduleDigest).toBe("0".repeat(64));
    expect(m.planDigest).toBe(baseFacts(["c1", "c2"]).planDigest);
    expect(m.runComplete).toBe(true);
    expect(m.expectedSampleKeys).toEqual(SAMPLE_KEYS);
    expect(m.promotionEligible).toBe(true);
    // The two identities are distinct fields — never one digest standing in for both.
    expect(m.executionIdentityDigest).not.toBe(m.scheduleDigest);
  });

  it("F02: a PARTIAL run is recorded not promotion-eligible even though the finished subset pairs exactly", () => {
    // Both delivered pairs are perfectly matched, but the run was cut short.
    const { candidate } = buildV3ArtifactsFromPaired([pair("c1", 1, true)], {
      ...baseFacts(["c1", "c2"]),
      isolationStrength: "strong",
      promotionEligible: false, // CLI: strong AND complete required (F02)
      executionIdentityDigest: "f".repeat(64),
      expectedSampleKeys: SAMPLE_KEYS, // two expected, only one delivered
      runComplete: false,
      incompleteReason: "budget-halted",
    });
    const m = candidate.manifest as Record<string, unknown>;
    expect(m.promotionEligible).toBe(false);
    expect(m.runComplete).toBe(false);
    expect(m.incompleteReason).toBe("budget-halted");
    // Fewer delivered samples than the confirmed grid expects is detectable.
    expect((m.expectedSampleKeys as string[]).length).toBe(2);
    expect(candidate.outcomes.length).toBe(1);
  });

  it("omitting the new optional facts stays valid (backward compatible)", () => {
    const { candidate } = buildV3ArtifactsFromPaired([pair("c1", 1, true)], baseFacts(["c1"]));
    const m = candidate.manifest as Record<string, unknown>;
    expect("executionIdentityDigest" in m).toBe(false);
    expect("runComplete" in m).toBe(false);
  });
});

describe("E4-R22 (F02) write boundary: promotion-grade V3 is refused without a bound plan", () => {
  it("promotionEligible=true with NO execution plan throws (never written)", () => {
    const facts = { ...baseFacts(["c1", "c2"]) } as Partial<PairedV3Facts>;
    delete facts["executionPlan"];
    expect(() => buildV3ArtifactsFromPaired([pair("c1", 1, true), pair("c2", 1, true)], facts as PairedV3Facts)).toThrow(
      /confirmed execution plan is required/,
    );
  });

  it("an executionPlan that fails the protocol (empty {}) throws", () => {
    const facts = { ...baseFacts(["c1", "c2"]), executionPlan: {} as never };
    expect(() => buildV3ArtifactsFromPaired([pair("c1", 1, true), pair("c2", 1, true)], facts)).toThrow(
      /fails the confirmed-plan protocol/,
    );
  });

  it("a planDigest that does not match the plan CONTENT throws (digest recompute at the writer)", () => {
    // The plan was altered after confirmation (seed tampered) while the
    // recorded planDigest stayed the ORIGINAL plan's digest.
    const original = fixturePlan(["c1", "c2"]);
    const tampered = { ...original, seed: 999 };
    const facts = { ...baseFacts(["c1", "c2"]), executionPlan: tampered, planDigest: computeExecutionPlanDigest(original) };
    expect(() => buildV3ArtifactsFromPaired([pair("c1", 1, true), pair("c2", 1, true)], facts)).toThrow(
      /planDigest .* != recomputed execution plan digest/,
    );
  });

  it("expectedSampleKeys disagreeing with the plan-derived grid throws (the plan derives the grid)", () => {
    // The plan covers c1+c2 but the facts claim a NARROWER grid — the manifest
    // grid is corroboration, never the authority.
    const facts = { ...baseFacts(["c1", "c2"]), expectedSampleKeys: ["holdout\u0000c1\u00001"] };
    expect(() => buildV3ArtifactsFromPaired([pair("c1", 1, true)], facts)).toThrow(
      /expectedSampleKeys does not equal the grid derived from the confirmed plan/,
    );
  });
});
