import { createServer } from "node:http";
import { mkdtemp, mkdir, readFile, rm, writeFile, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { createHarness, type Harness } from "@ar/harness";
import { ScriptedModelProvider } from "@ar/model";
import type { AgentEvent, ApprovalRequest, ModelProvider, SessionId, TurnId } from "@ar/contracts";
import { createDeepseekComposition } from "./composition.js";
import { projectSessionHistory } from "./projections.js";
import { allocateAvailableLeaseFixture } from "./test-support/lease-fixture.js";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const action of cleanup.splice(0).reverse()) await action(); });
const signal = () => new AbortController().signal;

it("configured model window and output limit affect the actual owner and provider requests", async () => {
  const requests: Array<{ model: string; max_tokens?: number }> = [];
  const server = createServer(async (request, response) => {
    let raw = ""; for await (const chunk of request) raw += chunk;
    requests.push(JSON.parse(raw)); response.writeHead(200, { "content-type": "text/event-stream" });
    response.end(`data: ${JSON.stringify({ choices: [{ delta: { content: "Configured output" } }] })}\n\ndata: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`);
  });
  await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
  cleanup.push(() => new Promise<void>(done => server.close(() => done())));
  // Model request limits do not depend on persistence. Cover the supported
  // memory host here; durable owner/lease and restart coverage lives below.
  const stack = await fixture(undefined, { durableStorage: false });
  await stack.composition.catalog.call("credentials/set", { ref: "LIMITS_FIXTURE", value: "local-limits-fixture" }, signal());
  await stack.composition.catalog.call("settings/update", { ns: "llm-pi-ai", patch: { providers: { limits: {
    api: "openai-completions", baseURL: `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`, apiKeyEnv: "LIMITS_FIXTURE",
    defaultContextWindow: 16384, defaultMaxTokens: 128, models: [{ id: "default-limits" }, { id: "model-limits", contextWindow: 8192, maxTokens: 64 }],
  } } } }, signal());
  for (const [modelId, window, maximum] of [["default-limits", 16384, 128], ["model-limits", 8192, 64]] as const) {
    const session = await stack.composition.owners.createSession(undefined, signal(), { providerKey: "limits", modelId });
    const owner = await stack.composition.owners.ownerOf(session.id);
    expect((await owner.config.modelProvider.listModels()).find(model => model.id === modelId)?.capabilities).toMatchObject({ contextWindowTokens: window, maxOutputTokens: maximum });
    expect(owner.context.budgetFallback).toBe(false);
    expect(owner.context.budget.maxTokens).toBe(Math.floor(window * 0.7));
    const actor = await owner.sessions.load(session.id); const turn = await actor.createTurn({ sessionId: session.id, text: "Explain the configured output limit" });
    expect((await actor.runTurn(turn.id)).status).toBe("completed");
    expect(requests.at(-1)).toMatchObject({ model: modelId, max_tokens: maximum });
    const client = owner.config.modelProvider.createClient(owner.config.model, {});
    for await (const _event of client.generate({ messages: [], maxTokens: 7 }, signal())) { /* Consume the actual HTTP stream. */ }
    expect(requests.at(-1)).toMatchObject({ model: modelId, max_tokens: 7 });
  }
});
async function fixture(provider: ModelProvider = new ScriptedModelProvider([ScriptedModelProvider.text("Real composition answer")]), options: { durableStorage?: boolean } = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "dsh-composition-"))); cleanup.push(() => rm(root, { recursive: true, force: true }));
  const cwd = join(root, "primary"); const secondary = join(root, "secondary"); const dataDir = join(root, "data");
  await Promise.all([mkdir(cwd), mkdir(secondary)]);
  await Promise.all([writeFile(join(cwd, "identity.txt"), "PRIMARY"), writeFile(join(secondary, "identity.txt"), "SECONDARY")]);
  // Functional assertions use the supported memory host. A test of restart
  // or persistence opts into real directory ownership explicitly; unrelated
  // tests must not assume a random Windows legacy lock port is available.
  const durable = options.durableStorage === true;
  const config = { cwd, ...(durable ? { dataDir } : {}), profile: "interactive" as const, modelProvider: provider, model: { providerId: provider.id, modelId: "scripted-model" } };
  const base = await createHarness(config); cleanup.push(() => base.close());
  const composition = await createDeepseekComposition(base, durable ? dataDir : undefined); cleanup.push(() => composition.close());
  const createSession = async (workspaceId?: string) => (await composition.sessions.call("session/create", { request: workspaceId === undefined ? {} : { workspaceId } }, signal()) as { sessionId: SessionId }).sessionId;
  return { root, cwd, secondary, dataDir, config, base, composition, createSession };
}
/** Subscribe before starting the real actor. The durable store still creates
 * the actual request; readiness no longer depends on 300 short polling slots.
 * Own the run through teardown too, so a failed assertion cannot close the
 * workspace manager underneath an unobserved actor promise. */
