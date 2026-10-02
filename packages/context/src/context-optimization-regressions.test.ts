import { performance } from "node:perf_hooks";
import { describe, expect, it, vi } from "vitest";
import type { CompactionSummary, Compactor, ContextBlock, ContextSource } from "@ar/contracts";
import { DefaultCompactor, MultiStageCompactor, previewMarker } from "./compaction.js";
import { buildRehydrationBlocks } from "./rehydration.js";
import { ContextPipeline, estimateMessageTokens } from "./pipeline.js";
import { CompactionCircuitBreaker } from "./circuit-breaker.js";
import { DEFAULT_TOKEN_ESTIMATOR } from "./tokenizer.js";

function summary(over: Partial<CompactionSummary> = {}): CompactionSummary {
  return { goal: "continue task", constraints: [], decisions: [], completed: [], filesChanged: [], commandsRun: [], tests: [], failures: [], openTasks: [], importantFacts: [], artifactRefs: [], childAgentRefs: [], ...over };
}
function block(over: Partial<ContextBlock> = {}): ContextBlock {
  const content = over.content ?? "evidence";
  return { id: "evidence", source: "mcp", trust: "semi-trusted", priority: 100, content, tokens: DEFAULT_TOKEN_ESTIMATOR.estimate(content), compressible: true, ephemeral: false, category: "evidence", ...over };
}
function previewBody(content: string): string {
  return content.slice(0, content.lastIndexOf("\n# [previewed at"));
}
function pipeline(over: ConstructorParameters<typeof ContextPipeline>[0] = {}): ContextPipeline {
  return new ContextPipeline({ discovery: { discover: async () => [] }, ...over });
}
function buildOpts(priorBlocks: ContextBlock[] = [], maxTokens = 100) {
  return { cwd: process.cwd(), systemPrompt: "sys", priorBlocks, budget: { maxTokens, reserved: { system: 0, task: 0, output: 0 }, dynamic: maxTokens }, summaryOverride: summary() };
}
function effectiveInput() {
  return [1, 2, 3].map((id) => block({ id: `tool-${id}`, source: "tool", content: String(id).repeat(160), tokens: 40 }));
}
function ineffectiveOpts() {
  return buildOpts([block({ content: "x".repeat(100) })], 10);
}

