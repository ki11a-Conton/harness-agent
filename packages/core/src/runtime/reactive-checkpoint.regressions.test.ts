import { expect, it } from "vitest";
import type { AgentDefinition, ModelEvent, ModelProvider, ModelRequest } from "@ar/contracts";
import { assertToolProtocol, errorInfo, newAgentId, newMessageId, newPromptId, newToolCallId, newTurnId } from "@ar/contracts";
import { ContextPipeline, renderHistoryCheckpoint } from "@ar/context";
import { AgentRuntime } from "./runtime.js";
import { MemoryEventStore, MemorySessionStore } from "../test/fakes.js";
import { FakeOrchestrator } from "../test/fake-orchestrator.js";

const HANDOFF = "Prior decision: preserve src/legacy.ts and the exact unresolved error E_HISTORICAL_271828.";
const USER = "Continue the same implementation and verify its result.";
const STEER = "[steering] Preserve the configuration 中文🙂 exactly.";
const AGENT: AgentDefinition = {
  id: newAgentId(), name: "reactive-checkpoint", description: "offline regression", mode: "primary",
  model: { providerId: "offline", modelId: "offline" }, systemPrompt: "Continue the current task.",
  tools: {}, permissions: { rules: [] }, skills: {}, limits: {},
};

async function setup(options: { repeatOverflow?: boolean; cancel?: boolean } = {}) {
  const store = new MemorySessionStore(), events = new MemoryEventStore(), requests: ModelRequest[] = [];
  const controller = new AbortController();
  let codingCalls = 0;
  const provider: ModelProvider = { id: "offline", listModels: async () => [], createClient: () => ({
    async *generate(request): AsyncGenerator<ModelEvent> {
      requests.push(request);
      // No summary request is needed for this small checkpoint + tail. A
      // reactive retry must keep the existing handoff without another model.
      if (request.system?.includes("CONTEXT CHECKPOINT COMPACTION")) throw new Error("unexpected summary request");
      codingCalls++;
      if (codingCalls === 1) {
        const active = request.messages.find(message => message.role === "user" && message.content === USER)!;
        await store.appendMessage({ id: newMessageId(), sessionId: active.sessionId, turnId: active.turnId,
          role: "user", content: STEER, promptId: newPromptId(), createdAt: 100 });
        if (options.cancel) controller.abort();
      }
      if (codingCalls === 1 || options.repeatOverflow) yield { type: "error",
        error: errorInfo("CONTEXT_OVERFLOW", "context full", { retryable: false, safeToRetry: false }), timestamp: 0 };
      else yield { type: "completed", result: { finishReason: "stop", text: "done" }, timestamp: 0 };
    },
  }) };
  const runtime = new AgentRuntime({ store, events, modelProvider: provider, agents: [AGENT], orchestrator: new FakeOrchestrator(),
    maxIterationsPerTurn: 5, context: {
      pipeline: new ContextPipeline({ historyCompaction: true, discovery: { discover: async () => [] } }),
      budget: { maxTokens: 10000, reserved: { system: 0, task: 0, output: 1000 }, dynamic: 0 },
    } });
  const session = await runtime.createSession({ agent: AGENT, cwd: "/reactive-checkpoint" }), oldTurn = newTurnId();
  const original = { id: newMessageId(), sessionId: session.id, turnId: oldTurn, role: "assistant" as const,
    content: HANDOFF, createdAt: 0 };
  await store.appendMessage(original);
  const checkpoint = { id: newMessageId(), sessionId: session.id, turnId: oldTurn, role: "assistant" as const,
    content: renderHistoryCheckpoint(HANDOFF), contextCheckpoint: { version: 1 as const, throughMessageId: original.id, source: "model" as const }, createdAt: 1 };
  await store.appendMessage(checkpoint);
  for (let index = 0; index < 24; index++) await store.appendMessage({ id: newMessageId(), sessionId: session.id, turnId: oldTurn,
    role: "assistant", content: `Recent progress ${index}`, createdAt: index + 2 });
  const toolIds = [newToolCallId(), newToolCallId()];
  await store.appendMessage({ id: newMessageId(), sessionId: session.id, turnId: oldTurn, role: "assistant", content: "",
    toolCalls: toolIds.map(id => ({ id, name: "read_file", args: { path: "src/legacy.ts" } })), createdAt: 30 });
  for (const id of toolIds) await store.appendMessage({ id: newMessageId(), sessionId: session.id, turnId: oldTurn,
    role: "tool", toolCallId: id, content: "latest completed read evidence", createdAt: 31 });
  const durableBefore = await store.listMessages(session.id);
  const turn = await runtime.startTurn(session.id, USER);
  const outcome = await runtime.runTurn(session.id, turn.id, controller.signal);
  return { store, session, turn, outcome, requests, checkpoint, durableBefore, toolIds, events };
}

it("keeps the durable handoff, current user/steer and completed tool batch after a reactive overflow", async () => {
  const h = await setup();
  expect(h.outcome.status).toBe("completed"); expect(h.requests).toHaveLength(2);
  for (const request of h.requests) {
    assertToolProtocol(request.messages);
    expect(request.messages.filter(message => message.id === h.checkpoint.id)).toHaveLength(1);
    expect(JSON.stringify(request.messages)).toContain(HANDOFF);
    expect(request.messages.filter(message => message.content === USER)).toHaveLength(1);
    expect(request.messages.filter(message => message.role === "tool").map(message => message.toolCallId)).toEqual(h.toolIds);
  }
  expect(h.requests[1]!.messages.filter(message => message.content === STEER)).toHaveLength(1);
  expect(h.requests[1]!.messages.length).toBeLessThan(h.requests[0]!.messages.length);
  const durable = await h.store.listMessages(h.session.id);
  for (const message of h.durableBefore) expect(durable.find(item => item.id === message.id)).toEqual(message);
  expect(durable.filter(message => message.contextCheckpoint)).toHaveLength(1);
});

it("a second overflow fails within the existing retry bound while retaining the handoff", async () => {
  const h = await setup({ repeatOverflow: true });
  expect(h.outcome.status).toBe("failed"); expect(h.requests).toHaveLength(2);
  expect(h.requests.every(request => request.messages.some(message => message.id === h.checkpoint.id))).toBe(true);
  expect((await h.events.list(h.session.id)).filter(event => event.type === "context.compacted" && event.payload.reactive === true)).toHaveLength(1);
});

it("cancellation during the overflowing request does not start a retry or discard durable context", async () => {
  const h = await setup({ cancel: true });
  expect(h.outcome.status).toBe("cancelled"); expect(h.requests).toHaveLength(1);
  expect((await h.store.listMessages(h.session.id)).find(message => message.id === h.checkpoint.id)).toEqual(h.checkpoint);
});
