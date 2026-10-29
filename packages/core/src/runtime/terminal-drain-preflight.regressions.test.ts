import { expect, it, vi } from "vitest";
import { newAgentId, newPromptId, type AdmittedPrompt, type AgentDefinition, type InboxStore, type ModelEvent } from "@ar/contracts";
import { ScriptedModelProvider } from "@ar/model";
import { AgentRuntime } from "./runtime.js";
import { DefaultSessionActor, type RecoveryScheduler } from "./session-actor.js";
import { MemoryEventStore, MemorySessionStore } from "../test/fakes.js";
import { FakeOrchestrator } from "../test/fake-orchestrator.js";

function gate() {
  let release!: () => void, reject!: (error: Error) => void;
  const promise = new Promise<void>((resolve, fail) => { release = resolve; reject = fail; });
  return { promise, release, reject };
}
const AGENT: AgentDefinition = { id: newAgentId(), name: "terminal-drain-preflight", description: "offline regression", mode: "primary",
  model: { providerId: "scripted", modelId: "scripted-model" }, systemPrompt: "test", tools: {}, permissions: { rules: [] }, skills: {}, limits: {} };
async function fixture(script: AsyncIterable<ModelEvent> | ModelEvent[] = ScriptedModelProvider.text("done")) {
  const store = new MemorySessionStore(), events = new MemoryEventStore(), rows: AdmittedPrompt[] = [];
  const inbox: InboxStore = {
    admit: async row => { rows.push(structuredClone(row)); },
    listPending: async id => rows.filter(row => row.sessionId === id && row.status === "pending"),
    listRecoverable: vi.fn(async id => rows.filter(row => row.sessionId === id && row.status !== "consumed")),
    listAll: async id => rows.filter(row => row.sessionId === id),
    markPromoted: async id => { rows.find(row => row.id === id)!.status = "promoted"; },
    bindPromotion: async (id, turnId) => { Object.assign(rows.find(row => row.id === id)!, { status: "promoted", promotedTurnId: turnId }); },
    markConsumed: vi.fn(async id => { rows.find(row => row.id === id)!.status = "consumed"; }),
  };
  const model = new ScriptedModelProvider([script]), orchestrator = new FakeOrchestrator();
  const runtime = new AgentRuntime({ store, events, inbox, modelProvider: model, orchestrator, agents: [AGENT] });
  const session = await runtime.createSession({ agent: AGENT, cwd: "/terminal-drain-preflight" });
  const scheduled: Array<{ delay: number; callback: () => void; cancel: ReturnType<typeof vi.fn> }> = [];
  const scheduler: RecoveryScheduler = { schedule(delay, callback) { const cancel = vi.fn(); scheduled.push({ delay, callback, cancel }); return { cancel }; } };
  const actor = new DefaultSessionActor({ persistent: session, runtime, store, inbox, scheduler });
  return { store, events, rows, inbox, model, orchestrator, runtime, session, actor, scheduled };
}

it("an unfinished terminal preflight leaves foreground admission free and cannot replace its newer reservation", async () => {
  const repair = gate(), entered = gate(), modelEntered = gate(), finishModel = gate();
  const h = await fixture((async function* () { modelEntered.release(); await finishModel.promise; yield* ScriptedModelProvider.text("foreground answer"); })());
  const original = h.runtime.reconcileTerminalTurns.bind(h.runtime);
  const policy = vi.spyOn(h.runtime, "reconcileTerminalTurns").mockImplementationOnce(async id => { entered.release(); await repair.promise; await original(id); });
  const drain = h.actor.drainFollowupsForTest();
  try {
    await entered.promise;
    expect(h.actor.executionState).toBe("idle");
    const foreground = await h.actor.startTurn({ sessionId: h.session.id, text: "new foreground task" });
    await modelEntered.promise;
    repair.release(); await drain;
    expect(h.actor.activeTurn?.turn.id).toBe(foreground.turnId);
    expect(h.actor.executionState).toBe("running");
    finishModel.release(); expect((await foreground.outcome).status).toBe("completed");
    expect(await h.store.listTurns(h.session.id)).toHaveLength(1);
    expect(h.model.calls).toHaveLength(1); expect(h.orchestrator.calls).toHaveLength(0);
  } finally { repair.release(); finishModel.release(); await drain; policy.mockRestore(); await h.actor.close(); }
});