describe("context compaction: bounded previews and preservation", () => {
  it.each(["x".repeat(100_000), "界🙂".repeat(25_000), JSON.stringify({ output: "payload".repeat(20_000) })])("bounds a long first line in UTF-8 without introducing replacement characters", async (content) => {
    const output = await new MultiStageCompactor({ previewMaxBytes: 64 }).compact([block({ content })], summary());
    const preview = output[0]!;
    const body = previewBody(preview.content);
    expect(Buffer.byteLength(body)).toBeLessThanOrEqual(64);
    expect(body).not.toContain("\uFFFD");
    expect(content.startsWith(body)).toBe(true);
    expect(preview.content).toContain(previewMarker(Buffer.byteLength(content)));
    expect(preview.tokens).toBe(DEFAULT_TOKEN_ESTIMATOR.estimate(preview.content));
  });

  it("prefers complete lines when the next line cannot fit", async () => {
    const input = block({ content: `first line\n${"x".repeat(200)}` });
    const output = await new MultiStageCompactor({ previewMaxBytes: 32 }).compact([input], summary());
    expect(previewBody(output[0]!.content)).toBe("first line");
    expect(input.content).toHaveLength(211);
  });

  it("applies the contract's default evidence category when none is provided", async () => {
    const output = await new MultiStageCompactor({ previewMaxBytes: 64 }).compact([block({ content: "x".repeat(100_000), category: undefined })], summary());
    expect(Buffer.byteLength(previewBody(output[0]!.content))).toBeLessThanOrEqual(64);
    expect(output[0]!.tokens).toBe(DEFAULT_TOKEN_ESTIMATOR.estimate(output[0]!.content));
  });

  it.each(["system", "user", "project", "local", "skill"] as ContextSource[])("preserves a %s anchor through all early stages", async (source) => {
    const anchor = block({ id: "anchor", source, content: "policy constraint ".repeat(500), ephemeral: true });
    const output = await new MultiStageCompactor({ previewMaxBytes: 32 }).compact([anchor, block({ source: "tool" })], summary());
    expect(output.find((candidate) => candidate.id === "anchor")).toBe(anchor);
  });

  it.each([
    { compressible: false },
    { category: "protected-instruction" as const },
    { instructional: true },
    { trust: "trusted" as const },
  ])("preserves the explicit protection flags %j", async (protection) => {
    const anchor = block({ id: "anchor", content: "critical evidence ".repeat(500), ephemeral: true, ...protection });
    const output = await new MultiStageCompactor({ previewMaxBytes: 32 }).compact([anchor], summary());
    expect(output).toEqual([anchor]);
    expect(output[0]).toBe(anchor);
  });

  it.each([DefaultCompactor, MultiStageCompactor])("preserves protected tool instructions with %s", async (CompactorClass) => {
    const anchor = block({ id: "anchor", source: "tool", category: "protected-instruction", instructional: true });
    const output = await new CompactorClass().compact([anchor], summary());
    expect(output).toEqual([anchor]);
  });

  it("keeps trusted tool traffic compactable when it is explicitly data", async () => {
    const input = block({ source: "tool", trust: "trusted", instructional: false });
    const output = await new MultiStageCompactor().compact([input], summary());
    expect(output.map((candidate) => candidate.id)).toEqual(["compaction-summary"]);
  });

  it("keeps the last duplicate in its actual call order", async () => {
    const input = [block({ id: "a-old", content: "A" }), block({ id: "b", content: "B" }), block({ id: "a-new", content: "A" })];
    const output = await new MultiStageCompactor().compact(input, summary());
    expect(output.map((candidate) => candidate.id)).toEqual(["b", "a-new"]);
    expect(input.map((candidate) => candidate.id)).toEqual(["a-old", "b", "a-new"]);
  });

  it("does not merge different full evidence with an identical preview", async () => {
    const shared = "line\n".repeat(100);
    const input = [block({ id: "one", content: `${shared}tail-A` }), block({ id: "two", content: `${shared}tail-B` })];
    const output = await new MultiStageCompactor({ previewMaxBytes: 32 }).compact(input, summary());
    expect(output.map((candidate) => candidate.id)).toEqual(["one", "two"]);
  });

  it("retains duplicate original evidence only once even when previewed", async () => {
    const content = "large evidence\n".repeat(100);
    const output = await new MultiStageCompactor({ previewMaxBytes: 32 }).compact([block({ id: "old", content }), block({ id: "new", content })], summary());
    expect(output.map((candidate) => candidate.id)).toEqual(["new"]);
  });

  it.each([
    { path: "other.ts" },
    { source: "memory" as const, compressible: false },
    { trust: "untrusted" as const },
    { provenance: { kind: "mcp", serviceId: "other-server", toolId: "read", trust: "semi-trusted" as const } },
  ])("does not collapse evidence from different identities %j", async (identity) => {
    const one = block({ id: "one", path: "file.ts" });
    const two = block({ id: "two", path: "file.ts", ...identity });
    const output = await new MultiStageCompactor().compact([one, two], summary());
    expect(output.map((candidate) => candidate.id)).toEqual(["one", "two"]);
  });

  it("conservatively keeps previously previewed evidence whose originals are unavailable", async () => {
    const content = `prefix\n${previewMarker(10_000)}\n`;
    const output = await new MultiStageCompactor().compact([block({ id: "one", content }), block({ id: "two", content })], summary());
    expect(output.map((candidate) => candidate.id)).toEqual(["one", "two"]);
  });
});

describe("context compaction: consistent token estimation", () => {
  it.each([DefaultCompactor, MultiStageCompactor])("counts Unicode summary bytes through the default estimator in %s", async (CompactorClass) => {
    const output = await new CompactorClass().compact([block({ source: "tool" })], summary({ goal: "优化智能体🙂".repeat(40) }));
    const digest = output.find((candidate) => candidate.id === "compaction-summary")!;
    expect(digest.tokens).toBe(DEFAULT_TOKEN_ESTIMATOR.estimate(digest.content));
  });

  it("keeps Unicode rehydration inside its actual default-estimator budget", () => {
    const output = buildRehydrationBlocks(summary({ filesChanged: [`src/${"界".repeat(20)}.ts`] }), { maxTokens: 20 });
    expect(output.reduce((total, candidate) => total + DEFAULT_TOKEN_ESTIMATOR.estimate(candidate.content), 0)).toBeLessThanOrEqual(20);
    expect(output.every((candidate) => candidate.tokens === DEFAULT_TOKEN_ESTIMATOR.estimate(candidate.content))).toBe(true);
  });

  it("uses an injected estimator for preview and summary generation", async () => {
    const tokenEstimator = { estimate: () => 7 };
    const preview = await new MultiStageCompactor({ previewMaxBytes: 32, tokenEstimator }).compact([block({ content: "x".repeat(100) })], summary());
    expect(preview[0]?.tokens).toBe(7);
    const digest = new DefaultCompactor({ tokenEstimator }).compact([block({ source: "tool" })], summary());
    expect(digest[0]?.tokens).toBe(7);
  });

  it("uses the injected estimator for messages and quarantine envelopes", async () => {
    const tokenEstimator = { estimate: () => 7 };
    const tp = pipeline({ tokenEstimator, injectionScanner: (content) => ({ hasInjection: content.includes("INJECT"), reasons: ["test"] }) });
    const result = await tp.build({ ...buildOpts([block({ id: "bad", content: "INJECT攻击" })], 1000), messages: [{ role: "user", content: "hello" }, { role: "assistant", content: "回复" }], quarantineInjection: true });
    expect(result.blocks.find((candidate) => candidate.id === "bad:quarantine")?.tokens).toBe(7);
    expect(result.report.messagesTokens).toBe(30); // 2 × (content 7 + structure 8)
  });

  it("uses one injected estimator for the default compactor and rehydrated blocks", async () => {
    const result = await pipeline({ tokenEstimator: { estimate: () => 7 } }).build(buildOpts(effectiveInput()));
    expect(result.summary?.tokens).toBe(7);
    expect(result.blocks.filter((candidate) => candidate.id.startsWith("rehydrate:")).every((candidate) => candidate.tokens === 7)).toBe(true);
  });

  it("keeps message estimation backward compatible and supports an explicit adapter", () => {
    const messages = [{ role: "user", content: "🙂中文" }];
    expect(estimateMessageTokens(messages)).toBe(8 + DEFAULT_TOKEN_ESTIMATOR.estimate(messages[0]!.content));
    expect(estimateMessageTokens(messages, { estimate: () => 11 })).toBe(19);
  });
});

