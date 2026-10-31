import { describe, expect, it } from "vitest";
import { assertToolProtocol, errorInfo, newAgentId, newMessageId, newPromptId, newToolCallId, newTurnId,
  type AdmittedPrompt, type AgentDefinition, type InboxStore, type ModelEvent, type ModelProvider, type ModelRequest,
  type PromptId, type RunLimits, type SessionId, type TurnId } from "@ar/contracts";
import { ContextPipeline, renderHistoryCheckpoint } from "@ar/context";
import { AgentRuntime } from "./runtime.js";
import { MemoryEventStore, MemorySessionStore, defaultTestToolCatalog } from "../test/fakes.js";
import { FakeOrchestrator } from "../test/fake-orchestrator.js";

const INPUT = "Continue fixing src/fix.ts. Preserve public APIs and run the existing tests.";
const STEER = "Preserve package.json exactly. 用户约束🙂";
const inputBytes = (request: ModelRequest) => Buffer.byteLength((request.system ?? "") + JSON.stringify(request.messages), "utf8");
const isSummary = (request: ModelRequest) => request.system?.includes("CONTEXT CHECKPOINT COMPACTION") === true;
const overflow: ModelEvent = { type: "error", error: errorInfo("CONTEXT_OVERFLOW", "context full", { retryable: false, safeToRetry: false }), timestamp: 0 };
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
function fixture(options: { summaryFails?: boolean; limits?: RunLimits; afterSummary?: () => Promise<void>;
  toolRounds?: number; actualWindowBytes?: number; alwaysOverflow?: boolean; firstOverflow?: boolean;
  summaryForbidden?: boolean; checkpointText?: string; smallHistory?: boolean; afterFirstOverflow?: () => Promise<void>;
  beforeCoding?: (index: number) => Promise<void> } = {}) {
  const requests: ModelRequest[] = [], store = new MemorySessionStore(), events = new MemoryEventStore(), inbox = new Inbox();
  const orchestrator = new FakeOrchestrator({ status: "success", output: "small observed file content" });
  let rounds = 0, codingRequests = 0;
  const provider: ModelProvider = { id: "reactive-window", listModels: async () => [], createClient: () => ({
    async *generate(request): AsyncGenerator<ModelEvent> {
      assertToolProtocol(request.messages); requests.push(structuredClone(request));
      if (isSummary(request)) {
        if (options.summaryForbidden) throw new Error("Existing small checkpoint must not need a model summary");
        await options.afterSummary?.();
        if (options.summaryFails) { yield { type: "error", error: errorInfo("MODEL_ERROR", "summary connection reset", { retryable: false, safeToRetry: false }), timestamp: 0 }; return; }
        yield { type: "completed", result: { finishReason: "stop", text: "Decision: inspect src/fix.ts. Preserve public APIs and verify the change.",
          usage: { inputTokens: 100, outputTokens: 20, estimatedCostUsd: 0.2 } }, timestamp: 0 }; return;
      }
      codingRequests++;
      await options.beforeCoding?.(codingRequests);
      if (codingRequests === 1 && options.firstOverflow) { await options.afterFirstOverflow?.(); yield overflow; return; }
      if (options.alwaysOverflow || inputBytes(request) > (options.actualWindowBytes ?? 12000)) { yield overflow; return; }
      if (rounds++ < (options.toolRounds ?? 0)) yield { type: "completed", result: { finishReason: "tool_calls",
        toolCalls: [{ id: newToolCallId(), name: "read_file", args: { path: `src/file-${rounds}.ts` } }] }, timestamp: 0 };
      else yield { type: "completed", result: { finishReason: "stop", text: "done" }, timestamp: 0 };
    },
  }) };
  const agent: AgentDefinition = { id: newAgentId(), name: "reactive-window", description: "deterministic upstream context boundary", mode: "primary",
    model: { providerId: provider.id, modelId: "bounded" }, systemPrompt: "Continue coding.", tools: {}, permissions: { rules: [] }, skills: {}, limits: options.limits ?? {} };
  const pipeline = new ContextPipeline({ historyCompaction: true, discovery: { discover: async () => [] } });
  const runtime = new AgentRuntime({ store, events, inbox, orchestrator, modelProvider: provider, agents: [agent],
    toolRegistry: defaultTestToolCatalog(), permissiveToolResolution: true,
    context: { pipeline,
      budget: { maxTokens: 16000, reserved: { system: 0, task: 0, output: 500 }, dynamic: 0 } } });
  async function start(input = INPUT, historicalCount = 8) {
    const session = await runtime.createSession({ agent, cwd: "/reactive-window" }), oldTurn = newTurnId();
    if (options.checkpointText) {
      const original = { id: newMessageId(), sessionId: session.id, turnId: oldTurn, role: "assistant" as const,
        content: options.checkpointText, createdAt: -2 };
      await store.appendMessage(original);
      await store.appendMessage({ id: newMessageId(), sessionId: session.id, turnId: oldTurn, role: "assistant",
        content: renderHistoryCheckpoint(options.checkpointText),
        contextCheckpoint: { version: 1, throughMessageId: original.id, source: "model" }, createdAt: -1 });
    }
    for (let index = 0; index < historicalCount; index++) await store.appendMessage({ id: newMessageId(), sessionId: session.id, turnId: oldTurn,
      role: "assistant", content: options.smallHistory ? `Recent progress ${index}` : `Observed coding result ${index}: ` + "project investigation detail ".repeat(70), createdAt: index });
    const turn = await runtime.startTurn(session.id, input);
    return { session, turn, run: (signal = new AbortController().signal) => runtime.runTurn(session.id, turn.id, signal) };
  }
  return { runtime, store, events, inbox, orchestrator, requests, start, pipeline };
}

