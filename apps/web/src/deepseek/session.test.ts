import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { createHarness, type Harness } from "@ar/harness";
import { createRuntimeRpc } from "@ar/gateway";
import { ScriptedModelProvider } from "@ar/model";
import { newToolCallId, toToolSemantics, type ModelEvent, type ModelProvider, type SessionId } from "@ar/contracts";
import { ToolOrchestrator, ToolRegistry } from "@ar/tools";
import { createSessionService, type SessionHost } from "./session.js";
import { createEventsService } from "./events.js";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const action of cleanup.splice(0).reverse()) await action(); });
async function setup(provider: ModelProvider = new ScriptedModelProvider([ScriptedModelProvider.text("actual answer")])) {
  const directory = await mkdtemp(join(tmpdir(), "dsh-session-live-"));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  const harness = await createHarness({ cwd: directory, dataDir: directory, profile: "interactive", modelProvider: provider,
    model: { providerId: provider.id, modelId: "scripted-model" } });
  cleanup.push(() => harness.close());
  const rpc = createRuntimeRpc(harness.runtime, { sessionService: harness.sessionService, sessions: harness.sessions,
    events: harness.events, approvalStore: harness.approvalStore });
  const executor = new ToolOrchestrator({ registry: new ToolRegistry(), workspaceRoot: directory });
  const host: SessionHost = { harness, rpc, cwd: directory, dataDir: directory, pollDelayMs: 1,
    executeHostTool: async (sessionId, definition, args, signal) => {
      const id = newToolCallId(); const agent = harness.agents[0]!;
      return executor.executeBound({ id, sessionId: sessionId as SessionId, agentId: agent.id,
        call: { id, name: definition.name, args }, binding: { name: definition.name, definition,
          spec: { name: definition.name, description: definition.description, inputSchema: {} }, semantics: toToolSemantics(definition.metadata, definition.risk), provenance: { kind: "builtin" } } },
      { sessionId: sessionId as SessionId, agentId: agent.id, cwd: directory, signal,
        permissions: { rules: [{ action: "read", resource: "file", effect: "allow" }, { action: "edit", resource: "file", effect: "allow" }] },
        sandboxPolicy: { filesystem: { mode: "workspace-write", allowedPaths: [directory] }, network: { mode: "deny" }, process: {} } });
    } };
  const service = createSessionService(host); const signal = new AbortController().signal;
  const call = (endpoint: string, request: Record<string, unknown>) => service.call(endpoint, { request }, signal);
  const created = await call("session/create", {}) as { sessionId: SessionId };
  return { directory, harness, service, host, call, signal, id: created.sessionId };
}
async function eventually<T>(read: () => Promise<T>, accept: (value: T) => boolean): Promise<T> {
  let last: T | undefined;
  for (let i = 0; i < 500; i++) { const result = await read(); last = result; if (accept(result)) return result; await new Promise(done => setTimeout(done, 5)); }
  throw new Error(`Real Harness owner did not settle: ${JSON.stringify(last)}`);
}
function send(id: string, requestId = "unique-request") { return { sessionId: id, requestId, mode: "queue", content: [{ type: "text", text: "Please answer" }] }; }

it("admission persists one request correlation and retries never start a duplicate turn", async () => {
  const stack = await setup();
  await Promise.all([stack.call("session/prompt", send(stack.id)), stack.call("session/prompt", send(stack.id))]);
  await eventually(() => stack.harness.store.listTurns(stack.id), turns => turns.length === 1 && turns[0]?.status === "completed");
  const restarted = createSessionService(stack.host);
  await restarted.call("session/prompt", { request: send(stack.id) }, stack.signal);
  expect(await stack.harness.store.listTurns(stack.id)).toHaveLength(1);
  const projection = await stack.call("session/page", { address: { kind: "session", sessionId: stack.id }, throughSeq: (await stack.call("session/projections", { sessionId: stack.id }) as { asOfSeq: number }).asOfSeq }) as { records: Array<{ event: { type: string; data: { source?: { rpcId?: string } } } }> };
  expect(projection.records.find(record => record.event.type === "user/message")?.event.data.source?.rpcId).toBe("unique-request");
  await expect(stack.call("session/prompt", { ...send(stack.id), content: [{ type: "text", text: "Different" }] })).rejects.toMatchObject({ code: "session/request-conflict" });
});

