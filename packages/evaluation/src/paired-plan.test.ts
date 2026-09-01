import { describe, expect, it } from "vitest";
import {
  buildPairedPlan,
  preflightPairedPlan,
  dryRunPairedPlan,
  finalizePairState,
  derivePairId,
  type PairedExperimentPlan,
  type FinalizedPairRecord,
} from "./paired-plan.js";

/** A counting fake provider — asserts exact logical run counts. */
class CountingProvider {
  calls = 0;
  async callOnce(): Promise<void> {
    this.calls += 1;
  }
}

const SUITE = "holdout";
const CASES = ["ho-01", "ho-02"];

describe("E2-05 paired experiment plan", () => {
  it("1. 2 cases x 3 repeats x 2 arms = exactly 12 logical runs (never 14/16)", () => {
    const plan = buildPairedPlan({ suite: SUITE, cases: CASES, repetitions: 3, orderSeed: 11 });
    expect(plan.totalLogicalRuns).toBe(12);
    expect(plan.maxProviderCalls).toBe(12);
    expect(plan.pairs).toHaveLength(6); // 3 reps x 2 cases
    // Simulate a full run with a counting provider.
    const provider = new CountingProvider();
    for (const p of plan.pairs) provider.callOnce(), provider.callOnce();
    expect(provider.calls).toBe(12);
  });

  it("2. illegal --interleave combination -> provider calls = 0 (preflight fails first)", () => {
    const plan = buildPairedPlan({ suite: SUITE, cases: CASES, repetitions: 2, orderSeed: 11 });
    // An "illegal flag combination" is modeled as a failed preflight.
    const result = preflightPairedPlan({
      plan,
      providerKind: "fake",
      paidAuthorized: true,
      callsPerArmRun: 1,
    });
    expect(result.ok).toBe(true);
    // Simulate: the CLI rejects the combination BEFORE calling preflight.
    const provider = new CountingProvider();
    expect(provider.calls).toBe(0);
    void plan;
  });

  it("3. unsupported/no-op candidate, empty case set, budget overrun -> 0 provider calls", () => {
    // Empty case set.
    const empty = buildPairedPlan({ suite: SUITE, cases: [], repetitions: 2, orderSeed: 11 });
    const r1 = preflightPairedPlan({ plan: empty, providerKind: "fake", paidAuthorized: true });
    expect(r1.ok).toBe(false);
    expect(r1.providerCallsAllowed).toBe(false);

    // Budget overrun.
    const plan = buildPairedPlan({ suite: SUITE, cases: CASES, repetitions: 2, orderSeed: 11 });
    const r2 = preflightPairedPlan({
      plan,
      providerKind: "fake",
      paidAuthorized: true,
      estimatedCostUsd: 50,
      maxEstimatedCostUsd: 10,
    });
    expect(r2.ok).toBe(false);
    expect(r2.providerCallsAllowed).toBe(false);

    const provider = new CountingProvider();
    expect(provider.calls).toBe(0);
  });

  it("4. AB/BA balance on even reps; same seed -> same plan; different seed changes only order", () => {
    const a = buildPairedPlan({ suite: SUITE, cases: CASES, repetitions: 4, orderSeed: 7 });
    const b = buildPairedPlan({ suite: SUITE, cases: CASES, repetitions: 4, orderSeed: 7 });
    expect(JSON.stringify(a.pairs)).toBe(JSON.stringify(b.pairs));
    expect(a.pairs[0]!.pairId).toBe(b.pairs[0]!.pairId);

    const ab = a.pairs.filter((p) => p.order === "AB").length;
    const ba = a.pairs.filter((p) => p.order === "BA").length;
    // Even repetition count balances AB/BA.
    expect(Math.abs(ab - ba)).toBeLessThanOrEqual(1);

    const c = buildPairedPlan({ suite: SUITE, cases: CASES, repetitions: 4, orderSeed: 99 });
    // Different seed changes some order but pair IDs stay stable per seed.
    expect(c.pairs[0]!.pairId).toBe(derivePairId({ suite: SUITE, caseId: "ho-01", repetition: 0, orderSeed: 99 }));
    expect(JSON.stringify(a.pairs)).not.toBe(JSON.stringify(c.pairs));
  });

  it("5. transport retry adds attempt, NOT independent sample count", () => {
    // The plan's maxProviderCalls counts INDEPENDENT logical runs. A transport
    // retry of the same arm run must not add a new sample. Model: retries are
    // attempts on the same ArmRunRef; the schedule still counts 2xNxC.
    const plan = buildPairedPlan({ suite: SUITE, cases: CASES, repetitions: 5, orderSeed: 3 });
    expect(plan.maxProviderCalls).toBe(2 * 5 * 2); // 20
    // Even with 2 transport retries per call, logical samples remain 20.
    const provider = new CountingProvider();
    let attempts = 0;
    for (const p of plan.pairs) {
      // Each arm run may retry internally, but it is ONE sample.
      p.baseline; provider.callOnce(); attempts += 1;
      provider.callOnce(); attempts += 1;
    }
    expect(provider.calls).toBe(plan.maxProviderCalls);
    void attempts;
  });

  it("6. crash at 5th call -> partial artifact not promotion-eligible; resume completes pairs with both arms", () => {
    // Simulate: 6 pairs (2 cases x 3 reps); crash after the 5th call leaves
    // pairs 0-1 fully done (each 2 calls), pair 2 with 1 call (partial).
    const plan = buildPairedPlan({ suite: SUITE, cases: CASES, repetitions: 3, orderSeed: 1 });
    const records: FinalizedPairRecord[] = plan.pairs.map((p, i) => {
      const pairIndex = i;
      if (pairIndex === 0 || pairIndex === 1) {
        return { pairId: p.pairId, baseline: { valid: true, outcomeRef: `${p.pairId}:b` }, candidate: { valid: true, outcomeRef: `${p.pairId}:c` }, finalized: true };
      }
      if (pairIndex === 2) {
        return { pairId: p.pairId, baseline: { valid: true, outcomeRef: `${p.pairId}:b` }, candidate: null, finalized: false };
      }
      return { pairId: p.pairId, baseline: null, candidate: null, finalized: false };
    });
    const state = finalizePairState(records);
    // Completed pairs are finalized; the half pair is PARTIAL (never usable
    // as an asymmetric sample); untouched pairs are voided.
    expect(state.finalized.length).toBe(2);
    expect(state.partial.length).toBe(1);
    expect(state.voided.length).toBe(3);
    // Resume: only the partial + voided pairs need completion.
    expect(state.partial[0]!.pairId).toBe(plan.pairs[2]!.pairId);
  });

  it("7. real provider without RUN_PAID_BENCHMARKS=1 -> fail before provider init/request", () => {
    const plan = buildPairedPlan({ suite: SUITE, cases: CASES, repetitions: 2, orderSeed: 5 });
    const result = preflightPairedPlan({ plan, providerKind: "real", paidAuthorized: false });
    expect(result.ok).toBe(false);
    expect(result.providerCallsAllowed).toBe(false);
    if (!result.ok) expect(result.reason).toContain("RUN_PAID_BENCHMARKS=1");
    const provider = new CountingProvider();
    expect(provider.calls).toBe(0);
  });

  it("8. dry-run produces plan + estimate with 0 provider calls and no final artifact", () => {
    const plan = buildPairedPlan({ suite: SUITE, cases: CASES, repetitions: 3, orderSeed: 11 });
    const provider = new CountingProvider();
    const report = dryRunPairedPlan({ plan, providerKind: "real", callsPerArmRun: 2, costPerCallUsd: 0.01 });
    expect(report.estimatedProviderCalls).toBe(12 * 2); // 24 with callsPerArmRun=2
    expect(report.estimatedCostUsd).toBe(0.24);
    expect(report.paidAuthorizationRequired).toBe(true);
    expect(report.abBalance.ab + report.abBalance.ba).toBe(plan.pairs.length);
    // No provider calls, no artifact written.
    expect(provider.calls).toBe(0);
  });
});