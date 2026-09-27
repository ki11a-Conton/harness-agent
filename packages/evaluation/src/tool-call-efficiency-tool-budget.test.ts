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
import { CostBudget, createFormalBudgetedProvider } from "./tool-call-efficiency-formal-run.js";
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

async function drain(provider: ModelProvider, budget: CostBudget, dir: string, arm: string): Promise<void> {
  const ledger = await openR97BudgetLedger(dir, {
    planDigest: "p".repeat(64),
    campaignModelCalls: 100,
    mode: "first-run",
  });
  const { provider: wrapped } = createFormalBudgetedProvider({
    provider,
    ledger,
    costBudget: budget,
    arm,
    usdMicrosPerCall: 0,
  });
  const client = wrapped.createClient({ providerId: "n4-tool-fake", modelId: "m" } as ModelRef, {} as ProviderConfig);
  for await (const _ev of client.generate({} as ModelRequest, new AbortController().signal)) {
    // drain
  }
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

describe("N4 — the tool dimension is CONSUMED, and two arms SHARE the quota", () => {
  it("[N4.6] a completed response carrying 2 tool calls charges exactly 2 to the campaign ledger", async () => {
    const dir = await tempDir();
    const budget = await CostBudget.open(dir, artifactWith(), { allowCreate: true });
    await drain(toolCallingProvider(2), budget, dir, TOOL_CALL_EFFICIENCY_CANDIDATE_ID_V2);
    expect(budget.view().charged.toolCalls).toBe(2);
  }, 60_000);

  it("[N4.7] a response carrying MORE tool calls than the campaign cap allows freezes the charge", async () => {
    const dir = await tempDir();
    const budget = await CostBudget.open(dir, artifactWith({ maxToolCalls: 1 }), { allowCreate: true });
    await expect(drain(toolCallingProvider(2), budget, dir, "candidate")).rejects.toThrow(/BUDGET_EXHAUSTED|tool-call cap/);
    expect(budget.view().charged.toolCalls).toBe(0);
  }, 60_000);

  it("[N4.8] TWO arms share ONE campaign tool quota — the second arm gets no fresh allowance", async () => {
    const dir = await tempDir();
    // maxToolCalls = 2: the FIRST arm consumes both, so the second arm's tool
    // consumption must be refused. A per-arm reset would wrongly admit it.
    const budget = await CostBudget.open(dir, artifactWith({ maxToolCalls: 2 }), { allowCreate: true });
    await drain(toolCallingProvider(2), budget, dir, "baseline");
    expect(budget.view().charged.toolCalls).toBe(2);
    await expect(drain(toolCallingProvider(1), budget, dir, "candidate")).rejects.toThrow(/BUDGET_EXHAUSTED/);
    expect(budget.view().charged.toolCalls).toBe(2);
  }, 90_000);

  it("[N4.9] the quota is DURABLE: a reopened campaign still sees the consumed tool calls", async () => {
    const dir = await tempDir();
    const artifact = artifactWith({ maxToolCalls: 2 });
    const first = await CostBudget.open(dir, artifact, { allowCreate: true });
    await first.charge({ toolCalls: 2 });
    // Re-open from disk (a crash/restart is the same code path) and try again.
    const second = await CostBudget.open(dir, artifact, { allowCreate: false });
    expect(second.view().charged.toolCalls).toBe(2);
    await expect(second.charge({ toolCalls: 1 })).rejects.toThrow(/BUDGET_EXHAUSTED/);
  }, 60_000);
});
