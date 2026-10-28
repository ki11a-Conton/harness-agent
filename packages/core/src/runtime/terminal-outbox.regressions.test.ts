import { describe, expect, it, vi } from "vitest";
import type { AgentDefinition, AgentEvent, DurabilityFenceStore, EventStore, SessionStore } from "@ar/contracts";
import { DEFAULT_TOOL_SEMANTICS, errorInfo, eventSinkFromStore, newAgentId, newTurnId, newWorkingState } from "@ar/contracts";
import { ScriptedModelProvider } from "@ar/model";
import { RecoveryController } from "./recovery-controller.js";
import { AgentState } from "../state/agent-state.js";
import { AgentRuntime } from "./runtime.js";
import { DefaultLoadedSessionManager, DefaultSessionActor } from "./session-actor.js";
import { MemoryEventStore, MemorySessionStore, defaultTestToolCatalog } from "../test/fakes.js";
import { FakeOrchestrator } from "../test/fake-orchestrator.js";

const AGENT: AgentDefinition = { id: newAgentId(), name: "terminal-outbox", description: "offline regression", mode: "primary",
  model: { providerId: "scripted", modelId: "scripted-model" }, systemPrompt: "test", tools: {},
  permissions: { rules: [] }, skills: {}, limits: {} };
const terminal = (event: Pick<AgentEvent, "type">) => ["turn.completed", "turn.failed", "turn.cancelled"].includes(event.type);

function faultEvents(inner: EventStore, stage: "before" | "after"): EventStore {
  let armed = true;
  return { append: event => inner.append(event), list: (id, opts) => inner.list(id, opts),
    stream: (id, opts) => inner.stream(id, opts), nextSequence: id => inner.nextSequence(id),
    async appendNew(event) {
      if (!terminal(event) || !armed) return inner.appendNew(event);
      armed = false;
      if (stage === "before") throw new Error("terminal append before commit");
      await inner.appendNew(event);
      throw new Error("terminal append after commit");
    } };
}
function runtime(store: SessionStore, events: EventStore, calls = { model: 0 }, durabilityFence?: DurabilityFenceStore) {
  const provider = new ScriptedModelProvider([ScriptedModelProvider.text("done")]);
  const original = provider.createClient.bind(provider);
  provider.createClient = (...args) => { calls.model++; return original(...args); };
  const orchestrator = new FakeOrchestrator();
  return { engine: new AgentRuntime({ store, events, agents: [AGENT], modelProvider: provider, orchestrator, durabilityFence }), orchestrator, calls };
}
async function setup(events = new MemoryEventStore()) {
  const store = new MemorySessionStore(), h = runtime(store, events);
  const session = await h.engine.createSession({ agent: AGENT, cwd: "/terminal-outbox" });
  const turn = await h.engine.startTurn(session.id, "finish");
  const state = new AgentState(session.id, AGENT.id, () => 1); state.beginTurn(turn.id);
  const ctx = { sessionId: session.id, turnId: turn.id, session, agent: AGENT, signal: new AbortController().signal };
  const controller = (journal: EventStore = events) => new RecoveryController({ store, events: journal,
    emit: (sessionId, type, payload, turnId) => journal.appendNew({ id: `legacy-${type}` as never, sessionId, type, payload, turnId, timestamp: 1000 }),
    now: () => 1000, semanticsOf: () => DEFAULT_TOOL_SEMANTICS });
  return { store, events, h, session, turn, state, ctx, controller, working: newWorkingState("finish") };
}

