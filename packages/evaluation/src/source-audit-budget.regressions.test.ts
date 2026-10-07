import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import type { ModelEvent, ModelProvider, ModelRequest } from "@ar/contracts";
import { CostBudget, createFormalBudgetedProvider, type PricingExecutionGuard } from "./tool-call-efficiency-formal-run.js";
import { openR97BudgetLedger } from "./r97-budget-ledger.js";
import type { ToolCallEfficiencyPreregistrationV2 } from "./tool-call-efficiency-preregistration-v2.js";

const roots: string[] = [];
const artifact = { preregistrationDigest: "round2-budget", budget: { campaignWorstCaseModelCalls: 4,
  maxInputTokens: 256000, maxOutputTokens: 128000, maxTotalTokens: 384000,
  maxToolCalls: 100, maxDurationMs: 60000, maxUsdMicros: 1000000 } } as ToolCallEfficiencyPreregistrationV2;
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function setup(events: ModelEvent[], envelope?: { inputTokens: number; outputTokens: number }, pricingGuard?: PricingExecutionGuard) {
  const root = await mkdtemp(join(tmpdir(), "audit-budget-")); roots.push(root);
  const fixture = { ...artifact, preregistrationDigest: `round2-${randomUUID()}` };
  const cost = await CostBudget.open(root, fixture, { allowCreate: true });
  cost.bindJournalScope({ campaignDigest: fixture.preregistrationDigest, armRunId: "baseline-one", arm: "baseline", caseId: "case", repetition: 0 });
  const ledger = await openR97BudgetLedger(root, { planDigest: fixture.preregistrationDigest, campaignModelCalls: 4, mode: "first-run" });
  let sends = 0;
  const provider: ModelProvider = { id: "scripted", async listModels() { return []; }, createClient() {
    return { async *generate() { sends++; yield* events; } };
  } };
  const wrapped = createFormalBudgetedProvider({ provider, ledger, costBudget: cost, arm: "baseline", usdMicrosPerCall: 1,
    ...(envelope ? { tokenEnvelope: envelope } : {}), ...(pricingGuard ? { pricingGuard } : {}) });
  const client = wrapped.provider.createClient({ providerId: "scripted", modelId: "test" }, {});
  const drain = async () => { const delivered: string[] = []; let error: unknown;
    try { for await (const event of client.generate({ messages: [] } as ModelRequest, new AbortController().signal)) delivered.push(event.type); }
    catch (e) { error = e; } return { delivered, error }; };
  const stopOnCompletion = async () => {
    for await (const event of client.generate({ messages: [] }, new AbortController().signal)) {
      if (event.type === "completed") { expect(cost.view().charged.totalTokens).toBe(49); expect(cost.journalEntries()).toHaveLength(1); break; }
    }
  };
  return { root, cost, ledger, drain, stopOnCompletion, artifact: fixture, sends: () => sends };
}
const completed = (usage?: { inputTokens: number; outputTokens: number }): ModelEvent => ({ type: "completed", timestamp: 0,
  result: { finishReason: "stop", text: "done", ...(usage ? { usage } : {}) } });