it("a failed terminal preflight cannot discover or consume promoted prompts and remains retryable", async () => {
  const h = await fixture();
  const turn = await h.runtime.startTurn(h.session.id, "finished original");
  await h.runtime.runTurn(h.session.id, turn.id, new AbortController().signal);
  const promptId = newPromptId();
  await h.inbox.admit({ id: promptId, sessionId: h.session.id, text: "finished original", kind: "followup", status: "promoted", promotedTurnId: turn.id, admittedAt: 1 });
  vi.mocked(h.inbox.listRecoverable).mockClear();
  const policy = vi.spyOn(h.runtime, "reconcileTerminalTurns").mockRejectedValueOnce(new Error("terminal repair unavailable"));
  const run = vi.spyOn(h.runtime, "runTurn");
  const consumed = gate(), mark = vi.mocked(h.inbox.markConsumed).getMockImplementation()!;
  vi.mocked(h.inbox.markConsumed).mockImplementation(async id => { await mark(id); consumed.release(); });
  try {
    await h.actor.drainFollowupsForTest();
    expect(h.inbox.listRecoverable).not.toHaveBeenCalled(); expect(h.inbox.markConsumed).not.toHaveBeenCalled();
    expect(h.rows[0]!.status).toBe("promoted"); expect(h.actor.executionState).toBe("idle");
    expect(h.scheduled).toHaveLength(1); expect(h.scheduled[0]!.delay).toBeGreaterThan(0); expect(h.scheduled[0]!.delay).toBeLessThanOrEqual(30_000);
    h.scheduled[0]!.callback();
    await consumed.promise;
    expect(h.rows[0]!.status).toBe("consumed"); expect(h.inbox.markConsumed).toHaveBeenCalledTimes(1);
    expect(run).not.toHaveBeenCalled(); expect(h.model.calls).toHaveLength(1); expect(await h.store.listTurns(h.session.id)).toHaveLength(1);
    expect(h.events.events.filter(event => event.type === "turn.completed")).toHaveLength(1);
  } finally { policy.mockRestore(); await h.actor.close(); }
});

it("empty durable hydration leaves foreground admission free and cannot overwrite its turn", async () => {
  const hydration = gate(), entered = gate(), modelEntered = gate(), finishModel = gate();
  const h = await fixture((async function* () { modelEntered.release(); await finishModel.promise; yield* ScriptedModelProvider.text("foreground answer"); })());
  const list = vi.mocked(h.inbox.listRecoverable).getMockImplementation()!; let reads = 0;
  vi.mocked(h.inbox.listRecoverable).mockImplementation(async id => {
    if (++reads === 2) { entered.release(); await hydration.promise; }
    return list(id);
  });
  const drain = h.actor.drainFollowupsForTest();
  try {
    await entered.promise;
    expect(h.actor.executionState).toBe("idle");
    const foreground = await h.actor.startTurn({ sessionId: h.session.id, text: "foreground during empty hydration" });
    await modelEntered.promise;
    hydration.release(); await drain;
    expect(h.actor.activeTurn?.turn.id).toBe(foreground.turnId); expect(h.actor.executionState).toBe("running");
    finishModel.release(); expect((await foreground.outcome).status).toBe("completed");
    expect(await h.store.listTurns(h.session.id)).toHaveLength(1); expect(h.model.calls).toHaveLength(1);
  } finally { hydration.release(); finishModel.release(); await drain; await h.actor.close(); }
});

it("closing during failed terminal preflight does not consume work or recreate a recovery timer", async () => {
  const h = await fixture(), entered = gate(), repair = gate();
  const policy = vi.spyOn(h.runtime, "reconcileTerminalTurns").mockImplementationOnce(async () => { entered.release(); await repair.promise; });
  const drain = h.actor.drainFollowupsForTest();
  try {
    await entered.promise;
    const closing = h.actor.close();
    repair.reject(new Error("repair failed after close"));
    await drain; await closing;
    expect(h.inbox.listRecoverable).not.toHaveBeenCalled(); expect(h.inbox.markConsumed).not.toHaveBeenCalled();
    expect(h.scheduled).toHaveLength(0); expect(h.model.calls).toHaveLength(0); expect(h.orchestrator.calls).toHaveLength(0);
  } finally { repair.release(); await drain; policy.mockRestore(); await h.actor.close(); }
});