it("rename and body search are durable across independent browser services", async () => {
  const stack = await setup();
  await stack.call("session/prompt", send(stack.id));
  await eventually(() => stack.harness.store.listTurns(stack.id), turns => turns[0]?.status === "completed");
  const renamed = await stack.call("session/rename", { sessionId: stack.id, title: "  Saved   名称  " }) as { title: string; seq: number };
  expect(renamed.title).toBe("Saved 名称");
  const second = createSessionService(stack.host);
  const baseline = await second.call("session/projections", { request: { sessionId: stack.id } }, stack.signal) as { values: { title: string } };
  expect(baseline.values.title).toBe("Saved 名称");
  expect(await stack.call("session/search", { query: "actual answer" })).toMatchObject({ items: [{ sessionId: stack.id, snippet: "actual answer" }], hasMore: false });
  expect((await stack.harness.events.list(stack.id)).some(event => event.type === "tool.completed" && event.payload.tool === "web_session_metadata")).toBe(true);
});

it("official follow openings use format 4 and follow live tokens with dense revisions; both tabs cancel independently", async () => {
  let release!: () => void;
  const released = new Promise<void>(done => { release = done; });
  const provider: ModelProvider = { id: "gated-live", listModels: async () => [], createClient: () => ({
    async *generate(): AsyncIterable<ModelEvent> {
      yield { type: "text_delta", text: "first ", timestamp: 0 }; await released;
      yield { type: "text_delta", text: "second", timestamp: 0 }; yield { type: "usage", usage: { inputTokens: 10, outputTokens: 2 }, timestamp: 0 };
      yield { type: "completed", result: { text: "first second", toolCalls: [], finishReason: "stop" }, timestamp: 0 };
    } }) };
  const stack = await setup(provider); const a = new AbortController(); const b = new AbortController();
  const request = { request: { address: { kind: "session", sessionId: stack.id }, assistantStream: true } };
  const first = stack.service.stream("session/follow", request, a.signal)[Symbol.asyncIterator]();
  const second = stack.service.stream("session/follow", request, b.signal)[Symbol.asyncIterator]();
  expect((await first.next()).value).toMatchObject({ type: "snapshot", header: { version: 4 }, assistantStream: { revision: 0 } });
  expect((await second.next()).value).toMatchObject({ type: "snapshot", header: { id: stack.id } });
  await stack.call("session/prompt", send(stack.id));
  const revisions: number[] = []; let sawText = false;
  while (!sawText) {
    const frame = (await first.next()).value as { type: string; frame?: { revision: number; chunk?: { type: string; text?: string } } };
    if (frame.type === "assistant-stream") { revisions.push(frame.frame!.revision); sawText = frame.frame?.chunk?.text === "first "; }
  }
  expect(revisions).toEqual(revisions.map((_, index) => index + 1));
  a.abort(); await first.return?.();
  release();
  await eventually(() => stack.harness.store.listTurns(stack.id), turns => turns[0]?.status === "completed");
  let sawAnswer = false;
  while (!sawAnswer) { const frame = (await second.next()).value as { type: string; event?: { type: string } }; sawAnswer = frame.event?.type === "assistant/message"; }
  b.abort(); await second.return?.();
});

