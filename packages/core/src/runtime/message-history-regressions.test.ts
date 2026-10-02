import { describe, expect, it } from "vitest";
import type { AgentDefinition, Message, ModelRef, ModelRequest, ProviderConfig } from "@ar/contracts";
import { assertToolProtocol, dropOrphanToolResults, newAgentId, newMessageId, newSessionId, newToolCallId } from "@ar/contracts";
import { ContextPipeline, DEFAULT_TOKEN_ESTIMATOR, estimateMessageTokens } from "@ar/context";
import { ScriptedModelProvider } from "@ar/model";
import { trimMessageHistory } from "./turn-helpers.js";
import { AgentRuntime } from "./runtime.js";
import { MemoryEventStore, MemorySessionStore, defaultTestToolCatalog } from "../test/fakes.js";
import { FakeOrchestrator } from "../test/fake-orchestrator.js";

const sessionId = newSessionId();
function message(role: Message["role"], content = "", extra: Partial<Message> = {}): Message {
  return { id: newMessageId(), sessionId, role, content, createdAt: 0, ...extra };
}
const plainHistory = (count: number) => Array.from({ length: count }, (_, i) => message(i % 2 === 0 ? "user" : "assistant", `row-${i} `));

describe("linear history trim regressions", () => {
  it("prices each message once using the supplied counter", () => {
    const history = plainHistory(2_000);
    const calls = new Map<string, number>();
    const trimmed = trimMessageHistory(history, 8, (item) => {
      calls.set(item.id, (calls.get(item.id) ?? 0) + 1);
      return 2;
    });
    expect(trimmed.map((item) => item.id)).toEqual(history.slice(-4).map((item) => item.id));
    expect(calls.size).toBe(history.length);
    expect([...calls.values()].every((count) => count === 1)).toBe(true);
  });

  it("keeps the maximal suffix that fits a supplied per-message budget", () => {
    const history = plainHistory(10);
    expect(trimMessageHistory(history, 60, () => 10)).toEqual(history.slice(-6));
  });

  it.each([40, 49, 50, 51])("honors the inclusive %i-token boundary", (headroom) => {
    const history = Array.from({ length: 5 }, () => message("user", "12345678"));
    const expected = headroom < 50 ? history.slice(-4) : history;
    expect(trimMessageHistory(history, headroom)).toEqual(expected);
  });

  it.each([0, -1, -Infinity])("keeps the existing four-message floor at headroom %s", (headroom) => {
    const history = plainHistory(10);
    expect(trimMessageHistory(history, headroom)).toEqual(history.slice(-4));
  });

  it.each([Infinity, NaN])("preserves history with unbounded/non-orderable headroom %s", (headroom) => {
    const history = plainHistory(10);
    expect(trimMessageHistory(history, headroom)).toEqual(history);
  });

  it.each([0, 1, 3, 4])("preserves a %i-message short history without invoking its counter", (length) => {
    const history = plainHistory(length);
    expect(trimMessageHistory(history, 0, () => { throw new Error("short tail must not be priced"); })).toEqual(history);
  });

  it("trims a large old tool call with an empty body and repairs its leading results", () => {
    const id = newToolCallId();
    const history = [message("user", "old request"), message("assistant", "", { toolCalls: [{ id, name: "edit_file", args: { content: "x".repeat(32_000) } }] }), message("tool", "ok", { toolCallId: id }), ...plainHistory(4)];
    assertToolProtocol(history);
    const trimmed = trimMessageHistory(history, 500);
    expect(trimmed.map((item) => item.id)).toEqual(history.slice(-4).map((item) => item.id));
    assertToolProtocol(trimmed);
  });

  it("keeps complete multi-call blocks when they fit", () => {
    const ids = [newToolCallId(), newToolCallId()];
    const history = [message("user", "old"), message("assistant", "", { toolCalls: ids.map((id) => ({ id, name: "read_file", args: { path: "a" } })) }), ...ids.map((id) => message("tool", "ok", { toolCallId: id })), message("assistant", "done")];
    const trimmed = trimMessageHistory(history, 10_000);
    expect(trimmed).toEqual(history);
    assertToolProtocol(trimmed);
  });

  it("drops only leading orphan results when a prefix ends inside a tool block", () => {
    const ids = [newToolCallId(), newToolCallId()];
    const history = [message("user", "old"), message("assistant", "", { toolCalls: ids.map((id) => ({ id, name: "read_file", args: {} })) }), ...ids.map((id) => message("tool", "ok", { toolCallId: id })), ...plainHistory(2)];
    const trimmed = trimMessageHistory(history, 0);
    expect(trimmed).toEqual(history.slice(-2));
    assertToolProtocol(trimmed);
  });

  it("preserves internal corruption for the existing send-boundary refusal", () => {
    const id = newToolCallId();
    const history = [message("assistant", "", { toolCalls: [{ id, name: "read_file", args: {} }] }), message("system", "illegal interleaving"), message("tool", "result", { toolCallId: id }), message("user", "continue")];
    const trimmed = trimMessageHistory(history, 0);
    expect(trimmed).toEqual(history);
    expect(() => assertToolProtocol(trimmed)).toThrow(/protocol violation/);
  });

  it("never mutates the input array or message objects", () => {
    const history = Object.freeze(plainHistory(10).map((item) => Object.freeze(item)));
    const before = JSON.stringify(history);
    const trimmed = trimMessageHistory(history, 1_000);
    expect(trimmed).not.toBe(history);
    expect(trimmed[0]).toBe(history[0]);
    expect(JSON.stringify(history)).toBe(before);
  });

  it("matches the previous suffix policy for varied text-only histories", () => {
    let seed = 73;
    const random = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed; };
    for (let round = 0; round < 200; round++) {
      const history = Array.from({ length: 5 + random() % 40 }, (_, i) => message(i % 2 ? "user" : "assistant", "中文🙂x".repeat(random() % 20)));
      const headroom = random() % 800;
      let previous = [...history];
      while (previous.length > 4 && previous.reduce((total, item) => total + 8 + Math.ceil(Buffer.byteLength(item.content, "utf8") / 4), 0) > headroom) previous = previous.slice(1);
      expect(trimMessageHistory(history, headroom)).toEqual(dropOrphanToolResults(previous));
    }
  });
});

