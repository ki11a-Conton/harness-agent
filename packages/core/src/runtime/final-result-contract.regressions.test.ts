import { describe, expect, it } from "vitest";
import { newAgentId, newToolCallId, type AgentDefinition, type ModelEvent, type ModelFinalResult, type ModelRequest } from "@ar/contracts";
import { ScriptedModelProvider } from "@ar/model";
import { AgentRuntime } from "./runtime.js";
import { MemoryEventStore, MemorySessionStore, defaultTestToolCatalog } from "../test/fakes.js";
import { FakeOrchestrator } from "../test/fake-orchestrator.js";

async function run(final: ModelFinalResult, deltas: ModelEvent[] = [], maxOutputChars = 5) {
  const agent: AgentDefinition = { id: newAgentId(), name: "final-result-contract", description: "terminal-only provider contract", mode: "primary",
    model: { providerId: "scripted", modelId: "scripted-model" }, systemPrompt: "test", tools: {}, permissions: { rules: [] }, skills: {},
    limits: { maxTurns: 3, maxOutputChars } };
  const store = new MemorySessionStore(), events = new MemoryEventStore(), orchestrator = new FakeOrchestrator();
  const provider = new ScriptedModelProvider([[...deltas, { type: "completed", result: final, timestamp: 0 }], ScriptedModelProvider.text("done")]);
  const requests: ModelRequest[] = [], createClient = provider.createClient.bind(provider);
  provider.createClient = (model, config) => {
    const client = createClient(model, config);
    return { async *generate(request: unknown, signal: AbortSignal) {
      requests.push(structuredClone(request) as ModelRequest);
      yield* client.generate(request, signal);
    } };
  };
  const runtime = new AgentRuntime({ store, events, orchestrator, modelProvider: provider, agents: [agent], now: () => 0,
    toolRegistry: defaultTestToolCatalog(), permissiveToolResolution: true });
  const session = await runtime.createSession({ agent, cwd: "/work" });
  const turn = await runtime.startTurn(session.id, "complete the change");
  const outcome = await runtime.runTurn(session.id, turn.id, new AbortController().signal);
  return { store, events, orchestrator, provider, requests, outcome, history: await store.listMessages(session.id) };
}

describe("final model results remain part of the runtime contract", () => {
  it.each([{ name: "final only", deltas: [] }, { name: "short prefix", deltas: [{ type: "text_delta", text: "ab", timestamp: 0 }] }] satisfies Array<{ name: string; deltas: ModelEvent[] }>)(
    "meters $name text before any requested tool executes", async ({ deltas }) => {
      const call = { id: newToolCallId(), name: "write_file", args: { path: "must-not-run.txt", content: "blocked" } };
      const h = await run({ finishReason: "tool_calls", text: "123456", toolCalls: [call] }, deltas);
      expect(h.outcome.status).toBe("failed");
      expect(h.outcome.terminationReason).toBe("agent_limit");
      expect(h.outcome.error?.code).toBe("RESOURCE_LIMIT");
      expect(h.orchestrator.calls).toHaveLength(0);
      expect(h.provider.calls).toHaveLength(1);
      expect(h.events.events.filter(event => event.type === "run.limit_reached")).toMatchObject([{ payload: { limit: "maxOutputChars", used: 6, allowed: 5 } }]);
      const assistant = h.history.findIndex(message => message.role === "assistant");
      expect(h.history[assistant]).toMatchObject({ content: "123456", toolCalls: [call] });
      expect(h.history[assistant + 1]).toMatchObject({ role: "tool", toolCallId: call.id });
      expect(h.history[assistant + 1]!.content).toContain("[not executed]");
    });

  it("a shorter terminal replacement does not refund already streamed output", async () => {
    const h = await run({ finishReason: "stop", text: "end" }, [{ type: "text_delta", text: "123456", timestamp: 0 }]);
    expect(h.outcome.status).toBe("failed");
    expect(h.events.events.find(event => event.type === "run.limit_reached")?.payload).toMatchObject({ used: 6, allowed: 5 });
  });

  it.each([{ name: "final only", deltas: [] }, { name: "identical prefix", deltas: [{ type: "text_delta", text: "12345", timestamp: 0 }] }] satisfies Array<{ name: string; deltas: ModelEvent[] }>)(
    "accepts the exact output boundary for $name without counting twice", async ({ deltas }) => {
      const h = await run({ finishReason: "stop", text: "12345" }, deltas);
      expect(h.outcome.status).toBe("completed");
      expect(h.events.events.some(event => event.type === "run.limit_reached")).toBe(false);
      expect(h.history.filter(message => message.role === "assistant").map(message => message.content)).toEqual(["12345"]);
    });

  it.each([
    { streamed: "", final: "synthetic terminal reasoning", expected: "synthetic terminal reasoning" },
    { streamed: "synthetic prefix", final: "synthetic canonical reasoning", expected: "synthetic canonical reasoning" },
    { streamed: "synthetic prefix", final: "", expected: undefined },
    { streamed: "synthetic prefix", final: undefined, expected: "synthetic prefix" },
  ])("retains canonical reasoning privately for the next provider request: $expected", async row => {
    const call = { id: newToolCallId(), name: "read_file", args: { path: "proof.txt" } };
    const h = await run({ finishReason: "tool_calls", text: "done", toolCalls: [call], ...(row.final === undefined ? {} : { reasoningContent: row.final }) },
      row.streamed ? [{ type: "reasoning_delta", text: row.streamed, timestamp: 0 }] : [], 100);
    expect(h.outcome.status).toBe("completed");
    expect(h.history.find(message => message.role === "assistant")?.reasoningContent).toBe(row.expected);
    expect(h.requests).toHaveLength(2);
    expect(h.requests[1]!.messages.find(message => message.role === "assistant")?.reasoningContent).toBe(row.expected);
    expect(JSON.stringify(h.events.events)).not.toContain("synthetic");
  });
});
