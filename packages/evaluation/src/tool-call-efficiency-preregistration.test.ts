import { describe, expect, it } from "vitest";
import {
  buildToolCallEfficiencyPreregistration,
  computePreregistrationDigest,
  TOOL_CALL_EFFICIENCY_CANDIDATE_ID,
  TOOL_CALL_EFFICIENCY_PREREGISTRATION_SCHEMA_VERSION,
} from "./tool-call-efficiency-preregistration.js";
import { toolCallEfficiencyGuidanceDigest, budgetAwareCompletionGuidanceDigest } from "./mechanism-guidance.js";
import { evaluateMechanismContract, mechanismContractFor } from "./mechanism-contract.js";
import { getArmFactory } from "./arm-factory.js";
import { orderedArmRuns } from "./paired-executor.js";

/**
 * N5/P5 — the challenger `tool_call_efficiency_v1` must be PRE-REGISTERED as a
 * strict, budget-bounded paired experiment while spending nothing. Everything
 * here is offline and deterministic: no provider, no API key, no cost.
 *
 * The frozen case set is the R87 selection (8 non-holdout dev-set cases,
 * digest-bound before any candidate result was seen) — reused so the
 * pre-registration cannot be silently re-chosen after seeing results.
 */
const FROZEN_CASES = [
  "regression/reg-16-cicd-step",
  "stress/stress-many-artifacts",
  "stress/stress-very-long-json",
  "regression/reg-24-error-handling",
  "regression/reg-03-add-import",
  "regression/reg-14-stack",
  "regression/reg-17-gcd",
  "regression/reg-06-json-parse-test",
];

const BUDGET = { campaignModelCalls: 320, perCaseToolCalls: 100, perCaseDurationMs: 600_000 };

