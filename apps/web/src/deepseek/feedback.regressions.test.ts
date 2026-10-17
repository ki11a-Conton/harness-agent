import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import type { ModelProvider, ModelRequest, SessionId } from "@ar/contracts";
import { createHarness } from "@ar/harness";
import { ScriptedModelProvider } from "@ar/model";
import { createRuntimeRpc } from "@ar/gateway";
import { createHostTools } from "./host-tools.js";
import { createSessionService, type SessionHost } from "./session.js";
import { MAX_FEEDBACK_NOTE_BYTES } from "./feedback-records.js";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
async function setup() {
  const cwd = await realpath(await mkdtemp(join(tmpdir(), "web-feedback-"))), dataDir = join(cwd, "state"), requests: ModelRequest[] = [];
  cleanup.push(() => rm(cwd, { recursive: true, force: true }));
  const provider: ModelProvider = { id: "feedback-fixture", listModels: async () => [{ id: "local" }],
    createClient: () => ({ async *generate(request) { requests.push(structuredClone(request)); yield* ScriptedModelProvider.text("Actual assistant answer"); } }),
  };
  const harness = await createHarness({ cwd, dataDir, profile: "interactive", modelProvider: provider,
    model: { providerId: provider.id, modelId: "local" }, featureFlags: { skills: false, memory: false, mcp: false, delegation: false, learning: false } });
  cleanup.push(() => harness.close());
  const rpc = createRuntimeRpc(harness.runtime, { sessionService: harness.sessionService, sessions: harness.sessions, events: harness.events, approvalStore: harness.approvalStore });
  const host: SessionHost = { harness, rpc, cwd, dataDir, ...createHostTools(harness, cwd, dataDir), pollDelayMs: 1 };
  const service = createSessionService(host); cleanup.push(() => service.close());
  const signal = new AbortController().signal;
  const id = (await service.call("session/create", { request: {} }, signal) as { sessionId: SessionId }).sessionId;
  const call = (endpoint: string, args: Record<string, unknown>) => service.call(endpoint,
    endpoint.startsWith("messageFeedback/") || endpoint.startsWith("sessionFeedback/") ? { request: args } : args, signal) as Promise<any>;
  async function prompt(sessionId = id, requestId = "first") {
    await call("session/prompt", { request: { sessionId, requestId, mode: "queue", content: [{ type: "text", text: "Reply to this coding task" }] } });
    const deadline = Date.now() + 10000;
    while ((await harness.store.listTurns(sessionId)).at(-1)?.status !== "completed") {
      if (Date.now() > deadline) throw new Error("Actual Harness turn did not complete");
      await new Promise(done => setTimeout(done, 5));
    }
    return (await harness.store.listMessages(sessionId)).findLast(message => message.role === "assistant")!.id;
  }
  return { cwd, dataDir, harness, host, service, call, prompt, id, requests, signal };
}

it("actual feedback buttons' wire vocabulary is registered, persists its audit, and survives a new service", async () => {
  const s = await setup(), messageId = await s.prompt();
  expect(s.service.endpoints).toEqual(expect.arrayContaining(["messageFeedback/list", "messageFeedback/put", "messageFeedback/delete", "sessionFeedback/record"]));
  expect(await s.call("messageFeedback/list", { sessionId: s.id })).toEqual({ ok: true, value: { items: [] } });
  const saved = await s.call("messageFeedback/put", { sessionId: s.id, messageId, rating: "positive", note: "Preserve the existing exports", category: "task-result", ifVersion: null });
  expect(saved).toMatchObject({ ok: true, value: { messageId, rating: "positive", note: "Preserve the existing exports" } });
  expect(saved.value.version).toMatch(/^[a-f0-9-]{36}$/);
  const disk = JSON.parse(await readFile(join(s.dataDir, "deepseek/session-metadata.json"), "utf8"));
  expect(disk.sessions[s.id].feedback).toEqual([{ kind: "message-put", item: saved.value }]);
  await s.service.close(); const restored = createSessionService(s.host); cleanup.push(() => restored.close());
  expect(await restored.call("messageFeedback/list", { request: { sessionId: s.id } }, s.signal)).toEqual({ ok: true, value: { items: [saved.value] } });
});

it("concurrent tabs compare actual versions and never overwrite an unobserved judgment", async () => {
  const s = await setup(), messageId = await s.prompt();
  const results = await Promise.all(["positive", "negative"].map(rating => s.call("messageFeedback/put", { sessionId: s.id, messageId, rating, ifVersion: null })));
  const winner = results.find(value => value.ok), conflict = results.find(value => !value.ok);
  expect(winner).toBeDefined(); expect(conflict).toEqual({ ok: false, error: { code: "version-conflict", current: winner.value } });
  expect((await s.call("messageFeedback/list", { sessionId: s.id })).value.items).toEqual([winner.value]);
  expect((await s.service.metadata.read(s.id)).feedback).toHaveLength(1);
});

