import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { z } from "zod";
import { computeCheckpointChecksum, newApprovalId, newArtifactId, newAskId, newEventId, newMessageId, newPromptId, newToolCallId, type ModelProvider, type SessionId } from "@ar/contracts";
import { acquireDataDirLease, DataDirLeaseError } from "@ar/cli";
import { createHarness, type Harness } from "@ar/harness";
import { OpenAICompatibleProvider, ScriptedModelProvider } from "@ar/model";
import { createHostTools } from "./host-tools.js";
import { createOwnerManager, type OwnerHooks, type OwnerManager } from "./owners.js";
import { createDeliverablesService } from "./deliverables.js";
import { createFilesService, workspaceReadTool } from "./files.js";
import { allocateAvailableLeaseFixture } from "./test-support/lease-fixture.js";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const action of cleanup.splice(0).reverse()) await action(); });
const signal = () => new AbortController().signal;

// Expected business failures are asserted after admission, never retried. A
// genuine lease refusal must still escape to the whole-fixture allocator.
async function preparationFailure(action: () => Promise<unknown>): Promise<unknown> {
  try { await action(); return undefined; }
  catch (error) { if (error instanceof DataDirLeaseError) throw error; return error; }
}

async function fixture(provider: ModelProvider = new ScriptedModelProvider([ScriptedModelProvider.text("real answer")]), options: Partial<OwnerHooks> = {}, modelId = "scripted-model") {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "dsh-owner-"))); cleanup.push(() => rm(directory, { recursive: true, force: true }));
  const primary = join(directory, "primary"); const secondary = join(directory, "secondary"); const dataDir = join(directory, "data");
  await Promise.all([mkdir(primary), mkdir(secondary)]);
  await Promise.all([writeFile(join(primary, "identity.txt"), "PRIMARY"), writeFile(join(secondary, "identity.txt"), "SECONDARY")]);
  const config = { cwd: primary, dataDir, profile: "interactive" as const, modelProvider: provider, model: { providerId: provider.id, modelId } };
  const base = await createHarness(config); cleanup.push(() => base.close());
  const tools = createHostTools(base, primary, dataDir);
  const hooks: OwnerHooks = { dataDir, workspace: async id => id === "secondary" ? { path: secondary, workspaceId: "secondary" } : id === "primary" || id === undefined ? { path: primary, workspaceId: "primary" } : undefined,
    executeHostTool: tools.executeHostTool, ...options };
  const manager = await createOwnerManager(base, hooks); cleanup.push(() => manager.close());
  return { directory, primary, secondary, dataDir, base, tools, hooks, manager, config };
}

it("a secondary workspace executes its actual read tool with its own cwd, sandbox, journal, and actor", async () => {
  const provider = new ScriptedModelProvider([ScriptedModelProvider.toolCall("read_file", { path: "identity.txt" }), ScriptedModelProvider.text("secondary complete")]);
  const { stack, session, owner } = await allocateAvailableLeaseFixture(async () => {
    const stack = await fixture(provider);
    const session = await stack.manager.createSession("secondary", signal());
    const owner = await stack.manager.ownerOf(session.id);
    return { stack, session, owner };
  }, cleanup);
  expect(owner).not.toBe(stack.base); expect(owner.config.cwd).toBe(stack.secondary); expect(session.cwd).toBe(stack.secondary);
  const actor = await stack.manager.harnessFacade.sessions.load(session.id);
  const turn = await actor.createTurn({ sessionId: session.id, text: "Read the workspace identity" });
  const result = await actor.runTurn(turn.id);
  expect(result.status).toBe("completed");
  const messages = await stack.manager.harnessFacade.store.listMessages(session.id);
  expect(messages.find(message => message.role === "tool")?.content).toContain("SECONDARY");
  expect(messages.find(message => message.role === "tool")?.content).not.toContain("PRIMARY");
  expect(await stack.base.store.getSession(session.id)).toBeUndefined();
  expect((await stack.manager.harnessFacade.events.list(session.id)).some(event => event.type === "tool.completed")).toBe(true);
  expect(stack.manager.harnessFacade.sessions.listLoaded()).toContain(session.id);
  expect((await stack.manager.harnessFacade.store.listSessions()).map(row => row.id)).toContain(session.id);
});

it("real selected models reach separate HTTP endpoints and never mutate a previous frozen session", async () => {
  const requests: Array<{ endpoint: string; model: string }> = [];
  async function provider(modelId: string, endpoint: string): Promise<ModelProvider> {
    const server = createServer(async (req, res) => {
      let body = ""; for await (const chunk of req) body += String(chunk);
      requests.push({ endpoint, model: (JSON.parse(body) as { model: string }).model });
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(`data: ${JSON.stringify({ choices: [{ delta: { content: `${endpoint} answer` } }] })}\n\ndata: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 2, completion_tokens: 2 } })}\n\ndata: [DONE]\n\n`);
    });
    await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
    cleanup.push(() => new Promise<void>((done, reject) => server.close(error => error === undefined ? done() : reject(error))));
    const port = (server.address() as { port: number }).port;
    return new OpenAICompatibleProvider({ baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: "loopback-test-key", modelId, requestPolicy: { maxProviderRetries: 0, retryDelayMs: 0, requestTimeoutMs: 10000 } });
  }
  const original = await provider("model-original", "original"); const selected = await provider("model-selected", "selected");
  const { stack, first, second } = await allocateAvailableLeaseFixture(async () => {
    const stack = await fixture(original, { resolveSelection: async selection => ({ modelProvider: selected, model: { providerId: selected.id, modelId: selection.modelId } }) }, "model-original");
    const first = await stack.manager.createSession(undefined, signal());
    const second = await stack.manager.createSession("secondary", signal(), { providerKey: "selected-reference", modelId: "model-selected" });
    return { stack, first, second };
  }, cleanup);
  expect(first.model.modelId).toBe("model-original"); expect(second.model.modelId).toBe("model-selected");
  for (const session of [first, second]) {
    const actor = await stack.manager.harnessFacade.sessions.load(session.id);
    const turn = await actor.createTurn({ sessionId: session.id, text: "Give a short answer" });
    expect((await actor.runTurn(turn.id)).status).toBe("completed");
  }
  expect(requests).toEqual([{ endpoint: "original", model: "model-original" }, { endpoint: "selected", model: "model-selected" }]);
  const before = await stack.base.store.loadStateSnapshot(first.id);
  await expect(stack.manager.selectModel(first.id, { providerKey: "selected-reference", modelId: "model-selected" }, signal())).rejects.toMatchObject({ code: "session/model-frozen" });
  expect(await stack.base.store.loadStateSnapshot(first.id)).toEqual(before);
  await expect(stack.manager.selectModel(second.id, { providerKey: "selected-reference", modelId: "model-selected" }, signal())).resolves.toBeUndefined();
  const index = await readFile(join(stack.dataDir, "deepseek", "owners-index.json"), "utf8");
  expect(index).toContain("selected-reference"); expect(index).not.toContain("loopback-test-key"); expect(index).not.toContain("baseUrl");
});

