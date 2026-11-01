import { describe, expect, it } from "vitest";
import { assertToolProtocol, errorInfo, newAgentId, newMessageId, newPromptId, newToolCallId, newTurnId,
  type AdmittedPrompt, type AgentDefinition, type InboxStore, type Message, type ModelEvent, type ModelProvider,
  type ModelRequest, type PromptId, type SessionId, type TurnId } from "@ar/contracts";
import { ContextPipeline, renderHistoryCheckpoint } from "@ar/context";
import { AgentRuntime } from "./runtime.js";
import { MemoryEventStore, MemorySessionStore, defaultTestToolCatalog } from "../test/fakes.js";
import { FakeOrchestrator } from "../test/fake-orchestrator.js";

const COVERED = "COVERED_RAW_RECORD_MUST_STAY_COVERED";
const USER = "Continue the current coding task.";
const STEER = "Preserve the public API 中文🙂 exactly.";
const LATE = "New observation admitted while the summary was running.";
const isSummary = (request: ModelRequest) => request.system?.includes("CONTEXT CHECKPOINT COMPACTION") === true;
class Inbox implements InboxStore {
  readonly prompts: AdmittedPrompt[] = [];
  async admit(prompt: AdmittedPrompt) { this.prompts.push(prompt); }
  async listPending(id: SessionId) { return this.prompts.filter(prompt => prompt.sessionId === id && prompt.status === "pending"); }
  async listRecoverable(id: SessionId) { return this.prompts.filter(prompt => prompt.sessionId === id && prompt.status !== "consumed"); }
  async listAll(id: SessionId) { return this.prompts.filter(prompt => prompt.sessionId === id); }
  async markPromoted(id: PromptId) { this.prompts.find(prompt => prompt.id === id)!.status = "promoted"; }
  async bindPromotion(id: PromptId, turnId: TurnId) { this.prompts.find(prompt => prompt.id === id)!.promotedTurnId = turnId; }
  async markConsumed(id: PromptId) { this.prompts.find(prompt => prompt.id === id)!.status = "consumed"; }
}

async function runCase(options: { steer: boolean; summary: "short" | "long" | "failed"; toolBatch?: boolean; lateRecord?: boolean }) {
  const store = new MemorySessionStore(), events = new MemoryEventStore(), inbox = new Inbox();
  const requests: ModelRequest[] = [], orchestrator = new FakeOrchestrator();
  const pipeline = new ContextPipeline({ historyCompaction: true, discovery: { discover: async () => [] } });
  let sessionId!: SessionId, turnId!: TurnId, steerId: PromptId | undefined, late: Message | undefined;
  const provider: ModelProvider = { id: "compaction-steer-view", listModels: async () => [], createClient: () => ({
    async *generate(request): AsyncGenerator<ModelEvent> {
      assertToolProtocol(request.messages); requests.push(structuredClone(request));
      if (isSummary(request)) {
        if (options.steer) {
          steerId = newPromptId();
          await inbox.admit({ id: steerId, sessionId, kind: "steer", status: "pending", text: STEER, admittedAt: 0 });
        }
        if (options.lateRecord) {
          late = { id: newMessageId(), sessionId, turnId, role: "assistant", content: LATE, createdAt: 100 };
          await store.appendMessage(late);
        }
        if (options.summary === "failed") yield { type: "error", timestamp: 0,
          error: errorInfo("MODEL_ERROR", "summary offline", { retryable: false, safeToRetry: false }) };
        else yield { type: "completed", timestamp: 0, result: { finishReason: "stop",
          text: options.summary === "short" ? "Short handoff" : "Continue the coding task. " + "Useful current context. ".repeat(30) } };
        return;
      }
      yield { type: "completed", timestamp: 0, result: { finishReason: "stop", text: "done" } };
    },
  }) };
  const agent: AgentDefinition = { id: newAgentId(), name: "compaction-steer-view", description: "offline coverage boundary",
    mode: "primary", model: { providerId: provider.id, modelId: "offline" }, systemPrompt: "Continue coding.",
    tools: {}, permissions: { rules: [] }, skills: {}, limits: {} };
  const runtime = new AgentRuntime({ store, events, inbox, orchestrator, agents: [agent], modelProvider: provider,
    toolRegistry: defaultTestToolCatalog(), permissiveToolResolution: true, context: { pipeline,
      budget: { maxTokens: 10000, reserved: { system: 0, task: 0, output: 500 }, dynamic: 0 } } });
  const session = await runtime.createSession({ agent, cwd: "/compaction-steer-view" }); sessionId = session.id;
  const oldTurn = newTurnId();
  const original: Message = { id: newMessageId(), sessionId, turnId: oldTurn, role: "assistant", content: COVERED, createdAt: 0 };
  await store.appendMessage(original);
  const checkpoint: Message = { id: newMessageId(), sessionId, turnId: oldTurn, role: "assistant",
    content: renderHistoryCheckpoint(options.toolBatch ? "Original handoff. " + "Preserve known coding decisions. ".repeat(100) : "Short handoff"),
    contextCheckpoint: { version: 1, throughMessageId: original.id, source: "model" }, createdAt: 1 };
  await store.appendMessage(checkpoint);
  const toolIds = options.toolBatch ? [newToolCallId(), newToolCallId()] : [];
  if (toolIds.length) {
    await store.appendMessage({ id: newMessageId(), sessionId, turnId: oldTurn, role: "assistant", content: "",
      toolCalls: toolIds.map(id => ({ id, name: "read_file", args: { path: "src/current.ts" } })), createdAt: 2 });
    for (const id of toolIds) await store.appendMessage({ id: newMessageId(), sessionId, turnId: oldTurn,
      role: "tool", toolCallId: id, content: "Latest completed read evidence.", createdAt: 3 });
  }
  const before = structuredClone(await store.listMessages(sessionId));
  const turn = await runtime.startTurn(sessionId, USER); turnId = turn.id;
  pipeline.requestCompaction(sessionId);
  const outcome = await runtime.runTurn(sessionId, turnId, new AbortController().signal);
  return { outcome, requests, store, events, inbox, sessionId, original, checkpoint, before, steerId, late, toolIds, orchestrator };
}

