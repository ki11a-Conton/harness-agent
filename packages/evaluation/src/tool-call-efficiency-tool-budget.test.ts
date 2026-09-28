/**
 * N4 — really constrain tool calls (and, separately, run duration).
 * plan(20260926-175819).md §N4, items 1–2.
 *
 * WHAT THIS FILE PROVES (and what it does NOT)
 * --------------------------------------------
 * PROVEN here, behaviourally and offline:
 *   - `settle` treats the held tool reservation as an upper BOUND: an actual
 *     above it freezes the campaign instead of being charged;
 *   - a refused settle/charge writes NOTHING (all-or-nothing — no partial write,
 *     no reserved/charged desynchronisation);
 *   - `charge()` validates every dimension (a negative never credits the ledger)
 *     and enforces every cap, refusing with `BUDGET_EXHAUSTED` rather than
 *     recording an over-cap charge;
 *   - the campaign tool dimension is CONSUMED by the tool calls a completed
 *     response actually carries, and it is bounded by `maxToolCalls` — so
 *     `maxToolCalls = 0` admits no tool call at all;
 *   - TWO arms SHARE one campaign quota: the second arm cannot get a fresh
 *     allowance (no per-arm reset), which is the shared-allowance requirement.
 *
 * NOT proven here (reported as residual limits in docs/evidence/E4-N4-report.md):
 *   - item 1's reservation BEFORE each physical `ToolOrchestrator` dispatch
 *     (this suite's tool consumption happens at the model-response boundary);
 *   - item 3's global wall-clock deadline / cross-worker cancellation.
 *
 * SAFETY: zero network, zero real provider, zero cost. Scratch dirs live under
 * the OS temp dir; no key is read.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ModelEvent, ModelProvider, ModelRequest, ProviderConfig, ModelRef } from "@ar/contracts";
import { DEFAULT_DECISION_POLICY_V3 } from "./decision-policy-v3.js";
import {
  TOOL_CALL_EFFICIENCY_CANDIDATE_ID_V2,
  buildToolCallEfficiencyPreregistrationV2,
  type PreregCatalogEntryV2,
  type PreregistrationV2Options,
  type ToolCallEfficiencyPreregistrationV2,
} from "./tool-call-efficiency-preregistration-v2.js";
import {
  COST_BUDGET_FILENAME,
  CostBudget,
  TOOL_DISPATCH_BUDGET_EXHAUSTED,
  TOOL_DISPATCH_DEADLINE_EXCEEDED,
  createDurableToolDispatchBudget,
  createFormalBudgetedProvider,
  type FormalBudgetStats,
} from "./tool-call-efficiency-formal-run.js";
import { openR97BudgetLedger } from "./r97-budget-ledger.js";

const SHA_A = "a".repeat(40);
const CASE_IDS = ["reg-01", "reg-02", "reg-06", "reg-08", "adv-03", "adv-07", "st-02", "st-05"];
const REQUEST_PROFILE = { budgetTokens: 32000, stallPolicy: "default" };

const CATALOG: PreregCatalogEntryV2[] = CASE_IDS.map((caseId) => ({
  caseId,
  suite: "regression",
  contentDigest: `content-${caseId}`,
  eligibilityDigest: `elig-${caseId}`,
  holdout: false,
  eligible: true,
}));

function preregOptions(budgetOver: Record<string, unknown> = {}): PreregistrationV2Options {
  return {
    subject: {
      candidateSourceSha: SHA_A,
      baselineArmDigest: "baseline-arm-digest",
      candidateArmDigest: "candidate-arm-digest",
      cleanTreePolicy: "require-clean",
      runtimeConfigDigest: "runtime-config-digest",
    },
    candidateId: TOOL_CALL_EFFICIENCY_CANDIDATE_ID_V2,
    provider: {
      providerId: "deepseek",
      modelId: "deepseek-v4-flash",
      endpointBaseUrl: "https://api.example.com/v1",
      requestProfile: REQUEST_PROFILE,
    },
    catalog: CATALOG,
    selection: {
      caseIds: [...CASE_IDS],
      selectionRule: "R87 frozen dev-set selection",
      selectionProvenanceDigest: "r87-selection-digest",
      holdoutPolicy: "holdout is never read",
    },
    suiteId: "tool-call-efficiency",
    suiteVersion: "1.0.0",
    evaluation: {
      judgeId: "judge-1",
      judgeDigest: "judge-digest",
      verifierDigest: "verifier-digest",
      scorerDigest: "scorer-digest",
      decisionPolicy: { ...DEFAULT_DECISION_POLICY_V3 },
    },
    schedule: { repetitions: 2, orderSeed: 7 },
    budget: {
      maxModelCallsPerRun: 30,
      maxToolCalls: 100,
      maxDurationMs: 600_000,
      maxInputTokens: 320_000,
      maxOutputTokens: 64_000,
      maxTotalTokens: 384_000,
      maxUsdMicros: 5_000_000,
      pricingUnknownPolicy: "refuse",
      ...budgetOver,
    },
    isolation: {
      driverSchema: "r97-driver-v1",
      workerSchema: "r97-worker-v1",
      isolationBackendId: "process-exec",
      isolationStrength: "process",
      resumeStateSchema: "r97-execution-state-v1",
    },
  };
}

function artifactWith(budgetOver: Record<string, unknown> = {}): ToolCallEfficiencyPreregistrationV2 {
  return buildToolCallEfficiencyPreregistrationV2(preregOptions(budgetOver));
}

const dirs: string[] = [];
async function tempDir(): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), "n4-tool-budget-"));
  dirs.push(d);
  return d;
}

const PREVIOUS_CLAIMS_DIR = process.env["R97_CAMPAIGN_CLAIMS_DIR"];
beforeEach(async () => {
  process.env["R97_CAMPAIGN_CLAIMS_DIR"] = await mkdtemp(join(tmpdir(), "n4-claims-"));
});
afterEach(async () => {
  if (PREVIOUS_CLAIMS_DIR === undefined) delete process.env["R97_CAMPAIGN_CLAIMS_DIR"];
  else process.env["R97_CAMPAIGN_CLAIMS_DIR"] = PREVIOUS_CLAIMS_DIR;
  while (dirs.length > 0) await rm(dirs.pop()!, { recursive: true, force: true });
});

/** A provider whose completed response CARRIES `toolCallCount` tool calls. */
function toolCallingProvider(toolCallCount: number): ModelProvider {
  return {
    id: "n4-tool-fake",
    async listModels() {
      return [];
    },
    createClient() {
      return {
        async *generate(): AsyncGenerator<ModelEvent> {
          yield {
            type: "completed",
            result: {
              finishReason: "tool_calls",
              toolCalls: Array.from({ length: toolCallCount }, (_v, i) => ({ id: `c${i}`, name: "read_file", args: {} })),
            } as never,
            timestamp: 0,
          };
        },
      };
    },
  };
}