async function runUntilApproval(owner: Harness, actor: Awaited<ReturnType<Harness["sessions"]["load"]>>, turnId: TurnId) {
  let notify!: (request: ApprovalRequest) => void;
  const ready = new Promise<ApprovalRequest>(resolve => { notify = resolve; });
  const create = owner.approvalStore.create.bind(owner.approvalStore);
  const subscription = vi.spyOn(owner.approvalStore, "create").mockImplementation(request => {
    const entry = create(request); notify(request); return entry;
  });
  const controller = new AbortController();
  const running = actor.runTurn(turnId, controller.signal);
  // Install rejection ownership immediately, including before readiness.
  void running.catch(() => {});
  cleanup.push(async () => { try { controller.abort(); await running.catch(() => {}); } finally { subscription.mockRestore(); } });
  await Promise.race([ready, running.then(outcome => { throw new Error(`Turn settled before requesting approval: ${outcome.status}`); })]);
  return { running };
}

it("actual composed event generations survive private host identities and emit only visible sessions", async () => {
  const stack = await fixture(); const id = await stack.createSession(); const controller = new AbortController();
  const stream = stack.composition.sessions.stream("$events", {}, controller.signal)[Symbol.asyncIterator]();
  try {
    expect((await stream.next()).value).toMatchObject({ type: "ready" });
    expect((await stream.next()).value).toMatchObject({ type: "emit", event: "api-session/added", args: [{ sessionId: id }] });
    const workspaces = await stack.composition.workspace.metadata.read(signal());
    expect(workspaces.items.flatMap(row => row.sessionIds)).toEqual([id]);
  } finally { controller.abort(); await stream.return?.(); }
});

it("official secondary workspace creation and file read use the actual owner and enforce its boundary", async () => {
  const stack = await fixture();
  const created = await stack.composition.workspace.call("workspace/create", { request: { path: stack.secondary } }, signal()) as { workspace: { workspaceId: string } };
  const id = await stack.createSession(created.workspace.workspaceId);
  const file = await stack.composition.files.call("workspaceFiles/read", { workspaceFileScopeId: id, path: "identity.txt", range: {} }, signal()) as { text: string; absolutePath: string };
  expect(file.text).toBe("SECONDARY"); expect(file.absolutePath).toBe(join(stack.secondary, "identity.txt"));
  await expect(stack.composition.files.call("workspaceFiles/read", { workspaceFileScopeId: id, path: join(stack.cwd, "identity.txt"), range: {} }, signal())).rejects.toThrow();
  expect(await stack.base.store.getSession(id)).toBeUndefined();
});