it("waterfall answer is bound to its current generation and original ask; concurrent retry continues exactly once", async () => {
  const provider = new ScriptedModelProvider([
    ScriptedModelProvider.toolCall("ask_user", { question: "Choose target", reason: "choice_required", options: ["a", "b"] }),
    ScriptedModelProvider.text("Continued from original answer"),
  ]);
  const stack = await setup(provider);
  await stack.call("session/prompt", send(stack.id));
  const turns = await eventually(() => stack.harness.store.listTurns(stack.id), values => values[0]?.status === "waiting_for_user");
  const controller = new AbortController();
  const stream = stack.service.stream("$events", {}, controller.signal)[Symbol.asyncIterator]();
  const ready = (await stream.next()).value as { clientId: string };
  let frame: { eventId: string; request: { questions: Array<{ id: string }> } };
  while (true) { const item = (await stream.next()).value as { type: string }; if (item.type === "waterfall") { frame = item as unknown as typeof frame; break; } }
  const args = { clientId: ready.clientId, eventId: frame.eventId, outcome: { kind: "result", value: { answers: [{ id: frame.request.questions[0]!.id, selected: ["a"] }] } } };
  await expect(stack.service.call("$events/result", { ...args, clientId: "foreign-generation" }, stack.signal)).rejects.toMatchObject({ code: "gateway/conflict" });
  await Promise.all([stack.service.call("$events/result", args, stack.signal), stack.service.call("$events/result", args, stack.signal)]);
  await eventually(() => stack.harness.store.getTurn(turns[0]!.id), turn => turn?.status === "completed");
  const messages = await stack.harness.store.listMessages(stack.id);
  expect(messages.filter(message => message.askId !== undefined)).toHaveLength(1);
  expect(messages.filter(message => message.role === "assistant" && message.content === "Continued from original answer")).toHaveLength(1);
  expect(await stack.harness.store.listTurns(stack.id)).toHaveLength(1);
  controller.abort(); await stream.return?.();
  await expect(stack.service.call("$events/result", args, stack.signal)).rejects.toMatchObject({ code: "gateway/conflict" });
});

it("cross-parent reads, malformed args, unknown namespaces and pre-aborted mutations fail closed", async () => {
  const stack = await setup(); const other = await stack.call("session/create", {}) as { sessionId: string };
  await expect(stack.call("session/page", { address: { kind: "subagent", parentSessionId: other.sessionId, childSessionId: stack.id, mode: "unknown" }, throughSeq: 0 })).rejects.toMatchObject({ code: "subagent/not-found" });
  await expect(stack.call("session/rename", { sessionId: stack.id, title: "bad", extra: true })).rejects.toMatchObject({ code: "gateway/bad-request" });
  await expect(stack.call("session/unknown", {})).rejects.toMatchObject({ code: "gateway/not-found" });
  const cancelled = new AbortController(); cancelled.abort();
  await expect(stack.service.call("session/prompt", { request: send(stack.id) }, cancelled.signal)).rejects.toBeDefined();
  expect(await stack.harness.store.listTurns(stack.id)).toHaveLength(0);
});

it("holds an unbound queue promotion instead of changing an already followed prompt rpcId", async () => {
  const stack = await setup();
  const original = stack.harness.inbox.bindPromotion.bind(stack.harness.inbox);
  let release!: () => void;
  const gate = new Promise<void>(done => { release = done; });
  stack.harness.inbox.bindPromotion = async (id, turnId) => { await gate; await original(id, turnId); };
  const controller = new AbortController();
  const stream = stack.service.stream("session/follow", { request: { address: { kind: "session", sessionId: stack.id } } }, controller.signal)[Symbol.asyncIterator]();
  const snapshot = (await stream.next()).value as { records: Array<{ event: { seq: number } }> };
  await stack.call("session/prompt", send(stack.id));
  await eventually(() => stack.harness.store.listTurns(stack.id), turns => turns.length === 1);
  const before = await stack.call("session/projections", { sessionId: stack.id }) as { asOfSeq: number };
  expect(before.asOfSeq).toBe(snapshot.records.at(-1)!.event.seq);
  release();
  let user: { source: { rpcId: string } } | undefined;
  while (user === undefined) {
    const frame = (await stream.next()).value as { event?: { type: string; data: { source: { rpcId: string } } } };
    if (frame.event?.type === "user/message") user = frame.event.data;
  }
  expect(user.source.rpcId).toBe("unique-request");
  await eventually(() => stack.harness.store.listTurns(stack.id), turns => turns[0]?.status === "completed");
  controller.abort(); await stream.return?.();
});

