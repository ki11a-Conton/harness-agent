import { describe, expect, it } from "vitest";
import { newAgentId, newToolCallId, type AgentDefinition, type AgentEvent, type Message, type ModelEvent, type RunLimits, type UsageSnapshot } from "@ar/contracts";
import { ScriptedModelProvider } from "@ar/model";
import { AgentRuntime } from "./runtime.js";
import { MemoryEventStore, MemorySessionStore, defaultTestToolCatalog } from "../test/fakes.js";
import { FakeOrchestrator } from "../test/fake-orchestrator.js";

const measured = { inputTokens: 10, outputTokens: 5, estimatedCostUsd: 0.5 };

function setup(script: ModelEvent[] | AsyncIterable<ModelEvent>, limits: RunLimits, now: () => number = () => 0) {
  const agent: AgentDefinition = { id: newAgentId(), name: "completed-call-accounting", description: "account early terminal boundaries", mode: "primary",
    model: { providerId: "scripted", modelId: "scripted-model" }, systemPrompt: "test", tools: {}, permissions: { rules: [] }, skills: {}, limits };
  const store = new MemorySessionStore(), events = new MemoryEventStore(), orchestrator = new FakeOrchestrator();
  const provider = new ScriptedModelProvider([script]);
  const reports: Array<{ usage: UsageSnapshot; assistant: Message[]; completed: AgentEvent[] }> = [];
  const runtime = new AgentRuntime({ store, events, orchestrator, modelProvider: provider, agents: [agent], now,
    toolRegistry: defaultTestToolCatalog(), permissiveToolResolution: true,
    reportModelUsage(sessionId, usage) {
      // The scheduler callback must observe the durable call record already
      // committed, even when this response can only finish the turn.
      reports.push(structuredClone({ usage,
        assistant: store.messages.filter(message => message.sessionId === sessionId && message.role === "assistant"),
        completed: events.events.filter(event => event.sessionId === sessionId && event.type === "model.completed"),
      }));
    },
  });
  return { agent, store, events, orchestrator, provider, reports, runtime };
}

async function run(h: ReturnType<typeof setup>) {
  const session = await h.runtime.createSession({ agent: h.agent, cwd: "/work" });
  const turn = await h.runtime.startTurn(session.id, "complete the change");
  const outcome = await h.runtime.runTurn(session.id, turn.id, new AbortController().signal);
  return { session, turn, outcome };
}

function expectRecordedBeforeReport(h: ReturnType<typeof setup>, text: string, maxEstimatedCostUsd: number, terminal: "turn.failed" | "turn.cancelled" = "turn.failed") {
  expect(h.reports).toHaveLength(1);
  expect(h.reports[0]!.usage).toMatchObject({ ...measured, source: "measured" });
  expect(h.reports[0]!.assistant.map(message => message.content)).toEqual([text]);
  expect(h.reports[0]!.completed).toHaveLength(1);
  expect(h.reports[0]!.completed[0]!.payload).toMatchObject({ text, usage: { ...measured, source: "measured" } });
  expect(h.events.events.filter(event => event.type === "model.completed")).toHaveLength(1);
  const costLimits = h.events.events.filter(event => event.type === "run.limit_reached" && event.payload.limit === "maxEstimatedCostUsd");
  expect(costLimits).toHaveLength(maxEstimatedCostUsd < measured.estimatedCostUsd ? 1 : 0);
  if (costLimits.length > 0) expect(costLimits[0]!.payload).toMatchObject({ used: 0.5, allowed: maxEstimatedCostUsd });
  expect(h.provider.calls).toHaveLength(1);
  expect(h.orchestrator.calls).toHaveLength(0);
  expect(h.events.events.some(event => event.type === "tool.started" || event.type === "verification.started" || event.type === "turn.completed")).toBe(false);
  const completedIndex = h.events.events.findIndex(event => event.type === "model.completed");
  expect(completedIndex).toBeLessThan(h.events.events.findIndex(event => event.type === terminal));
}

