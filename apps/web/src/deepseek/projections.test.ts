import { readFileSync } from "node:fs";
import vm from "node:vm";
import { describe, expect, it } from "vitest";
import { newAgentId, newEventId, newMessageId, newSessionId, newToolCallId, newTurnId } from "@ar/contracts";
import type { AgentEvent, EventType, Message, Session } from "@ar/contracts";
import { pageSessionHistory, projectSessionHistory } from "./projections.js";
import type { PageProjection, SessionAssistantStreamBaseline, SessionAssistantStreamFrame, SessionFollowFrame, SessionHistoryRecord, SessionWireEvent } from "./projections.js";

function fixture() {
  const session: Session = { id: newSessionId(), agentId: newAgentId(), model: { providerId: "loopback", modelId: "coding" }, cwd: "/workspace/project", status: "active", createdAt: 1, updatedAt: 1 };
  const turnId = newTurnId();
  const events: AgentEvent[] = [];
  const messages: Message[] = [];
  let time = 1;
  function event(type: EventType, payload: Record<string, unknown> = {}, inTurn = true): AgentEvent {
    const result: AgentEvent = { id: newEventId(), sessionId: session.id, ...(inTurn ? { turnId } : {}), sequence: events.length, timestamp: ++time, schemaVersion: 1, type, payload };
    events.push(result); return result;
  }
  function message(role: Message["role"], content: string, extra: Partial<Message> = {}): Message {
    const result: Message = { id: newMessageId(), sessionId: session.id, turnId, role, content, createdAt: ++time, ...extra };
    messages.push(result); return result;
  }
  function project(): PageProjection { return projectSessionHistory({ session, events, messages }); }
  return { session, turnId, events, messages, event, message, project };
}
function recordData(event: SessionWireEvent): Record<string, unknown> { return event.data as Record<string, unknown>; }
function wireMessage(event: SessionWireEvent): Record<string, unknown> {
  return (event.type === "user/message" ? event.data : recordData(event).message) as Record<string, unknown>;
}
function followFrames(projection: PageProjection, afterSource = -1): SessionFollowFrame[] {
  return [...projection.framesBySourceSequence].filter(([sequence]) => sequence > afterSource).flatMap(([, frames]) => [...frames]);
}

/** Execute the vendored, unchanged official decoding and settlement functions.
 * Only unused Cordis service declarations need module-loading infrastructure;
 * no transport, event validator, stream fold, or projection is substituted. */
function officialClient() {
  interface Registration { id: string; factory: (require: (name: string) => unknown) => Record<string, unknown> }
  const registrations = new Map<string, Registration>();
  const context = vm.createContext({
    window: { __ModuleLoader__: { load(registration: Registration) { registrations.set(registration.id, registration); } } },
    console, AbortController, AbortSignal, setTimeout, clearTimeout, queueMicrotask,
  });
  const base = new URL("../../public/deepseek/plugins/", import.meta.url);
  const gateway = readFileSync(new URL("dsh-api-gateway/client.js", base), "utf8");
  const controller = readFileSync(new URL("dsh-api-session-controller/client.js", base), "utf8");
  vm.runInContext(gateway, context);
  // Expose existing private pure functions for the acceptance assertions.
  vm.runInContext(controller.replace("return module.exports;", "exports.__assertSessionWireEvent = assertSessionWireEvent; exports.__ClientAssistantStream = ClientAssistantStream; return module.exports;"), context);
  const cordis = { Service: class {}, Context: { filter: Symbol("filter") } };
  const loaded = new Map<string, Record<string, unknown>>();
  function require(name: string): unknown {
    if (name === "@deepseek-ai/cordis") return cordis;
    if (name === "@deepseek-ai/dsh-client-store") return {};
    const id = name.endsWith("/client") ? name.slice(0, -7) : name;
    let value = loaded.get(id);
    if (value === undefined) { value = registrations.get(id)!.factory(require); loaded.set(id, value); }
    return value;
  }
  const exports = require("@deepseek-ai/dsh-api-session-controller") as Record<string, unknown>;
  interface Decision { type: string; entry?: SessionHistoryRecord; attemptId?: string; retireAttemptId?: string }
  interface AssistantFold {
    replace(entries: readonly SessionHistoryRecord[], baseline?: SessionAssistantStreamBaseline): readonly { type: string; event: SessionWireEvent }[];
    acceptDurable(entry: SessionHistoryRecord): Decision | undefined;
    acceptFrame(frame: SessionAssistantStreamFrame): Decision | undefined;
  }
  return {
    assertEvent: exports.__assertSessionWireEvent as (event: unknown) => void,
    AssistantFold: exports.__ClientAssistantStream as new () => AssistantFold,
    SessionEventStream: exports.SessionEventStream as new (remote: unknown, address: unknown, options: unknown) => {
      follow(request: unknown, signal: AbortSignal): AsyncIterable<unknown>;
      readPage(request: unknown, throughSeq: number, signal: AbortSignal): Promise<unknown>;
    },
  };
}