it("concurrent creations share one owner and restart recovers native history through its real frozen owner", async () => {
  const { stack, sessions } = await allocateAvailableLeaseFixture(async () => {
    const stack = await fixture();
    const sessions = await Promise.all(Array.from({ length: 6 }, () => stack.manager.createSession("secondary", signal())));
    return { stack, sessions };
  }, cleanup);
  expect(new Set(sessions.map(session => session.id)).size).toBe(6); expect(stack.manager.ownerList()).toHaveLength(2);
  expect((JSON.parse(await readFile(join(stack.dataDir, "deepseek", "owners-index.json"), "utf8")) as { owners: unknown[] }).owners).toHaveLength(1);
  const session = sessions[0]!; const actor = await stack.manager.harnessFacade.sessions.load(session.id);
  const turn = await actor.createTurn({ sessionId: session.id, text: "Durable history" }); await actor.runTurn(turn.id);
  const originalMessages = await stack.manager.harnessFacade.store.listMessages(session.id);
  await stack.manager.close(); await stack.base.close();
  const base = await createHarness(stack.config); cleanup.push(() => base.close());
  const tools = createHostTools(base, stack.primary, stack.dataDir);
  const restarted = await createOwnerManager(base, { ...stack.hooks, executeHostTool: tools.executeHostTool }); cleanup.push(() => restarted.close());
  expect(await restarted.harnessFacade.store.listMessages(session.id)).toEqual(originalMessages);
  expect((await restarted.ownerOf(session.id)).config.cwd).toBe(stack.secondary);
  expect((await restarted.harnessFacade.sessions.load(session.id)).sessionId).toBe(session.id);
  expect((await restarted.harnessFacade.checkSessionConfigDrift(session.id)).severity).toBe("none");
});

it("every child owns a genuine single-writer lease and closing it releases the store for another host", async () => {
  const { stack, session, child, childDir } = await allocateAvailableLeaseFixture(async () => {
    const stack = await fixture(); const session = await stack.manager.createSession("secondary", signal());
    const child = await stack.manager.ownerOf(session.id); const childDir = child.config.dataDir!;
    return { stack, session, child, childDir };
  }, cleanup);
  await expect(acquireDataDirLease(childDir)).rejects.toMatchObject({ code: "HARNESS_DATA_DIR_IN_USE" });
  await stack.manager.close();
  const replacement = await acquireDataDirLease(childDir); expect(replacement?.dataDir).toBe(childDir); await replacement?.release();
  await expect(stack.manager.createSession("secondary", signal())).rejects.toMatchObject({ code: "gateway/cancelled" });
});

it("new primary UI sessions can use children without changing the legacy Harness policy", async () => {
  const { stack, oldAgent, frozenBaseConfig, session } = await allocateAvailableLeaseFixture(async () => {
    const stack = await fixture(undefined, { newSessionsUseChildren: true });
    const oldAgent = JSON.stringify(stack.base.agents[0]); const frozenBaseConfig = stack.base.resolvedConfig.fingerprint;
    const session = await stack.manager.createSession(undefined, signal());
    return { stack, oldAgent, frozenBaseConfig, session };
  }, cleanup);
  expect(await stack.manager.ownerOf(session.id)).not.toBe(stack.base);
  expect(await stack.base.store.getSession(session.id)).toBeUndefined();
  expect(JSON.stringify(stack.base.agents[0])).toBe(oldAgent); expect(stack.base.resolvedConfig.fingerprint).toBe(frozenBaseConfig);
});

it("new owner tool registration and one exact metadata capability are frozen without widening the legacy policy", async () => {
  const { stack, schedulePath, original, oldToolNames, manager, session, owner } = await allocateAvailableLeaseFixture(async () => {
    const stack = await fixture(); await stack.manager.close();
    const schedulePath = join(stack.dataDir, "deepseek", "schedules.json");
    const original = stack.base.resolvedConfig.fingerprint; const oldToolNames = [...stack.base.agents[0]!.tools.allow!];
    const manager = await createOwnerManager(stack.base, { ...stack.hooks, newSessionsUseChildren: true, extraSandboxPaths: [schedulePath], configureOwner: owner => {
      owner.registry.register({ name: "owner_schedule_probe", description: "Inspect the registered owner capability.", inputSchema: z.object({}).strict(), risk: "readonly", metadata: { name: "owner_schedule_probe", version: "1", sideEffect: false, filesystem: false, process: false, network: false, interactive: false, retry: "safe" }, async execute() { return { status: "success", output: "registered" }; } });
      owner.agents[0]!.tools.allow!.push("owner_schedule_probe");
    } }); cleanup.push(() => manager.close());
    const session = await manager.createSession(undefined, signal()); const owner = await manager.ownerOf(session.id);
    return { stack, schedulePath, original, oldToolNames, manager, session, owner };
  }, cleanup);
  expect(owner.config.sandboxPolicy?.filesystem.allowedPaths).toContain(schedulePath);
  expect((await manager.harnessFacade.runtime.getSessionAgent(session.id)).tools.allow).toContain("owner_schedule_probe");
  expect(stack.base.resolvedConfig.fingerprint).toBe(original); expect(stack.base.agents[0]!.tools.allow).toEqual(oldToolNames);
  expect(stack.base.config.sandboxPolicy?.filesystem.allowedPaths ?? []).not.toContain(schedulePath);
  await expect(createOwnerManager(stack.base, { ...stack.hooks, extraSandboxPaths: [stack.secondary] })).rejects.toMatchObject({ code: "gateway/forbidden" });
});

it("approval and question ownership remain in the actual secondary stores", async () => {
  const { stack, session } = await allocateAvailableLeaseFixture(async () => {
    const stack = await fixture(); const session = await stack.manager.createSession("secondary", signal());
    return { stack, session };
  }, cleanup);
  const owner = await stack.manager.ownerOf(session.id); const actor = await owner.sessions.load(session.id);
  const turn = await actor.createTurn({ sessionId: session.id, text: "Question owner" });
  const askId = newAskId(); const approvalId = newApprovalId();
  await owner.askUserStore!.create({ id: askId, sessionId: session.id, turnId: turn.id, question: "Choose", reason: "choice_required", status: "pending", createdAt: Date.now() });
  const pending = owner.approvalStore.create({ id: approvalId, sessionId: session.id, turnId: turn.id, agentId: owner.agents[0]!.id, action: "edit", target: join(stack.secondary, "identity.txt"), reason: "Owner test", createdAt: Date.now(), expiresAt: Date.now() + 10000 });
  expect(await stack.manager.harnessFacade.askUserStore!.get(askId)).toMatchObject({ sessionId: session.id });
  expect(await stack.manager.harnessFacade.askUserStore!.listPending(session.id)).toHaveLength(1);
  expect(stack.manager.harnessFacade.approvalStore.listPending(session.id)).toHaveLength(1);
  stack.manager.harnessFacade.approvalStore.resolve(approvalId, "deny", "test");
  expect((await pending.wait(signal())).value).toBe("deny"); expect(stack.base.approvalStore.listDecisions()).toHaveLength(0);
  expect(stack.manager.harnessFacade.approvalStore.listDecisions(session.id)).toMatchObject([{ id: approvalId, sessionId: session.id, value: "deny" }]);
});