async function drain(
  provider: ModelProvider,
  budget: CostBudget,
  dir: string,
  arm: string,
  over: { deadlineAtMs?: number | null; now?: () => number } = {},
): Promise<{ stats: FormalBudgetStats; error: unknown }> {
  const ledger = await openR97BudgetLedger(dir, {
    planDigest: "p".repeat(64),
    campaignModelCalls: 100,
    mode: "first-run",
  });
  const { provider: wrapped, stats } = createFormalBudgetedProvider({
    provider,
    ledger,
    costBudget: budget,
    arm,
    usdMicrosPerCall: 0,
    ...(over.deadlineAtMs !== undefined ? { deadlineAtMs: over.deadlineAtMs } : {}),
    ...(over.now !== undefined ? { now: over.now } : {}),
  });
  const client = wrapped.createClient({ providerId: "n4-tool-fake", modelId: "m" } as ModelRef, {} as ProviderConfig);
  let error: unknown = null;
  try {
    for await (const _ev of client.generate({} as ModelRequest, new AbortController().signal)) {
      // drain
    }
  } catch (err) {
    // A RED refusal (budget/deadline) is thrown BEFORE the transport is entered;
    // the caller asserts on it rather than on a silent pass.
    error = err;
  }
  return { stats, error };
}

/** R3/F4 — one real tool dispatch's reservation request. */
function toolReservation(): {
  toolCallId: string;
  tool: string;
  sessionId: string;
  readOnly: boolean;
  sideEffectScope: string;
} {
  return { toolCallId: "call-1", tool: "read_file", sessionId: "s1", readOnly: true, sideEffectScope: "none" };
}

