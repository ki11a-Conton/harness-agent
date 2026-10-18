import { mkdtemp, rm, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { createHarness, type Harness } from "@ar/harness";
import { createRuntimeRpc } from "@ar/gateway";
import { ScriptedModelProvider } from "@ar/model";
import { newToolCallId, toToolSemantics, type SessionId } from "@ar/contracts";
import { ToolOrchestrator, ToolRegistry } from "@ar/tools";
import { createSessionService, type SessionHost } from "./session.js";
import { createEventsService } from "./events.js";
import { createHostTools } from "./host-tools.js";

// P41 audit WEB-020/WEB-021: both `$events` and `session/control` poll every
// ~25 ms. These cases pin the per-poll work down by counting the actual owners:
// full journal reads for the waterfall, and metadata host-tool calls (the
// expensive read inside one projection) for the control stream.

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const action of cleanup.splice(0).reverse()) await action(); });

async function setup() {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "dsh-web-poll-")));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  const provider = new ScriptedModelProvider([ScriptedModelProvider.text("unused")]);
  const harness = await createHarness({ cwd: directory, dataDir: directory, profile: "interactive", modelProvider: provider,
    model: { providerId: provider.id, modelId: "scripted-model" } });
  cleanup.push(() => harness.close());
  const rpc = createRuntimeRpc(harness.runtime, { sessionService: harness.sessionService, sessions: harness.sessions,
    events: harness.events, approvalStore: harness.approvalStore });
  const executor = new ToolOrchestrator({ registry: new ToolRegistry(), workspaceRoot: directory });
  const hostToolCalls = { count: 0 };
  const host: SessionHost = { harness, rpc, cwd: directory, dataDir: directory, pollDelayMs: 1,
    executeHostTool: async (sessionId, definition, args, signal) => {
      hostToolCalls.count += 1;
      const id = newToolCallId(); const agent = harness.agents[0]!;
      return executor.executeBound({ id, sessionId: sessionId as SessionId, agentId: agent.id,
        call: { id, name: definition.name, args }, binding: { name: definition.name, definition,
          spec: { name: definition.name, description: definition.description, inputSchema: {} }, semantics: toToolSemantics(definition.metadata, definition.risk), provenance: { kind: "builtin" } } },
      { sessionId: sessionId as SessionId, agentId: agent.id, cwd: directory, signal,
        permissions: { rules: [{ action: "read", resource: "file", effect: "allow" }, { action: "edit", resource: "file", effect: "allow" }] },
        sandboxPolicy: { filesystem: { mode: "workspace-write", allowedPaths: [directory] }, network: { mode: "deny" }, process: {} } });
    } };
  const service = createSessionService({ ...host, ...createHostTools(harness, directory, directory) });
  cleanup.push(() => service.close());
  const signal = new AbortController().signal;
  const call = (endpoint: string, request: Record<string, unknown>) => service.call(endpoint, { request }, signal);
  const created = await call("session/create", {}) as { sessionId: SessionId };
  return { service, harness, signal, call, hostToolCalls, id: created.sessionId };
}

function approval(id: string, sessionId: SessionId, agentId: string) {
  return { id: id as never, sessionId, agentId: agentId as never, action: "file.write", target: "notes.txt",
    reason: "P41 polling budget case", createdAt: Date.now(), expiresAt: Date.now() + 60_000 };
}

/** An async generator only advances while a consumer pulls, so pump it the way
 * a real connection does and let the test observe the frames it produced. */
function pump(iterator: AsyncIterator<unknown>) {
  const frames: Array<Record<string, unknown>> = [];
  const finished = (async () => {
    for (;;) {
      const next = await iterator.next();
      if (next.done === true) return;
      frames.push(next.value as Record<string, unknown>);
    }
  })().catch(() => undefined);
  const waitFor = async (predicate: (frame: Record<string, unknown>) => boolean) => {
    for (let step = 0; step < 1_000; step += 1) {
      const frame = frames.find(value => predicate(value));
      if (frame !== undefined) return frame;
      await new Promise(done => setTimeout(done, 2));
    }
    throw new Error("frame did not arrive");
  };
  return { frames, waitFor, finished };
}

it("the $events waterfall replays no idle journal and still delivers a new approval", async () => {
  const stack = await setup();
  await stack.call("session/create", {});
  const full = new Map<string, number>();
  const real = stack.harness.events;
  // A counting facade: only reads without `afterSequence` replay a whole journal.
  const events = { ...real,
    list: async (sessionId: SessionId, options?: { afterSequence?: number; limit?: number }) => {
      if (options?.afterSequence === undefined) full.set(sessionId, (full.get(sessionId) ?? 0) + 1);
      return real.list(sessionId, options);
    } };
  const counting = createEventsService({ harness: { ...stack.harness, events } as unknown as Harness,
    answerAsk: async () => { throw new Error("unused"); }, pollDelayMs: 1 });
  const controller = new AbortController();
  const stream = pump(counting.stream("$events", {}, controller.signal)[Symbol.asyncIterator]());
  await stream.waitFor(frame => frame.type === "ready");
  await new Promise(done => setTimeout(done, 80));
  const settled = new Map(full);
  // Two idle sessions over ~80 one-millisecond polls, yet each journal is
  // replayed at most once: the cached pending set is validated by a bounded
  // tail read instead of a full replay plus one ownership read per ask id.
  await new Promise(done => setTimeout(done, 80));
  expect(full.size).toBe(2);
  expect([...full].sort()).toEqual([...settled].sort());
  expect(Math.max(0, ...full.values())).toBe(1);

  // A real change still surfaces immediately through the same cache.
  const pending = stack.harness.approvalStore.create(approval("approval-p41", stack.id, stack.harness.agents[0]!.id));
  expect(await stream.waitFor(frame => frame.event === "approval/request")).toMatchObject({ agentId: stack.id });
  stack.harness.approvalStore.resolve(pending.request.id, "deny", "p41");
  expect(await stream.waitFor(frame => frame.type === "cancel")).toBeDefined();
  controller.abort(); await stream.finished;
});

it("session/control reuses its projection while idle and refreshes it after a metadata commit", async () => {
  const stack = await setup();
  const original = stack.harness.events.list.bind(stack.harness.events);
  let fullReads = 0;
  // The expensive part of one projection is the full journal replay it feeds to
  // the message, activity and inbox owners; count only those, not tail reads.
  const spy = vi.spyOn(stack.harness.events, "list").mockImplementation(async (sessionId, options) => {
    if (options?.afterSequence === undefined) fullReads += 1;
    return original(sessionId, options);
  });
  const controller = new AbortController();
  try {
    const control = pump(stack.service.stream("session/control", {}, controller.signal)[Symbol.asyncIterator]());
    await control.waitFor(frame => frame.type === "baseline");
    const before = fullReads;
    await new Promise(done => setTimeout(done, 120));
    // ~120 polls of one session must not repeat the journal replay per poll.
    expect(fullReads - before).toBeLessThan(5);

    await stack.call("session/rename", { sessionId: stack.id, title: "P41 renamed session" });
    const renamed = await control.waitFor(frame => frame.type === "projection" && frame.key === "title");
    expect(renamed.value).toBe("P41 renamed session");
    controller.abort(); await control.finished;
  } finally { spy.mockRestore(); }
});