it("failed durable hydration leaves the actor idle and retries its pending prompt through the scheduled wake", async () => {
  const h = await fixture(), promptId = newPromptId(), consumed = gate();
  await h.inbox.admit({ id: promptId, sessionId: h.session.id, text: "pending after hydration outage", kind: "followup", status: "pending", admittedAt: 1 });
  vi.mocked(h.inbox.listRecoverable).mockResolvedValueOnce([]).mockRejectedValueOnce(new Error("hydration unavailable"));
  const mark = vi.mocked(h.inbox.markConsumed).getMockImplementation()!;
  vi.mocked(h.inbox.markConsumed).mockImplementation(async id => { await mark(id); consumed.release(); });
  try {
    await h.actor.drainFollowupsForTest();
    expect(h.actor.executionState).toBe("idle"); expect(h.rows[0]!.status).toBe("pending");
    expect(h.inbox.markConsumed).not.toHaveBeenCalled(); expect(h.model.calls).toHaveLength(0);
    expect(h.scheduled).toHaveLength(1); expect(h.scheduled[0]!.delay).toBeGreaterThan(0); expect(h.scheduled[0]!.delay).toBeLessThanOrEqual(30_000);
    h.scheduled[0]!.callback(); await consumed.promise;
    expect(h.rows[0]!.status).toBe("consumed"); expect(h.inbox.markConsumed).toHaveBeenCalledTimes(1);
    const turns = await h.store.listTurns(h.session.id);
    expect(turns).toHaveLength(1); expect(turns[0]!.id).toBe(h.rows[0]!.promotedTurnId);
    expect(h.model.calls).toHaveLength(1); expect(h.events.events.filter(event => event.type === "turn.completed")).toHaveLength(1);
  } finally { await h.actor.close(); }
});

it("an overridden native dequeuer can provide an external followup while its internal pending count is zero", async () => {
  const h = await fixture(), id = newPromptId(), consumed = gate(); let provided = false;
  const reserve = vi.spyOn(h.actor.inputQueue, "reservePendingFollowup").mockImplementation(async () => {
    if (provided) return undefined;
    provided = true;
    await h.inbox.admit({ id, sessionId: h.session.id, text: "external dynamic followup", kind: "followup", status: "pending", admittedAt: 1 });
    return { id, input: { sessionId: h.session.id, text: "external dynamic followup" } };
  });
  const bind = vi.spyOn(h.actor.inputQueue, "bindReservedFollowup").mockImplementation(async (reservedId, turnId) => {
    expect(reservedId).toBe(id); await h.inbox.bindPromotion(id, turnId);
  });
  const complete = vi.spyOn(h.actor.inputQueue, "completeReservedFollowup").mockImplementation(async reservedId => {
    expect(reservedId).toBe(id); await h.inbox.markConsumed(id); consumed.release();
  });
  const execute = h.runtime.runTurn.bind(h.runtime);
  const run = vi.spyOn(h.runtime, "runTurn").mockImplementation(async (...args) => {
    expect(h.rows[0]).toMatchObject({ status: "promoted", promotedTurnId: args[1] });
    return execute(...args);
  });
  try {
    expect(h.actor.inputQueue.pendingCount).toBe(0); expect(h.rows).toHaveLength(0);
    await h.actor.drainFollowupsForTest();
    expect(reserve).toHaveBeenCalled();
    await consumed.promise;
    expect(bind).toHaveBeenCalledTimes(1); expect(complete).toHaveBeenCalledTimes(1); expect(run).toHaveBeenCalledTimes(1);
    const turns = await h.store.listTurns(h.session.id);
    expect(turns).toHaveLength(1); expect(turns[0]).toMatchObject({ status: "completed", input: { text: "external dynamic followup" } });
    expect(h.rows[0]).toMatchObject({ status: "consumed", promotedTurnId: turns[0]!.id });
    expect(h.model.calls).toHaveLength(1); expect(h.orchestrator.calls).toHaveLength(0);
  } finally { await h.actor.close(); }
});