describe("durable terminal outcome", () => {
  it.each(["before", "after"] as const)("repairs an append failure %s commit after a fresh controller without changing the first result", async stage => {
    const h = await setup(), failed = faultEvents(h.events, stage);
    const firstError = errorInfo("VERIFICATION_FAILED", "original failure");
    const firstEvidence = { passedSteps: 1, totalSteps: 2 };
    await expect(h.controller(failed).finishTurn(h.ctx, "failed", h.state, h.working,
      firstError, "verification_failed", [], firstEvidence)).rejects.toThrow(`terminal append ${stage}`);
    const second = await h.controller().finishTurn(h.ctx, "completed", h.state, h.working,
      errorInfo("INTERNAL_ERROR", "late"), "verified_complete", [], { passedSteps: 2, totalSteps: 2 });
    expect(second).toMatchObject({ status: "failed", statusDetail: "failed_no_effect", error: firstError,
      terminationReason: "verification_failed", grade: "verification_failed" });
    const records = (await h.events.list(h.session.id)).filter(terminal);
    expect(records).toHaveLength(1);
    expect(records[0]!.payload).toMatchObject({ status: "failed", error: firstError, terminationReason: "verification_failed",
      grade: "verification_failed", completionEvidence: firstEvidence });
  });

  it("serializes competing controller finishes and preserves the winning result", async () => {
    const h = await setup();
    const results = await Promise.all([
      h.controller().finishTurn(h.ctx, "completed", h.state, h.working, undefined, "verified_complete", [], { passedSteps: 1, totalSteps: 1 }),
      h.controller().finishTurn(h.ctx, "cancelled", h.state, h.working, errorInfo("INTERNAL_ERROR", "late"), "cancelled", []),
    ]);
    expect(results.every(result => result.status === "completed" && result.terminationReason === "verified_complete" && result.grade === "verified_complete" && result.error === undefined)).toBe(true);
    expect((await h.events.list(h.session.id)).filter(terminal)).toHaveLength(1);
  });

  it.each(["runTurn", "resumeTurn", "actorLoad"] as const)("public %s repairs the committed outcome without another model or tool", async entry => {
    const h = await setup(), counted = { model: 0 };
    const first = runtime(h.store, faultEvents(h.events, "before"), counted);
    await expect(first.engine.runTurn(h.session.id, h.turn.id, new AbortController().signal)).rejects.toThrow("terminal append before commit");
    expect(counted.model).toBe(1);
    const restored = runtime(h.store, h.events, counted);
    if (entry === "runTurn") await expect(restored.engine.runTurn(h.session.id, h.turn.id, new AbortController().signal)).rejects.toThrow(/terminal/);
    else if (entry === "resumeTurn") await expect(restored.engine.resumeTurn(h.session.id, new AbortController().signal)).rejects.toThrow();
    else {
      const manager = new DefaultLoadedSessionManager({ runtime: restored.engine, store: h.store });
      try { await manager.load(h.session.id); } finally { await manager.close(); }
    }
    expect(counted.model).toBe(1);
    expect(first.orchestrator.calls).toHaveLength(0); expect(restored.orchestrator.calls).toHaveLength(0);
    expect((await h.events.list(h.session.id)).filter(terminal)).toHaveLength(1);
    expect(await h.store.listTurns(h.session.id)).toHaveLength(1);
  });

  it("legacy terminal rows retain their no-evidence compatibility and pauses remain nonterminal", async () => {
    const h = await setup();
    await h.store.updateTurn({ ...h.turn, status: "completed", completedAt: 100 });
    await h.controller().finishTurn(h.ctx, "completed", h.state, h.working);
    expect((await h.events.list(h.session.id)).filter(terminal)).toHaveLength(0);
    await h.store.updateTurn({ ...h.turn, status: "running" });
    const paused = await h.controller().finishTurn(h.ctx, "waiting_for_approval", h.state, h.working);
    expect(paused.status).toBe("waiting_for_approval");
    expect(await h.store.getTurn(h.turn.id)).not.toHaveProperty("terminalOutcome");
    const finished = await h.controller().finishTurn(h.ctx, "completed", h.state, h.working, undefined, "model_stopped");
    expect(finished.status).toBe("completed");
  });

  it.each(["before", "after"] as const)("revoked actor reservations retain a cancelled outbox when append fails %s commit", async stage => {
    const h = await setup(), counted = { model: 0 }, failedEvents = faultEvents(h.events, stage);
    const real = runtime(h.store, failedEvents, counted), runSpy = vi.spyOn(real.engine, "runTurn");
    const actor = new DefaultSessionActor({ persistent: h.session, runtime: real.engine, store: h.store, emit: eventSinkFromStore(failedEvents) });
    const original = h.store.getTurn.bind(h.store);
    let entered!: () => void, release!: () => void;
    const reading = new Promise<void>(resolve => { entered = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
    const read = vi.spyOn(h.store, "getTurn").mockImplementationOnce(async id => { entered(); await gate; return original(id); });
    const pending = actor.runTurn(h.turn.id);
    const observed = pending.then(value => ({ value }), error => ({ error }));
    await reading; await actor.cancelTurn(h.turn.id); release();
    const result = await observed;
    read.mockRestore();
    expect(result).toHaveProperty("error");
    expect(await h.store.getTurn(h.turn.id)).toMatchObject({ status: "cancelled", terminalOutcome: { version: 1, status: "cancelled", terminationReason: "cancelled" } });
    const restored = runtime(h.store, h.events, counted);
    await restored.engine.getSessionAgent(h.session.id);
    expect((await h.events.list(h.session.id)).filter(terminal)).toHaveLength(1);
    expect(counted.model).toBe(0); expect(runSpy).not.toHaveBeenCalled();
    expect(real.orchestrator.calls).toHaveLength(0); expect(await h.store.listTurns(h.session.id)).toHaveLength(1);
    await actor.close();
  });


  it("batches a cold session journal read and performs no history IO on warm metadata", async () => {
    const h = await setup(), writer = h.controller();
    for (let index = 0; index < 24; index++) {
      const id = newTurnId();
      await h.store.createTurn({ ...h.turn, id });
      await writer.finishTurn({ ...h.ctx, turnId: id }, "completed", h.state, h.working, undefined, "model_stopped");
    }
    const restored = runtime(h.store, h.events), list = vi.spyOn(h.events, "list"), rows = vi.spyOn(h.store, "listTurns");
    await restored.engine.getSessionAgent(h.session.id);
    expect(list).toHaveBeenCalledTimes(1); expect(rows).toHaveBeenCalledTimes(1);
    list.mockClear(); rows.mockClear();
    for (let index = 0; index < 5; index++) await restored.engine.getSessionAgent(h.session.id);
    expect(list).not.toHaveBeenCalled(); expect(rows).not.toHaveBeenCalled();
    // Another controller commits a new outbox then fails publication. Its
    // generation invalidates the warm metadata cache on the same store.
    const id = newTurnId(); await h.store.createTurn({ ...h.turn, id });
    await expect(h.controller(faultEvents(h.events, "before")).finishTurn({ ...h.ctx, turnId: id }, "completed", h.state, h.working,
      undefined, "model_stopped")).rejects.toThrow("terminal append before commit");
    list.mockClear(); rows.mockClear();
    await restored.engine.getSessionAgent(h.session.id);
    expect(list).toHaveBeenCalledTimes(1); expect(rows).toHaveBeenCalledTimes(1);
    list.mockClear(); rows.mockClear();
    await restored.engine.getSessionAgent(h.session.id);
    expect(list).not.toHaveBeenCalled(); expect(rows).not.toHaveBeenCalled();
    list.mockRestore(); rows.mockRestore();
  });

  it("a failed repair blocks loading and new prompts and remains retryable", async () => {
    const h = await setup();
    await expect(h.controller(faultEvents(h.events, "before")).finishTurn(h.ctx, "completed", h.state, h.working,
      undefined, "model_stopped")).rejects.toThrow("terminal append before commit");
    const failing = runtime(h.store, faultEvents(h.events, "before"));
    await expect(failing.engine.startTurn(h.session.id, "new input")).rejects.toThrow("terminal append before commit");
    expect(await h.store.listTurns(h.session.id)).toHaveLength(1);
    const manager = new DefaultLoadedSessionManager({ runtime: runtime(h.store, faultEvents(h.events, "before")).engine, store: h.store });
    try {
      await expect(manager.load(h.session.id)).rejects.toThrow("terminal append before commit");
      expect(manager.listLoaded()).toHaveLength(0);
      await manager.load(h.session.id);
      expect((await h.events.list(h.session.id)).filter(terminal)).toHaveLength(1);
    } finally { await manager.close(); }
    expect(failing.calls.model).toBe(0); expect(failing.orchestrator.calls).toHaveLength(0);
  });

  it("rejects a conflicting event identity without appending another terminal event", async () => {
    const h = await setup();
    await expect(h.controller(faultEvents(h.events, "before")).finishTurn(h.ctx, "completed", h.state, h.working,
      undefined, "verified_complete", [], { passedSteps: 1, totalSteps: 1 })).rejects.toThrow();
    const turn = (await h.store.getTurn(h.turn.id))!;
    await h.events.appendNew({ id: turn.terminalOutcome!.eventId, sessionId: h.session.id, turnId: h.turn.id,
      timestamp: turn.terminalOutcome!.timestamp, type: "turn.cancelled", payload: { unexpected: true } });
    const restored = runtime(h.store, h.events);
    await expect(restored.engine.getSessionAgent(h.session.id)).rejects.toThrow("conflicting durable terminal outcome event");
    expect((await h.events.list(h.session.id)).filter(terminal)).toHaveLength(1);
    expect(restored.calls.model).toBe(0); expect(restored.orchestrator.calls).toHaveLength(0);
  });


  it("a cold terminal repair fences the actual sequence and retries a failed fence before warm metadata", async () => {
    const h = await setup();
    await expect(h.controller(faultEvents(h.events, "before")).finishTurn(h.ctx, "completed", h.state, h.working,
      undefined, "model_stopped")).rejects.toThrow();
    let fail = true;
    const flush = vi.fn(async (_sessionId: string, _sequence: number) => { if (fail) { fail = false; throw new Error("terminal fence failed"); } });
    const restored = runtime(h.store, h.events, { model: 0 }, { durabilityLevel: "memory", flushThrough: flush });
    await expect(restored.engine.getSessionAgent(h.session.id)).rejects.toThrow("terminal fence failed");
    await restored.engine.getSessionAgent(h.session.id);
    await restored.engine.getSessionAgent(h.session.id);
    expect(flush).toHaveBeenCalledTimes(2);
    const finalSequence = (await h.events.nextSequence(h.session.id)) - 1;
    expect(flush.mock.calls.every(args => args[0] === h.session.id && args[1] === finalSequence)).toBe(true);
    expect((await h.events.list(h.session.id)).filter(terminal)).toHaveLength(1);
    expect(restored.calls.model).toBe(0); expect(restored.orchestrator.calls).toHaveLength(0);
  });

  it("unstarted cancellation uses the completion fence without entering runTurn", async () => {
    const h = await setup(), flush = vi.fn(async () => {});
    const actual = runtime(h.store, h.events, { model: 0 }, { durabilityLevel: "memory", flushThrough: flush });
    const run = vi.spyOn(actual.engine, "runTurn");
    await actual.engine.cancelUnstartedTurn(h.session.id, h.turn.id);
    expect(flush).toHaveBeenCalledWith(h.session.id, (await h.events.nextSequence(h.session.id)) - 1);
    expect(actual.calls.model).toBe(0); expect(run).not.toHaveBeenCalled(); expect(actual.orchestrator.calls).toHaveLength(0);
  });

  it("a fabricated pause without recoverable state cannot invent a no-effect cancellation", async () => {
    const h = await setup();
    await h.store.updateTurn({ ...h.turn, status: "waiting_for_user" });
    await expect(h.h.engine.cancelPausedTurn(h.session.id, h.turn.id)).rejects.toThrow(/question-pause checkpoint/);
    expect(await h.store.getTurn(h.turn.id)).toMatchObject({ status: "waiting_for_user" });
    expect((await h.events.list(h.session.id)).filter(terminal)).toHaveLength(0);
    expect(h.h.calls.model).toBe(0); expect(h.h.orchestrator.calls).toHaveLength(0);
  });


  it("a failed fence sequence read remains retryable instead of confirming warm metadata", async () => {
    const h = await setup();
    await expect(h.controller(faultEvents(h.events, "before")).finishTurn(h.ctx, "completed", h.state, h.working,
      undefined, "model_stopped")).rejects.toThrow();
    const sequence = vi.spyOn(h.events, "nextSequence").mockRejectedValueOnce(new Error("terminal sequence read failed"));
    const flush = vi.fn(async () => {});
    const restored = runtime(h.store, h.events, { model: 0 }, { durabilityLevel: "memory", flushThrough: flush });
    await expect(restored.engine.getSessionAgent(h.session.id)).rejects.toThrow("terminal sequence read failed");
    await restored.engine.getSessionAgent(h.session.id);
    await restored.engine.getSessionAgent(h.session.id);
    expect(sequence).toHaveBeenCalledTimes(2); expect(flush).toHaveBeenCalledTimes(1);
    expect(restored.calls.model).toBe(0); expect(restored.orchestrator.calls).toHaveLength(0);
    sequence.mockRestore();
  });

  it("an idle cancel retry repairs a previously cancelled row before its status early return", async () => {
    const h = await setup();
    await expect(h.controller(faultEvents(h.events, "before")).finishTurn(h.ctx, "cancelled", h.state, h.working,
      undefined, "cancelled")).rejects.toThrow();
    const actual = runtime(h.store, h.events);
    const actor = new DefaultSessionActor({ persistent: h.session, runtime: actual.engine, store: h.store });
    try {
      expect((await actor.cancelTurn(h.turn.id)).disposition).toBe("not_running");
      expect((await h.events.list(h.session.id)).filter(terminal)).toHaveLength(1);
      expect(actual.calls.model).toBe(0); expect(actual.orchestrator.calls).toHaveLength(0);
    } finally { await actor.close(); }
  });


  it.each([false, true])("cancels a genuine pause at its exhausted iteration cap without new work (memory=%s)", async memory => {
    const store = new MemorySessionStore(), events = new MemoryEventStore(), orchestrator = new FakeOrchestrator();
    const provider = new ScriptedModelProvider([
      ScriptedModelProvider.toolCall("write_file", { path: "effect.txt", content: "written" }),
      ScriptedModelProvider.toolCall("ask_user", { question: "Which target?", reason: "choice_required" }),
    ]);
    let prefetches = 0;
    const actual = new AgentRuntime({ store, events, agents: [AGENT], modelProvider: provider, orchestrator,
      toolRegistry: defaultTestToolCatalog(), maxIterationsPerTurn: 2,
      ...(memory ? { memoryBlocks: async () => { prefetches++; return []; } } : {}) });
    const session = await actual.createSession({ agent: AGENT, cwd: "/paused-budget" }), turn = await actual.startTurn(session.id, "write and ask");
    expect((await actual.runTurn(session.id, turn.id, new AbortController().signal)).status).toBe("waiting_for_user");
    const before = { model: provider.calls.length, tools: orchestrator.calls.length, memory: prefetches,
      verification: events.events.filter(event => event.type === "verification.started").length };
    expect(before.model).toBe(2); expect(before.tools).toBe(1);
    const cancelled = await actual.cancelPausedTurn(session.id, turn.id);
    expect(cancelled).toMatchObject({ status: "cancelled", statusDetail: "cancelled_with_effects", terminationReason: "cancelled", toolCalls: 1, iterations: 2 });
    expect({ model: provider.calls.length, tools: orchestrator.calls.length, memory: prefetches,
      verification: events.events.filter(event => event.type === "verification.started").length }).toEqual(before);
  });

  it("a successful cancel retry wakes the followup queued while the first cancellation failed", async () => {
    const store = new MemorySessionStore(), events = new MemoryEventStore();
    const provider = new ScriptedModelProvider([
      ScriptedModelProvider.toolCall("ask_user", { question: "Which target?", reason: "choice_required" }), ScriptedModelProvider.text("next task finished"),
    ]);
    const actual = new AgentRuntime({ store, events: faultEvents(events, "before"), agents: [AGENT], modelProvider: provider,
      orchestrator: new FakeOrchestrator(), toolRegistry: defaultTestToolCatalog() });
    const session = await actual.createSession({ agent: AGENT, cwd: "/cancel-followup" }), turn = await actual.startTurn(session.id, "ask target");
    expect((await actual.runTurn(session.id, turn.id, new AbortController().signal)).status).toBe("waiting_for_user");
    const actor = new DefaultSessionActor({ persistent: session, runtime: actual, store });
    const update = store.updateTurn.bind(store); let entered!: () => void, release!: () => void;
    const ready = new Promise<void>(resolve => { entered = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
    const write = vi.spyOn(store, "updateTurn").mockImplementation(async value => { if (value.status === "cancelled") { entered(); await gate; } await update(value); });
    try {
      const first = actor.cancelTurn(turn.id), observed = first.then(value => ({ value }), error => ({ error }));
      await ready; await actor.enqueueFollowup({ sessionId: session.id, text: "next task" }); release();
      expect(await observed).toHaveProperty("error"); write.mockRestore();
      expect((await actor.cancelTurn(turn.id)).disposition).toBe("not_running");
      await vi.waitFor(() => expect(provider.calls).toHaveLength(2), { timeout: 1000, interval: 5 });
      await vi.waitFor(async () => expect((await store.listTurns(session.id)).filter(row => row.status === "completed")).toHaveLength(1), { timeout: 1000, interval: 5 });
      expect(events.events.filter(event => event.type === "turn.cancelled")).toHaveLength(1);
    } finally { release(); write.mockRestore(); await actor.close(); }
  });

});