function expectUsers(request: ModelRequest, texts = [INPUT]) {
  assertToolProtocol(request.messages);
  for (const text of texts) expect(request.messages.filter(message => message.role === "user" && message.content === text)).toHaveLength(1);
}

describe("confirmed upstream overflow uses the existing history compaction path", () => {
  it("reduces nine large records even when local estimates are below the automatic threshold", async () => {
    const f = fixture(), started = await f.start();
    expect((await started.run()).status).toBe("completed");
    const coding = f.requests.filter(request => !isSummary(request));
    expect(coding).toHaveLength(2); expect(coding[0]!.messages).toHaveLength(9);
    expect(inputBytes(coding[1]!)).toBeLessThan(inputBytes(coding[0]!));
    const summaries = f.requests.filter(isSummary); expect(summaries).toHaveLength(1);
    expect(inputBytes(summaries[0]!)).toBeLessThanOrEqual(12000);
    expect(inputBytes(summaries[0]!)).toBeLessThan(inputBytes(coding[0]!));
    expect(f.store.messages.some(message => message.contextCheckpoint?.source === "model")).toBe(true);
    for (const request of coding) expectUsers(request);
    expect(f.store.messages.filter(message => message.content.startsWith("Observed coding result"))).toHaveLength(8);
    const completed = f.events.events.filter(event => event.type === "context.compacted" && event.payload.phase === "completed");
    expect(completed).toHaveLength(1); expect(completed[0]!.payload).toMatchObject({ reactive: true, compressed: 1 });
  });

  it("compacts an existing checkpoint view without reviving covered history or resummarizing later tool rounds", async () => {
    const f = fixture({ toolRounds: 2 }); const started = await f.start();
    const covered = f.store.messages[3]!;
    await f.store.appendMessage({ id: newMessageId(), sessionId: started.session.id, turnId: newTurnId(), role: "assistant",
      content: "Historical coding handoff " + "context notes ".repeat(450), contextCheckpoint: { version: 1, throughMessageId: covered.id, source: "model" }, createdAt: 10 });
    const callId = newToolCallId();
    await f.store.appendMessage({ id: newMessageId(), sessionId: started.session.id, role: "assistant", content: "Read the current file", toolCalls: [{ id: callId, name: "read_file", args: { path: "src/current.ts" } }], createdAt: 11 });
    await f.store.appendMessage({ id: newMessageId(), sessionId: started.session.id, role: "tool", toolCallId: callId, content: "LATEST_COMPLETED_FILE_READ", createdAt: 12 });
    expect((await started.run()).status).toBe("completed");
    const coding = f.requests.filter(request => !isSummary(request)); expect(coding).toHaveLength(4);
    expect(f.requests.filter(isSummary)).toHaveLength(1); expect(f.orchestrator.calls).toHaveLength(2);
    for (const request of coding) {
      expectUsers(request); expect(request.messages.some(message => message.id === covered.id)).toBe(false);
      expect(request.messages.some(message => message.content === "LATEST_COMPLETED_FILE_READ")).toBe(true);
    }
  });

  it("uses the existing extractive fallback when the auxiliary summary fails", async () => {
    const f = fixture({ summaryFails: true }), started = await f.start();
    expect((await started.run()).status).toBe("completed");
    const coding = f.requests.filter(request => !isSummary(request)); expect(coding).toHaveLength(2);
    expect(inputBytes(coding[1]!)).toBeLessThan(inputBytes(coding[0]!));
    expect(f.store.messages.some(message => message.contextCheckpoint?.source === "extractive")).toBe(true);
    expect(f.requests.filter(isSummary)).toHaveLength(1); for (const request of coding) expectUsers(request);
  });

  it("retains a large protected user that fits upstream even when it exceeds the ordinary reduction target", async () => {
    const input = "Preserve current API; do the task: " + "x".repeat(10000), f = fixture(), started = await f.start(input, 3);
    expect((await started.run()).status).toBe("completed");
    const coding = f.requests.filter(request => !isSummary(request)); expect(coding).toHaveLength(2);
    expect(inputBytes(coding[0]!)).toBeGreaterThan(12000); expect(inputBytes(coding[1]!)).toBeLessThanOrEqual(12000);
    expect(inputBytes(coding[1]!)).toBeLessThan(inputBytes(coding[0]!));
    for (const request of coding) expectUsers(request, [input]);
    expect(f.requests.filter(isSummary)).toHaveLength(1);
  });

  it.each([[24, "completed"], [28, "completed"], [48, "completed"], [72, "failed"]] as const)(
    "preserves a small existing handoff and its reduced tail across two later tool rounds with %d progress records and outcome %s", async (historicalCount, expectedStatus) => {
    const handoff = "Prior decision: preserve src/legacy.ts and the exact unresolved error E_HISTORICAL_271828.";
    let steer!: () => Promise<void>;
    const f = fixture({ firstOverflow: true, toolRounds: 2, summaryForbidden: true, checkpointText: handoff,
      smallHistory: true, afterFirstOverflow: () => steer() });
    const started = await f.start(INPUT, historicalCount);
    const checkpoint = f.store.messages.find(message => message.contextCheckpoint)!;
    const toolIds = [newToolCallId(), newToolCallId()];
    await f.store.appendMessage({ id: newMessageId(), sessionId: started.session.id, role: "assistant", content: "",
      toolCalls: toolIds.map(id => ({ id, name: "read_file", args: { path: "src/legacy.ts" } })), createdAt: 30 });
    for (const id of toolIds) await f.store.appendMessage({ id: newMessageId(), sessionId: started.session.id, role: "tool",
      toolCallId: id, content: "latest completed read evidence", createdAt: 31 });
    const before = structuredClone(f.store.messages);
    steer = () => f.store.appendMessage({ id: newMessageId(), sessionId: started.session.id, turnId: started.turn.id,
      role: "user", content: STEER, promptId: newPromptId(), createdAt: 32 });
    const outcome = await started.run();
    expect(outcome.status, JSON.stringify({ error: outcome.error, requests: f.requests.map(request => ({ bytes: inputBytes(request), summary: isSummary(request), messages: request.messages.length })) })).toBe(expectedStatus);
    expect(f.requests.filter(isSummary)).toHaveLength(0); expect(f.requests).toHaveLength(4);
    if (expectedStatus === "failed") {
      // The retained view fits initially, then two tool rounds reach this
      // fixture's real byte cap again. Preserve the same handoff and honor
      // the original single changed-context retry instead of looping.
      expect(outcome).toMatchObject({ terminationReason: "model_error", error: { code: "CONTEXT_OVERFLOW" } });
      expect(inputBytes(f.requests[1]!)).toBeLessThanOrEqual(12000);
      expect(inputBytes(f.requests[2]!)).toBeLessThanOrEqual(12000);
      expect(inputBytes(f.requests[3]!)).toBeGreaterThan(12000);
    }
    const retained = new Set(f.requests[1]!.messages.filter(message => message.content.startsWith("Recent progress")).map(message => message.id));
    expect(retained.size).toBeLessThan(historicalCount);
    for (const [index, request] of f.requests.entries()) {
      expectUsers(request, index === 0 ? [INPUT] : [INPUT, STEER]);
      expect(request.messages.find(message => message.id === checkpoint.id)).toEqual(checkpoint);
      expect(JSON.stringify(request.messages)).toContain("E_HISTORICAL_271828");
      for (const id of toolIds) expect(request.messages.filter(message => message.role === "tool" && message.toolCallId === id)).toHaveLength(1);
      if (index > 1) for (const message of request.messages.filter(row => row.content.startsWith("Recent progress"))) expect(retained.has(message.id)).toBe(true);
    }
    expect(f.orchestrator.calls).toHaveLength(2);
    expect(f.store.messages.filter(message => message.contextCheckpoint)).toEqual([checkpoint]);
    for (const message of before) expect(f.store.messages.find(row => row.id === message.id)).toEqual(message);
  });

  it("uses a newer durable checkpoint and its later complete tool block after the per-turn tail boundary", async () => {
    let appendCheckpoint!: (index: number) => Promise<void>;
    const f = fixture({ firstOverflow: true, toolRounds: 2, summaryForbidden: true, smallHistory: true,
      checkpointText: "Historical decision: preserve E_OLD_STATE.", beforeCoding: index => appendCheckpoint(index) });
    const started = await f.start(INPUT, 24), oldCheckpoint = f.store.messages.find(message => message.contextCheckpoint)!;
    let newCheckpoint: typeof oldCheckpoint | undefined;
    appendCheckpoint = async index => {
      if (index !== 3) return;
      const through = f.store.messages.findLast(message => message.role === "tool")!;
      newCheckpoint = { id: newMessageId(), sessionId: started.session.id, turnId: started.turn.id, role: "assistant",
        content: renderHistoryCheckpoint("New durable handoff: preserve E_OLD_STATE and E_NEW_STATE."),
        contextCheckpoint: { version: 1, throughMessageId: through.id, source: "model" }, createdAt: 100 };
      await f.store.appendMessage(newCheckpoint);
    };
    expect((await started.run()).status).toBe("completed"); expect(f.requests).toHaveLength(4);
    expect(f.requests.filter(isSummary)).toHaveLength(0);
    const last = f.requests.at(-1)!; expectUsers(last);
    expect(last.messages.find(message => message.id === newCheckpoint!.id)).toEqual(newCheckpoint);
    expect(last.messages.some(message => message.id === oldCheckpoint.id)).toBe(false);
    expect(last.messages.some(message => message.content.startsWith("Recent progress"))).toBe(false);
    const latestCall = last.messages.find(message => message.toolCalls?.some(call => call.args.path === "src/file-2.ts"))!;
    expect(latestCall).toBeDefined();
    expect(last.messages.some(message => message.role === "tool" && message.toolCallId === latestCall.toolCalls![0]!.id)).toBe(true);
    expect(f.store.messages.find(message => message.id === oldCheckpoint.id)).toEqual(oldCheckpoint);
    expect(f.store.messages.filter(message => message.contextCheckpoint)).toHaveLength(2);
    for (const request of f.requests) assertToolProtocol(request.messages);
  });

  it("does not acknowledge a simultaneous manual request using the non-durable small-handoff tail path", async () => {
    let requestManual!: () => Promise<void>;
    const f = fixture({ firstOverflow: true, smallHistory: true,
      checkpointText: "Prior decision: preserve the existing files. " + "Important fact. ".repeat(20),
      afterFirstOverflow: () => requestManual() });
    const started = await f.start(INPUT, 24);
    requestManual = async () => f.pipeline.requestCompaction(started.session.id);
    expect((await started.run()).status).toBe("completed");
    expect(f.store.messages.filter(message => message.contextCheckpoint)).toHaveLength(2);
    const completed = f.events.events.filter(event => event.type === "context.compacted" && event.payload.phase === "completed");
    expect(completed).toHaveLength(1); expect(completed[0]!.payload.manual).toBe(true);
    expect(completed[0]!.payload.summarySource).not.toBe("existing-checkpoint");
    for (const request of f.requests.filter(request => !isSummary(request))) expectUsers(request);
  });

  it("admits a steer arriving during the forced summary exactly once before retry", async () => {
    let steer!: () => Promise<void>;
    const f = fixture({ afterSummary: () => steer() }), started = await f.start();
    const promptId = newPromptId();
    steer = () => f.inbox.admit({ id: promptId, sessionId: started.session.id, kind: "steer", status: "pending", text: STEER, admittedAt: 0 });
    expect((await started.run()).status).toBe("completed");
    const coding = f.requests.filter(request => !isSummary(request)); expect(coding).toHaveLength(2);
    expectUsers(coding[1]!, [INPUT, `[steering] ${STEER}`]);
    expect(f.store.messages.filter(message => message.promptId === promptId)).toHaveLength(1);
    expect(f.inbox.prompts[0]!.status).toBe("consumed");
  });

  it("keeps the original single changed-context retry when the smaller request still overflows", async () => {
    const f = fixture({ alwaysOverflow: true }), started = await f.start();
    expect(await started.run()).toMatchObject({ status: "failed", error: { code: "CONTEXT_OVERFLOW" } });
    const coding = f.requests.filter(request => !isSummary(request)); expect(coding).toHaveLength(2);
    expect(inputBytes(coding[1]!)).toBeLessThan(inputBytes(coding[0]!));
    expect(f.requests.filter(isSummary)).toHaveLength(1); expect(f.orchestrator.calls).toHaveLength(0);
  });

  it("does not replay irreducible protected user input after confirmed overflow", async () => {
    const input = "Preserve these exact instructions: " + "x".repeat(13000), f = fixture(), started = await f.start(input, 0);
    expect(await started.run()).toMatchObject({ status: "failed", terminationReason: "context_limit", error: { code: "RESOURCE_LIMIT" } });
    expect(f.requests.filter(request => !isSummary(request))).toHaveLength(1);
    expect(f.requests.filter(isSummary)).toHaveLength(0); expect(f.orchestrator.calls).toHaveLength(0);
    expectUsers(f.requests[0]!, [input]); expect(f.store.messages.some(message => message.content === input)).toBe(true);
  });

  it("meters the forced summary and stops before a coding retry at the existing cost limit", async () => {
    const f = fixture({ limits: { maxEstimatedCostUsd: 0.1 } }), started = await f.start();
    expect(await started.run()).toMatchObject({ status: "failed", terminationReason: "agent_limit", error: { code: "RESOURCE_LIMIT" } });
    expect(f.requests.filter(request => !isSummary(request))).toHaveLength(1); expect(f.requests.filter(isSummary)).toHaveLength(1);
    expect(f.events.events.find(event => event.type === "run.limit_reached")?.payload.limit).toBe("maxEstimatedCostUsd");
    expect(f.orchestrator.calls).toHaveLength(0);
  });

  it("honors cancellation during the forced summary without a coding retry or checkpoint publication", async () => {
    const abort = new AbortController(), f = fixture({ afterSummary: async () => abort.abort() }), started = await f.start();
    expect(await started.run(abort.signal)).toMatchObject({ status: "cancelled" });
    expect(f.requests.filter(request => !isSummary(request))).toHaveLength(1); expect(f.requests.filter(isSummary)).toHaveLength(1);
    expect(f.store.messages.some(message => message.contextCheckpoint !== undefined)).toBe(false);
    expect(f.orchestrator.calls).toHaveLength(0);
  });
});