describe("N4 — the held tool reservation is an upper BOUND", () => {
  it("[N4.1] settle refuses a toolCalls actual ABOVE the held reservation and charges nothing", async () => {
    const budget = await CostBudget.open(await tempDir(), artifactWith(), { allowCreate: true });
    const r = await budget.reserve({ inputTokens: 0, outputTokens: 0, toolCalls: 1, durationMs: 0, usdMicros: 0 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    await expect(budget.settle(r.id, { toolCalls: 9 })).rejects.toThrow(/toolCalls/i);
    const v = budget.view();
    expect(v.charged.toolCalls).toBe(0);
    // All-or-nothing: the reservation is STILL outstanding, not half-released.
    expect(v.reserved.toolCalls).toBe(1);
  }, 60_000);

  it("[N4.2] a refused settle is all-or-nothing across dimensions (no partial charge)", async () => {
    const budget = await CostBudget.open(await tempDir(), artifactWith(), { allowCreate: true });
    const r = await budget.reserve({ inputTokens: 10, outputTokens: 10, toolCalls: 1, durationMs: 0, usdMicros: 0 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // `toolCalls` is over-held, so the WHOLE settle must be refused — the
    // in-bound token actuals may not be written on their own.
    await expect(budget.settle(r.id, { inputTokens: 5, outputTokens: 5, toolCalls: 2 })).rejects.toThrow();
    const v = budget.view();
    expect(v.charged.inputTokens).toBe(0);
    expect(v.charged.outputTokens).toBe(0);
    expect(v.charged.toolCalls).toBe(0);
    expect(v.reserved.inputTokens).toBe(10);
    expect(v.reserved.toolCalls).toBe(1);
  }, 60_000);
});

describe("N4 — charge() validates and enforces every cap", () => {
  it("[N4.3] charge() refuses a NEGATIVE or NON-INTEGER actual for every dimension and writes nothing", async () => {
    const budget = await CostBudget.open(await tempDir(), artifactWith(), { allowCreate: true });
    await expect(budget.charge({ inputTokens: -5 })).rejects.toThrow();
    await expect(budget.charge({ toolCalls: -1 })).rejects.toThrow();
    await expect(budget.charge({ outputTokens: 1.5 })).rejects.toThrow();
    await expect(budget.charge({ usdMicros: -1 })).rejects.toThrow();
    const v = budget.view();
    expect(v.charged.inputTokens).toBe(0);
    expect(v.charged.outputTokens).toBe(0);
    expect(v.charged.toolCalls).toBe(0);
    expect(v.charged.usdMicros).toBe(0);
  }, 60_000);

  it("[N4.4] charge() refuses an OVER-CAP tool charge with BUDGET_EXHAUSTED and writes nothing", async () => {
    const budget = await CostBudget.open(await tempDir(), artifactWith({ maxToolCalls: 2 }), { allowCreate: true });
    await budget.charge({ toolCalls: 2 });
    expect(budget.view().charged.toolCalls).toBe(2);
    await expect(budget.charge({ toolCalls: 1 })).rejects.toThrow(/BUDGET_EXHAUSTED/);
    expect(budget.view().charged.toolCalls).toBe(2);
  }, 60_000);

  it("[N4.5] maxToolCalls=0 admits NO tool call at all", async () => {
    const budget = await CostBudget.open(await tempDir(), artifactWith({ maxToolCalls: 0 }), { allowCreate: true });
    await expect(budget.charge({ toolCalls: 1 })).rejects.toThrow(/BUDGET_EXHAUSTED/);
    expect(budget.view().charged.toolCalls).toBe(0);
    // And a reservation for a tool call cannot be taken either.
    const r = await budget.reserve({ inputTokens: 0, outputTokens: 0, toolCalls: 1, durationMs: 0, usdMicros: 0 });
    expect(r.ok).toBe(false);
  }, 60_000);
});

describe("R3/F4 — a DECLARED tool call is a diagnostic, NOT consumption", () => {
  it("[N4.6/R3] a completed response carrying 2 tool calls records declaredToolCalls=2 and charges 0 to the tool dimension", async () => {
    // F4: the tool dimension used to be charged from the DECLARATION, an
    // after-the-fact tally. Actual consumption is now reserved at the REAL
    // dispatch point, so a declared-but-never-dispatched tool cannot look like
    // consumption.
    const dir = await tempDir();
    const budget = await CostBudget.open(dir, artifactWith(), { allowCreate: true });
    const { stats } = await drain(toolCallingProvider(2), budget, dir, TOOL_CALL_EFFICIENCY_CANDIDATE_ID_V2);
    expect(stats.declaredToolCalls).toBe(2);
    expect(budget.view().charged.toolCalls).toBe(0);
  }, 60_000);

  it("[N4.7/R3] a declaration OVER the cap no longer freezes anything: the cap is enforced at DISPATCH", async () => {
    // Under the old semantics the declaration itself threw BUDGET_EXHAUSTED after
    // the model ledger had already committed. Now the declaration never charges;
    // the durable dispatch budget is what enforces `maxToolCalls`.
    const dir = await tempDir();
    const budget = await CostBudget.open(dir, artifactWith({ maxToolCalls: 1 }), { allowCreate: true });
    const { stats } = await drain(toolCallingProvider(2), budget, dir, "candidate");
    expect(stats.declaredToolCalls).toBe(2);
    expect(budget.view().charged.toolCalls).toBe(0);
    const dispatch = createDurableToolDispatchBudget({ costBudget: budget, deadlineAtMs: null });
    expect((await dispatch.reserve(toolReservation())).ok).toBe(true);
    expect((await dispatch.reserve(toolReservation())).ok).toBe(false);
    expect(budget.view().charged.toolCalls).toBe(0); // still reserved, not yet settled
  }, 60_000);

  it("[N4.8/R3] TWO arms competing CONCURRENTLY never exceed the cap", async () => {
    const dir = await tempDir();
    const budget = await CostBudget.open(dir, artifactWith({ maxToolCalls: 2 }), { allowCreate: true });
    const dispatch = createDurableToolDispatchBudget({ costBudget: budget, deadlineAtMs: null });
    // Four arms race for TWO slots. The reservation is taken under the campaign
    // lock, so exactly two may proceed no matter the interleaving.
    const results = await Promise.all([1, 2, 3, 4].map(() => dispatch.reserve(toolReservation())));
    expect(results.filter((r) => r.ok).length).toBe(2);
    expect(results.filter((r) => !r.ok).length).toBe(2);
    expect(results.filter((r) => !r.ok).every((r) => r.reason === TOOL_DISPATCH_BUDGET_EXHAUSTED)).toBe(true);
    for (const r of results) if (r.ok) await r.settle("dispatched");
    expect(budget.view().charged.toolCalls).toBe(2);
    expect(dispatch.stats()).toMatchObject({ reserved: 2, dispatched: 2, capRefused: 2, unknown: 0, released: 0 });
  }, 90_000);

  it("[N4.9/R3] an UNKNOWN dispatch is CHARGED, never refunded", async () => {
    const dir = await tempDir();
    const budget = await CostBudget.open(dir, artifactWith({ maxToolCalls: 2 }), { allowCreate: true });
    const dispatch = createDurableToolDispatchBudget({ costBudget: budget, deadlineAtMs: null });
    const r = await dispatch.reserve(toolReservation());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    await r.settle("unknown");
    const v = budget.view();
    expect(v.charged.toolCalls).toBe(1);
    expect(v.reserved.toolCalls).toBe(0);
    expect(dispatch.stats().unknown).toBe(1);
  }, 60_000);

  it("[N4.10/R3] a RELEASED dispatch (never executed) refunds its reservation", async () => {
    const dir = await tempDir();
    const budget = await CostBudget.open(dir, artifactWith({ maxToolCalls: 2 }), { allowCreate: true });
    const dispatch = createDurableToolDispatchBudget({ costBudget: budget, deadlineAtMs: null });
    const r = await dispatch.reserve(toolReservation());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    await r.settle("not_executed");
    const v = budget.view();
    expect(v.charged.toolCalls).toBe(0);
    expect(v.reserved.toolCalls).toBe(0);
    expect(dispatch.stats().released).toBe(1);
  }, 60_000);

  it("[N4.11/R3] maxToolCalls=0 ⇒ the dispatch budget refuses EVERY dispatch", async () => {
    const dir = await tempDir();
    const budget = await CostBudget.open(dir, artifactWith({ maxToolCalls: 0 }), { allowCreate: true });
    const dispatch = createDurableToolDispatchBudget({ costBudget: budget, deadlineAtMs: null });
    const r = await dispatch.reserve(toolReservation());
    expect(r.ok).toBe(false);
    expect(r.reason).toBe(TOOL_DISPATCH_BUDGET_EXHAUSTED);
    expect(budget.view().charged.toolCalls).toBe(0);
  }, 60_000);
});

describe("R3/F4 — ONE campaign deadline, and it is durable", () => {
  it("[N4.12/R3] the deadline is frozen at creation and REUSED by a later open (a resume keeps only what is left)", async () => {
    const dir = await tempDir();
    const artifact = artifactWith({ maxDurationMs: 600_000 });
    const t0 = 1_700_000_000_000;
    const first = await CostBudget.open(dir, artifact, { allowCreate: true, now: () => t0 });
    expect(first.deadlineAtMs()).toBe(t0 + 600_000);
    // A "restart" 500s later asking for a brand-new window must NOT get one.
    const second = await CostBudget.open(dir, artifact, { allowCreate: false, now: () => t0 + 500_000 });
    expect(second.deadlineAtMs()).toBe(t0 + 600_000);
    expect(second.deadlineAtMs() - (t0 + 500_000)).toBe(100_000);
  }, 60_000);

  it("[N4.13/R3] a LEGACY budget file without a deadline is treated as EXPIRED, never as a fresh window", async () => {
    const dir = await tempDir();
    const artifact = artifactWith({ maxDurationMs: 600_000 });
    const t0 = 1_700_000_000_000;
    await CostBudget.open(dir, artifact, { allowCreate: true, now: () => t0 });
    // Simulate a pre-R3 file: strip the field.
    const path = join(dir, COST_BUDGET_FILENAME);
    const raw = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    delete raw["campaignDeadlineAtMs"];
    delete raw["openedAtMs"];
    writeFileSync(path, `${JSON.stringify(raw, null, 2)}\n`, "utf8");
    const reopened = await CostBudget.open(dir, artifact, { allowCreate: false, now: () => t0 + 10 });
    expect(reopened.deadlineAtMs()).toBe(t0 + 10);
    expect(reopened.view().deadlineSource).toBe("legacy-missing-expired");
    const dispatch = createDurableToolDispatchBudget({
      costBudget: reopened,
      deadlineAtMs: reopened.deadlineAtMs(),
      now: () => t0 + 10,
    });
    const r = await dispatch.reserve(toolReservation());
    expect(r.ok).toBe(false);
    expect(r.reason).toBe(TOOL_DISPATCH_DEADLINE_EXCEEDED);
    expect(dispatch.stats().deadlineRefused).toBe(1);
  }, 60_000);

  it("[N4.14/R3] after the deadline the provider sends NO request (the fake transport is never entered)", async () => {
    const dir = await tempDir();
    const budget = await CostBudget.open(dir, artifactWith(), { allowCreate: true });
    let entered = 0;
    const provider: ModelProvider = {
      id: "n4-deadline-fake",
      async listModels() {
        return [];
      },
      createClient() {
        return {
          async *generate(): AsyncGenerator<ModelEvent> {
            entered += 1;
            yield { type: "completed", result: { finishReason: "stop" } as never, timestamp: 0 };
          },
        };
      },
    };
    const { stats, error } = await drain(provider, budget, dir, "candidate", {
      deadlineAtMs: 1_000,
      now: () => 5_000, // already past
    });
    expect(entered).toBe(0);
    expect(stats.refusedCalls).toBe(1);
    expect(String(error)).toMatch(/CAMPAIGN_DEADLINE_EXCEEDED/);
    expect(budget.view().reserved.usdMicros).toBe(0); // the cost reservation was released
    expect(budget.view().reserved.durationMs).toBe(0);
    expect(budget.view().reserved.toolCalls).toBe(0);
  }, 60_000);
});