class RecordingProvider extends ScriptedModelProvider {
  readonly requests: ModelRequest[] = [];
  override createClient(model: ModelRef, config: ProviderConfig) {
    const delegate = super.createClient(model, config);
    return { generate: (request: unknown, signal: AbortSignal) => {
      this.requests.push(request as ModelRequest);
      return delegate.generate(request, signal);
    } };
  }
}

const AGENT: AgentDefinition = {
  id: newAgentId(), name: "history-regression", description: "history budget regression", mode: "primary",
  model: { providerId: "scripted", modelId: "scripted-model" }, systemPrompt: "Continue the current task.",
  tools: {}, permissions: { rules: [] }, skills: {}, limits: {},
};

describe("real runtime message-budget regressions", () => {
  it.each(["tool-arguments", "reasoning", "custom-estimator"])("trims %s using the reported budget while retaining durable evidence", async (scenario) => {
    const estimator = scenario === "custom-estimator" ? { estimate: (text: string) => 4 * Buffer.byteLength(text, "utf8") } : DEFAULT_TOKEN_ESTIMATOR;
    const pipeline = new ContextPipeline({ discovery: { discover: async () => [] }, tokenEstimator: estimator });
    const maxTokens = scenario === "custom-estimator" ? 4_000 : 1_000;
    const store = new MemorySessionStore();
    const events = new MemoryEventStore();
    const provider = new RecordingProvider([ScriptedModelProvider.text("done")]);
    const runtime = new AgentRuntime({ store, events, modelProvider: provider, orchestrator: new FakeOrchestrator(),
      agents: [AGENT], toolRegistry: defaultTestToolCatalog(), permissiveToolResolution: true,
      context: { pipeline, budget: { maxTokens, reserved: { system: 0, task: 0, output: 0 }, dynamic: 0 } } });
    const session = await runtime.createSession({ agent: AGENT, cwd: "/history-regression" });
    const id = newToolCallId();
    const originals = scenario === "custom-estimator"
      ? Array.from({ length: 30 }, (_, i) => message(i % 2 ? "assistant" : "user", `${i}: ${"x".repeat(80)}`))
      : [message("user", "old request"),
        message("assistant", "", scenario === "tool-arguments"
          ? { toolCalls: [{ id, name: "edit_file", args: { content: "x".repeat(32_000) } }] }
          : { reasoningContent: "中文🙂".repeat(3_000) }),
        ...(scenario === "tool-arguments" ? [message("tool", "ok", { toolCallId: id })] : []),
        ...plainHistory(4)];
    for (const item of originals) await store.appendMessage({ ...item, sessionId: session.id });
    const turn = await runtime.startTurn(session.id, "CURRENT TASK: keep this goal");
    const outcome = await runtime.runTurn(session.id, turn.id, new AbortController().signal);
    expect(outcome.status).toBe("completed");
    expect(provider.requests).toHaveLength(1);
    const request = provider.requests[0]!;
    const eventList = await events.list(session.id);
    const report = eventList.find((event) => event.type === "context.built")!.payload;
    const headroom = maxTokens - Number(report.used);
    expect(estimateMessageTokens(request.messages, estimator)).toBeLessThanOrEqual(headroom);
    expect(request.messages.some((item) => item.content.includes("CURRENT TASK: keep this goal"))).toBe(true);
    expect(request.messages.some((item) => item.content.includes("message history trimmed"))).toBe(true);
    expect(eventList.some((event) => event.type === "context.compacted" && event.payload.reason === "message-history trim (context budget)")).toBe(true);
    assertToolProtocol(request.messages);
    const durable = await store.listMessages(session.id);
    for (const original of originals) expect(durable.find((item) => item.id === original.id)).toEqual({ ...original, sessionId: session.id });
    expect(durable.length).toBeGreaterThan(request.messages.length);
  });
});