it("restored child owners register their frozen schedule model tools before loading a session", async () => {
  // Admit the complete real restart before assertions. A unique temporary
  // directory does not reserve its child owner's fixed TCP lease port.
  const { id, initialScheduleTool, restarted, restored } = await allocateAvailableLeaseFixture(async () => {
    const stack = await fixture(undefined, { durableStorage: true }); const id = await stack.createSession();
    const initialScheduleTool = (await stack.composition.owners.ownerOf(id)).registry.has("schedule_create");
    await stack.composition.close(); await stack.base.close();
    const base = await createHarness(stack.config); cleanup.push(() => base.close());
    const restarted = await createDeepseekComposition(base, stack.dataDir); cleanup.push(() => restarted.close());
    const restored = await restarted.owners.ownerOf(id);
    return { id, initialScheduleTool, restarted, restored };
  }, cleanup);
  expect(initialScheduleTool).toBe(true);
  expect(restored.registry.has("schedule_create")).toBe(true);
  expect((await restarted.harness.runtime.getSessionAgent(id)).tools.allow).toContain("schedule_create");
  await expect(restarted.harness.sessions.load(id)).resolves.toBeDefined();
});

it("an external host observer preserves actual deliverable capture on a completed approved coding turn", async () => {
  const provider = new ScriptedModelProvider([ScriptedModelProvider.toolCall("write_file", { path: "generated.txt", content: "real generated content\n" }), ScriptedModelProvider.text("Created generated.txt")]);
  const stack = await fixture(provider); const id = await stack.createSession(); const seen: AgentEvent[] = [];
  stack.composition.observe(async event => { seen.push(event); });
  const owner = await stack.composition.owners.ownerOf(id); const actor = await owner.sessions.load(id);
  const turn = await actor.createTurn({ sessionId: id, text: "Create generated.txt" });
  const { running } = await runUntilApproval(owner, actor, turn.id);
  const pending = owner.approvalStore.listPending(id);
  owner.approvalStore.resolve(pending[0]!.id, "allow", "composition-test");
  expect((await running).status).toBe("completed"); expect(await readFile(join(stack.cwd, "generated.txt"), "utf8")).toBe("real generated content\n");
  expect(seen.some(event => event.type === "turn.completed")).toBe(true);
  const events = await stack.composition.harness.events.list(id);
  const changes = events.find(event => event.type === "tool.completed" && event.payload.tool === "web_workspace_changes");
  expect(changes).toBeDefined();
  expect(stack.composition.deliverables.summary(id, changes!.sequence)).toMatchObject({ files: [{ path: "generated.txt" }], total: 1 });
});

it("new valid model profiles are admitted by production composition and their profile identity reaches real HTTP", async () => {
  const calls: Array<{ model: string; authorization?: string }> = [];
  const server = createServer(async (req, res) => {
    let raw = ""; for await (const chunk of req) raw += String(chunk); calls.push({ model: (JSON.parse(raw) as { model: string }).model, authorization: req.headers.authorization });
    res.writeHead(200, { "content-type": "text/event-stream" }); res.end(`data: ${JSON.stringify({ choices: [{ delta: { content: "fresh configured answer" } }] })}\n\ndata: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`);
  });
  await new Promise<void>(done => server.listen(0, "127.0.0.1", done)); cleanup.push(() => new Promise<void>((done, reject) => server.close(error => error === undefined ? done() : reject(error))));
  const endpoint = `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`;
  const stack = await fixture(); const secret = "composition-private-key-89349";
  await stack.composition.catalog.call("credentials/set", { ref: "COMPOSITION_LOCAL_KEY", value: secret }, signal());
  await stack.composition.catalog.call("settings/update", { ns: "llm-pi-ai", patch: { providers: { gateway: { api: "openai-completions", baseURL: endpoint, apiKeyEnv: "COMPOSITION_LOCAL_KEY", models: [{ id: "fresh-coding", name: "Configured coding" }] } } } }, signal());
  const id = await stack.createSession(); const initial = (await stack.composition.harness.store.getSession(id))!;
  const snapshot = await (await stack.composition.owners.ownerOf(id)).store.loadStateSnapshot(id);
  expect(await stack.composition.catalog.call("session/selectModel", { request: { sessionId: id, provider: "gateway", model: "fresh-coding" } }, signal())).toEqual({ selected: { provider: "gateway", model: "fresh-coding" } });
  const session = (await stack.composition.harness.store.getSession(id))!;
  expect(session.id).toBe(initial.id); expect(stack.composition.owners.nativeSessionId(id)).not.toBe(id);
  const retired = stack.composition.owners.ownerList().find(row => row.harness.config.model.modelId === "scripted-model" && row.harness !== stack.base)!;
  expect(await retired.harness.store.loadStateSnapshot(id)).toEqual(snapshot);
  expect(session.model).toEqual({ providerId: "gateway", modelId: "fresh-coding" });
  const actor = await stack.composition.harness.sessions.load(session.id); const turn = await actor.createTurn({ sessionId: session.id, text: "Use the configured model" });
  expect((await actor.runTurn(turn.id)).status).toBe("completed");
  expect(calls).toEqual([{ model: "fresh-coding", authorization: `Bearer ${secret}` }]);
  const projected = await stack.composition.sessions.call("session/projections", { request: { sessionId: session.id } }, signal()) as { values: { modelSelection: { next: { provider: string; model: string } } } };
  expect(projected.values.modelSelection.next).toMatchObject({ provider: "gateway", model: "fresh-coding" });
  const allEvents = (await Promise.all((await stack.composition.harness.store.listSessions()).map(row => stack.composition.harness.events.list(row.id)))).flat();
  expect(JSON.stringify(allEvents)).not.toContain(secret);
});