describe("official DeepSeek Harness history projection", () => {
  it("preserves actual message ids, tool arguments, full results, and official surface envelopes", () => {
    const f = fixture();
    f.event("session.created", {}, false);
    const prompt = f.message("user", "Read the file");
    f.event("turn.started", { text: prompt.content });
    f.event("model.started", { callId: "model-call", stepId: "step-one", contextMessageIds: [prompt.id] });
    f.event("model.delta", { kind: "text", text: "Reading " });
    f.event("model.delta", { kind: "text", text: "the file." });
    const call = { id: newToolCallId(), name: "read_file", args: { path: "src/file.ts" } };
    const assistant = f.message("assistant", "Reading the file.", { toolCalls: [call], reasoningContent: "Inspect before changing." });
    f.event("model.completed", { text: assistant.content, toolCalls: 1, finishReason: "tool_calls", usage: { source: "measured", inputTokens: 12, outputTokens: 8 } });
    f.event("tool.requested", { toolCallId: call.id, name: call.name, args: call.args });
    f.event("tool.started", { toolCallId: call.id, tool: call.name });
    f.event("tool.output", { toolCallId: call.id, tool: call.name, stream: "stdout", text: "a".repeat(2000) });
    f.event("tool.completed", { toolCallId: call.id, tool: call.name, status: "success", outputPreview: "short preview" });
    f.event("tool.completed", { toolCallId: call.id, tool: call.name, durationMs: 2 });
    const result = f.message("tool", "whole result\n".repeat(2000), { toolCallId: call.id });
    f.event("model.started", { callId: "model-final", stepId: "step-two", contextMessageIds: f.messages.map(message => message.id) });
    const final = f.message("assistant", "Done **correctly**.");
    f.event("model.completed", { text: final.content, toolCalls: 0, finishReason: "stop" });
    f.event("turn.completed", { terminationReason: "model_stopped" });
    const projection = f.project();
    const client = officialClient();
    for (const { event } of projection.records) client.assertEvent(event);
    expect(projection.records.map(record => record.event.seq)).toEqual(projection.records.map((_, index) => index));
    const projectedMessages = projection.records.filter(record => ["user/message", "assistant/message", "tool/result"].includes(record.event.type));
    expect(projectedMessages.map(record => wireMessage(record.event).id)).toEqual([prompt.id, assistant.id, result.id, final.id]);
    expect(JSON.stringify(projection)).not.toContain("Inspect before changing.");
    const toolResult = projection.records.find(record => record.event.type === "tool/result")!.event;
    expect(wireMessage(toolResult).content).toEqual([{ type: "text", text: result.content }]);
    const toolCall = projection.records.find(record => record.event.type === "tool/call")!.event;
    expect(recordData(toolCall).arguments).toBe(JSON.stringify(call.args));
    expect(projection.records.filter(record => record.event.type === "tool/call")).toHaveLength(1);
    expect(projection.records.find(record => record.event.type === "harness/tool.output")?.event.data).toMatchObject({ payload: { text: "a".repeat(2000) } });
    expect(projection.assistantStream.activeAttempt).toBeUndefined();
    expect(projection.projections.values.turnBoundary).toMatchObject({ openTurnStartSeq: null, lastTurn: 1 });
  });

  it("holds the tool outcome append gap and preserves every published prefix when the result arrives", () => {
    const f = fixture();
    const prompt = f.message("user", "run");
    f.event("turn.started", { text: prompt.content });
    f.event("model.started", { callId: "call", stepId: "s" });
    const call = { id: newToolCallId(), name: "exec", args: { command: "echo real" } };
    const assistant = f.message("assistant", "", { toolCalls: [call] });
    f.event("model.completed", { text: "", toolCalls: 1, finishReason: "tool_calls" });
    f.event("tool.requested", { toolCallId: call.id, name: call.name, args: call.args });
    f.event("tool.started", { toolCallId: call.id, tool: call.name });
    const before = f.project();
    const terminal = f.event("tool.completed", { toolCallId: call.id, tool: call.name, status: "success" });
    const gap = f.project();
    expect(gap.records).toEqual(before.records);
    expect(gap.sourceCursor).toBe(terminal.sequence - 1);
    f.event("tool.completed", { toolCallId: call.id, tool: call.name });
    f.message("tool", "real stdout", { toolCallId: call.id });
    const settled = f.project();
    expect(settled.records.slice(0, before.records.length)).toEqual(before.records);
    expect(settled.sourceCursor).toBe(f.events.length - 1);
    expect(settled.records.filter(record => record.event.type === "assistant/message").map(record => wireMessage(record.event).id)).toEqual([assistant.id]);
    expect(settled.records.filter(record => record.event.type === "tool/result")).toHaveLength(1);
  });

  it("keeps published history immutable when a live session switches its model", () => {
    const f = fixture();
    const prompt = f.message("user", "只回复两个字：好的");
    f.event("turn.started", { text: prompt.content });
    f.event("model.started", { callId: "call", stepId: "step" });
    f.message("assistant", "好的", { model: { providerId: "loopback", modelId: "coding" } });
    f.event("model.completed", { text: "好的", toolCalls: 0, finishReason: "stop" });
    f.event("turn.completed");
    const before = f.project();
    const settled = before.records.find(record => record.event.type === "assistant/message")!.event;
    expect((recordData(settled).message as Record<string, unknown>).source).toEqual({ kind: "model", provider: "loopback", model: "coding" });
    // session/selectModel mutates the session row. The durable prefix a client
    // already holds must stay byte-identical, or the follow stream is right to
    // refuse it as a changed prefix.
    const switched: Session = { ...f.session, model: { providerId: "loopback", modelId: "coding-2" } };
    const after = projectSessionHistory({ session: switched, events: f.events, messages: f.messages });
    expect(after.records.map(record => JSON.stringify(record))).toEqual(before.records.map(record => JSON.stringify(record)));
    expect(after.projections.values.modelSelection).toEqual({ lastUsed: { provider: "loopback", model: "coding" }, next: { provider: "loopback", model: "coding-2" } });
  });

  it("joins dense assistant revisions and reconnect prefix through the official settlement fold", () => {
    const f = fixture();
    const prompt = f.message("user", "hello");
    f.event("turn.started", { text: prompt.content });
    const before = f.project();
    f.event("model.started", { callId: "stream", stepId: "step" });
    f.event("model.delta", { kind: "text", text: "Hello " });
    const reconnect = f.project();
    f.event("model.delta", { kind: "text", text: "world" });
    f.message("assistant", "Hello world");
    f.event("model.completed", { text: "Hello world", toolCalls: 0, finishReason: "stop" });
    f.event("turn.completed");
    const completed = f.project();
    const client = officialClient();
    const frames = followFrames(completed);
    const revisions = frames.flatMap(frame => frame.type === "assistant-stream" ? [frame.frame.revision] : []);
    expect(revisions).toEqual(revisions.map((_, index) => index + 1));
    const live = new client.AssistantFold();
    live.replace(before.records, before.assistantStream);
    for (const frame of followFrames(completed, before.sourceCursor)) {
      const decision = frame.type === "assistant-stream" ? live.acceptFrame(frame.frame) : frame.type === "event" ? live.acceptDurable(frame) : undefined;
      expect(decision?.type).not.toBe("rebaseline");
    }
    const resumed = new client.AssistantFold();
    const opening = resumed.replace(reconnect.records, reconnect.assistantStream);
    expect(opening.filter(entry => entry.type === "transient")).toHaveLength(2);
    for (const frame of followFrames(completed, reconnect.sourceCursor)) {
      const decision = frame.type === "assistant-stream" ? resumed.acceptFrame(frame.frame) : frame.type === "event" ? resumed.acceptDurable(frame) : undefined;
      expect(decision?.type).not.toBe("rebaseline");
    }
    const settlement = completed.records.find(record => record.event.type === "assistant/message")!.event;
    expect(recordData(settlement).stream).toMatchObject([
      { type: "chunk", chunk: { type: "block-start", index: 0, blockType: "text" } },
      { type: "chunk", chunk: { type: "text-delta", text: "Hello " } },
      { type: "chunk", chunk: { type: "text-delta", text: "world" } },
      { type: "chunk", chunk: { type: "block-end", block: { type: "text", text: "Hello world" } } },
      { type: "chunk", chunk: { type: "finish", reason: { kind: "stop" } } },
    ]);
  });

  it("passes real official follow/page decoding and detects a deliberately skipped revision", async () => {
    const f = fixture();
    const prompt = f.message("user", "stream");
    f.event("turn.started", { text: prompt.content });
    const initial = f.project();
    f.event("model.started", { callId: "stream", stepId: "step" });
    f.event("model.delta", { kind: "text", text: "partial" });
    const live = f.project();
    const client = officialClient();
    const snapshot: SessionFollowFrame = { type: "snapshot", header: initial.header, cursor: initial.cursor, records: initial.records, hasMore: false, projections: initial.projections, assistantStream: initial.assistantStream };
    let frames = [snapshot, ...followFrames(live, initial.sourceCursor)];
    const remote = {
      $stream: () => ({}),
      session: {
        async *follow() { yield* frames; },
        async page() { return { ok: true, value: pageSessionHistory(live, { throughSeq: live.cursor }) }; },
      },
    };
    const stream = new client.SessionEventStream(remote, { kind: "session", sessionId: f.session.id }, { publish() {}, failed() {} });
    const accepted = [];
    for await (const frame of stream.follow({}, new AbortController().signal)) accepted.push(frame);
    expect(accepted).toHaveLength(frames.length);
    expect(await stream.readPage({}, live.cursor, new AbortController().signal)).toEqual(pageSessionHistory(live, { throughSeq: live.cursor }));
    frames = frames.filter(frame => frame.type !== "assistant-stream" || frame.frame.revision !== 2);
    await expect((async () => { for await (const frame of stream.follow({}, new AbortController().signal)) void frame; })()).rejects.toThrow("skipped revision 2");
  });

  it("keeps failed and cancelled streamed attempts without fabricating assistant messages", () => {
    const f = fixture();
    f.message("user", "work"); f.event("turn.started", { text: "work" });
    f.event("model.started", { callId: "failed", stepId: "s" });
    f.event("model.delta", { kind: "text", text: "discarded attempt" });
    f.event("model.retry", { callId: "failed", attempt: 1, error: { code: "HTTP_ERROR", message: "503" } });
    f.event("model.started", { callId: "cancelled", stepId: "s" });
    f.event("model.delta", { kind: "text", text: "cancelled prefix" });
    f.event("turn.cancelled", { terminationReason: "cancelled" });
    const projection = f.project();
    expect(projection.records.filter(record => record.event.type === "step/start")).toHaveLength(1);
    expect(projection.records.filter(record => record.event.type === "assistant/attempt")).toHaveLength(2);
    expect(projection.records.filter(record => record.event.type === "assistant/message")).toHaveLength(0);
    expect(projection.assistantStream.activeAttempt).toBeUndefined();
    expect(projection.records.at(-1)?.event.data).toMatchObject({ reason: { kind: "aborted", reason: { kind: "user" } } });
    const client = officialClient();
    for (const { event } of projection.records) client.assertEvent(event);
  });

  it("reconciles accepted prompt ids from message or inbox identity and only logs real metadata commits", () => {
    const f = fixture();
    const prompt = f.message("user", "rename me"); f.event("turn.started", { text: prompt.content });
    f.event("tool.completed", { tool: "web_session_metadata", outputPreview: JSON.stringify({ title: "Committed title" }) }, false);
    const projection = projectSessionHistory({ session: f.session, events: f.events, messages: f.messages, title: "Cached title", requestIds: { [prompt.id]: "request-1" } });
    const user = projection.records.find(record => record.event.type === "user/message")!.event;
    expect(wireMessage(user).source).toEqual({ kind: "user", rpcId: "request-1" });
    expect(projection.projections.values.title).toBe("Committed title");
    expect(projection.records.filter(record => record.event.type === "session/title")).toHaveLength(1);
    const hintOnly = projectSessionHistory({ session: f.session, events: f.events.slice(0, 1), messages: f.messages, title: "Cached title" });
    expect(hintOnly.records.some(record => record.event.type === "session/title")).toBe(false);
  });

  it("uses official message-aligned page cuts and a fixed inclusive history watermark", () => {
    const f = fixture();
    f.message("user", "first"); f.event("turn.started", { text: "first" });
    f.event("model.started", { callId: "a" }); f.message("assistant", "answer"); f.event("model.completed", { text: "answer", toolCalls: 0, finishReason: "stop" }); f.event("turn.completed");
    const first = f.project();
    const secondTurn = newTurnId();
    f.message("user", "second", { turnId: secondTurn });
    const start = f.event("turn.started", { text: "second" }); start.turnId = secondTurn;
    const started = f.event("model.started", { callId: "b" }); started.turnId = secondTurn;
    f.message("assistant", "answer 2", { turnId: secondTurn });
    const done = f.event("model.completed", { text: "answer 2", toolCalls: 0, finishReason: "stop" }); done.turnId = secondTurn;
    const terminal = f.event("turn.completed"); terminal.turnId = secondTurn;
    const projection = f.project();
    const page = pageSessionHistory(projection, { throughSeq: projection.cursor, maxMessages: 1 });
    expect(page.records[0]?.event.type).toBe("assistant/message");
    expect(page.hasMore).toBe(true);
    expect(pageSessionHistory(projection, { throughSeq: first.cursor })).toEqual({ records: first.records, hasMore: false });
    const turnPage = pageSessionHistory(projection, { throughSeq: projection.cursor, maxMessages: 20, turnWindow: { minMessages: 2, minTurns: 1 } });
    expect(turnPage.records[0]?.event.data).toEqual({ turn: 2 });
    expect(turnPage.hasMore).toBe(true);
    expect(pageSessionHistory(projection, { throughSeq: -1 })).toEqual({ records: [], hasMore: false });
    expect(() => pageSessionHistory(projection, { throughSeq: projection.cursor + 1 })).toThrow("beyond");
    expect(() => pageSessionHistory(projection, { throughSeq: projection.cursor, maxMessages: 0 })).toThrow("positive");
  });

  it("rejects gaps, duplicated identities, wrong-session messages, incompatible ABI, and non-JSON payloads", () => {
    const f = fixture(); f.event("session.created", {}, false);
    expect(() => projectSessionHistory({ ...f, events: [{ ...f.events[0]!, sequence: 1 }] })).toThrow("contiguous");
    expect(() => projectSessionHistory({ ...f, events: [{ ...f.events[0]!, schemaVersion: 2 }] })).toThrow("ABI");
    const message = f.message("user", "test");
    expect(() => projectSessionHistory({ ...f, messages: [{ ...message, sessionId: newSessionId() }] })).toThrow("another session");
    expect(() => projectSessionHistory({ ...f, messages: [message, message] })).toThrow("duplicate message");
    expect(() => projectSessionHistory({ ...f, events: [{ ...f.events[0]!, payload: { missing: undefined } }] })).toThrow("lossless JSON");
  });

  it("keeps private host operations out of chat and assigns settled workspace snapshots stable source-owned seqs", () => {
    const f = fixture();
    f.message("user", "make a change"); f.event("turn.started", { text: "make a change" });
    f.event("model.started", { callId: "answer", stepId: "s" });
    f.message("assistant", "Changed"); f.event("model.completed", { text: "Changed", toolCalls: 0, finishReason: "stop" });
    const ended = f.event("turn.completed"); const before = f.project();
    f.event("tool.requested", { toolCallId: "host-1", tool: "web_workspace_read", hostOnly: true, privateValue: "SECRET-PRIVATE-HOST" }, false);
    f.event("tool.completed", { toolCallId: "host-1", tool: "web_workspace_read", hostOnly: true, status: "success" }, false);
    const hidden = f.project();
    expect(hidden.records).toEqual(before.records);
    expect(hidden.sourceCursor).toBe(f.events.length - 1);
    expect(JSON.stringify(hidden.records)).not.toContain("SECRET-PRIVATE-HOST");
    const derived = f.event("tool.completed", { tool: "web_workspace_changes", status: "success", hostOnly: true, derived: true, sourceSequence: ended.sequence, summary: { files: [], totals: { files: 0 } } });
    const completed = f.project();
    expect(completed.records.slice(0, before.records.length)).toEqual(before.records);
    const changes = completed.records.find(record => record.event.type === "workspace/changes")!.event;
    expect(changes.data).toEqual({ turn: 1 });
    expect(completed.sourceSequenceBySeq[changes.seq]).toBe(derived.sequence);
    const client = officialClient(); for (const record of completed.records) client.assertEvent(record.event);
  });

  it("holds the reply-message append gap so a later answer cannot renumber the followed durable prefix", () => {
    const f = fixture();
    f.message("user", "ask"); f.event("turn.started", { text: "ask" });
    f.event("ask.user_asked", { askId: "owned-ask", turnId: f.turnId, question: "Which?", reason: "choice_required" });
    f.event("ask.turn_waiting", { askId: "owned-ask", turnId: f.turnId });
    const before = f.project();
    const reply = f.event("ask.user_replied", { askId: "owned-ask", text: "yes" });
    expect(f.project().records).toEqual(before.records);
    f.message("user", "[user reply to your question]\nyes", { askId: "owned-ask" as never });
    const completed = f.project();
    expect(completed.records.slice(0, before.records.length)).toEqual(before.records);
    expect(completed.sourceCursor).toBe(reply.sequence);
    expect(completed.records.filter(record => record.event.type === "user/message")).toHaveLength(2);
  });

  it("publishes actual durable draft selection with an advancing official wire coordinate and no fabricated model use", () => {
    const f = fixture(); f.event("session.created", {}, false); const before = f.project();
    expect(before.projections.values.modelSelection).toMatchObject({ lastUsed: null });
    const selection = { provider: "configured-route", model: "selected-model" };
    f.session.model = { providerId: selection.provider, modelId: selection.model };
    const committed = f.event("human.message", { hostOnly: true, kind: "web_model_selection", selection }, false);
    const after = f.project(); const record = after.records.at(-1)!;
    expect(after.records.slice(0, before.records.length)).toEqual(before.records);
    expect(record.event).toMatchObject({ type: "model/selection", data: selection });
    expect(after.projections.asOfSeq).toBeGreaterThan(before.projections.asOfSeq);
    expect(after.sourceSequenceBySeq[record.event.seq]).toBe(committed.sequence);
    expect(after.projections.values.modelSelection).toEqual({ lastUsed: null, next: selection });
    const client = officialClient(); client.assertEvent(record.event);
    const invalid = { ...committed, payload: { ...committed.payload, selection: { ...selection, secret: "must-not-leak" } } };
    expect(() => projectSessionHistory({ ...f, events: [f.events[0]!, invalid] })).toThrow("durable Web model selection");
  });
});


it("review PR11: switching an upgraded session keeps its legacy durable prefix unchanged", () => {
  const f = fixture();
  f.event("session.created", {}, false);
  const user = f.message("user", "Existing task before upgrade");
  f.event("turn.started", { text: user.content });
  f.event("model.started", { callId: "old-model-call", contextMessageIds: [user.id] });
  const answer = f.message("assistant", "Persisted answer from before this PR");
  expect("model" in answer).toBe(false); // Exactly the persisted pre-PR Message contract.
  f.event("model.completed", { text: answer.content, toolCalls: 0, finishReason: "stop" });
  f.event("turn.completed", { terminationReason: "model_stopped" });
  const before = f.project();
  // The Runtime atomically records migration provenance with the new row.
  f.session.modelSelection = { version: 1, initialModel: { ...f.session.model }, model: { providerId: "new-route", modelId: "new-model" }, eventId: newEventId(), timestamp: 99 };
  f.session.model = { ...f.session.modelSelection.model };
  const after = f.project();
  expect(after.records.slice(0, before.records.length)).toEqual(before.records);
});
