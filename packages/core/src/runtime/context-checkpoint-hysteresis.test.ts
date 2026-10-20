import { expect, it } from "vitest";
import { assertToolProtocol, newAgentId, newMessageId, newToolCallId, newTurnId, type AgentDefinition, type ModelEvent, type ModelProvider, type ModelRequest } from "@ar/contracts";
import { ContextPipeline } from "@ar/context";
import { AgentRuntime } from "./runtime.js";
import { MemoryEventStore, MemorySessionStore, defaultTestToolCatalog } from "../test/fakes.js";
import { FakeOrchestrator } from "../test/fake-orchestrator.js";

it("a large protected task does not recompact before every small tool round", async () => {
  const store = new MemorySessionStore(), events = new MemoryEventStore(), requests: ModelRequest[] = [];
  let round = 0;
  const provider: ModelProvider = { id: "bounded", listModels: async () => [], createClient: () => ({
    async *generate(request): AsyncGenerator<ModelEvent> {
      requests.push(request);
      if (request.system?.includes("CONTEXT CHECKPOINT COMPACTION")) {
        yield { type: "completed", result: { finishReason: "stop", text: "Decision: inspect src/fix.ts, preserve the current user constraints and verify before completion." }, timestamp: 0 }; return;
      }
      if (++round <= 3) {
        const call = { id: newToolCallId(), name: "read_file", args: { path: `src/file-${round}.ts` } };
        yield { type: "completed", result: { finishReason: "tool_calls", toolCalls: [call] }, timestamp: 0 };
      } else yield { type: "completed", result: { finishReason: "stop", text: "done" }, timestamp: 0 };
    },
  }) };
  const agent: AgentDefinition = { id: newAgentId(), name: "bounded", description: "test", mode: "primary", model: { providerId: "bounded", modelId: "bounded" },
    systemPrompt: "Inspect the task.", tools: {}, permissions: { rules: [] }, skills: {}, limits: {} };
  const runtime = new AgentRuntime({ store, events, modelProvider: provider, agents: [agent],
    orchestrator: new FakeOrchestrator({ status: "success", output: "small read result" }), toolRegistry: defaultTestToolCatalog(), permissiveToolResolution: true,
    context: { pipeline: new ContextPipeline({ historyCompaction: true, discovery: { discover: async () => [] } }),
      budget: { maxTokens: 10000, reserved: { system: 0, task: 0, output: 500 }, dynamic: 0 } } });
  const session = await runtime.createSession({ agent, cwd: "/bounded-task" });
  const oldTurn = newTurnId();
  for (let i = 0; i < 12; i++) await store.appendMessage({ id: newMessageId(), sessionId: session.id, turnId: oldTurn,
    role: "assistant", content: "Old investigation fact. ".repeat(100), createdAt: i });
  const input = "Exact protected user task: " + "x".repeat(33000);
  const turn = await runtime.startTurn(session.id, input);
  const outcome = await runtime.runTurn(session.id, turn.id, new AbortController().signal);
  expect(outcome.status).toBe("completed"); expect(round).toBe(4);
  expect(requests.filter(request => request.system?.includes("CONTEXT CHECKPOINT COMPACTION"))).toHaveLength(1);
  for (const request of requests.filter(request => !request.system?.includes("CONTEXT CHECKPOINT COMPACTION"))) {
    assertToolProtocol(request.messages);
    expect(request.messages.filter(message => message.role === "user" && message.content === input)).toHaveLength(1);
  }
});