it("a production-composed selected coding model edits the actual secondary workspace through its own approval and stable capture coordinates", async () => {
  const calls: Array<{ model: string; toolReply: boolean }> = [];
  const server = createServer(async (req, res) => {
    let raw = ""; for await (const chunk of req) raw += String(chunk);
    const request = JSON.parse(raw) as { model: string; messages: Array<{ role: string }> }; const toolReply = request.messages.some(message => message.role === "tool");
    calls.push({ model: request.model, toolReply }); res.writeHead(200, { "content-type": "text/event-stream" });
    const delta = toolReply ? { content: "Actual selected model created generated.txt" }
      : { tool_calls: [{ index: 0, id: "selected-coding-write", type: "function", function: { name: "write_file", arguments: JSON.stringify({ path: "generated.txt", content: "SELECTED SECONDARY\n" }) } }] };
    res.end(`data: ${JSON.stringify({ choices: [{ delta }] })}\n\ndata: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: toolReply ? "stop" : "tool_calls" }] })}\n\ndata: [DONE]\n\n`);
  });
  await new Promise<void>(done => server.listen(0, "127.0.0.1", done)); cleanup.push(() => new Promise<void>((done, reject) => server.close(error => error ? reject(error) : done())));
  const stack = await fixture(); const endpoint = `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`;
  await stack.composition.catalog.call("credentials/set", { ref: "SELECTED_CODING_KEY", value: "private-selected-coding-key" }, signal());
  await stack.composition.catalog.call("settings/update", { ns: "llm-pi-ai", patch: { providers: { "local-coding": { api: "openai-completions", baseURL: endpoint, apiKeyEnv: "SELECTED_CODING_KEY", models: [{ id: "selected-coding" }] } } } }, signal());
  const created = await stack.composition.workspace.call("workspace/create", { request: { path: stack.secondary } }, signal()) as { workspace: { workspaceId: string } };
  const id = await stack.createSession(created.workspace.workspaceId); const prefix = await stack.composition.harness.events.list(id);
  await stack.composition.catalog.call("session/selectModel", { request: { sessionId: id, provider: "local-coding", model: "selected-coding" } }, signal());
  const native = stack.composition.owners.nativeSessionId(id); const owner = await stack.composition.owners.ownerOf(id);
  const actor = await stack.composition.harness.sessions.load(id); const turn = await actor.createTurn({ sessionId: id, text: "Write generated.txt in this workspace" });
  const { running } = await runUntilApproval(owner, actor, turn.id);
  const pending = stack.composition.harness.approvalStore.listPending(id);
  expect(pending[0]).toMatchObject({ sessionId: id, turnId: turn.id }); expect(owner.approvalStore.listPending(native)[0]?.sessionId).toBe(native);
  stack.composition.harness.approvalStore.resolve(pending[0]!.id, "allow", "selected-model-integration");
  const outcome = await running; expect(outcome.status).toBe("completed"); expect(outcome.turn.sessionId).toBe(id);
  expect(await readFile(join(stack.secondary, "generated.txt"), "utf8")).toBe("SELECTED SECONDARY\n");
  await expect(readFile(join(stack.cwd, "generated.txt"))).rejects.toMatchObject({ code: "ENOENT" });
  expect(calls).toEqual([{ model: "selected-coding", toolReply: false }, { model: "selected-coding", toolReply: true }]);
  const journal = await stack.composition.harness.events.list(id); expect(journal.slice(0, prefix.length)).toEqual(prefix);
  expect(journal.every(event => event.sessionId === id)).toBe(true); expect(journal.map(event => event.sequence)).toEqual(journal.map((_, index) => index));
  const captured = journal.find(event => event.payload.tool === "web_workspace_changes" && event.payload.derived === true)!;
  expect(captured).toBeDefined(); expect(stack.composition.deliverables.summary(id, captured.sequence)).toMatchObject({ total: 1, files: [{ path: "generated.txt" }] });
  // Read the public projection's committed cursor, rather than synthesizing
  // HTTP coordinates from a physical sequence belonging to another generation.
  const view = await stack.composition.sessions.call("session/projections", { request: { sessionId: id } }, signal()) as { asOfSeq: number; values: unknown };
  const page = await stack.composition.sessions.call("session/page", { request: { address: { kind: "session", sessionId: id }, throughSeq: view.asOfSeq } }, signal()) as { records: Array<{ event: { seq: number; type: string } }> };
  const changes = page.records.find(record => record.event.type === "workspace/changes")!.event;
  expect(await stack.composition.sessions.sourceSequence(id, changes.seq, signal())).toBe(captured.sequence);
  const response = await stack.composition.http(new Request(`http://localhost/api/changes.summary?sessionId=${id}&seq=${changes.seq}`));
  expect(response?.status).toBe(200); expect(await response?.json()).toMatchObject({ total: 1, files: [{ path: "generated.txt" }] });
});