describe("P5 tool_call_efficiency_v1 — strict paired pre-registration (zero calls)", () => {
  it("pre-registers a STRICT paired plan: exactly 2 × repetitions × cases, balanced AB/BA", () => {
    const pre = buildToolCallEfficiencyPreregistration({
      eligibleCaseIds: FROZEN_CASES,
      repetitions: 1,
      orderSeed: 7,
      callsPerArmRun: 10,
      budget: BUDGET,
    });

    expect(pre.candidateId).toBe(TOOL_CALL_EFFICIENCY_CANDIDATE_ID);
    // Strict pair: 8 cases × 1 repetition × 2 arms = 16 logical runs.
    expect(pre.plan.totalLogicalRuns).toBe(16);
    expect(pre.strictness.logicalRuns).toBe(16);
    expect(pre.strictness.expectedLogicalRuns).toBe(16);
    expect(orderedArmRuns(pre.plan)).toHaveLength(16);
    // Even pair count (8) => AB and BA are exactly balanced.
    expect(pre.strictness.balanced).toBe(true);
    expect(pre.strictness.abCount).toBe(4);
    expect(pre.strictness.baCount).toBe(4);
  });

  it("spends nothing: constructs no provider and reports 0 calls", () => {
    const pre = buildToolCallEfficiencyPreregistration({
      eligibleCaseIds: FROZEN_CASES,
      repetitions: 1,
      callsPerArmRun: 10,
      budget: BUDGET,
    });
    expect(pre.providerCalls).toBe(0);
    // The dry run only ESTIMATES (16 logical runs × 10 calls), never executes.
    expect(pre.dryRun.estimatedProviderCalls).toBe(160);
    expect(pre.dryRun.paidAuthorizationRequired).toBe(true);
  });

  it("the unpaid preflight REFUSES before any call; the paid preflight allows exactly the estimate", () => {
    const pre = buildToolCallEfficiencyPreregistration({
      eligibleCaseIds: FROZEN_CASES,
      repetitions: 1,
      callsPerArmRun: 10,
      budget: BUDGET,
    });

    expect(pre.preflightUnpaid.ok).toBe(false);
    if (pre.preflightUnpaid.ok) throw new Error("unreachable");
    expect(pre.preflightUnpaid.providerCallsAllowed).toBe(false);
    expect(pre.preflightUnpaid.reason).toContain("RUN_PAID_BENCHMARKS=1");

    expect(pre.preflightPaid.ok).toBe(true);
    if (!pre.preflightPaid.ok) throw new Error("unreachable");
    expect(pre.preflightPaid.maxProviderCalls).toBe(160);
  });

  it("binds the EXACT strategy text digest so a P1/P2/P4 text change invalidates the pre-registration", () => {
    const pre = buildToolCallEfficiencyPreregistration({
      eligibleCaseIds: FROZEN_CASES,
      repetitions: 1,
      callsPerArmRun: 10,
      budget: BUDGET,
    });
    expect(pre.promptAdditionsDigest).toBe(toolCallEfficiencyGuidanceDigest());
    // Not the REJECTED budget-aware mechanism — the no-op guard still holds.
    expect(pre.promptAdditionsDigest).not.toBe(budgetAwareCompletionGuidanceDigest());
    expect(pre.preregistrationDigest).toMatch(/^[0-9a-f]{64}$/);
  });

  it("fails closed when the declared eligible set is below the contract minimum", () => {
    const contract = mechanismContractFor(TOOL_CALL_EFFICIENCY_CANDIDATE_ID);
    const short = FROZEN_CASES.slice(0, contract!.minEligibleCases - 1);
    expect(() =>
      buildToolCallEfficiencyPreregistration({
        eligibleCaseIds: short,
        repetitions: 1,
        callsPerArmRun: 10,
        budget: BUDGET,
      }),
    ).toThrow(/contract minimum/);
  });

  it("fails closed on an underfunded budget — a partial run is not a strict pair", () => {
    expect(() =>
      buildToolCallEfficiencyPreregistration({
        eligibleCaseIds: FROZEN_CASES,
        repetitions: 1,
        callsPerArmRun: 10,
        // 16 logical runs × 10 calls = 160; 159 cannot cover the schedule.
        budget: { ...BUDGET, campaignModelCalls: 159 },
      }),
    ).toThrow(/cannot cover the schedule/);
  });

  it("the pre-registration digest is deterministic and changes with the schedule and budget", () => {
    const base = {
      eligibleCaseIds: FROZEN_CASES,
      repetitions: 1,
      callsPerArmRun: 10,
      budget: BUDGET,
    } as const;
    const a = buildToolCallEfficiencyPreregistration(base);
    const b = buildToolCallEfficiencyPreregistration(base);
    expect(a.preregistrationDigest).toBe(b.preregistrationDigest);

    const differentOrder = buildToolCallEfficiencyPreregistration({ ...base, orderSeed: 99 });
    expect(differentOrder.preregistrationDigest).not.toBe(a.preregistrationDigest);

    const differentBudget = buildToolCallEfficiencyPreregistration({ ...base, budget: { ...BUDGET, campaignModelCalls: 321 } });
    expect(differentBudget.preregistrationDigest).not.toBe(a.preregistrationDigest);

    // The digest excludes the estimated-cost/report fields, so re-deriving it
    // from the identity fields reproduces the same value.
    const { preregistrationDigest, ...identity } = a;
    expect(computePreregistrationDigest(identity)).toBe(preregistrationDigest);
  });

  it("the challenger is causally READY per the REAL ArmFactory + contract (P1/P2 wiring intact)", () => {
    const factory = getArmFactory();
    expect(factory.resolveArm(null).runtimeMechanisms.toolCallEfficiency).toBe(false);
    expect(factory.resolveArm(TOOL_CALL_EFFICIENCY_CANDIDATE_ID).runtimeMechanisms.toolCallEfficiency).toBe(true);

    const evaluation = evaluateMechanismContract(
      TOOL_CALL_EFFICIENCY_CANDIDATE_ID,
      { eligible: new Map(FROZEN_CASES.map((id) => [id, true])) },
      {
        wired: { [TOOL_CALL_EFFICIENCY_CANDIDATE_ID]: true },
        requiredEvents: { [TOOL_CALL_EFFICIENCY_CANDIDATE_ID]: { "tool-call-efficiency-guidance-injected": true } },
      },
    );
    expect(evaluation.readiness).toBe("READY");
    expect(evaluation.baselineContamination).toBe(false);
    expect(evaluation.hasRealDelta).toBe(true);
    expect(evaluation.eligibleCases).toBe(FROZEN_CASES.length);
  });

  it("the schema version is stable and distinct from the paired-plan schema", () => {
    expect(TOOL_CALL_EFFICIENCY_PREREGISTRATION_SCHEMA_VERSION).toBe("e4-n5-preregistration-v1");
  });
});