it("a denied owner index write does not create or expose a child session", async () => {
  const stack = await fixture();
  await stack.manager.close();
  const manager = await createOwnerManager(stack.base, { ...stack.hooks, executeHostTool: async (id, definition, args, abort) => definition.name === "web_owner_index_write" ? { status: "denied" } : stack.tools.executeHostTool(id, definition, args, abort) }); cleanup.push(() => manager.close());
  await expect(manager.createSession("secondary", signal())).rejects.toMatchObject({ code: "gateway/internal" });
  expect(manager.ownerList()).toHaveLength(1);
  await expect(readFile(join(stack.dataDir, "deepseek", "owners-index.json"))).rejects.toMatchObject({ code: "ENOENT" });
});

it("index traversal and a symlink owner parent fail closed without writing outside host metadata", async () => {
  const stack = await fixture(); await stack.manager.close();
  await mkdir(join(stack.dataDir, "deepseek"), { recursive: true });
  await writeFile(join(stack.dataDir, "deepseek", "owners-index.json"), JSON.stringify({ version: 1, revision: 0, owners: [{ id: "../outside", path: stack.secondary }] }));
  await expect(createOwnerManager(stack.base, stack.hooks)).rejects.toMatchObject({ code: "gateway/internal" });
  await rm(join(stack.dataDir, "deepseek", "owners-index.json"));
  const outside = join(stack.directory, "outside"); await mkdir(outside);
  await symlink(outside, join(stack.dataDir, "deepseek", "owners"), process.platform === "win32" ? "junction" : "dir");
  const manager = await createOwnerManager(stack.base, stack.hooks); cleanup.push(() => manager.close());
  await expect(manager.createSession("secondary", signal())).rejects.toThrow(/symlink/);
  const id = createHash("sha256").update(JSON.stringify({ path: process.platform === "win32" ? stack.secondary.toLowerCase() : stack.secondary })).digest("hex");
  await expect(readFile(join(outside, id, "sessions", "index.json"))).rejects.toMatchObject({ code: "ENOENT" });
});

it("native facade refuses unknown sessions and cross-session turn/message forgery even within one owner", async () => {
  const { stack, first, second } = await allocateAvailableLeaseFixture(async () => {
    const stack = await fixture();
    const first = await stack.manager.createSession("secondary", signal()); const second = await stack.manager.createSession("secondary", signal());
    return { stack, first, second };
  }, cleanup);
  const facade = stack.manager.harnessFacade; const turn = await (await facade.sessions.load(first.id)).createTurn({ sessionId: first.id, text: "Original" });
  await expect(facade.store.updateTurn({ ...turn, sessionId: second.id })).rejects.toMatchObject({ code: "session/conflict" });
  await expect(facade.store.appendMessage({ id: newMessageId(), sessionId: second.id, turnId: turn.id, role: "user", content: "Forged", createdAt: Date.now() })).rejects.toMatchObject({ code: "session/conflict" });
  await expect(facade.store.listMessagesByTurn(second.id, turn.id)).rejects.toMatchObject({ code: "session/conflict" });
  await expect(stack.manager.ownerOf("unknown-native-session")).rejects.toMatchObject({ code: "session/not-found" });
  expect(await facade.store.getSession("unknown-native-session" as SessionId)).toBeUndefined();
  expect((await facade.store.getTurn(turn.id))?.sessionId).toBe(first.id); expect(await facade.store.listMessages(second.id)).toEqual([]);
});

it("a caller abort before creation and an unavailable selected profile leave no extra owner", async () => {
  const stack = await fixture(); const aborted = new AbortController(); aborted.abort();
  await expect(stack.manager.createSession("secondary", aborted.signal)).rejects.toThrow();
  await expect(stack.manager.createSession("unknown", signal())).rejects.toMatchObject({ code: "workspace/not-found" });
  await expect(stack.manager.createSession("secondary", signal(), { providerKey: "missing", modelId: "missing" })).rejects.toMatchObject({ code: "model/not-found" });
  expect(stack.manager.ownerList()).toHaveLength(1);
});

it("fresh admission rejects a changed configuration behind an already frozen provider reference", async () => {
  const first = new OpenAICompatibleProvider({ baseUrl: "http://127.0.0.1:19001/v1", apiKey: "private-reference-test", modelId: "coding" });
  const { stack, selected, original, originalOwner, snapshot, references, failure, fresh } = await allocateAvailableLeaseFixture(async () => {
    let current = first;
    const stack = await fixture(undefined, { resolveSelection: async choice => ({ modelProvider: current, model: { providerId: current.id, modelId: choice.modelId } }) });
    const selected = { providerKey: "fixed-reference", modelId: "coding" };
    const original = await stack.manager.createSession("secondary", signal(), selected);
    const originalOwner = await stack.manager.ownerOf(original.id); const snapshot = await originalOwner.store.loadStateSnapshot(original.id);
    const references = await stack.manager.referencedSelections(signal());
    current = new OpenAICompatibleProvider({ baseUrl: "http://127.0.0.1:19002/v1", apiKey: "private-reference-test", modelId: "coding" });
    const failure = await preparationFailure(() => stack.manager.createSession("secondary", signal(), selected));
    const fresh = await stack.manager.createSession("secondary", signal(), { ...selected, providerKey: "new-reference" });
    return { stack, selected, original, originalOwner, snapshot, references, failure, fresh };
  }, cleanup);
  expect(references).toEqual([selected]); expect(failure).toMatchObject({ code: "session/provider-config-changed" });
  expect(await originalOwner.store.loadStateSnapshot(original.id)).toEqual(snapshot);
  expect((await originalOwner.store.listSessions()).filter(session => session.status !== "failed")).toHaveLength(1);
  expect(await stack.manager.ownerOf(fresh.id)).not.toBe(originalOwner);
});