it("a memory-only host still changes a draft model and still refuses durable task state", async () => {
  const stack = await fixture(undefined, { durableStorage: false });
  await stack.composition.catalog.call("credentials/set", { ref: "MEMORY_ONLY_KEY", value: "memory-only-private-key" }, signal());
  await stack.composition.catalog.call("settings/update", { ns: "llm-pi-ai", patch: { providers: { "memory-only": {
    api: "openai-completions", baseURL: "http://127.0.0.1:9/v1", apiKeyEnv: "MEMORY_ONLY_KEY", models: [{ id: "memory-only-model" }],
  } } } }, signal());
  const id = await stack.createSession();
  {
    // The memory-only host must expose the same per-session, zero-based dense
    // journal the durable stores expose: the draft-prefix guard in owners.ts
    // rejects a session whose journal is not a dense immutable prefix.
    const owner = await stack.composition.owners.ownerOf(id);
    const native = stack.composition.owners.nativeSessionId(id) as SessionId;
    const journal = await owner.events.list(native);
    expect(journal.map(event => event.sequence)).toEqual(journal.map((_event, index) => index));
    expect(await owner.events.nextSequence(native)).toBe(journal.length);
  }
  // The official model dialog selects through this endpoint, and a host without a
  // data directory owns no durable tasks, so the draft must not be blocked.
  expect(await stack.composition.catalog.call("session/selectModel", { request: { sessionId: id, provider: "memory-only", model: "memory-only-model" } }, signal()))
    .toEqual({ selected: { provider: "memory-only", model: "memory-only-model" } });
  expect((await stack.composition.harness.store.getSession(id))!.model).toEqual({ providerId: "memory-only", modelId: "memory-only-model" });
  expect(await stack.composition.activity.sessionActivity(id, signal())).toMatchObject({ activeSchedules: 0, pendingDispatches: 0, unresolvedClaims: 0 });
  // Claiming a durable answer without durable storage stays a refusal.
  await expect(stack.composition.activity.call("schedule/catalog", {}, signal())).rejects.toMatchObject({ code: "schedule/unavailable" });
});