describe("checkpoint view survives steering admitted during history summary", () => {
  for (const summary of ["short", "long", "failed"] as const) for (const steer of [false, true]) {
    it(`${summary} summary with steer=${steer} never revives checkpoint-covered raw history`, async () => {
      const h = await runCase({ summary, steer });
      expect(h.outcome.status).toBe("completed");
      expect(h.requests.filter(isSummary)).toHaveLength(1);
      const coding = h.requests.filter(request => !isSummary(request)); expect(coding).toHaveLength(1);
      for (const request of h.requests) {
        assertToolProtocol(request.messages);
        expect(request.messages.some(message => message.id === h.original.id)).toBe(false);
        expect(JSON.stringify(request.messages)).not.toContain(COVERED);
      }
      expect(coding[0]!.messages.filter(message => message.role === "user" && message.content === USER)).toHaveLength(1);
      expect(coding[0]!.messages.filter(message => message.role === "user" && message.content === `[steering] ${STEER}`)).toHaveLength(steer ? 1 : 0);
      if (steer) {
        expect(h.inbox.prompts).toHaveLength(1); expect(h.inbox.prompts[0]!.status).toBe("consumed");
        expect(h.store.messages.filter(message => message.promptId === h.steerId)).toHaveLength(1);
      }
      for (const original of h.before) expect(h.store.messages.find(message => message.id === original.id)).toEqual(original);
      expect(h.orchestrator.calls).toHaveLength(0);
    });
  }

  it.each(["short", "failed"] as const)("%s summary preserves the latest complete tool batch and newly admitted observation", async summary => {
    const h = await runCase({ summary, steer: true, toolBatch: true, lateRecord: true });
    expect(h.outcome.status).toBe("completed");
    const coding = h.requests.filter(request => !isSummary(request)); expect(coding).toHaveLength(1);
    const view = coding[0]!.messages; assertToolProtocol(view);
    expect(view.some(message => message.id === h.original.id)).toBe(false);
    for (const id of h.toolIds) expect(view.filter(message => message.role === "tool" && message.toolCallId === id)).toHaveLength(1);
    expect(view.filter(message => message.id === h.late!.id)).toEqual([h.late]);
    expect(view.filter(message => message.role === "user" && message.content === `[steering] ${STEER}`)).toHaveLength(1);
    for (const original of h.before) expect(h.store.messages.find(message => message.id === original.id)).toEqual(original);
    const durable = await h.store.listMessages(h.sessionId);
    expect(durable.find(message => message.id === h.original.id)).toEqual(h.original);
    for (const checkpoint of durable.filter(message => message.contextCheckpoint && message.id !== h.checkpoint.id)) {
      const through = durable.findIndex(message => message.id === checkpoint.contextCheckpoint!.throughMessageId);
      expect(through).toBeLessThan(durable.findIndex(message => message.id === h.late!.id));
    }
    expect(h.orchestrator.calls).toHaveLength(0);
  });
});
