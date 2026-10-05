import { describe, expect, it } from "vitest";
import type { CompactionSummary, ContextBlock, ContextBudget } from "@ar/contracts";
import { ContextPipeline } from "./pipeline.js";
import { DEFAULT_REHYDRATION_OPTIONS } from "./rehydration.js";
import { DEFAULT_TOKEN_ESTIMATOR } from "./tokenizer.js";
import { CompactionCircuitBreaker } from "./circuit-breaker.js";

function summary(over: Partial<CompactionSummary> = {}): CompactionSummary {
  return { goal: "short task", constraints: [], decisions: [], completed: [], filesChanged: [`src/${"a".repeat(130)}.ts`], commandsRun: [], tests: [], failures: [], openTasks: [], importantFacts: [], artifactRefs: [], childAgentRefs: [], ...over };
}
function tool(id: string, tokens: number): ContextBlock {
  return { id, source: "tool", trust: "untrusted", priority: 100, tokens, content: "ordinary data", compressible: true, ephemeral: false };
}
function budget(maxTokens: number, reserved: ContextBudget["reserved"] = { system: 0, task: 0, output: 0 }): ContextBudget {
  return { maxTokens, reserved, dynamic: 0 };
}
function opts(maxTokens: number, over: { reserved?: ContextBudget["reserved"]; summary?: CompactionSummary } = {}) {
  return { cwd: ".", systemPrompt: "sys", priorBlocks: [tool("fits", 10), tool("dropped", 100_000)], budget: budget(maxTokens, over.reserved), summaryOverride: over.summary ?? summary() };
}
function pipeline(deps: ConstructorParameters<typeof ContextPipeline>[0] = {}) {
  return new ContextPipeline({ discovery: { discover: async () => [] }, ...deps });
}
const used = (blocks: readonly ContextBlock[]) => blocks.reduce((sum, block) => sum + block.tokens, 0);
const hydration = (blocks: readonly ContextBlock[]) => blocks.filter(block => block.id.startsWith("rehydrate:"));