describe("source audit: durable provider accounting", () => {
  it("refuses a 64k price for a 96k effective envelope before any physical request", async () => {
    const guard: PricingExecutionGuard = { amountUsdMicros: 1, basisDigest: "a".repeat(64), sourceKind: "operator_declared", currency: "USD",
      issuedAtMs: Date.now() - 10000, expiresAtMs: Date.now() + 60000, coveredTokenCeiling: 64000, requiredTokenCeiling: 64000 };
    const s = await setup([completed({ inputTokens: 32258, outputTokens: 376 })], { inputTokens: 64000, outputTokens: 32000 }, guard);
    expect(String((await s.drain()).error)).toContain("PRICING_COVERAGE_INSUFFICIENT");
    expect(s.sends()).toBe(0); expect((await s.ledger.view()).committed).toBe(0); expect(s.cost.journalEntries()).toHaveLength(0);
  });
  it("charges a >32k input with its declared 64k input bound and final-only usage", async () => {
    const s = await setup([completed({ inputTokens: 32258, outputTokens: 376 })], { inputTokens: 64000, outputTokens: 32000 });
    const result = await s.drain();
    expect(result.error).toBeUndefined(); expect(result.delivered).toContain("completed");
    expect(s.cost.view().charged.inputTokens).toBe(32258);
    expect(s.cost.journalEntries()).toMatchObject([{ basis: "MEASURED", inputTokens: 32258, outputTokens: 376 }]);
    expect((await s.ledger.view()).committed).toBe(1);
  });
  it("never delivers completion or permits a second send after an invalid bound settlement, including reopen", async () => {
    const s = await setup([{ type: "usage", timestamp: 0, usage: { inputTokens: 32258, outputTokens: 376 } }, completed()]);
    const first = await s.drain(); expect(String(first.error)).toContain("BUDGET_STATE_REJECTED");
    expect(first.delivered).not.toContain("completed");
    expect((await s.ledger.view()).unknown).toBe(1);
    expect(String((await s.drain()).error)).toContain("frozen"); expect(s.sends()).toBe(1);
    const reopened = await CostBudget.open(s.root, s.artifact, { allowCreate: false });
    expect(reopened.cannotAffordMore().refused).toBe(true);
    expect((await reopened.reserve({ inputTokens: 1, outputTokens: 1, toolCalls: 0, durationMs: 1, usdMicros: 1 })).ok).toBe(false);
  });
  it("a completed response without usage is unknown cost rather than a measured zero", async () => {
    const s = await setup([completed()]); expect((await s.drain()).error).toBeUndefined();
    expect(s.cost.journalEntries()).toMatchObject([{ basis: "RESERVED_UPPER_BOUND", outcomeUnknown: true, inputTokens: null }]);
    expect(s.cost.view().charged.totalTokens).toBe(64000);
  });
  it("persists settlement and attribution together before a consumer stops on completion", async () => {
    const s = await setup([completed({ inputTokens: 42, outputTokens: 7 })]);
    await s.stopOnCompletion(); const reopened = await CostBudget.open(s.root, s.artifact, { allowCreate: false });
    expect(reopened.view().charged.totalTokens).toBe(49);
    expect(reopened.journalEntries().reduce((n, e) => n + e.chargedTotalTokens, 0)).toBe(49);
  });
  it("refuses a corrupted negative charge on reopen instead of granting extra allowance", async () => {
    const s = await setup([]); const path = join(s.root, "cost-budget.json");
    const raw = JSON.parse(await readFile(path, "utf8")); raw.charged.inputTokens = -100;
    await writeFile(path, JSON.stringify(raw));
    await expect(CostBudget.open(s.root, s.artifact, { allowCreate: false })).rejects.toThrow("invalid");
  });
  it("uses the final cumulative snapshot rather than the largest intermediate value", async () => {
    const s = await setup([{ type: "usage", timestamp: 0, usage: { inputTokens: 100, outputTokens: 50 } }, completed({ inputTokens: 42, outputTokens: 7 })]);
    expect((await s.drain()).error).toBeUndefined(); expect(s.cost.view().charged.totalTokens).toBe(49);
  });
  it("returning a view cannot mutate persisted budget authority or attribution", async () => {
    const s = await setup([completed({ inputTokens: 42, outputTokens: 7 })]); await s.drain();
    const view = s.cost.view(); view.charged.inputTokens = -100; view.caps.maxInputTokens = 1;
    view.journal!.entries[0]!.arm = "candidate";
    expect(s.cost.view().charged.inputTokens).toBe(42); expect(s.cost.journalEntries()[0]!.arm).toBe("baseline");
  });
  it("rejects changed on-disk caps and incomplete reservation dimensions before dispatch", async () => {
    const s = await setup([]);
    expect((await s.cost.reserve({ usdMicros: 0 } as never)).ok).toBe(false);
    const path = join(s.root, "cost-budget.json"), raw = JSON.parse(await readFile(path, "utf8"));
    raw.caps.maxInputTokens++; await writeFile(path, JSON.stringify(raw));
    await expect(s.cost.reserve({ inputTokens: 1, outputTokens: 1, toolCalls: 0, durationMs: 1, usdMicros: 1 })).rejects.toThrow("invalid identity");
  });
});