it("treats prototype-shaped request ids as durable own identities without poisoning metadata", async () => {
  const provider = new ScriptedModelProvider([ScriptedModelProvider.text("one"), ScriptedModelProvider.text("two")]);
  const stack = await setup(provider);
  for (const requestId of ["__proto__", "constructor"]) {
    await stack.call("session/prompt", send(stack.id, requestId));
    await eventually(() => stack.harness.store.listTurns(stack.id), turns => turns.length === provider.calls.length && turns.every(turn => turn.status === "completed"));
    await stack.call("session/prompt", send(stack.id, requestId));
  }
  expect(provider.calls).toHaveLength(2);
  const metadata = await stack.service.metadata.read(stack.id);
  expect(Object.keys(metadata.requests).sort()).toEqual(["__proto__", "constructor"]);
  expect(Object.getPrototypeOf(metadata.requests)).toBe(Object.prototype);
});

it("durable answer retries recover a metadata-claim failure and never replace the accepted answer", async () => {
  const provider = new ScriptedModelProvider([
    ScriptedModelProvider.toolCall("ask_user", { question: "Pick", reason: "choice_required", options: ["a", "b"] }),
    ScriptedModelProvider.text("after answer"),
  ]);
  const stack = await setup(provider);
  await stack.call("session/prompt", send(stack.id));
  const turns = await eventually(() => stack.harness.store.listTurns(stack.id), values => values[0]?.status === "waiting_for_user");
  const ask = (await stack.harness.askUserStore!.listPending(stack.id))[0]!;
  const args = { agentId: stack.id, callId: ask.id, answer: { answers: [{ id: ask.id, selected: ["a"] }] } };
  const original = stack.host.executeHostTool!;
  let denyClaim = true;
  stack.host.executeHostTool = async (...call) => {
    if (denyClaim && call[1].risk === "side_effect") { denyClaim = false; return { status: "failed", error: { code: "PERMISSION_DENIED", message: "metadata claim denied", retryable: false, safeToRetry: false } }; }
    return original(...call);
  };
  await expect(stack.service.call("userQuestions/answer", args, stack.signal)).rejects.toThrow("metadata claim denied");
  expect((await stack.harness.askUserStore!.get(ask.id))?.status).toBe("answered");
  expect((await stack.harness.store.getTurn(turns[0]!.id))?.status).toBe("waiting_for_user");
  const reconnect = new AbortController();
  const stream = stack.service.stream("$events", {}, reconnect.signal)[Symbol.asyncIterator]();
  await stream.next();
  let seenAsk = false;
  while (!seenAsk) { const frame = (await stream.next()).value as { type: string; request?: { questions: Array<{ id: string }> } }; seenAsk = frame.type === "waterfall" && frame.request?.questions[0]?.id === ask.id; }
  const wrongSession = await stack.call("session/create", {}) as { sessionId: string };
  await expect(stack.service.call("userQuestions/answer", { ...args, agentId: wrongSession.sessionId }, stack.signal)).rejects.toMatchObject({ code: "user-questions/not-found" });
  await expect(stack.service.call("userQuestions/answer", { ...args, answer: { answers: [{ id: ask.id, selected: ["b"] }] } }, stack.signal)).rejects.toMatchObject({ code: "user-questions/conflict" });
  await Promise.all([stack.service.call("userQuestions/answer", args, stack.signal), stack.service.call("userQuestions/answer", args, stack.signal)]);
  await eventually(() => stack.harness.store.getTurn(turns[0]!.id), turn => turn?.status === "completed");
  const restarted = createSessionService(stack.host);
  expect(await restarted.call("userQuestions/answer", args, stack.signal)).toBe(true);
  expect(provider.calls).toHaveLength(2);
  expect((await stack.harness.store.listMessages(stack.id)).filter(message => message.askId === ask.id)).toHaveLength(1);
  expect(await stack.harness.store.listTurns(stack.id)).toHaveLength(1);
  reconnect.abort(); await stream.return?.();
});

