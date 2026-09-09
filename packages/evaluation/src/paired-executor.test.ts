/**
 * E3-02 — PairedExperimentExecutor unit tests.
 *
 * All tests use fake/in-memory providers (zero real provider calls).
 * Acceptance criteria from the E3 plan:
 *   1. 2 cases × 3 repetitions × 2 arms = exactly 12 logical arm runs.
 *   2. BA pair → candidate executes before baseline; AB → baseline first.
 *   3. Same seed → full ordered plan byte-identical; different seed changes
 *      only order fields.
 *   4. Counting provider may show multiple model calls per arm; hitting
 *      max-model-calls stops immediately and produces a partial invalid artifact.
 *   5. Inject a crash after the 5th logical run; after resume every finalized
 *      pair has exactly one A and one B outcome, no duplicate independent samples.
 *   6. Resume rejects different plan digest.
 *   7. Half pair (one arm only) never scored.
 *   8. Repeat N means exactly N per arm (not N+1).
 */

import { describe, expect, it } from "vitest";
import { rm, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ModelProvider, ModelRef, ProviderConfig, ModelRequest, ModelEvent } from "@ar/contracts";
import type { EvalOutcome } from "./runner.js";
import type { BenchmarkCase } from "./baseline.js";
import { buildPairedPlan, computePairedPlanDigest, type PairedExperimentPlan } from "./paired-plan.js";
import { buildExecutionIdentityV1, type PairedExecutionIdentityV1 } from "./paired-execution-identity.js";
import {
  runPairedExperiment,
  armRunIdOf,
  orderedArmRunsFlat,
  type PairedExperimentRunResult,
  type PairedArmContext,
} from "./paired-executor.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const SUITE = "holdout";

function makeCase(id: string): BenchmarkCase {
  return {
    id,
    task: `task ${id}`,
    requestMd: `request ${id}`,
    expectedMd: `expected ${id}`,
    fixture: {},
    expected: { status: "completed" },
    suite: "regression",
    judgeVersion: "1.0.0",
  };
}

function makeOutcome(caseId: string, passed: boolean): EvalOutcome {
  return {
    caseId,
    status: passed ? "passed" : "failed",
    actualStatus: passed ? "completed" : "failed",
    events: [],
    metrics: {
      turn_count: 1,
      tool_call_count: 0,
      tokens_input: 100,
      tokens_output: 50,
      context_tokens: 0,
      compaction_count: 0,
      duration_ms: 100,
      retry_count: 0,
      verification_failures: 0,
      human_interventions: 0,
      estimated_cost: 0,
      usage_unknown: 0,
      cache_tokens_read: 0,
      cache_tokens_created: 0,
      model_call_count: 0,
    },
    violations: [],
    suite: "regression",
    judgeVersion: "1.0.0",
  };
}

/** Simple counting provider: each generate() yields one completed event. */
class CountingProvider implements ModelProvider {
  readonly id = "counting";
  callCount = 0;
  retryCount = 0;
  private readonly _enableRetries: boolean;

  constructor(enableRetries = false) {
    this._enableRetries = enableRetries;
  }

  async listModels() {
    return [{ id: "m", name: "M" }];
  }

  createClient(_model: ModelRef, _config: ProviderConfig) {
    const self = this;
    return {
      async *generate(_request: ModelRequest, _signal: AbortSignal): AsyncGenerator<ModelEvent, void, void> {
        self.callCount += 1;
        if (self._enableRetries) {
          self.retryCount += 1;
          yield {
            type: "retry",
            attempt: 1,
            error: { code: "MODEL_ERROR" as any, message: "transient", retryable: true, safeToRetry: true },
            timestamp: 0,
          } as ModelEvent;
        }
        yield { type: "started", timestamp: 0 };
        yield {
          type: "completed",
          result: { finishReason: "stop", text: "ok" },
          timestamp: 0,
        } as ModelEvent;
      },
    };
  }
}

/** Multi-call provider: each generate() yields a basic completed event.
 *  runArm can call generate() multiple times to simulate multi-call arms. */
class MultiCallProvider implements ModelProvider {
  readonly id = "multi";
  callCount = 0;

  async listModels() {
    return [{ id: "m", name: "M" }];
  }

