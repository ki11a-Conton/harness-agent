import { createServer } from "node:http";
import { mkdtemp, mkdir, readFile, rm, writeFile, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { createHarness, type Harness } from "@ar/harness";
import { ScriptedModelProvider } from "@ar/model";
import type { AgentEvent, ModelProvider, SessionId } from "@ar/contracts";
import { createDeepseekComposition } from "./composition.js";

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
  const stack = await fixture();
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
  // `dsh web` runs without a data directory until a launch lease supplies one,
  // so the fixtures cover both the durable and the memory-only host shape.
  const config = { cwd, ...(options.durableStorage === false ? {} : { dataDir }), profile: "interactive" as const, modelProvider: provider, model: { providerId: provider.id, modelId: "scripted-model" } };
  const base = await createHarness(config); cleanup.push(() => base.close());
  const composition = await createDeepseekComposition(base, options.durableStorage === false ? undefined : dataDir); cleanup.push(() => composition.close());
  const createSession = async (workspaceId?: string) => (await composition.sessions.call("session/create", { request: workspaceId === undefined ? {} : { workspaceId } }, signal()) as { sessionId: SessionId }).sessionId;
  return { root, cwd, secondary, dataDir, config, base, composition, createSession };
}
async function eventually<T>(read: () => Promise<T>, accept: (value: T) => boolean): Promise<T> {
  for (let i = 0; i < 300; i++) { const value = await read(); if (accept(value)) return value; await new Promise(done => setTimeout(done, 5)); }
  throw new Error("Real composition owner did not reach the required state");
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
  const stack = await fixture(); const id = await stack.createSession();
  expect((await stack.composition.owners.ownerOf(id)).registry.has("schedule_create")).toBe(true);
  await stack.composition.close(); await stack.base.close();
  const base = await createHarness(stack.config); cleanup.push(() => base.close());
  const restarted = await createDeepseekComposition(base, stack.dataDir); cleanup.push(() => restarted.close());
  const restored = await restarted.owners.ownerOf(id);
  expect(restored.registry.has("schedule_create")).toBe(true);
  expect((await restarted.harness.runtime.getSessionAgent(id)).tools.allow).toContain("schedule_create");
  await expect(restarted.harness.sessions.load(id)).resolves.toBeDefined();
});

it("an external host observer preserves actual deliverable capture on a completed approved coding turn", async () => {
  const provider = new ScriptedModelProvider([ScriptedModelProvider.toolCall("write_file", { path: "generated.txt", content: "real generated content\n" }), ScriptedModelProvider.text("Created generated.txt")]);
  const stack = await fixture(provider); const id = await stack.createSession(); const seen: AgentEvent[] = [];
  stack.composition.observe(async event => { seen.push(event); });
  const owner = await stack.composition.owners.ownerOf(id); const actor = await owner.sessions.load(id);
  const turn = await actor.createTurn({ sessionId: id, text: "Create generated.txt" }); const running = actor.runTurn(turn.id);
  const pending = await eventually(async () => owner.approvalStore.listPending(id), rows => rows.length > 0);
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
  const running = actor.runTurn(turn.id);
  const pending = await eventually(async () => stack.composition.harness.approvalStore.listPending(id), items => items.length > 0);
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