it("stops the actual original paused turn and rejects an answer after terminal cancellation", async () => {
  const provider = new ScriptedModelProvider([ScriptedModelProvider.toolCall("ask_user", { question: "Wait", reason: "choice_required", options: ["a"] })]);
  const stack = await setup(provider);
  await stack.call("session/prompt", send(stack.id));
  const turns = await eventually(() => stack.harness.store.listTurns(stack.id), values => values[0]?.status === "waiting_for_user");
  const ask = (await stack.harness.askUserStore!.listPending(stack.id))[0]!;
  expect(await stack.call("session/cancel", { sessionId: stack.id })).toEqual({ accepted: true });
  expect((await stack.harness.store.getTurn(turns[0]!.id))?.status).toBe("cancelled");
  await expect(stack.service.call("userQuestions/answer", { agentId: stack.id, callId: ask.id, answer: { answers: [{ id: ask.id, selected: ["a"] }] } }, stack.signal)).rejects.toMatchObject({ code: "user-questions/conflict" });
  expect((await stack.harness.events.list(stack.id)).filter(event => event.type === "turn.cancelled")).toHaveLength(1);
  expect(provider.calls).toHaveLength(1);
});

it("waiting-turn continuation reports a real running model and keeps original-turn ownership", async () => {
  let release!: () => void;
  const gate = new Promise<void>(done => { release = done; });
  const provider = new ScriptedModelProvider([
    ScriptedModelProvider.toolCall("ask_user", { question: "Go", reason: "choice_required", options: ["yes"] }),
    (async function* (): AsyncIterable<ModelEvent> { yield { type: "text_delta", text: "continuing", timestamp: 0 }; await gate; yield { type: "completed", result: { text: "continuing", finishReason: "stop" }, timestamp: 0 }; })(),
  ]);
  const stack = await setup(provider);
  await stack.call("session/prompt", send(stack.id));
  const turns = await eventually(() => stack.harness.store.listTurns(stack.id), values => values[0]?.status === "waiting_for_user");
  const ask = (await stack.harness.askUserStore!.listPending(stack.id))[0]!;
  expect((await stack.service.summary(stack.id)).running).toBe(false);
  await stack.service.call("userQuestions/answer", { agentId: stack.id, callId: ask.id, answer: { answers: [{ id: ask.id, selected: ["yes"] }] } }, stack.signal);
  await eventually(() => stack.service.summary(stack.id), value => value.running);
  expect(await stack.harness.store.listTurns(stack.id)).toHaveLength(1);
  release();
  await eventually(() => stack.harness.store.getTurn(turns[0]!.id), turn => turn?.status === "completed");
  expect((await stack.service.summary(stack.id)).running).toBe(false);
});