async function httpModel(modelId: string, label: string, calls: Array<{ label: string; model: string }>): Promise<ModelProvider> {
  const server = createServer(async (req, res) => {
    let raw = ""; for await (const chunk of req) raw += String(chunk);
    calls.push({ label, model: (JSON.parse(raw) as { model: string }).model });
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end(`data: ${JSON.stringify({ choices: [{ delta: { content: `${label} real answer` } }] })}\n\ndata: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 2, completion_tokens: 2 } })}\n\ndata: [DONE]\n\n`);
  });
  await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
  cleanup.push(() => new Promise<void>((done, reject) => server.close(error => error ? reject(error) : done())));
  return new OpenAICompatibleProvider({ baseUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`, apiKey: "private-draft-model-key", modelId,
    requestPolicy: { maxProviderRetries: 0, retryDelayMs: 0, requestTimeoutMs: 10000 } });
}

it("a stable Web draft changes its real HTTP model without editing native frozen snapshots or its journal prefix, including restart", async () => {
  const calls: Array<{ label: string; model: string }> = [];
  const original = await httpModel("model-original", "original", calls); const selected = await httpModel("model-selected", "selected", calls);
  const { stack, session, oldOwner, oldActor, snapshot, prefix, physical, actual } = await allocateAvailableLeaseFixture(async () => {
    const stack = await fixture(original, { newSessionsUseChildren: true,
      resolveSelection: async choice => ({ modelProvider: selected, model: { providerId: selected.id, modelId: choice.modelId } }) }, "model-original");
    const session = await stack.manager.createSession("secondary", signal()); const oldOwner = await stack.manager.ownerOf(session.id);
    const oldActor = await stack.manager.harnessFacade.sessions.load(session.id);
    const snapshot = await oldOwner.store.loadStateSnapshot(session.id); const prefix = await oldOwner.events.list(session.id);
    await stack.manager.selectModel(session.id, { providerKey: "selected-reference", modelId: "model-selected" }, signal());
    const physical = stack.manager.nativeSessionId(session.id); const actual = await stack.manager.ownerOf(session.id);
    return { stack, session, oldOwner, oldActor, snapshot, prefix, physical, actual };
  }, cleanup);
  expect(actual).not.toBe(oldOwner); expect(physical).not.toBe(session.id); expect(stack.manager.externalSessionId(physical)).toBe(session.id);
  expect(await oldOwner.store.loadStateSnapshot(session.id)).toEqual(snapshot);
  expect(await oldOwner.events.list(session.id)).toEqual(prefix);
  expect((await oldOwner.store.getSession(session.id))?.status).toBe("failed");
  expect(await stack.manager.harnessFacade.store.getSession(session.id)).toMatchObject({ id: session.id, createdAt: session.createdAt, status: "active", model: { modelId: "model-selected" } });
  expect(await stack.manager.harnessFacade.store.getSession(physical)).toBeUndefined();
  await expect(stack.manager.ownerOf(physical)).rejects.toMatchObject({ code: "session/not-found" });
  await expect(stack.manager.harnessFacade.sessions.load(physical)).rejects.toMatchObject({ code: "session/not-found" });
  await expect(oldActor.createTurn({ sessionId: session.id, text: "Retired model must not run" })).rejects.toMatchObject({ code: "session/conflict" });
  const before = await stack.manager.harnessFacade.events.list(session.id);
  expect(before.slice(0, prefix.length)).toEqual(prefix); expect(before.map(event => event.sequence)).toEqual(before.map((_, index) => index));
  expect(await stack.manager.journalCoordinate(session.id, 0)).toEqual({ sessionId: session.id, sequence: 0 });
  expect(await stack.manager.journalCoordinate(session.id, prefix.length)).toEqual({ sessionId: physical, sequence: 0 });
  expect(await stack.manager.projectEvent((await actual.events.list(physical))[0]!)).toMatchObject({ sessionId: session.id, sequence: prefix.length, payload: { sessionId: session.id } });
  const actor = await stack.manager.harnessFacade.sessions.load(session.id); const turn = await actor.createTurn({ sessionId: session.id, text: "Answer through the selected HTTP route" });
  expect(turn.sessionId).toBe(session.id); expect(turn.input.sessionId).toBe(session.id);
  const outcome = await actor.runTurn(turn.id);
  expect(outcome.status, JSON.stringify({ statusDetail: outcome.statusDetail, terminationReason: outcome.terminationReason, error: outcome.error, calls })).toBe("completed");
  expect(outcome.turn.sessionId).toBe(session.id);
  expect(calls).toEqual([{ label: "selected", model: "model-selected" }]);
  expect((await stack.manager.harnessFacade.store.listMessages(session.id)).every(message => message.sessionId === session.id)).toBe(true);
  const visibleIds = (await stack.manager.harnessFacade.store.listSessions()).map(row => row.id);
  expect(visibleIds.filter(id => id === session.id)).toHaveLength(1); expect(visibleIds).not.toContain(physical);
  const history = await stack.manager.harnessFacade.events.list(session.id);
  expect(history.map(event => event.sequence)).toEqual(history.map((_, index) => index));
  expect(history.slice(0, prefix.length)).toEqual(prefix);
  const messages = await stack.manager.harnessFacade.store.listMessages(session.id);
  const branch = await stack.manager.harnessFacade.sessionService.threadFork(session.id);
  expect(branch.parentId).toBe(session.id); expect((await actual.store.getSession(branch.id))?.parentId).toBe(physical);
  expect((await stack.manager.harnessFacade.sessionService.resume(session.id)).id).toBe(session.id);
  // DSH parity: a session that already admitted input, ran a turn or produced a
  // child keeps its identity and transcript; the selection applies to its next
  // request instead of being refused.
  const settled = await stack.manager.harnessFacade.events.list(session.id);
  await stack.manager.selectModel(session.id, { providerKey: "original-reference", modelId: "model-original" }, signal());
  expect(stack.manager.nativeSessionId(session.id)).toBe(physical);
  expect(await stack.manager.harnessFacade.store.getSession(session.id)).toMatchObject({ id: session.id, status: "active", model: { modelId: "model-original" } });
  const switched = await stack.manager.harnessFacade.events.list(session.id);
  expect(switched).toHaveLength(settled.length + 1); expect(switched.slice(0, settled.length)).toEqual(settled);
  await stack.manager.close(); await stack.base.close();
  const base = await createHarness(stack.config); cleanup.push(() => base.close());
  const tools = createHostTools(base, stack.primary, stack.dataDir);
  const restarted = await createOwnerManager(base, { ...stack.hooks, executeHostTool: tools.executeHostTool }); cleanup.push(() => restarted.close());
  expect(restarted.nativeSessionId(session.id)).toBe(physical);
  expect(await restarted.harnessFacade.events.list(session.id)).toEqual(switched);
  expect(await restarted.harnessFacade.store.listMessages(session.id)).toEqual(messages);
  expect((await restarted.harnessFacade.sessionService.resume(branch.id)).parentId).toBe(session.id);
  expect((await restarted.harnessFacade.checkSessionConfigDrift(session.id)).severity).toBe("none");
  expect(JSON.stringify(await readFile(join(stack.dataDir, "deepseek", "owners-index.json"), "utf8"))).not.toContain("private-draft-model-key");
});

it("a genuinely busy later model owner reallocates setup without changing the original stable journal", async () => {
  const selected = new ScriptedModelProvider([ScriptedModelProvider.text("new route")]);
  const options: Partial<OwnerHooks> = { newSessionsUseChildren: true,
    resolveSelection: async choice => ({ modelProvider: selected, model: { providerId: selected.id, modelId: choice.modelId } }) };
  const one = { providerKey: "route-one", modelId: "one" }; const two = { providerKey: "route-two", modelId: "two" };
  const blocked = await allocateAvailableLeaseFixture(async () => {
    const stack = await fixture(undefined, options); const session = await stack.manager.createSession("secondary", signal());
    await stack.manager.selectModel(session.id, one, signal());
    const id = createHash("sha256").update(JSON.stringify({ path: process.platform === "win32" ? stack.secondary.toLowerCase() : stack.secondary, selection: two })).digest("hex");
    const path = join(stack.dataDir, "deepseek", "owners", id); const held = await acquireDataDirLease(path);
    if (!held) throw new Error("Expected a persistent model owner lease"); cleanup.push(() => held.release());
    return { stack, session, path, prefix: await stack.manager.harnessFacade.events.list(session.id) };
  }, cleanup);
  let attempts = 0;
  const admitted = await allocateAvailableLeaseFixture(async () => {
    const stack = ++attempts === 1 ? blocked.stack : await fixture(undefined, options);
    const session = stack === blocked.stack ? blocked.session : await stack.manager.createSession("secondary", signal());
    await stack.manager.selectModel(session.id, one, signal()); await stack.manager.selectModel(session.id, two, signal());
    return { stack, session, events: await stack.manager.harnessFacade.events.list(session.id) };
  }, cleanup);
  expect(attempts).toBeGreaterThanOrEqual(2); expect(admitted.stack.directory).not.toBe(blocked.stack.directory);
  expect(admitted.events.map(event => event.sequence)).toEqual([0, 1, 2, 3, 4]);
  expect((await admitted.stack.manager.harnessFacade.store.getSession(admitted.session.id))?.model.modelId).toBe("two");
  expect(await blocked.stack.manager.harnessFacade.events.list(blocked.session.id)).toEqual(blocked.prefix);
  expect((await blocked.stack.manager.harnessFacade.store.getSession(blocked.session.id))?.model.modelId).toBe("one");
  await expect(acquireDataDirLease(blocked.path)).rejects.toMatchObject({ code: "HARNESS_DATA_DIR_IN_USE" });
});

it("a genuinely busy initial workspace owner reallocates setup before attachment assertions and preserves the blocker", async () => {
  const blocked = await allocateAvailableLeaseFixture(async () => {
    const stack = await fixture();
    const id = createHash("sha256").update(JSON.stringify({ path: process.platform === "win32" ? stack.secondary.toLowerCase() : stack.secondary })).digest("hex");
    const path = join(stack.dataDir, "deepseek", "owners", id); const held = await acquireDataDirLease(path);
    if (!held) throw new Error("Expected a persistent workspace owner lease"); cleanup.push(() => held.release());
    return { stack, path, sessions: await stack.manager.harnessFacade.store.listSessions() };
  }, cleanup);
  let attempts = 0;
  const admitted = await allocateAvailableLeaseFixture(async () => {
    const stack = ++attempts === 1 ? blocked.stack : await fixture();
    const draft = await stack.manager.createSession("secondary", signal());
    return { stack, draft, owner: await stack.manager.ownerOf(draft.id) };
  }, cleanup);
  expect(attempts).toBeGreaterThanOrEqual(2); expect(admitted.stack.directory).not.toBe(blocked.stack.directory);
  expect(admitted.draft.cwd).toBe(admitted.stack.secondary); expect(admitted.owner.config.cwd).toBe(admitted.stack.secondary);
  expect(await blocked.stack.manager.harnessFacade.store.listSessions()).toEqual(blocked.sessions);
  await expect(acquireDataDirLease(blocked.path)).rejects.toMatchObject({ code: "HARNESS_DATA_DIR_IN_USE" });
  await expect(acquireDataDirLease(admitted.owner.config.dataDir)).rejects.toMatchObject({ code: "HARNESS_DATA_DIR_IN_USE" });
});

it("successive pristine model selections keep a dense stable journal and hide every physical replacement", async () => {
  const { stack, session, originalPrefix, first, firstPrefix, second, all } = await allocateAvailableLeaseFixture(async () => {
    const selected = new ScriptedModelProvider([ScriptedModelProvider.text("new route")]);
    const stack = await fixture(undefined, { newSessionsUseChildren: true,
      resolveSelection: async choice => ({ modelProvider: selected, model: { providerId: selected.id, modelId: choice.modelId } }) });
    const session = await stack.manager.createSession("secondary", signal());
    const originalPrefix = await stack.manager.harnessFacade.events.list(session.id);
    await stack.manager.selectModel(session.id, { providerKey: "route-one", modelId: "one" }, signal()); const first = stack.manager.nativeSessionId(session.id);
    const firstPrefix = await stack.manager.harnessFacade.events.list(session.id);
    await stack.manager.selectModel(session.id, { providerKey: "route-two", modelId: "two" }, signal()); const second = stack.manager.nativeSessionId(session.id);
    const all = await stack.manager.harnessFacade.events.list(session.id);
    return { stack, session, originalPrefix, first, firstPrefix, second, all };
  }, cleanup);
  expect(all.map(event => event.sequence)).toEqual([0, 1, 2, 3, 4]); expect(all.slice(0, originalPrefix.length)).toEqual(originalPrefix);
  expect(all.slice(0, firstPrefix.length)).toEqual(firstPrefix); expect(all.every(event => event.sessionId === session.id)).toBe(true);
  expect(await stack.manager.harnessFacade.events.nextSequence(session.id)).toBe(5);
  expect(await stack.manager.journalCoordinate(session.id, 1)).toEqual({ sessionId: first, sequence: 0 });
  expect(await stack.manager.journalCoordinate(session.id, 3)).toEqual({ sessionId: second, sequence: 0 });
  for (const hidden of [first, second]) await expect(stack.manager.harnessFacade.events.list(hidden)).rejects.toMatchObject({ code: "session/not-found" });
  await expect(stack.manager.journalCoordinate(session.id, 5)).rejects.toMatchObject({ code: "session/not-found" });
  await expect(stack.manager.harnessFacade.events.append({ ...all[0]!, sequence: 0 })).rejects.toMatchObject({ code: "session/conflict" });
});

it("model selection and durable prompt admission serialize on the same stable session, without locking facade reads", async () => {
  const selected = new ScriptedModelProvider([ScriptedModelProvider.text("selected")]);
  const { stack, first, second, lockedSession, native } = await allocateAvailableLeaseFixture(async () => {
    const stack = await fixture(undefined, { newSessionsUseChildren: true,
      resolveSelection: async choice => ({ modelProvider: selected, model: { providerId: selected.id, modelId: choice.modelId } }) });
    const first = await stack.manager.createSession("secondary", signal());
    let release!: () => void; let entered!: () => void; let lockedSession: Awaited<ReturnType<typeof stack.manager.harnessFacade.store.getSession>>;
    const enter = new Promise<void>(done => { entered = done; }); const wait = new Promise<void>(done => { release = done; });
    const admission = stack.manager.withSessionLock(first.id, async () => {
      entered(); lockedSession = await stack.manager.harnessFacade.store.getSession(first.id); await wait;
      await stack.manager.harnessFacade.inbox.admit({ id: newPromptId(), sessionId: first.id, kind: "followup", status: "pending", text: "Already admitted", admittedAt: Date.now() });
    });
    await enter; const selecting = stack.manager.selectModel(first.id, { providerKey: "selected", modelId: "new" }, signal()); release();
    await admission; await selecting;
    const second = await stack.manager.createSession("secondary", signal());
    const selectingSecond = stack.manager.selectModel(second.id, { providerKey: "selected", modelId: "new" }, signal());
    const admitSecond = stack.manager.withSessionLock(second.id, async () => {
      await stack.manager.harnessFacade.inbox.admit({ id: newPromptId(), sessionId: second.id, kind: "followup", status: "pending", text: "Selected admission", admittedAt: Date.now() });
    });
    const settled = await Promise.allSettled([selectingSecond, admitSecond]);
    for (const result of settled) if (result.status === "rejected") throw result.reason;
    return { stack, first, second, lockedSession, native: stack.manager.nativeSessionId(second.id) };
  }, cleanup);
  expect(lockedSession?.id).toBe(first.id);
  // The admitted prompt keeps the first identity; the pristine second draft is replaced.
  expect(stack.manager.nativeSessionId(first.id)).toBe(first.id);
  expect((await stack.manager.harnessFacade.store.getSession(first.id))?.model).toMatchObject({ modelId: "new" });
  expect(await stack.manager.harnessFacade.inbox.listAll(first.id)).toHaveLength(1);
  expect(native).not.toBe(second.id);
  expect((await (await stack.manager.ownerOf(second.id)).inbox.listAll(native))[0]?.sessionId).toBe(native);
  expect((await stack.manager.harnessFacade.inbox.listAll(second.id))[0]?.sessionId).toBe(second.id);
});

it("host attachments and active facilities block draft replacement, and a denied CAS keeps the original frozen draft", async () => {
  const selected = new ScriptedModelProvider([ScriptedModelProvider.text("selected")]);
  const { stack, session, firstSelection, firstNative, firstModel, pristine, manager, owner, before, failure } = await allocateAvailableLeaseFixture(async () => {
    let blockers: string[] = ["upload"];
    const stack = await fixture(undefined, { newSessionsUseChildren: true,
      draftBlockers: async () => blockers,
      resolveSelection: async choice => ({ modelProvider: selected, model: { providerId: selected.id, modelId: choice.modelId } }) });
    const session = await stack.manager.createSession("secondary", signal());
    const firstSelection = await stack.manager.selectModel(session.id, { providerKey: "selected", modelId: "new" }, signal());
    const firstNative = stack.manager.nativeSessionId(session.id), firstModel = (await stack.manager.harnessFacade.store.getSession(session.id))?.model;
    blockers = [];
    const pristine = await stack.manager.createSession("secondary", signal());
    await stack.manager.close();
    let writes = 0;
    const manager = await createOwnerManager(stack.base, { ...stack.hooks, executeHostTool: async (id, definition, args, abort) => {
      if (definition.name === "web_owner_index_write" && ++writes === 2) return { status: "denied" };
      return stack.tools.executeHostTool(id, definition, args, abort);
    } }); cleanup.push(() => manager.close());
    const owner = await manager.ownerOf(pristine.id); const before = await owner.store.loadStateSnapshot(pristine.id);
    const failure = await preparationFailure(() => manager.selectModel(pristine.id, { providerKey: "selected", modelId: "new" }, signal()));
    return { stack, session, firstSelection, firstNative, firstModel, pristine, manager, owner, before, failure };
  }, cleanup);
  expect(firstSelection).toBeUndefined(); expect(firstNative).toBe(session.id); expect(firstModel).toMatchObject({ modelId: "new" });
  expect(failure).toMatchObject({ code: "gateway/internal" });
  expect(manager.nativeSessionId(pristine.id)).toBe(pristine.id); expect((await manager.harnessFacade.store.getSession(pristine.id))?.status).toBe("active");
  expect(await owner.store.loadStateSnapshot(pristine.id)).toEqual(before);
  expect((JSON.parse(await readFile(join(stack.dataDir, "deepseek", "owners-index.json"), "utf8")) as { aliases: unknown[] }).aliases).toEqual([]);
});

it("a crash after the durable generation CAS but before activation recovers the selected frozen draft on restart", async () => {
  const selected = new ScriptedModelProvider([ScriptedModelProvider.text("recovered route")]); let activationFailed = false;
  const { stack, session, old, snapshot, prefix, failure } = await allocateAvailableLeaseFixture(async () => {
    const stack = await fixture(undefined, { newSessionsUseChildren: true,
      resolveSelection: async choice => ({ modelProvider: selected, model: { providerId: selected.id, modelId: choice.modelId } }),
      configureOwner(owner) {
        if (owner.config.model.modelId !== "selected") return;
        const update = owner.store.updateSession.bind(owner.store);
        owner.store.updateSession = async session => {
          if (session.status === "active" && !activationFailed) { activationFailed = true; throw new Error("deterministic activation I/O failure"); }
          return update(session);
        };
      },
    });
    const session = await stack.manager.createSession("secondary", signal()); const old = await stack.manager.ownerOf(session.id);
    const snapshot = await old.store.loadStateSnapshot(session.id); const prefix = await old.events.list(session.id);
    const failure = await preparationFailure(() => stack.manager.selectModel(session.id, { providerKey: "selected-reference", modelId: "selected" }, signal()));
    return { stack, session, old, snapshot, prefix, failure };
  }, cleanup);
  await expect(Promise.reject(failure)).rejects.toThrow("activation I/O failure");
  const physical = stack.manager.nativeSessionId(session.id); expect(physical).not.toBe(session.id);
  expect((await stack.manager.harnessFacade.store.getSession(session.id))?.status).toBe("failed");
  expect(await old.store.loadStateSnapshot(session.id)).toEqual(snapshot); expect(await old.events.list(session.id)).toEqual(prefix);
  await stack.manager.close(); await stack.base.close();
  const base = await createHarness(stack.config); cleanup.push(() => base.close()); const tools = createHostTools(base, stack.primary, stack.dataDir);
  const restarted = await createOwnerManager(base, { ...stack.hooks, executeHostTool: tools.executeHostTool }); cleanup.push(() => restarted.close());
  expect(restarted.nativeSessionId(session.id)).toBe(physical);
  expect(await restarted.harnessFacade.store.getSession(session.id)).toMatchObject({ id: session.id, status: "active", model: { modelId: "selected" } });
  const journal = await restarted.harnessFacade.events.list(session.id);
  expect(journal.slice(0, prefix.length)).toEqual(prefix);
  expect(journal.filter(event => event.payload.kind === "web_model_selection")).toHaveLength(1);
  expect(journal.map(event => event.sequence)).toEqual(journal.map((_, index) => index));
});

it("retired native prefix corruption fails restart closed rather than renumbering history", async () => {
  const selected = new ScriptedModelProvider([ScriptedModelProvider.text("selected")]);
  const { stack, session, old } = await allocateAvailableLeaseFixture(async () => {
    const stack = await fixture(undefined, { newSessionsUseChildren: true,
      resolveSelection: async choice => ({ modelProvider: selected, model: { providerId: selected.id, modelId: choice.modelId } }) });
    const session = await stack.manager.createSession("secondary", signal()); const old = await stack.manager.ownerOf(session.id);
    await stack.manager.selectModel(session.id, { providerKey: "selected-reference", modelId: "selected" }, signal());
    return { stack, session, old };
  }, cleanup);
  // Deliberate privileged corruption emulates an external writer violating the
  // lease; facade access cannot reach this retired native generation.
  const original = (await old.events.list(session.id))[0]!;
  await old.events.appendNew({ ...original, id: newEventId(), type: "human.message", payload: { corruption: true } });
  await stack.manager.close(); await stack.base.close();
  const base = await createHarness(stack.config); cleanup.push(() => base.close()); const tools = createHostTools(base, stack.primary, stack.dataDir);
  await expect(createOwnerManager(base, { ...stack.hooks, executeHostTool: tools.executeHostTool })).rejects.toMatchObject({ code: "session/alias-corrupt" });
});

it("stable draft typed stores retain actual native ownership and checkpoint integrity while rejecting physical and cross-session identities", async () => {
  const selected = new ScriptedModelProvider([ScriptedModelProvider.toolCall("write_file", { path: "typed-proof.txt", content: "Native checkpoint bytes\n" }), ScriptedModelProvider.text("Typed store complete")]);
  const { stack, draft } = await allocateAvailableLeaseFixture(async () => {
    const stack = await fixture(undefined, { newSessionsUseChildren: true,
      resolveSelection: async choice => ({ modelProvider: selected, model: { providerId: selected.id, modelId: choice.modelId } }) });
    const draft = await stack.manager.createSession("secondary", signal());
    await stack.manager.selectModel(draft.id, { providerKey: "typed-selected", modelId: "typed-model" }, signal());
    return { stack, draft };
  }, cleanup);
  const facade = stack.manager.harnessFacade, native = stack.manager.nativeSessionId(draft.id), owner = await stack.manager.ownerOf(draft.id);
  const actor = await facade.sessions.load(draft.id), turn = await actor.createTurn({ sessionId: draft.id, text: "Write the checkpoint proof" });
  const running = actor.runTurn(turn.id);
  let pending = facade.approvalStore.listPending(draft.id);
  for (let i = 0; i < 300 && pending.length === 0; i++) { await new Promise(done => setTimeout(done, 5)); pending = facade.approvalStore.listPending(draft.id); }
  expect(pending).toHaveLength(1); expect(pending[0]).toMatchObject({ sessionId: draft.id, turnId: turn.id });
  expect(owner.approvalStore.listPending(native)[0]?.sessionId).toBe(native);
  facade.approvalStore.resolve(pending[0]!.id, "allow", "typed-owner-test"); expect((await running).status).toBe("completed");
  expect(await readFile(join(stack.secondary, "typed-proof.txt"), "utf8")).toBe("Native checkpoint bytes\n");
  const checkpoints = await facade.checkpointStore!.list(draft.id); expect(checkpoints.length).toBeGreaterThan(0);
  expect(checkpoints).toEqual(await owner.checkpointStore!.list(native));
  for (const checkpoint of checkpoints) { const { checksum, ...payload } = checkpoint; expect(checkpoint.sessionId).toBe(native); expect(computeCheckpointChecksum(payload)).toBe(checksum); }
  await expect(facade.checkpointStore!.save({ ...checkpoints[0]!, sessionId: draft.id })).rejects.toMatchObject({ code: "checkpoint/conflict" });
  await expect(facade.checkpointStore!.list(native)).rejects.toMatchObject({ code: "session/not-found" });

  const askId = newAskId();
  await facade.askUserStore!.create({ id: askId, sessionId: draft.id, turnId: turn.id, question: "Owned question", reason: "choice_required", status: "pending", createdAt: Date.now() });
  expect(await facade.askUserStore!.get(askId)).toMatchObject({ sessionId: draft.id, turnId: turn.id });
  expect(await owner.askUserStore!.get(askId)).toMatchObject({ sessionId: native });
  const prompt = { id: newPromptId(), sessionId: draft.id, kind: "followup" as const, status: "pending" as const, text: "Typed durable admission", admittedAt: Date.now() };
  await facade.inbox.admit(prompt); expect((await facade.inbox.listAll(draft.id)).find(row => row.id === prompt.id)?.sessionId).toBe(draft.id);
  expect((await owner.inbox.listAll(native)).find(row => row.id === prompt.id)?.sessionId).toBe(native);
  await expect(facade.inbox.listAll(native)).rejects.toMatchObject({ code: "session/not-found" });

  const artifact = { id: newArtifactId(), sessionId: draft.id, turnId: turn.id, toolCallId: newToolCallId(), ref: join(stack.secondary, "typed-proof.txt"), mime: "text/plain", bytes: 24, sha256: createHash("sha256").update("Native checkpoint bytes\n").digest("hex"), createdAt: Date.now(), sensitivity: "low" as const, retention: "session" as const };
  await facade.artifactStore!.register(artifact); expect(await facade.artifactStore!.get(artifact.id)).toEqual(artifact);
  expect(await owner.artifactStore!.get(artifact.id)).toEqual({ ...artifact, sessionId: native });
  expect(await facade.artifactStore!.byToolCallId(draft.id, turn.id, artifact.toolCallId)).toEqual([artifact]);
  await expect(facade.artifactStore!.bySessionId(native)).rejects.toMatchObject({ code: "session/not-found" });
  const other = await stack.manager.createSession("secondary", signal());
  await expect(facade.artifactStore!.register({ ...artifact, id: newArtifactId(), sessionId: other.id })).rejects.toMatchObject({ code: "session/conflict" });
  await expect(facade.askUserStore!.create({ id: newAskId(), sessionId: other.id, turnId: turn.id, question: "Foreign turn", reason: "choice_required", status: "pending", createdAt: Date.now() })).rejects.toMatchObject({ code: "session/conflict" });
  await expect(facade.inbox.bindPromotion(prompt.id, (await (await facade.sessions.load(other.id)).createTurn({ sessionId: other.id, text: "Foreign promotion" })).id)).rejects.toMatchObject({ code: "session/conflict" });
});

it("a real staged attachment commit and model selection share the stable draft lock until acknowledgement", async () => {
  const selected = new ScriptedModelProvider([ScriptedModelProvider.text("Selected route")]); let manager!: OwnerManager;
  const { stack, draft, native } = await allocateAvailableLeaseFixture(async () => {
    const stack = await fixture(undefined, { newSessionsUseChildren: true,
      resolveSelection: async choice => ({ modelProvider: selected, model: { providerId: selected.id, modelId: choice.modelId } }),
      draftBlockers: async id => (await manager.harnessFacade.events.list(id as SessionId)).filter(event => event.type === "tool.started" && event.payload.tool === "web_upload_write").map(() => "upload"),
    }); manager = stack.manager;
    const draft = await manager.createSession("secondary", signal()); const native = manager.nativeSessionId(draft.id);
    return { stack, draft, native };
  }, cleanup);
  const tools = createHostTools(manager.harnessFacade, stack.primary, stack.dataDir, manager.ownerOf, manager.nativeSessionId);
  let entered!: () => void, release!: () => void; const committed = new Promise<void>(done => { entered = done; }), held = new Promise<void>(done => { release = done; });
  const deliverables = createDeliverablesService({ harness: manager.harnessFacade, cwd: stack.primary, dataDir: stack.dataDir, ...tools, withSessionLock: manager.withSessionLock,
    executeHostTool: async (id, definition, args, abort) => { const result = await tools.executeHostTool(id, definition, args, abort); if (definition.name === "web_upload_write") { entered(); await held; } return result; },
  }); cleanup.push(async () => { deliverables.dispose(); });
  const uploading = deliverables.call("fileUploads/upload", { agentId: draft.id, request: { name: "actual.txt", data: Buffer.from("Stable owned upload\n").toString("base64") } }, signal());
  await committed; let selectingDone = false;
  const selecting = manager.selectModel(draft.id, { providerKey: "selected", modelId: "new" }, signal()).then(() => ({ accepted: true }), error => ({ accepted: false, code: (error as { code?: string }).code })).finally(() => { selectingDone = true; });
  await new Promise(done => setTimeout(done, 20)); expect(selectingDone).toBe(false); expect(manager.nativeSessionId(draft.id)).toBe(native);
  release(); const receipt = await uploading as { receiptId: string };
  // Serialized, not refused: after the durable upload acknowledgement the same
  // session keeps its identity and its selection moves in place.
  expect(await selecting).toEqual({ accepted: true });
  expect((await manager.harnessFacade.store.getSession(draft.id))?.model).toMatchObject({ modelId: "new" });
  expect(manager.nativeSessionId(draft.id)).toBe(native); expect(await deliverables.resolveUpload(draft.id, receipt.receiptId, signal())).toMatchObject({ text: "Stable owned upload\n" });
});

it("a short file preview waits for the committed replacement activation without holding the entire watch generation", async () => {
  const selected = new ScriptedModelProvider([ScriptedModelProvider.text("Selected route")]);
  let entered!: () => void, release!: () => void; const switching = new Promise<void>(done => { entered = done; }), held = new Promise<void>(done => { release = done; });
  const { stack, draft, tools, files, selecting } = await allocateAvailableLeaseFixture(async () => {
    const stack = await fixture(undefined, { newSessionsUseChildren: true,
      resolveSelection: async choice => ({ modelProvider: selected, model: { providerId: selected.id, modelId: choice.modelId } }),
      configureOwner(owner) { if (owner.config.model.modelId !== "file-next") return; const update = owner.store.updateSession.bind(owner.store); owner.store.updateSession = async session => { if (session.status === "active") { entered(); await held; } return update(session); }; },
    });
    const draft = await stack.manager.createSession("secondary", signal());
    const tools = createHostTools(stack.manager.harnessFacade, stack.primary, stack.dataDir, stack.manager.ownerOf, stack.manager.nativeSessionId); tools.registerTool(workspaceReadTool);
    const files = createFilesService({ harness: stack.manager.harnessFacade, cwd: stack.primary, ...tools, withSessionLock: stack.manager.withSessionLock });
    const selecting = stack.manager.selectModel(draft.id, { providerKey: "selected", modelId: "file-next" }, signal());
    await Promise.race([switching, selecting.then(() => { throw new Error("Expected held activation before selection completion"); })]);
    return { stack, draft, tools, files, selecting };
  }, cleanup);
  let finished = false;
  const reading = files.call("workspaceFiles/read", { workspaceFileScopeId: draft.id, path: "identity.txt", range: {} }, signal()).then(value => ({ ok: true, value }), error => ({ ok: false, error })).finally(() => { finished = true; });
  try { await new Promise(done => setTimeout(done, 20)); expect(finished).toBe(false); }
  finally { release(); await selecting; }
  expect(await reading).toMatchObject({ ok: true, value: { text: "SECONDARY", absolutePath: join(stack.secondary, "identity.txt") } });
  const controller = new AbortController();
  const feed = files.stream("workspaceFiles/changes", { workspaceFileScopeId: draft.id, path: "identity.txt" }, controller.signal)[Symbol.asyncIterator]();
  expect((await feed.next()).value).toEqual({ kind: "ready" });
  const lock = stack.manager.withSessionLock(draft.id, async () => "A watch must release its sampling lock before yielding"); expect(await lock).toBe("A watch must release its sampling lock before yielding");
  controller.abort(); await feed.return?.();
});

it("bounded stable-owner tails keep global coordinates, limit physical delivery, and still reject a corrupted retired prefix", async () => {
  const selected = new ScriptedModelProvider([ScriptedModelProvider.text("unused")]);
  const { stack, draft, retiredOwner } = await allocateAvailableLeaseFixture(async () => {
    const stack = await fixture(undefined, { newSessionsUseChildren: true,
      resolveSelection: async choice => ({ modelProvider: selected, model: { providerId: selected.id, modelId: choice.modelId } }) });
    const draft = await stack.manager.createSession("secondary", signal());
    const retiredOwner = await stack.manager.ownerOf(draft.id);
    await stack.manager.selectModel(draft.id, { providerKey: "bounded", modelId: "bounded" }, signal());
    return { stack, draft, retiredOwner };
  }, cleanup);
  const owner = await stack.manager.ownerOf(draft.id), native = stack.manager.nativeSessionId(draft.id);
  for (let n = 0; n < 128; n++) await owner.events.appendNew({ id: newEventId(), sessionId: native,
    timestamp: Date.now(), type: "human.message", payload: { n } });
  const facade = stack.manager.harnessFacade;
  const all = await facade.events.list(draft.id);
  let delivered = 0;
  const list = owner.events.list.bind(owner.events);
  owner.events.list = async (id, options) => { const result = await list(id, options); delivered += result.length; return result; };
  const tail = await facade.events.list(draft.id, { afterSequence: all.at(-3)!.sequence, limit: 1 });
  expect(tail).toEqual(all.slice(-2, -1)); expect(delivered).toBe(1);
  delivered = 0;
  expect(await facade.events.list(draft.id, { afterSequence: all.at(-1)!.sequence, limit: 1 })).toEqual([]);
  expect(delivered).toBe(0);
  // A bounded cache check must still execute the existing prefix integrity gate.
  const first = (await retiredOwner.events.list(draft.id))[0]!;
  await retiredOwner.events.appendNew({ ...first, id: newEventId() });
  await expect(facade.events.list(draft.id, { afterSequence: all.at(-1)!.sequence, limit: 1 }))
    .rejects.toMatchObject({ code: "session/alias-corrupt" });
});

it.each(["factory", "runtime-facade"] as const)("%s never publishes a runnable session if its creating owner's config baseline fails", async entry => {
  const { stack, seed } = await allocateAvailableLeaseFixture(async () => {
    const stack = await fixture();
    const seed = await stack.manager.createSession("secondary", signal());
    return { stack, seed };
  }, cleanup);
  const owner = await stack.manager.ownerOf(seed.id);
  const before = new Set((await owner.store.listSessions()).map(session => session.id));
  const save = owner.store.saveStateSnapshot.bind(owner.store);
  owner.store.saveStateSnapshot = async (id, snapshot) => {
    if (snapshot["p27.configFingerprint"] !== undefined) throw new Error("owner baseline unavailable");
    await save(id, snapshot);
  };
  const creating = entry === "factory" ? stack.manager.createSession("secondary", signal())
    : stack.manager.harnessFacade.runtime.createSession({ agent: owner.agents[0]!, cwd: owner.config.cwd });
  await expect(creating).rejects.toThrow("owner baseline unavailable");
  const added = (await owner.store.listSessions()).filter(session => !before.has(session.id));
  expect(added).toHaveLength(1);
  expect(added[0]!.status).toBe("failed");
  await expect(owner.runtime.startTurn(added[0]!.id, "must not run")).rejects.toThrow("failed");
});

it("runtime-facade creation freezes its host baseline while retaining the caller's narrower agent policy", async () => {
  const { stack, seed } = await allocateAvailableLeaseFixture(async () => {
    const stack = await fixture(); const seed = await stack.manager.createSession("secondary", signal());
    return { stack, seed };
  }, cleanup);
  const owner = await stack.manager.ownerOf(seed.id);
  const restricted = { ...owner.agents[0]!, tools: { allow: ["read_file"] },
    permissions: { rules: [], defaultEffect: "deny" as const }, limits: { maxToolCalls: 1 } };
  const session = await stack.manager.harnessFacade.runtime.createSession({ agent: restricted, cwd: owner.config.cwd });
  expect(session.status).toBe("active");
  expect((await owner.store.loadStateSnapshot(session.id))!["p27.configFingerprint"]).toBe(owner.resolvedConfig.fingerprint);
  const effective = await stack.manager.harnessFacade.runtime.getSessionAgent(session.id);
  expect(effective.tools).toEqual(restricted.tools);
  expect(effective.permissions).toEqual(restricted.permissions);
  expect(effective.limits).toEqual(restricted.limits);
});