  createClient(_model: ModelRef, _config: ProviderConfig) {
    const self = this;
    return {
      async *generate(_request: ModelRequest, _signal: AbortSignal): AsyncGenerator<ModelEvent, void, void> {
        self.callCount += 1;
        yield { type: "started", timestamp: 0 };
        yield {
          type: "completed",
          result: { finishReason: "stop", text: "ok" },
          timestamp: 0,
        } as ModelEvent;
      },
    };
  }
}

async function drainGenerate(ctx: PairedArmContext, times = 1): Promise<void> {
  const client = ctx.provider.createClient({ providerId: "x", modelId: "m" }, {});
  for (let i = 0; i < times; i++) {
    for await (const _ev of client.generate({ messages: [] }, new AbortController().signal)) {
      // drain
    }
  }
}

function plan2cases(plan: PairedExperimentPlan): BenchmarkCase[] {
  return [...new Set(plan.cases)].map((id) => makeCase(id));
}

function assertOk(r: PairedExperimentRunResult): asserts r is Extract<PairedExperimentRunResult, { status: "ok" }> {
  expect(r.status).toBe("ok");
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("E3-02 PairedExperimentExecutor", () => {
  it("1. 2 cases × 3 reps × 2 arms = exactly 12 logical arm runs", async () => {
    const plan = buildPairedPlan({ suite: SUITE, cases: ["c1", "c2"], repetitions: 3, orderSeed: 7 });
    expect(plan.totalLogicalRuns).toBe(12);
    const provider = new CountingProvider();
    let armRunCount = 0;
    const result = await runPairedExperiment({
      plan,
      cases: plan2cases(plan),
      provider,
      runArm: async (_arm, _caseDef, _ctx) => {
        armRunCount += 1;
        return makeOutcome(_arm.caseId, true);
      },
    });
    assertOk(result);
    expect(armRunCount).toBe(12);
    expect(result.counters.logicalRuns).toBe(12);
    expect(result.finalizedPairs.length).toBe(6);
    expect(result.partialPairs.length).toBe(0);
    expect(result.complete).toBe(true);
    expect(result.haltedByBudget).toBe(false);
    expect(result.interrupted).toBe(false);
  });

  it("2. BA pairs: candidate before baseline; AB pairs: baseline before candidate", async () => {
    const plan = buildPairedPlan({ suite: SUITE, cases: ["c1", "c2"], repetitions: 3, orderSeed: 7 });
    const ordered = orderedArmRunsFlat(plan);
    // For each pair, check that the arm orderIndex matches the pair order.
    for (const pair of plan.pairs) {
      const pairRuns = ordered.filter((r) => r.pairId === pair.pairId);
      expect(pairRuns).toHaveLength(2);
      if (pair.order === "AB") {
        expect(pairRuns[0]!.armId).toBe("baseline");
        expect(pairRuns[1]!.armId).toBe("candidate");
      } else {
        expect(pairRuns[0]!.armId).toBe("candidate");
        expect(pairRuns[1]!.armId).toBe("baseline");
      }
    }
    // Run the executor and verify execution order matches.
    const provider = new CountingProvider();
    const executionOrder: string[] = [];
    const result = await runPairedExperiment({
      plan,
      cases: plan2cases(plan),
      provider,
      runArm: async (arm, _caseDef, _ctx) => {
        executionOrder.push(`${arm.armId}:${arm.caseId}:${arm.repetition}`);
        return makeOutcome(arm.caseId, true);
      },
    });
    assertOk(result);
    // Verify execution order matches the orderedRuns.
    expect(executionOrder.length).toBe(12);
    for (let i = 0; i < ordered.length; i++) {
      const run = ordered[i]!;
      expect(executionOrder[i]).toBe(`${run.armId}:${run.caseId}:${run.repetition}`);
    }
  });

  it("3. same seed → byte-identical ordered runs; different seed changes only order fields", async () => {
    const a = buildPairedPlan({ suite: SUITE, cases: ["c1", "c2"], repetitions: 3, orderSeed: 7 });
    const b = buildPairedPlan({ suite: SUITE, cases: ["c1", "c2"], repetitions: 3, orderSeed: 7 });
    const aFlat = orderedArmRunsFlat(a);
    const bFlat = orderedArmRunsFlat(b);
    expect(JSON.stringify(aFlat)).toBe(JSON.stringify(bFlat));

    // Different seed: the armId sequence changes (AB/BA pattern differs).
    const c = buildPairedPlan({ suite: SUITE, cases: ["c1", "c2"], repetitions: 3, orderSeed: 99 });
    const cFlat = orderedArmRunsFlat(c);
    // Same set of arm tuples (armId, caseId, repetition) — just order differs.
    const aSet = new Set(aFlat.map((r) => `${r.armId}:${r.caseId}:${r.repetition}`));
    const cSet = new Set(cFlat.map((r) => `${r.armId}:${r.caseId}:${r.repetition}`));
    expect(aSet).toEqual(cSet);
    // The armId sequence (which arm comes first in each pair) differs between seeds.
    const aArmSeq = aFlat.map((r) => `${r.armId}:${r.pairId}`);
    const cArmSeq = cFlat.map((r) => `${r.armId}:${r.pairId}`);
    expect(aArmSeq).not.toEqual(cArmSeq);
  });

  it("4. counting provider: multiple model calls per arm; max-model-calls stops immediately", async () => {
    const plan = buildPairedPlan({ suite: SUITE, cases: ["c1", "c2"], repetitions: 2, orderSeed: 7 });
    // 2 cases × 2 reps × 2 arms = 8 logical runs. Each arm does 3 generate() calls.
    const provider = new MultiCallProvider();
    let armRuns = 0;
    const result = await runPairedExperiment({
      plan,
      cases: plan2cases(plan),
      provider,
      maxModelCalls: 10, // enough for 3 arms (3×3=9) but not 4th (3 calls → 12 > 10)
      runArm: async (_arm, _caseDef, ctx) => {
        armRuns += 1;
        await drainGenerate(ctx, 3); // 3 model calls per arm
        return makeOutcome(_arm.caseId, true);
      },
    });
    assertOk(result);
    // 3 full arms (9 calls) + 1 partial arm (1 call → 10) = 10 calls, 4 arms attempted.
    expect(armRuns).toBe(4);
    expect(result.counters.modelCallAttempts).toBe(10);
    expect(result.haltedByBudget).toBe(true);
    expect(result.interrupted).toBe(true);
    // Pair 1 (arms 1-2) finalized; pair 2 (arm 3 valid, arm 4 invalid) partial.
    expect(result.finalizedPairs.length).toBe(1);
    expect(result.partialPairs.length).toBeGreaterThanOrEqual(1);
    // The partial pair includes the invalid arm.
    const partial = result.partialPairs[0]!;
    expect(partial.reason).toBe("invalid-arm");
  });

  it("5. crash after 5th logical run → resume: every finalized pair has one A + one B, no duplicates", async () => {
    const plan = buildPairedPlan({ suite: SUITE, cases: ["c1", "c2"], repetitions: 3, orderSeed: 1 });
    // 12 logical runs. Inject crash after 5th.
    const journalDir = join(tmpdir(), "paired-journal-5");
    await rm(journalDir, { recursive: true, force: true }).catch(() => {});

    // First run: crash after 5th arm.
    let armCount = 0;
    const provider1 = new CountingProvider();
    try {
      await runPairedExperiment({
        plan,
        cases: plan2cases(plan),
        provider: provider1,
        journalDir,
        identity: identFor(plan),
        runArm: async (arm, _caseDef, _ctx) => {
          armCount += 1;
          return makeOutcome(arm.caseId, true);
        },
        onArmCompleted: async (_info) => {
          if (_info.logicalRuns === 5) {
            throw new Error("CRASH SIMULATION");
          }
        },
      });
    } catch {
      // Expected crash
    }

    // Verify journal has 5 entries.
    const journalFiles = await readdir(journalDir).catch(() => []);
    const armJournalFiles = journalFiles.filter((f) => f.endsWith(".json") && !f.startsWith(".tmp-") && f !== "identity.json");
    expect(armJournalFiles.length).toBe(5);

    // Resume: should complete the remaining 7 arms.
    const provider2 = new CountingProvider();
    const result = await runPairedExperiment({
      plan,
      cases: plan2cases(plan),
      provider: provider2,
      journalDir,
      identity: identFor(plan),
      runArm: async (arm, _caseDef, _ctx) => {
        return makeOutcome(arm.caseId, true);
      },
    });
    assertOk(result);
    expect(result.resumed).toBe(true);
    expect(result.complete).toBe(true);
    // Count total logical runs across both sessions: 5 (crash) + 3 (new) = 8? Wait...
    // Actually: 5 journaled + 7 new = 12 total. But the budget's logicalRuns counts
    // only the new session (which skips 5 journaled = 7 new). But the budget was
    // seeded from the journal. So counters.logicalRuns = 5 (journal) + 7 (new) = 12.
    // But wait — the budget seeds from the journal: 5 entries → logicalRuns=5.
    // Then 7 new arms → logicalRuns increments to 12. So counters.logicalRuns = 12.
    expect(result.counters.logicalRuns).toBe(12);
    // Every finalized pair has exactly one A and one B outcome.
    expect(result.finalizedPairs.length).toBe(6);
    for (const pair of result.finalizedPairs) {
      expect(pair.baseline.valid).toBe(true);
      expect(pair.candidate.valid).toBe(true);
      expect(pair.baseline.arm.armId).toBe("baseline");
      expect(pair.candidate.arm.armId).toBe("candidate");
    }
    // No partial pairs.
    expect(result.partialPairs.length).toBe(0);
    // All 12 arms are present in the outcome (no duplicates).
    const armKeys = new Set(
      result.finalizedPairs.flatMap((p) => [
        armRunIdOf(p.pairId, "baseline"),
        armRunIdOf(p.pairId, "candidate"),
      ]),
    );
    expect(armKeys.size).toBe(12);
    expect(result.interrupted).toBe(false);
    expect(result.haltedByBudget).toBe(false);

    // Cleanup journal.
    await rm(journalDir, { recursive: true, force: true }).catch(() => {});
  });

  it("6. resume rejects different plan digest", async () => {
    const journalDir = join(tmpdir(), "paired-journal-digest");
    await rm(journalDir, { recursive: true, force: true }).catch(() => {});

    // Run with seed 7.
    const planA = buildPairedPlan({ suite: SUITE, cases: ["c1"], repetitions: 1, orderSeed: 7 });
    const providerA = new CountingProvider();
    const resultA = await runPairedExperiment({
      plan: planA,
      cases: plan2cases(planA),
      provider: providerA,
      journalDir,
      identity: identFor(planA),
      runArm: async (arm, _caseDef, _ctx) => makeOutcome(arm.caseId, true),
    });
    assertOk(resultA);
    expect(resultA.complete).toBe(true);

    // Resume with a DIFFERENT plan (different seed → different digest).
    const planB = buildPairedPlan({ suite: SUITE, cases: ["c1"], repetitions: 1, orderSeed: 99 });
    const providerB = new CountingProvider();
    const resultB = await runPairedExperiment({
      plan: planB,
      cases: plan2cases(planB),
      provider: providerB,
      journalDir,
      identity: identFor(planB),
      runArm: async (arm, _caseDef, _ctx) => makeOutcome(arm.caseId, true),
    });
    expect(resultB.status).toBe("resume-rejected");
    if (resultB.status === "resume-rejected") {
      // E4-R01: the identity gate names the differing field, and the rejected
      // run must not have touched the provider at all.
      expect((resultB.violations ?? []).some((v) => v.includes("scheduleDigest"))).toBe(true);
    }
    expect(providerB.callCount).toBe(0);

    await rm(journalDir, { recursive: true, force: true }).catch(() => {});
  });

  it("7. half pair (one arm only) never scored — partial pair not in finalizedPairs", async () => {
    const plan = buildPairedPlan({ suite: SUITE, cases: ["c1"], repetitions: 1, orderSeed: 7 });
    // The FIRST arm in execution order (whichever it is) throws an
    // infrastructure error; the second arm is a clean outcome.
    let armIndex = 0;
    const result = await runPairedExperiment({
      plan,
      cases: plan2cases(plan),
      provider: new CountingProvider(),
      runArm: async (arm, _caseDef, _ctx) => {
        armIndex += 1;
        if (armIndex === 1) {
          // First executed arm throws → infra outcome (invalid).
          throw new Error("infra failure");
        }
        return makeOutcome(arm.caseId, true);
      },
    });
    assertOk(result);
    // No finalized pair (both arms must be valid).
    expect(result.finalizedPairs.length).toBe(0);
    // One partial pair: exactly one arm valid, one invalid. Never scored.
    expect(result.partialPairs.length).toBe(1);
    const partial = result.partialPairs[0]!;
    expect(partial.reason).toBe("invalid-arm");
    const validArms = [partial.baseline, partial.candidate].filter((a) => a !== null && a.valid);
    const invalidArms = [partial.baseline, partial.candidate].filter((a) => a !== null && !a.valid);
    expect(validArms.length).toBe(1);
    expect(invalidArms.length).toBe(1);
    expect(partial.baseline).not.toBeNull();
    expect(partial.candidate).not.toBeNull();
    expect(result.complete).toBe(false);
  });

  it("8. repeat N means exactly N per arm (not N+1)", async () => {
    // repetitions=3 → 3 per case per arm = 2×3×2 = 12 runs.
    const plan = buildPairedPlan({ suite: SUITE, cases: ["c1"], repetitions: 3, orderSeed: 7 });
    expect(plan.totalLogicalRuns).toBe(6); // 1 case × 3 reps × 2 arms = 6
    const provider = new CountingProvider();
    let armRuns = 0;
    const result = await runPairedExperiment({
      plan,
      cases: plan2cases(plan),
      provider,
      runArm: async (arm, _caseDef, _ctx) => {
        armRuns += 1;
        return makeOutcome(arm.caseId, true);
      },
    });
    assertOk(result);
    // Got exactly 3 repetitions × 2 arms = 6 (not 7, not 8).
    expect(armRuns).toBe(6);
    expect(result.counters.logicalRuns).toBe(6);
    expect(result.finalizedPairs.length).toBe(3);
    // Each repetition: exactly 1 pair, 2 arms.
    const reps = new Set(result.finalizedPairs.map((p) => p.repetition));
    expect(reps.size).toBe(3);
  });

  it("9. transport retries are counted separately, not as extra logical runs", async () => {
    const plan = buildPairedPlan({ suite: SUITE, cases: ["c1"], repetitions: 1, orderSeed: 7 });
    // 1 case × 1 rep × 2 arms = 2 logical runs.
    // Each generate() yields a retry event.
    const provider = new CountingProvider(true); // enable retries
    let armCalls = 0;
    const result = await runPairedExperiment({
      plan,
      cases: plan2cases(plan),
      provider,
      runArm: async (arm, _caseDef, ctx) => {
        armCalls += 1;
        await drainGenerate(ctx, 2); // 2 generate() calls per arm → 2 retries
        return makeOutcome(arm.caseId, true);
      },
    });
    assertOk(result);
    expect(result.finalizedPairs.length).toBe(1);
    expect(result.counters.logicalRuns).toBe(2);
    // 2 arms × 2 generate() calls × 1 retry per call = 4 transport retries.
    expect(result.counters.transportRetries).toBe(4);
    expect(result.counters.modelCallAttempts).toBe(4);
  });
});
// ---------------------------------------------------------------------------
// E4-R01 — execution identity fixture. Hoisted so the resume tests above can
// use it. Override one field to prove that any security-relevant change to the
// experiment blocks a resume instead of silently reusing the old journal.
// ---------------------------------------------------------------------------
export function identFor(
  plan: PairedExperimentPlan,
  over: Partial<PairedExecutionIdentityV1> = {},
): PairedExecutionIdentityV1 {
  return buildExecutionIdentityV1({
    scheduleDigest: computePairedPlanDigest(plan),
    suite: plan.suite,
    judgeVersion: "1.0.0",
    repetitions: plan.repetitions,
    orderSeed: plan.orderSeed ?? 0,
    modelSeed: null,
    caseIds: plan.cases,
    caseFingerprints: Object.fromEntries(plan.cases.map((c) => [c, "fixture-" + c])),
    candidate: "cand-x",
    providerId: "fake",
    modelId: "fake-model",
    sourceSha: "a".repeat(40),
    limits: { maxLogicalRuns: null, maxModelCalls: null, maxEstimatedTokens: null, maxEstimatedCostUsd: null },
    billingClass: "offline-test",
    isolationBackendId: "none",
    isolationStrength: "none",
    promotionEligible: false,
    decisionPolicy: { version: "test-policy-v1" },
    thresholdDigest: "b".repeat(64),
    ...over,
  });
}