it("event listener delegation and rejection do not approve an actual pending owner", async () => {
  const provider = new ScriptedModelProvider([ScriptedModelProvider.toolCall("write_file", { path: "approval.txt", content: "actual approved bytes" }), ScriptedModelProvider.text("written")]);
  const stack = await setup(provider);
  await stack.call("session/prompt", send(stack.id));
  await eventually(async () => stack.harness.approvalStore.listPending(stack.id), rows => rows.length === 1);
  const events = createEventsService({ harness: stack.harness, answerAsk: async () => { throw new Error("unused"); }, pollDelayMs: 1 });
  const streamController = new AbortController();
  const stream = events.stream("$events", {}, streamController.signal)[Symbol.asyncIterator]();
  const ready = (await stream.next()).value as { clientId: string };
  await expect(events.call("$events/result", { clientId: ready.clientId, eventId: "invented", outcome: { kind: "next" } }, stack.signal)).rejects.toMatchObject({ code: "gateway/conflict" });
  const frame = (await stream.next()).value as { eventId: string; event: string };
  expect(frame.event).toBe("approval/request");
  await events.call("$events/result", { clientId: ready.clientId, eventId: frame.eventId, outcome: { kind: "rejected", error: { name: "UI listener error", message: "panel failed" } } }, stack.signal);
  expect(stack.harness.approvalStore.listPending(stack.id)).toHaveLength(1);
  await expect(readFile(join(stack.directory, "approval.txt"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  streamController.abort(); await stream.return?.();
  const nextController = new AbortController();
  const next = events.stream("$events", {}, nextController.signal)[Symbol.asyncIterator]();
  const nextReady = (await next.next()).value as { clientId: string };
  const nextFrame = (await next.next()).value as { eventId: string };
  await expect(events.call("$events/result", { clientId: ready.clientId, eventId: frame.eventId, outcome: { kind: "result", value: "allowed-once" } }, stack.signal)).rejects.toMatchObject({ code: "gateway/conflict" });
  await events.call("$events/result", { clientId: nextReady.clientId, eventId: nextFrame.eventId, outcome: { kind: "result", value: "allowed-once" } }, stack.signal);
  await eventually(() => stack.harness.store.listTurns(stack.id), turns => turns[0]?.status === "completed");
  expect(await readFile(join(stack.directory, "approval.txt"), "utf8")).toBe("actual approved bytes");
  expect(stack.harness.approvalStore.listDecisions(stack.id)).toMatchObject([{ value: "allow", scope: "one_call" }]);
  nextController.abort(); await next.return?.();
});

it("private failed host identities never enter session lists, control baselines or event generations", async () => {
  const stack = await setup();
  const hidden = await stack.harness.runtime.createSession({ agent: stack.harness.agents[0]!, cwd: stack.directory, initialStatus: "failed" });
  const listed = await stack.service.call("session/list", { _request: {} }, stack.signal) as { items: Array<{ sessionId: string }> };
  expect(listed.items.map(item => item.sessionId)).toEqual([stack.id]);
  expect(await stack.call("session/projections", { sessionId: hidden.id })).toBe(null);
  const controlController = new AbortController();
  const control = stack.service.stream("session/control", {}, controlController.signal)[Symbol.asyncIterator]();
  const baseline = (await control.next()).value as { value: { projections: Record<string, unknown> } };
  expect(Object.keys(baseline.value.projections)).toEqual([stack.id]);
  controlController.abort(); await control.return?.();
  const eventController = new AbortController();
  const events = stack.service.stream("$events", {}, eventController.signal)[Symbol.asyncIterator]();
  expect((await events.next()).value).toMatchObject({ type: "ready" });
  const first = (await events.next()).value as { type: string; args: Array<{ sessionId: string }> };
  expect(first).toMatchObject({ type: "emit", args: [{ sessionId: stack.id }] });
  const other = await stack.call("session/create", {}) as { sessionId: string };
  let sawNext = false;
  while (!sawNext) { const frame = (await events.next()).value as typeof first; expect(frame.args[0]!.sessionId).not.toBe(hidden.id); sawNext = frame.args[0]!.sessionId === other.sessionId; }
  eventController.abort(); await events.return?.();
});

it("adopts a blank session in its actual workspace and rejects cwd rebinding and busy adoption", async () => {
  let release!: () => void;
  const gate = new Promise<void>(done => { release = done; });
  const provider = new ScriptedModelProvider([(async function* (): AsyncIterable<ModelEvent> {
    yield { type: "text_delta", text: "running", timestamp: 0 }; await gate;
    yield { type: "completed", result: { text: "running", finishReason: "stop" }, timestamp: 0 };
  })()]);
  const stack = await setup(provider);
  const otherPath = join(stack.directory, "other-workspace"); await mkdir(otherPath);
  stack.host.resolveWorkspace = async id => ({ id, path: id === "same" ? stack.directory : otherPath });
  expect(await stack.call("session/create", { sessionId: stack.id, workspaceId: "same" })).toEqual({ sessionId: stack.id });
  await expect(stack.call("session/create", { sessionId: stack.id, workspaceId: "different" })).rejects.toMatchObject({ code: "session/conflict" });
  await expect(stack.call("session/create", { sessionId: stack.id, cwd: otherPath })).rejects.toMatchObject({ code: "session/conflict" });
  expect(await stack.harness.store.listSessions()).toHaveLength(1);
  await stack.call("session/prompt", send(stack.id));
  await eventually(async () => provider.calls, calls => calls.length === 1);
  try { await expect(stack.call("session/create", { sessionId: stack.id, workspaceId: "same" })).rejects.toMatchObject({ code: "session/agent-busy" }); }
  finally { release(); }
  await eventually(() => stack.harness.store.listTurns(stack.id), turns => turns[0]?.status === "completed");
});

it("cancels a running same-turn answer continuation exactly once without replaying its stale paused snapshot", async () => {
  const provider = new ScriptedModelProvider([
    ScriptedModelProvider.toolCall("ask_user", { question: "Proceed", reason: "choice_required", options: ["yes"] }),
    (async function* (): AsyncIterable<ModelEvent> {
      yield { type: "text_delta", text: "running continuation", timestamp: 0 };
      await new Promise<void>(done => { const signal = provider.abortSignals[1]!; if (signal.aborted) done(); else signal.addEventListener("abort", () => done(), { once: true }); });
      yield { type: "completed", result: { text: "running continuation", finishReason: "stop" }, timestamp: 0 };
    })(),
  ]);
  const stack = await setup(provider);
  await stack.call("session/prompt", send(stack.id));
  const turns = await eventually(() => stack.harness.store.listTurns(stack.id), values => values[0]?.status === "waiting_for_user");
  const ask = (await stack.harness.askUserStore!.listPending(stack.id))[0]!;
  await stack.service.call("userQuestions/answer", { agentId: stack.id, callId: ask.id, answer: { answers: [{ id: ask.id, selected: ["yes"] }] } }, stack.signal);
  await eventually(() => stack.service.summary(stack.id), summary => summary.running);
  await stack.call("session/cancel", { sessionId: stack.id });
  expect((await stack.harness.store.getTurn(turns[0]!.id))?.status).toBe("cancelled");
  expect((await stack.harness.events.list(stack.id)).filter(event => event.type === "turn.cancelled")).toHaveLength(1);
  expect(provider.calls).toHaveLength(2);
  expect(await stack.harness.store.listTurns(stack.id)).toHaveLength(1);
});

it("domain notifications reach both live tabs with owned exact frames and no pre-connection replay", async () => {
  const stack = await setup();
  const events = createEventsService({ harness: stack.harness, answerAsk: async () => {}, pollDelayMs: 1 });
  events.publish("schedule/changed", []);
  const a = new AbortController(); const b = new AbortController();
  const first = events.stream("$events", {}, a.signal)[Symbol.asyncIterator]();
  const second = events.stream("$events", {}, b.signal)[Symbol.asyncIterator]();
  expect((await first.next()).value).toMatchObject({ type: "ready" });
  expect((await second.next()).value).toMatchObject({ type: "ready" });
  const args: unknown[] = ["ui-theme", 1];
  events.publish("settings/document-updated", args); args[1] = 100;
  const expected = { type: "emit", event: "settings/document-updated", args: ["ui-theme", 1] };
  expect((await first.next()).value).toEqual(expected);
  expect((await second.next()).value).toEqual(expected);
  a.abort(); await first.return?.();
  events.publish("credentials/reference-updated", ["provider-key"]);
  expect((await second.next()).value).toEqual({ type: "emit", event: "credentials/reference-updated", args: ["provider-key"] });
  const c = new AbortController(); const third = events.stream("$events", {}, c.signal)[Symbol.asyncIterator]();
  await third.next(); events.publish("schedule/changed", []);
  expect((await third.next()).value).toEqual({ type: "emit", event: "schedule/changed", args: [] });
  expect(() => events.publish("approval/request", [])).toThrow("Unknown forwarded notification");
  expect(() => events.publish("settings/document-updated", ["ui-theme", undefined])).toThrow("Invalid forwarded notification");
  expect(() => events.publish("plugin-manager/changed", [{ getter: undefined }])).toThrow("lossless JSON");
  b.abort(); c.abort(); await second.return?.(); await third.return?.();
});

it("bounded notification overflow terminates that stale generation for an authoritative reconnect", async () => {
  const stack = await setup();
  const events = createEventsService({ harness: stack.harness, answerAsk: async () => {}, pollDelayMs: 1 });
  const signal = new AbortController().signal;
  const stream = events.stream("$events", {}, signal)[Symbol.asyncIterator]();
  await stream.next();
  for (let i = 0; i < 257; i++) events.publish("schedule/changed", []);
  await expect(stream.next()).rejects.toThrow("queue overflow");
  const restarted = events.stream("$events", {}, signal)[Symbol.asyncIterator]();
  expect((await restarted.next()).value).toMatchObject({ type: "ready" });
  events.publish("llm/adapters-updated", []);
  expect((await restarted.next()).value).toEqual({ type: "emit", event: "llm/adapters-updated", args: [] });
  await restarted.return?.();
});

it("reconciles a real rename commit whose journal append failed before the same-title retry", async () => {
  const stack = await setup();
  const append = stack.harness.events.appendNew.bind(stack.harness.events);
  let failTitle = true;
  stack.harness.events.appendNew = async event => {
    if (failTitle && event.type === "tool.completed" && event.payload.tool === "web_session_metadata") { failTitle = false; throw new Error("title journal failure"); }
    return append(event);
  };
  await expect(stack.call("session/rename", { sessionId: stack.id, title: "Committed before journal" })).rejects.toThrow("title journal failure");
  expect((await stack.service.metadata.read(stack.id)).title).toBe("Committed before journal");
  await stack.call("session/rename", { sessionId: stack.id, title: "Committed before journal" });
  const events = await stack.harness.events.list(stack.id);
  expect(events.filter(event => event.type === "tool.completed" && event.payload.tool === "web_session_metadata")).toHaveLength(1);
  const controller = new AbortController();
  const follow = stack.service.stream("session/follow", { request: { address: { kind: "session", sessionId: stack.id } } }, controller.signal)[Symbol.asyncIterator]();
  const snapshot = (await follow.next()).value as { records: Array<{ event: { type: string; data: { title?: string } } }> };
  expect(snapshot.records.find(record => record.event.type === "session/title")?.event.data.title).toBe("Committed before journal");
  controller.abort(); await follow.return?.();
});

it("rejects forged accepted presentation receipts without starting or claiming a missing durable prompt", async () => {
  const stack = await setup();
  await stack.call("session/prompt", send(stack.id));
  await eventually(() => stack.harness.store.listTurns(stack.id), turns => turns[0]?.status === "completed");
  // This fault affects presentation metadata, never the immutable native inbox.
  await stack.service.metadata.update(stack.id, data => { data.requests["unique-request"]!.promptId = "missing-durable-prompt"; });
  await expect(stack.call("session/prompt", send(stack.id))).rejects.toMatchObject({ code: "session/admission-uncertain" });
  expect(await stack.harness.store.listTurns(stack.id)).toHaveLength(1);
});
