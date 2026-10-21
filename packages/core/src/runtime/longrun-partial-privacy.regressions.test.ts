import { expect, it } from "vitest";
import { errorInfo, newAgentId, newMessageId, newToolCallId, type AgentDefinition, type ModelEvent, type ModelProvider } from "@ar/contracts";
import { ContextPipeline } from "@ar/context";
import { AgentRuntime } from "./runtime.js";
import { MemoryEventStore, MemorySessionStore, defaultTestToolCatalog } from "../test/fakes.js";
import { FakeOrchestrator } from "../test/fake-orchestrator.js";

const PRIVATE = "PRIVATE_INTERRUPTED_THINKING_271828";
const PRIVATE_SUMMARY = "PRIVATE_INTERRUPTED_SUMMARY_314159";
const error: ModelEvent = { type: "error", error: errorInfo("MODEL_ERROR", "socket reset", {
  retryable: false, safeToRetry: false, provider: { kind: "network" },
}), timestamp: 0 };
const agent: AgentDefinition = { id: newAgentId(), name: "partial-privacy", description: "offline", mode: "primary",
  model: { providerId: "offline", modelId: "offline" }, systemPrompt: "Continue coding.", tools: {}, permissions: { rules: [] }, skills: {}, limits: {} };

it("does not turn reasoning-only or partial tool intent into canonical visible history", async () => {
  let calls = 0;
  const provider: ModelProvider = { id: "offline", listModels: async () => [], createClient: () => ({ async *generate() {
    calls++;
    yield { type: "reasoning_delta", text: PRIVATE, timestamp: 0 } as ModelEvent;
    yield { type: "tool_call_delta", toolCall: { id: newToolCallId(), name: "write_file", args: { path: "must-not-run", content: "intent" } }, timestamp: 0 } as ModelEvent;
    yield error;
  } }) };
  const store = new MemorySessionStore(), events = new MemoryEventStore(), orchestrator = new FakeOrchestrator();
  const runtime = new AgentRuntime({ store, events, agents: [agent], modelProvider: provider, orchestrator,
    toolRegistry: defaultTestToolCatalog(), permissiveToolResolution: true });
  const session = await runtime.createSession({ agent, cwd: "/offline" }), turn = await runtime.startTurn(session.id, "work");
  expect(await runtime.runTurn(session.id, turn.id, new AbortController().signal)).toMatchObject({ status: "failed", terminationReason: "model_error" });
  expect(calls).toBe(1); expect(orchestrator.calls).toHaveLength(0);
  expect(store.messages.filter(message => message.role === "assistant")).toHaveLength(0);
  expect(events.events.find(event => event.type === "model.failed")?.payload.messageId).toBeUndefined();
  expect(events.events.filter(event => event.type === "model.completed" || event.type === "verification.started")).toHaveLength(0);
  expect(JSON.stringify({ messages: store.messages, events: events.events })).not.toContain(PRIVATE);
});

it("keeps failed private compaction text out of canonical chat and visible failure payloads", async () => {
  let summaries = 0, coding = 0;
  const provider: ModelProvider = { id: "offline", listModels: async () => [], createClient: () => ({ async *generate(request) {
    if (request.system?.includes("CONTEXT CHECKPOINT COMPACTION")) {
      summaries++;
      yield { type: "reasoning_delta", text: PRIVATE, timestamp: 0 } as ModelEvent;
      yield { type: "text_delta", text: PRIVATE_SUMMARY, timestamp: 0 } as ModelEvent;
      yield error;
    } else {
      coding++;
      yield { type: "completed", result: { finishReason: "stop", text: "Visible coding answer" }, timestamp: 0 } as ModelEvent;
    }
  } }) };
  const store = new MemorySessionStore(), events = new MemoryEventStore();
  const runtime = new AgentRuntime({ store, events, agents: [agent], modelProvider: provider, orchestrator: new FakeOrchestrator(),
    context: { pipeline: new ContextPipeline({ historyCompaction: true, discovery: { discover: async () => [] } }),
      budget: { maxTokens: 2500, reserved: { system: 0, task: 0, output: 300 }, dynamic: 0 } } });
  const session = await runtime.createSession({ agent, cwd: "/offline" });
  for (let index = 0; index < 12; index++) await store.appendMessage({ id: newMessageId(), sessionId: session.id,
    role: "assistant", content: `Historical result ${index}: ` + "progress observed in old code ".repeat(100), createdAt: index });
  const turn = await runtime.startTurn(session.id, "Continue the original task.");
  expect(await runtime.runTurn(session.id, turn.id, new AbortController().signal)).toMatchObject({ status: "completed" });
  expect(summaries).toBe(1); expect(coding).toBe(1);
  const failure = events.events.find(event => event.type === "model.failed" && event.payload.purpose === "compaction");
  expect(failure).toBeDefined(); expect(failure!.payload.messageId).toBeUndefined(); expect(failure!.payload.text).toBeUndefined();
  expect(store.messages.filter(message => message.incomplete)).toHaveLength(0);
  const durable = JSON.stringify({ messages: store.messages, events: events.events });
  expect(durable).not.toContain(PRIVATE); expect(durable).not.toContain(PRIVATE_SUMMARY);
});