describe("context compaction: truthful per-build feedback", () => {
  it("opens after ineffective builds even when an earlier build was effective", async () => {
    const breaker = new CompactionCircuitBreaker({ maxConsecutiveIneffective: 3 });
    const tp = pipeline({ compactionBreaker: breaker });
    await tp.build(buildOpts(effectiveInput()));
    expect(breaker.metrics.effectiveCompactions).toBe(1);
    for (let index = 0; index < 3; index++) await tp.build(ineffectiveOpts());
    expect(breaker.state).toBe("open");
    expect(breaker.metrics.ineffectiveCompactions).toBe(3);
    expect(breaker.metrics.last?.beforeTokens).toBe(1);
    expect(breaker.metrics.last?.afterTokens).toBe(1);
  });

  it("keeps concurrent default builds' effectiveness metrics independent", async () => {
    const breaker = new CompactionCircuitBreaker();
    const tp = pipeline({ compactionBreaker: breaker });
    await Promise.all([tp.build(buildOpts(effectiveInput())), tp.build(ineffectiveOpts())]);
    expect(breaker.metrics.effectiveCompactions).toBe(1);
    expect(breaker.metrics.ineffectiveCompactions).toBe(1);
  });

  it("records actual input and output for an injected compactor", async () => {
    const breaker = new CompactionCircuitBreaker();
    const compactor: Compactor = { compact: (input) => input.filter((candidate) => candidate.source === "system") };
    const result = await pipeline({ compactor, compactionBreaker: breaker }).build(buildOpts(effectiveInput()));
    expect(breaker.metrics.last?.beforeTokens).toBe(81);
    expect(breaker.metrics.last?.afterTokens).toBe(result.report.used);
    expect(breaker.metrics.effectiveCompactions).toBe(1);
  });

  it("includes post-compaction rehydration in the measured final footprint", async () => {
    const breaker = new CompactionCircuitBreaker();
    const result = await pipeline({ compactionBreaker: breaker }).build({ ...buildOpts(effectiveInput()), summaryOverride: summary({ openTasks: ["validate acceptance"] }) });
    expect(result.blocks.some((candidate) => candidate.id === "rehydrate:plan")).toBe(true);
    expect(breaker.metrics.last?.afterTokens).toBe(result.report.used);
    expect(result.report.available).toBe(100 - result.report.used);
  });

  it("records compaction failure and skips further calls after the breaker opens", async () => {
    const breaker = new CompactionCircuitBreaker({ maxConsecutiveIneffective: 1 });
    const compact = vi.fn(() => { throw new Error("compactor unavailable"); });
    const tp = pipeline({ compactor: { compact }, compactionBreaker: breaker });
    await expect(tp.build(ineffectiveOpts())).rejects.toThrow("compactor unavailable");
    expect(breaker.state).toBe("open");
    const next = await tp.build(ineffectiveOpts());
    expect(next.compactionBreakerOpen).toBe(true);
    expect(compact).toHaveBeenCalledTimes(1);
  });

  it("records elapsed compaction latency", async () => {
    const breaker = new CompactionCircuitBreaker();
    const clock = vi.spyOn(performance, "now").mockReturnValueOnce(100).mockReturnValue(125);
    try {
      await pipeline({ compactionBreaker: breaker }).build(ineffectiveOpts());
      expect(breaker.metrics.last?.latencyMs).toBe(25);
    } finally { clock.mockRestore(); }
  });

  it("reports protected overflow without evicting or rewriting anchors", async () => {
    const anchor = block({ id: "user-goal", source: "user", trust: "trusted", compressible: false, content: "preserve ".repeat(20) });
    const result = await pipeline().build(buildOpts([anchor], 10));
    expect(result.blocks.find((candidate) => candidate.id === anchor.id)).toBe(anchor);
    expect(result.report.available).toBe(10 - result.report.used);
    expect(result.report.available).toBeLessThan(0);
  });
});