describe("completed model calls remain accounted on early terminal boundaries", () => {
  it("records and meters a completed response before retaining its wall-clock time_limit", async () => {
    for (const maxEstimatedCostUsd of [1, 0.25]) {
      let clock = 0;
      const text = "late metered answer";
      const script: AsyncIterable<ModelEvent> = (async function* () {
        yield { type: "started", timestamp: 0 };
        yield { type: "text_delta", text, timestamp: 0 };
        clock = 51;
        yield { type: "completed", result: { finishReason: "stop", text, usage: measured }, timestamp: clock };
      })();
      const h = setup(script, { maxDurationMs: 50, maxEstimatedCostUsd }, () => clock);
      const { turn, outcome } = await run(h);
      expect(outcome.status).toBe("failed");
      expect(outcome.terminationReason).toBe("time_limit");
      expect(outcome.error?.code).toBe("RESOURCE_LIMIT");
      expect(outcome.error?.message).toContain("maxDurationMs");
      expect((await h.store.getTurn(turn.id))?.status).toBe("failed");
      expectRecordedBeforeReport(h, text, maxEstimatedCostUsd);
      expect(h.events.events.filter(event => event.type === "run.limit_reached" && event.payload.limit === "maxDurationMs"))
        .toMatchObject([{ payload: { used: 51, allowed: 50 } }]);
    }
  });

  it("records and meters an unrecoverable completed tool response before retaining its model_error", async () => {
    for (const maxEstimatedCostUsd of [1, 0.25]) {
      const text = "malformed metered tool response";
      const call = { id: newToolCallId(), name: "write_file", args: null as unknown as Record<string, unknown> };
      const script: ModelEvent[] = [
        { type: "started", timestamp: 0 }, { type: "text_delta", text, timestamp: 0 },
        { type: "tool_call_delta", toolCall: call, timestamp: 0 },
        { type: "completed", result: { finishReason: "tool_calls", text, toolCalls: [call], usage: measured }, timestamp: 0 },
      ];
      const h = setup(script, { maxEstimatedCostUsd });
      const { session, turn, outcome } = await run(h);
      expect(outcome.status).toBe("failed");
      expect(outcome.terminationReason).toBe("model_error");
      expect(outcome.error?.code).toBe("MODEL_ERROR");
      expect(outcome.error?.message).toContain("all were unrecoverable");
      expect((await h.store.getTurn(turn.id))?.status).toBe("failed");
      expectRecordedBeforeReport(h, text, maxEstimatedCostUsd);
      expect((await h.store.listMessages(session.id)).filter(message => message.role === "assistant"))
        .toMatchObject([{ content: text }]);
      expect(h.reports[0]!.assistant[0]!.toolCalls).toBeUndefined();
      expect(h.reports[0]!.completed[0]!.payload).toMatchObject({ finishReason: "tool_calls", toolCalls: 0, final: false });
      expect(h.events.events.filter(event => event.type === "protocol.repair_failed")).toHaveLength(1);
      expect(h.events.events.some(event => event.type === "tool.requested")).toBe(false);
    }
  });

  it("records and meters a completed response before a late abort cancels and settles its unexecuted tools", async () => {
    for (const maxEstimatedCostUsd of [1, 0.25]) {
      const controller = new AbortController();
      const text = "completed before cancellation";
      const call = { id: newToolCallId(), name: "write_file", args: { path: "must-not-exist.txt", content: "never execute" } };
      const script: AsyncIterable<ModelEvent> = (async function* () {
        yield { type: "started", timestamp: 0 };
        yield { type: "text_delta", text, timestamp: 0 };
        yield { type: "tool_call_delta", toolCall: call, timestamp: 0 };
        yield { type: "completed", result: { finishReason: "tool_calls", text, toolCalls: [call], usage: measured }, timestamp: 0 };
        controller.abort();
      })();
      const h = setup(script, { maxEstimatedCostUsd });
      const session = await h.runtime.createSession({ agent: h.agent, cwd: "/work" });
      const turn = await h.runtime.startTurn(session.id, "complete the change");
      const outcome = await h.runtime.runTurn(session.id, turn.id, controller.signal);
      expect(outcome.status).toBe("cancelled");
      expect(outcome.terminationReason).toBe("cancelled");
      expect((await h.store.getTurn(turn.id))?.status).toBe("cancelled");
      expectRecordedBeforeReport(h, text, maxEstimatedCostUsd, "turn.cancelled");
      const history = await h.store.listMessages(session.id);
      const index = history.findIndex(message => message.role === "assistant");
      expect(history[index]).toMatchObject({ content: text, toolCalls: [call] });
      expect(history[index + 1]).toMatchObject({ role: "tool", toolCallId: call.id });
      expect(history[index + 1]!.content).toContain("[not executed]");
      expect(h.events.events.some(event => event.type === "tool.requested")).toBe(false);
    }
  });
});