it("repeated memory-only selection runs each selected HTTP model, including after a turn", async () => {
  const requests: Array<Record<string, unknown>> = [];
  const server = createServer(async (request, response) => {
    let body = ""; for await (const chunk of request) body += chunk;
    requests.push(JSON.parse(body)); response.writeHead(200, { "content-type": "text/event-stream" });
    response.end('data: {"choices":[{"index":0,"delta":{"content":"actual memory model answer"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
  });
  await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
  cleanup.push(() => new Promise<void>((done, reject) => server.close(error => error ? reject(error) : done())));
  const address = server.address(); if (!address || typeof address === "string") throw new Error("Missing review listener");
  const stack = await fixture(undefined, { durableStorage: false });
  await stack.composition.catalog.call("credentials/set", { ref: "REVIEW_KEY", value: "review-local-key" }, signal());
  await stack.composition.catalog.call("settings/update", { ns: "llm-pi-ai", patch: { providers: { review: {
    api: "openai-completions", baseURL: `http://127.0.0.1:${address.port}/v1`, apiKeyEnv: "REVIEW_KEY", models: [{ id: "model-a" }, { id: "model-b" }],
  } } } }, signal());
  const id = await stack.createSession();
  for (const model of ["model-a", "model-b", "model-a"]) {
    await expect(stack.composition.catalog.call("session/selectModel", { request: { sessionId: id, provider: "review", model } }, signal())).resolves.toEqual({ selected: { provider: "review", model } });
  }
  await stack.composition.sessions.call("session/prompt", { request: { sessionId: id, requestId: "review-real-memory-turn", mode: "queue", content: [{ type: "text", text: "Give the configured answer" }] } }, signal());
  const deadline = performance.now() + 10000;
  while (performance.now() < deadline && !(await stack.composition.harness.store.listTurns(id)).some(turn => turn.status === "completed")) await new Promise(done => setTimeout(done, 10));
  expect((await stack.composition.harness.store.listTurns(id)).map(turn => turn.status)).toEqual(["completed"]);
  expect(requests).toHaveLength(1); expect(requests[0]).toHaveProperty("model", "model-a");
  expect((await stack.composition.harness.store.listMessages(id)).some(message => message.content === "actual memory model answer")).toBe(true);
  const project = async () => projectSessionHistory({
    session: (await stack.composition.harness.store.getSession(id))!,
    events: await stack.composition.harness.events.list(id),
    messages: await stack.composition.harness.store.listMessages(id),
  });
  const beforeSwitch = await project();
  // A session that already produced a turn keeps its identity and its journal:
  // the new selection applies to the next request instead of being refused.
  const native = stack.composition.owners.nativeSessionId(id);
  await expect(stack.composition.catalog.call("session/selectModel", { request: { sessionId: id, provider: "review", model: "model-b" } }, signal()))
    .resolves.toEqual({ selected: { provider: "review", model: "model-b" } });
  expect(stack.composition.owners.nativeSessionId(id)).toBe(native);
  expect((await stack.composition.harness.store.getSession(id))!.model).toEqual({ providerId: "review", modelId: "model-b" });
  // A client already holds the durable prefix above. Switching the model changes
  // what the NEXT request uses; it must never rewrite a published record (that
  // is exactly what the follow stream rejects as a changed prefix), and every
  // settled answer keeps the model that actually produced it.
  const afterSwitch = await project();
  expect(afterSwitch.records.slice(0, beforeSwitch.records.length).map(record => JSON.stringify(record)))
    .toEqual(beforeSwitch.records.map(record => JSON.stringify(record)));
  const settled = afterSwitch.records.find(record => record.event.type === "assistant/message")!.event;
  expect((settled.data as { message: { source: unknown } }).message.source).toEqual({ kind: "model", provider: "review", model: "model-a" });
  expect(afterSwitch.projections.values.modelSelection).toEqual({ lastUsed: { provider: "review", model: "model-a" }, next: { provider: "review", model: "model-b" } });
  await stack.composition.sessions.call("session/prompt", { request: { sessionId: id, requestId: "review-real-memory-turn-two", mode: "queue", content: [{ type: "text", text: "Give the second configured answer" }] } }, signal());
  const switchedDeadline = performance.now() + 10000;
  while (performance.now() < switchedDeadline && (await stack.composition.harness.store.listTurns(id)).filter(turn => turn.status === "completed").length < 2) await new Promise(done => setTimeout(done, 10));
  expect((await stack.composition.harness.store.listTurns(id)).map(turn => turn.status)).toEqual(["completed", "completed"]);
  expect(requests).toHaveLength(2); expect(requests[1]).toHaveProperty("model", "model-b");
});


it("review PR13: an idle real Web owner must not replay the full physical journal per events poll", async () => {
  const stack = await fixture(); const id = await stack.createSession();
  const owner = await stack.composition.owners.ownerOf(id);
  const list = owner.events.list.bind(owner.events); let fullPhysicalReads = 0;
  let observed!: () => void; const fourReads = new Promise<void>(done => { observed = done; });
  const spy = vi.spyOn(owner.events, "list").mockImplementation(async (sid, options) => {
    if (options?.afterSequence === undefined) {
      fullPhysicalReads += 1; if (fullPhysicalReads >= 4) observed();
    }
    return list(sid, options);
  });
  const { createEventsService } = await import("./events.js");
  const service = createEventsService({ harness: stack.composition.harness, pollDelayMs: 1,
    answerAsk: async () => { throw new Error("unused"); } });
  const controller = new AbortController();
  const running = (async () => { for await (const _frame of service.stream("$events", {}, controller.signal)) {} })();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([fourReads, new Promise<void>(done => { timer = setTimeout(done, 250); })]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    controller.abort(); await running.catch(error => { if (error?.name !== "AbortError") throw error; }); spy.mockRestore();
  }
  expect(fullPhysicalReads).toBeLessThanOrEqual(1);
});

it("review PR13: an idle replaced stable draft owner must not replay the full physical journal per events poll", async () => {
  const stack = await fixture(); const id = await stack.createSession();
  await stack.composition.catalog.call("credentials/set", { ref: "REVIEW_OWNER_ROUTE", value: "synthetic-local-provider-key" }, signal());
  await stack.composition.catalog.call("settings/update", { ns: "llm-pi-ai", patch: { providers: { review: {
    api: "openai-completions", baseURL: "http://127.0.0.1:1/v1", apiKeyEnv: "REVIEW_OWNER_ROUTE",
    models: [{ id: "review-model" }],
  } } } }, signal());
  await stack.composition.owners.selectModel(id, { providerKey: "review", modelId: "review-model" }, signal());
  expect(stack.composition.owners.nativeSessionId(id)).not.toBe(id);
  const owner = await stack.composition.owners.ownerOf(id);
  const list = owner.events.list.bind(owner.events); let fullPhysicalReads = 0;
  let observed!: () => void; const fourReads = new Promise<void>(done => { observed = done; });
  const spy = vi.spyOn(owner.events, "list").mockImplementation(async (sid, options) => {
    if (options?.afterSequence === undefined) {
      fullPhysicalReads += 1; if (fullPhysicalReads >= 4) observed();
    }
    return list(sid, options);
  });
  const { createEventsService } = await import("./events.js");
  const service = createEventsService({ harness: stack.composition.harness, pollDelayMs: 1,
    answerAsk: async () => { throw new Error("unused"); } });
  const controller = new AbortController();
  const running = (async () => { for await (const _frame of service.stream("$events", {}, controller.signal)) {} })();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([fourReads, new Promise<void>(done => { timer = setTimeout(done, 250); })]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    controller.abort(); await running.catch(error => { if (error?.name !== "AbortError") throw error; }); spy.mockRestore();
  }
  expect(fullPhysicalReads).toBeLessThanOrEqual(1);
});