it("matching no-ops retain versions; retract retries are idempotent and stale deletes cannot erase a new rating", async () => {
  const s = await setup(), messageId = await s.prompt(), input = { sessionId: s.id, messageId, rating: "positive", ifVersion: null };
  const first = (await s.call("messageFeedback/put", input)).value;
  const before = await s.service.metadata.read(s.id);
  expect((await s.call("messageFeedback/put", { ...input, ifVersion: first.version })).value).toEqual(first);
  expect((await s.service.metadata.read(s.id)).revision).toBe(before.revision);
  const deletion = { sessionId: s.id, messageId, ifVersion: first.version };
  expect(await s.call("messageFeedback/delete", deletion)).toEqual({ ok: true, value: { absent: true } });
  expect(await s.call("messageFeedback/delete", deletion)).toEqual({ ok: true, value: { absent: true } });
  const fresh = (await s.call("messageFeedback/put", input)).value;
  expect(fresh.version).not.toBe(first.version);
  expect(await s.call("messageFeedback/delete", deletion)).toEqual({ ok: false, error: { code: "version-conflict", current: fresh } });
  expect((await s.service.metadata.read(s.id)).feedback).toHaveLength(3);
});

it("rejects user messages, another session's assistant, unknown sessions, malformed input and UTF-8 oversize notes", async () => {
  const s = await setup(), assistant = await s.prompt();
  const user = (await s.harness.store.listMessages(s.id)).find(message => message.role === "user")!.id;
  const second = (await s.call("session/create", { request: {} })).sessionId;
  for (const [sessionId, messageId] of [[s.id, user], [second, assistant]]) {
    expect(await s.call("messageFeedback/put", { sessionId, messageId, rating: "negative", ifVersion: null })).toMatchObject({ ok: false, error: { code: "target-not-found" } });
  }
  expect(await s.call("messageFeedback/list", { sessionId: "session_missing" })).toMatchObject({ ok: false, error: { code: "session-not-found" } });
  for (const extra of [{ extra: true }, { category: "invented" }, { rating: "maybe" }, { ifVersion: 2 }]) {
    await expect(s.call("messageFeedback/put", { sessionId: s.id, messageId: assistant, rating: "positive", ifVersion: null, ...extra })).rejects.toMatchObject({ code: "gateway/bad-request" });
  }
  expect(await s.call("messageFeedback/put", { sessionId: s.id, messageId: assistant, rating: "positive", ifVersion: null, note: "   " })).toMatchObject({ ok: false, error: { code: "note-blank" } });
  const note = "界".repeat(Math.ceil(MAX_FEEDBACK_NOTE_BYTES / 3));
  expect(await s.call("messageFeedback/put", { sessionId: s.id, messageId: assistant, rating: "positive", ifVersion: null, note })).toEqual({ ok: false, error: { code: "note-too-large", maxBytes: MAX_FEEDBACK_NOTE_BYTES, actualBytes: Buffer.byteLength(note) } });
  expect((await s.call("messageFeedback/list", { sessionId: s.id })).value.items).toEqual([]);
});

it("local message/session feedback never enters the next actual model request or creates a new turn", async () => {
  const s = await setup(), messageId = await s.prompt();
  await s.call("messageFeedback/put", { sessionId: s.id, messageId, rating: "negative", note: "PRIVATE_LOCAL_FEEDBACK_SENTINEL", ifVersion: null });
  expect(await s.call("sessionFeedback/record", { sessionId: s.id, text: " PRIVATE_SESSION_REMARK_SENTINEL ", category: "product-interaction" })).toEqual({ ok: true, value: { recorded: true } });
  expect(s.requests).toHaveLength(1); expect(await s.harness.store.listTurns(s.id)).toHaveLength(1);
  await s.prompt(s.id, "second"); expect(s.requests).toHaveLength(2);
  expect(JSON.stringify(s.requests[1])).not.toMatch(/PRIVATE_(LOCAL_FEEDBACK|SESSION_REMARK)_SENTINEL/);
  expect((await s.service.metadata.read(s.id)).feedback?.at(-1)).toMatchObject({ kind: "session", text: "PRIVATE_SESSION_REMARK_SENTINEL" });
});

it("a denied controlled metadata write stays denied with no feedback persisted", async () => {
  const s = await setup(), messageId = await s.prompt();
  const rejected = createSessionService({ ...s.host, executeHostTool: async () => ({ status: "denied", error: { code: "PERMISSION_DENIED", message: "Controlled metadata refused", retryable: false, safeToRetry: false } }) });
  cleanup.push(() => rejected.close());
  await expect(rejected.call("messageFeedback/put", { request: { sessionId: s.id, messageId, rating: "positive", ifVersion: null } }, s.signal)).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
  expect((await s.call("messageFeedback/list", { sessionId: s.id })).value.items).toEqual([]);
});

it("accepts the actual Typert request envelope and rejects flat or extra transport arguments", async () => {
  const s = await setup();
  await expect(s.service.call("messageFeedback/list", { sessionId: s.id }, s.signal)).rejects.toMatchObject({ code: "gateway/bad-request" });
  await expect(s.service.call("messageFeedback/list", { request: { sessionId: s.id }, extra: true }, s.signal)).rejects.toMatchObject({ code: "gateway/bad-request" });
  expect(await s.service.call("messageFeedback/list", { request: { sessionId: s.id } }, s.signal)).toEqual({ ok: true, value: { items: [] } });
});
