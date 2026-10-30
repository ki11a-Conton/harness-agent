import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { newMessageId, newTurnId, type InstructionDiscovery, type ModelEvent, type ModelProvider } from "@ar/contracts";
import { createHarness } from "@ar/harness";
import { createDeepseekComposition } from "./composition.js";
import { sessionMetadataTool } from "./session.js";

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const close of cleanup.splice(0).reverse()) await close();
});
const signal = () => new AbortController().signal;
async function setup() {
  const root = await mkdtemp(join(tmpdir(), "compaction-request-identity-"));
  cleanup.push(() => rm(root, { recursive: true, force: true, maxRetries: 8 }));
  const cwd = join(root, "work"); await mkdir(cwd);
  let enter!: () => void, release!: () => void;
  const entered = new Promise<void>(resolve => { enter = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  const calls: Array<{ summary: boolean }> = [];
  const provider: ModelProvider = { id: "compaction-request-identity", listModels: async () => [], createClient: () => ({
    async *generate(request): AsyncGenerator<ModelEvent> {
      const summary = request.system?.includes("CONTEXT CHECKPOINT COMPACTION") === true;
      calls.push({ summary });
      if (summary && calls.filter(call => call.summary).length === 1) { enter(); await gate; }
      yield { type: "completed", result: { finishReason: "stop", text: summary
        ? "Earlier investigation is retained. Continue the current user instructions."
        : "Coding task completed." }, timestamp: Date.now() };
    },
  }) };
  const config = { cwd, dataDir: join(root, "data"), profile: "test" as const, modelProvider: provider,
    model: { providerId: provider.id, modelId: "test" },
    contextBudget: { maxTokens: 20000, reserved: { system: 1500, task: 2000, output: 2000 }, dynamic: 0 } };
  let current: { base: Awaited<ReturnType<typeof createHarness>>; composition: Awaited<ReturnType<typeof createDeepseekComposition>> } | undefined;
  const close = async () => { const old = current; current = undefined; if (old) { await old.composition.close(); await old.base.close(); } };
  cleanup.push(close); cleanup.push(async () => { release(); });
  const open = async () => { const base = await createHarness(config); const composition = await createDeepseekComposition(base, config.dataDir); current = { base, composition }; return current; };
  const first = await open();
  const { sessionId } = await first.composition.sessions.call("session/create", { request: {} }, signal()) as { sessionId: string };
  const owner = await first.composition.owners.ownerOf(sessionId), nativeId = first.composition.owners.nativeSessionId(sessionId);
  const oldTurn = newTurnId();
  for (let i = 0; i < 32; i++) await owner.store.appendMessage({ id: newMessageId(), sessionId: nativeId, turnId: oldTurn,
    role: "assistant", content: `Earlier decision ${i}: ` + "ordinary reliable investigation evidence ".repeat(95), createdAt: i });
  const command = (line: string) => current!.composition.activity.call("commands/execute", { agentId: sessionId, line, submittedAttachments: [] }, signal());
  const run = async () => {
    const host = current!.composition, own = await host.owners.ownerOf(sessionId), actor = await own.sessions.load(host.owners.nativeSessionId(sessionId));
    const turn = await actor.createTurn({ sessionId: host.owners.nativeSessionId(sessionId), text: "Continue this coding task with the current instructions." });
    return actor.runTurn(turn.id);
  };
  return { ...first, owner, nativeId, sessionId, calls, entered, release, close, open, command, run };
}

it("a same-millisecond manual request during a real summary survives completion and restart, then is consumed once", async () => {
  const f = await setup();
  await f.command("/compact");
  const first = (await f.composition.controls.read(f.sessionId)).compaction!;
  const running = f.run(); await f.entered;
  // Equal wall clocks must still identify two distinct human requests.
  const clock = vi.spyOn(Date, "now").mockReturnValue(first.requestedAt);
  try { await f.command("/compact"); } finally { clock.mockRestore(); }
  const second = (await f.composition.controls.read(f.sessionId)).compaction!;
  expect(second.requestedAt).toBe(first.requestedAt);
  expect(first.requestId).toEqual(expect.any(String));
  expect(second.requestId).not.toBe(first.requestId);
  f.release(); expect((await running).status).toBe("completed");
  await expect.poll(async () => (await f.composition.controls.read(f.sessionId)).compaction?.lastCompletedAt).toBeTypeOf("number");
  expect((await f.composition.controls.read(f.sessionId)).compaction?.pending).toBe(true);
  expect(f.calls.filter(call => call.summary)).toHaveLength(1);
  // Re-observing an older completion must not consume the newer identity.
  const completed = (await f.owner.events.list(f.nativeId)).find(event => event.type === "context.compacted" && event.payload.phase === "completed")!;
  f.composition.controls.observe(completed);
  f.composition.controls.observe(completed);
  await f.close(); const reopened = await f.open();
  expect((await reopened.composition.controls.read(f.sessionId)).compaction?.pending).toBe(true);
  expect((await f.run()).status).toBe("completed");
  await expect.poll(async () => (await reopened.composition.controls.read(f.sessionId)).compaction?.pending).toBe(false);
  expect(f.calls.filter(call => call.summary)).toHaveLength(2);
  expect((await f.run()).status).toBe("completed");
  expect(f.calls.filter(call => call.summary)).toHaveLength(2);
});

it("restores and consumes a legacy pending request without inventing a new request on later turns", async () => {
  const f = await setup();
  const tool = sessionMetadataTool(f.composition.sessions.metadata, row => {
    row.controls = { permission: "workspace-write", plan: { status: "off", revision: 0 }, compaction: { pending: true, requestedAt: 1234 } };
  });
  expect((await f.composition.tools.executeHostTool(f.sessionId, tool,
    { path: f.composition.sessions.metadata.path!, sessionId: f.sessionId }, signal())).status).toBe("success");
  await f.close(); const reopened = await f.open();
  expect((await reopened.composition.controls.read(f.sessionId)).compaction?.pending).toBe(true);
  const running = f.run(); await f.entered; f.release();
  expect((await running).status).toBe("completed");
  await expect.poll(async () => (await reopened.composition.controls.read(f.sessionId)).compaction?.pending).toBe(false);
  expect((await f.run()).status).toBe("completed");
  expect(f.calls.filter(call => call.summary)).toHaveLength(1);
});

it("a request arriving after pipeline consumption but before the started event is retained", async () => {
  const f = await setup(); await f.command("/compact");
  let entered!: () => void, release!: () => void;
  const consumed = new Promise<void>(resolve => { entered = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  cleanup.push(async () => { release(); });
  // Discovery is the first asynchronous operation after ContextPipeline has
  // consumed the one-shot flag. Delay real discovery, not the controls event.
  const discovery = Reflect.get(f.owner.context.pipeline, "discovery") as InstructionDiscovery;
  const discover = discovery.discover.bind(discovery);
  const delayed = vi.spyOn(discovery, "discover").mockImplementationOnce(async (...args) => {
    entered(); await gate; return discover(...args);
  });
  const running = f.run(); await consumed;
  await f.command("/compact");
  const laterRequest = (await f.composition.controls.read(f.sessionId)).compaction!;
  expect((await f.owner.events.list(f.nativeId)).some(event => event.type === "context.compacted" && event.payload.phase === "started")).toBe(false);
  release(); await f.entered; f.release();
  expect((await running).status).toBe("completed"); delayed.mockRestore();
  await expect.poll(async () => (await f.composition.controls.read(f.sessionId)).compaction?.lastCompletedAt).toBeTypeOf("number");
  expect((await f.composition.controls.read(f.sessionId)).compaction).toMatchObject({ pending: true, requestId: laterRequest.requestId });
  expect((await f.run()).status).toBe("completed");
  await expect.poll(async () => (await f.composition.controls.read(f.sessionId)).compaction?.pending).toBe(false);
  expect(f.calls.filter(call => call.summary)).toHaveLength(2);
});
