import { describe, expect, it } from "vitest";
import { newToolCallId } from "@ar/contracts";
import { ContextPipeline, estimateMessageTokens } from "./pipeline.js";
import { DEFAULT_TOKEN_ESTIMATOR } from "./tokenizer.js";

const call = (args: Record<string, unknown> = {}) => ({ id: newToolCallId(), name: "edit_file", args });
const budget = { maxTokens: 1_000, reserved: { system: 0, task: 0, output: 0 }, dynamic: 0 };

describe("message payload budget regressions", () => {
  it("keeps plain-text message estimates compatible, including UTF-8 and empty bodies", () => {
    const messages = [{ role: "user", content: "中文🙂" }, { role: "assistant", content: "" }];
    expect(estimateMessageTokens([])).toBe(0);
    expect(estimateMessageTokens(messages)).toBe(8 + 3 + 8);
  });

  it("counts a large tool argument even when assistant content is empty", () => {
    const messages = [{ role: "assistant", content: "", toolCalls: [call({ content: "x".repeat(32_000) })] }];
    expect(estimateMessageTokens(messages)).toBeGreaterThan(8_000);
  });

  it("counts reasoning content that the provider must replay", () => {
    const messages = [{ role: "assistant", content: "", reasoningContent: "中文🙂".repeat(3_000) }];
    expect(estimateMessageTokens(messages)).toBe(8 + 7_500);
  });

  it("counts a tool-result correlation id", () => {
    expect(estimateMessageTokens([{ role: "tool", content: "", toolCallId: "x".repeat(4_000) }])).toBe(1_008);
  });

  it("counts every call's structure, id, name and JSON-escaped arguments", () => {
    const calls = [call({ text: '中文🙂\n"quoted"\\path' }), call({ text: "second", count: 2 })];
    const input = { role: "assistant", content: "body", toolCalls: calls, reasoningContent: "thinking" };
    const estimate = (text: string) => DEFAULT_TOKEN_ESTIMATOR.estimate(text);
    const expected = 8 + estimate(input.content) + estimate(input.reasoningContent)
      + calls.reduce((total, item) => total + 8 + estimate(item.id) + estimate(item.name) + estimate(JSON.stringify(item.args)), 0);
    expect(estimateMessageTokens([input])).toBe(expected);
  });

  it("routes all payload fields through the injected estimator", () => {
    const seen: string[] = [];
    const item = call({ text: "payload" });
    const estimator = { estimate: (text: string) => { seen.push(text); return 3; } };
    expect(estimateMessageTokens([{ role: "assistant", content: "body", reasoningContent: "thought", toolCalls: [item] }], estimator)).toBe(31);
    expect(seen).toEqual(["body", "thought", item.id, item.name, JSON.stringify(item.args)]);
  });

  it("ignores assistant-only and tool-only metadata on user messages", () => {
    const input = { role: "user", content: "hello", reasoningContent: "ignored".repeat(1_000), toolCalls: [call({ text: "ignored" })], toolCallId: "ignored" };
    expect(estimateMessageTokens([input])).toBe(10);
  });

  it("ignores tool-only metadata on assistant messages", () => {
    expect(estimateMessageTokens([{ role: "assistant", content: "hello", toolCallId: "ignored".repeat(1_000) }])).toBe(10);
  });

  it("ignores assistant-only metadata on tool messages", () => {
    const input = { role: "tool", content: "", reasoningContent: "ignored".repeat(1_000), toolCalls: [call({ text: "ignored" })] };
    expect(estimateMessageTokens([input])).toBe(8);
  });

  it("does not modify frozen call arguments, reasoning or message fields", () => {
    const item = Object.freeze(call(Object.freeze({ content: "x".repeat(10_000) })));
    const input = Object.freeze({ role: "assistant", content: "", reasoningContent: "thinking", toolCalls: Object.freeze([item]) });
    const before = JSON.stringify(input);
    expect(estimateMessageTokens([input])).toBeGreaterThan(2_500);
    expect(JSON.stringify(input)).toBe(before);
  });

  it.each(["bigint", "cycle"])("refuses unserializable %s tool arguments rather than silently undercounting", (kind) => {
    const args: Record<string, unknown> = kind === "bigint" ? { value: 1n } : {};
    if (kind === "cycle") args.self = args;
    expect(() => estimateMessageTokens([{ role: "assistant", content: "", toolCalls: [call(args)] }])).toThrow();
  });

  it("reports the complete history using the same injected estimator as its public counting method", async () => {
    const estimator = { estimate: (text: string) => Buffer.byteLength(text, "utf8") };
    const pipeline = new ContextPipeline({ discovery: { discover: async () => [] }, tokenEstimator: estimator });
    const messages = [{ role: "assistant", content: "", reasoningContent: "中文", toolCalls: [call({ text: "a".repeat(2_000) })] }];
    const result = await pipeline.build({ cwd: ".", systemPrompt: "sys", priorBlocks: [], budget, messages });
    expect(result.report.messagesTokens).toBeGreaterThan(2_000);
    expect(result.report.messagesTokens).toBe(pipeline.estimateMessageTokens(messages));
    expect(result.report.messagesTokens).toBe(estimateMessageTokens(messages, estimator));
    expect(result.compacted).toBe(false);
    expect(result.blocks.map((block) => block.content)).toEqual(["sys"]);
  });

  it("allows the host to count a newly appended digest before another build", () => {
    const pipeline = new ContextPipeline({ tokenEstimator: { estimate: () => 17 } });
    expect(pipeline.estimateMessageTokens([{ role: "system", content: "state digest" }])).toBe(25);
  });
});