describe("post-compaction rehydration remaining context budget", () => {
  it("does not turn a fitting digest into overflow with an optional transcript pointer", async () => {
    const result = await pipeline().build(opts(100));
    expect(result.compacted).toBe(true);
    expect(result.summary?.content).toContain(`src/${"a".repeat(130)}.ts`);
    expect(result.blocks.some(block => block.id === "rehydrate:files")).toBe(true);
    expect(result.blocks.some(block => block.id === "rehydrate:pointers")).toBe(false);
    expect(result.report.used).toBe(90);
    expect(result.report.available).toBe(10);
  });

  it.each([51, 52, 60, 61, 62, 89, 90, 100, 101, 150])("bounds optional references at maxTokens=%s including exact boundaries", async maxTokens => {
    const result = await pipeline().build(opts(maxTokens));
    expect(result.summary).toBeDefined();
    expect(result.blocks[0]?.content).toBe("sys");
    expect(result.report.used).toBe(used(result.blocks));
    expect(result.report.used).toBeLessThanOrEqual(maxTokens);
    expect(result.report.available).toBe(maxTokens - used(result.blocks));
    if (maxTokens === 51) expect(hydration(result.blocks)).toEqual([]);
    if (maxTokens >= 101) expect(hydration(result.blocks).map(block => block.id)).toEqual(["rehydrate:files", "rehydrate:pointers"]);
  });

  it.each([
    { system: 20, task: 0, output: 0 },
    { system: 0, task: 20, output: 0 },
    { system: 0, task: 0, output: 20 },
    { system: 5, task: 7, output: 8 },
  ])("preserves every reserved area in the effective pipeline budget %j", async reserved => {
    const result = await pipeline().build(opts(110, { reserved }));
    expect(result.report.used).toBeLessThanOrEqual(90);
    expect(result.summary?.content).toContain("short task");
    expect(result.blocks.some(block => block.id === "rehydrate:files")).toBe(true);
    expect(result.blocks.some(block => block.id === "rehydrate:pointers")).toBe(false);
  });

  it("keeps message history observational and does not subtract the active user twice", async () => {
    const result = await pipeline().build({ ...opts(101, { reserved: { system: 0, task: 0, output: 0 } }), messages: [{ role: "assistant", content: "history".repeat(10_000) }] });
    expect(result.report.messagesTokens).toBeGreaterThan(10_000);
    expect(result.report.used).toBe(101);
    expect(hydration(result.blocks).map(block => block.id)).toEqual(["rehydrate:files", "rehydrate:pointers"]);
  });

  it("uses the injected estimator to admit Unicode references within remaining headroom", async () => {
    const tokenEstimator = { estimate: (content: string) => Buffer.byteLength(content, "utf8") };
    const state = summary({ goal: "继续优化🙂", filesChanged: [`src/${"界".repeat(30)}.ts`] });
    const ample = await pipeline({ tokenEstimator }).build(opts(1_000, { summary: state }));
    const digestFootprint = used(ample.blocks.filter(block => !block.id.startsWith("rehydrate:")));
    const result = await pipeline({ tokenEstimator }).build(opts(digestFootprint + 43, { summary: state }));
    expect(result.summary?.content).toContain("继续优化🙂");
    expect(result.report.used).toBeLessThanOrEqual(digestFootprint + 43);
    expect(hydration(result.blocks).map(block => block.id)).toEqual(["rehydrate:pointers"]);
    expect(result.blocks.every(block => block.tokens === tokenEstimator.estimate(block.content))).toBe(true);
  });

  it("keeps the independent existing 600-token cap even with abundant global headroom", async () => {
    const state = summary({ filesChanged: Array.from({ length: 8 }, (_, i) => `src/${i}-${"x".repeat(240)}.ts`), openTasks: ["verify the final command"], artifactRefs: ["artifact/original.txt"], commandsRun: ["pnpm typecheck"], tests: ["pnpm test"] });
    const result = await pipeline().build(opts(10_000, { summary: state }));
    expect(used(hydration(result.blocks))).toBeLessThanOrEqual(DEFAULT_REHYDRATION_OPTIONS.maxTokens);
    expect(hydration(result.blocks).length).toBeGreaterThan(0);
  });

  it("does not evict or rewrite protected blocks to make optional references fit", async () => {
    const anchor: ContextBlock = { ...tool("user-anchor", 80), source: "user", trust: "trusted", content: "critical user policy", compressible: false };
    const result = await pipeline().build({ ...opts(100), priorBlocks: [anchor, tool("fits", 10), tool("dropped", 100_000)] });
    expect(result.blocks.find(block => block.id === anchor.id)).toBe(anchor);
    expect(result.summary).toBeDefined();
    expect(hydration(result.blocks)).toEqual([]);
    expect(result.report.used).toBe(131);
    expect(result.report.available).toBe(-31);
  });

  it("reports an irreducibly oversized digest without adding more optional footprint", async () => {
    const state = summary({ goal: "protected working state ".repeat(50) });
    const result = await pipeline().build(opts(100, { summary: state }));
    expect(result.summary?.content).toContain(state.goal.trim());
    expect(result.report.available).toBeLessThan(0);
    expect(hydration(result.blocks)).toEqual([]);
  });

  it("does not rehydrate a build that did not compact", async () => {
    const result = await pipeline().build({ ...opts(100), priorBlocks: [] });
    expect(result.compacted).toBe(false);
    expect(result.summary).toBeUndefined();
    expect(hydration(result.blocks)).toEqual([]);
    expect(result.report.used).toBe(1);
  });

  it("reports the bounded final footprint in telemetry and breaker metrics", async () => {
    const breaker = new CompactionCircuitBreaker();
    const events: Array<{ phase: string; tokens: number }> = [];
    const result = await pipeline({ compactionBreaker: breaker, onTelemetry: event => events.push(event) }).build(opts(100));
    expect(result.report.used).toBe(90);
    expect(breaker.metrics.last?.afterTokens).toBe(90);
    expect(events.find(event => event.phase === "compacted")?.tokens).toBe(90);
  });

  it("does not mutate frozen source blocks, summary arrays or effective reserved values", async () => {
    const input = opts(100);
    input.priorBlocks.forEach(Object.freeze); Object.freeze(input.priorBlocks);
    Object.freeze(input.summaryOverride.filesChanged); Object.freeze(input.summaryOverride);
    Object.freeze(input.budget.reserved); Object.freeze(input.budget);
    const before = JSON.stringify(input);
    const result = await pipeline().build(input);
    expect(result.report.used).toBeLessThanOrEqual(100);
    expect(JSON.stringify(input)).toBe(before);
    expect(result.blocks.every(block => block.tokens === DEFAULT_TOKEN_ESTIMATOR.estimate(block.content))).toBe(true);
  });
});
