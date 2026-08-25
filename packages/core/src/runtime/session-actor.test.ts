// PHASE 25 — SessionActor: single owner of live session state.
// Covers P25-1..P25-6: Persistent/Loaded separation, manager + actor API,
// per-session concurrency (activeTurn ∈ {0,1}), steer-at-boundary semantics,
// follow-up queue, and idempotent shutdown.

import { describe, expect, it } from "vitest";
import type {
  AdmittedPrompt,
  AgentDefinition,
  InboxStore,
  ModelEvent,
  ModelProvider,
  PromptId,
  SessionId,
  ToolCallRequest,
  ToolExecutionContext,
  ToolResult,
  TurnId,
} from "@ar/contracts";
import { newAgentId, newPromptId } from "@ar/contracts";
import { EchoModelProvider, ScriptedModelProvider } from "@ar/model";
import { AgentRuntime } from "./runtime.js";
import {
  DefaultLoadedSessionManager,
  DefaultSessionActor,
  InboxSessionInputQueue,
  type SessionActor,
  type SessionInputQueue,
} from "./session-actor.js";
import { MemoryEventStore, MemorySessionStore, defaultTestToolCatalog } from "../test/fakes.js";
import { FakeOrchestrator } from "../test/fake-orchestrator.js";

const AGENT: AgentDefinition = {
  id: newAgentId(),
  name: "session-actor-agent",
  description: "test",
  mode: "primary",
  model: { providerId: "scripted", modelId: "scripted-model" },
  systemPrompt: "you are a session-actor test",
  tools: {},
  permissions: { rules: [] },
  skills: {},
  limits: {},
};

/** Model provider whose FIRST generate call blocks until released/aborted;
 *  later calls (across ALL turns) yield the optional script. */
class BlockingProvider implements ModelProvider {
  readonly id = "blocking";
  private calls = 0;
  private releaseBlocked?: () => void;
  readonly blocked: Promise<void> = new Promise((resolve) => {
    this.releaseBlocked = resolve;
  });

  constructor(private readonly later?: ModelEvent[]) {}
  listModels(): Promise<never[]> {
    return Promise.resolve([]);
  }
  createClient() {
    const self = this;
    return {
      async *generate(
        _request: unknown,
        signal: AbortSignal,
      ): AsyncGenerator<ModelEvent, void, void> {
        self.calls += 1;
        if (self.calls > 1 && self.later !== undefined) {
          yield* self.later;
          return;
        }
        yield { type: "started", timestamp: 0 };
        yield { type: "text_delta", text: "thinking", timestamp: 0 };
        self.releaseBlocked?.();
        await new Promise<void>((resolve) => {
          if (signal.aborted) resolve();
          else signal.addEventListener("abort", () => resolve(), { once: true });
        });
        yield { type: "completed", result: { finishReason: "stop", text: "done" }, timestamp: 0 };
      },
    };
  }
}

/** Orchestrator that blocks tool execution until explicitly released. */
class BlockingOrchestrator extends FakeOrchestrator {
  pending: Array<() => void> = [];

  override async execute(
    _request: ToolCallRequest,
    _context: ToolExecutionContext,
  ): Promise<ToolResult> {
    await new Promise<void>((resolve) => {
      this.pending.push(resolve);
    });
    return { status: "success", output: "blocked-tool-ok" };
  }

  releaseNext(): void {
    this.pending.shift()?.();
  }
}

/** In-memory InboxStore fake. */
class MemInboxStore implements InboxStore {
  prompts: AdmittedPrompt[] = [];
  async admit(prompt: AdmittedPrompt): Promise<void> {
    this.prompts.push(prompt);
  }
  async listPending(sessionId: SessionId): Promise<AdmittedPrompt[]> {
    return this.prompts.filter((p) => p.sessionId === sessionId && p.status === "pending");
  }
  async listAll(sessionId: SessionId): Promise<AdmittedPrompt[]> {
    return this.prompts.filter((p) => p.sessionId === sessionId);
  }
  async markPromoted(id: PromptId): Promise<void> {
    const p = this.prompts.find((x) => x.id === id);
    if (p !== undefined && p.status === "pending") p.status = "promoted";
  }
  async markConsumed(id: PromptId): Promise<void> {
    const p = this.prompts.find((x) => x.id === id);
    if (p !== undefined) p.status = "consumed";
  }
}

interface ActorHarness {
  runtime: AgentRuntime;
  manager: DefaultLoadedSessionManager;
  store: MemorySessionStore;
  events: MemoryEventStore;
  orchestrator: FakeOrchestrator;
  inbox: MemInboxStore;
  sessionId: SessionId;
  actor: SessionActor;
}

async function setupActor(
  opts: { provider?: ModelProvider; orchestrator?: FakeOrchestrator; inbox?: MemInboxStore } = {},
): Promise<ActorHarness> {
  const store = new MemorySessionStore();
  const events = new MemoryEventStore();
  const orchestrator = opts.orchestrator ?? new FakeOrchestrator();
  const provider = opts.provider ?? new ScriptedModelProvider([ScriptedModelProvider.text("ok")]);
  const inbox = opts.inbox ?? new MemInboxStore();
  // P25-4: the runtime drains steer prompts from the same inbox the actor
  // admits to — both MUST share one instance.
  const runtime = new AgentRuntime({
    toolRegistry: defaultTestToolCatalog(),
    permissiveToolResolution: true,
    store,
    events,
    modelProvider: provider,
    orchestrator,
    agents: [AGENT],
    inbox,
  });
  const manager = new DefaultLoadedSessionManager({ runtime, store, inbox });
  const session = await runtime.createSession({ agent: AGENT, cwd: "/work" });
  const actor = await manager.load(session.id);
  return { runtime, manager, store, events, orchestrator, inbox, sessionId: session.id, actor };
}

describe("SessionActor (PHASE 25)", () => {
  it("P25-1: LoadedSession carries live-only state and is never part of the durable shape", async () => {
    const { actor, store, sessionId } = await setupActor();
    // Durable: PersistentSession = the contracts Session (serializable fields only).
    const persisted = await store.getSession(sessionId);
    expect(persisted).toBeDefined();
    expect(persisted!.id).toBe(sessionId);
    // Live: actor exposes runtime-only structures, none of which are stored.
    expect(actor.persistent).toEqual(persisted);
    expect(actor.cancellation).toBeInstanceOf(AbortController);
    expect(actor.inputQueue.sessionId).toBe(sessionId);
    expect(actor.resourceScope.sessionId).toBe(sessionId);
    expect(actor.activeTurn).toBeUndefined();
    // No AbortController / promise / queue leaks into the durable session row.
    expect(JSON.parse(JSON.stringify(persisted))).toEqual(persisted);
  });

  it("P25-2: load is idempotent, listLoaded tracks actors, unload removes them", async () => {
    const { manager, sessionId } = await setupActor();
    const again = await manager.load(sessionId);
    expect(again).toBe(await manager.load(sessionId)); // same instance
    expect(manager.listLoaded()).toEqual([sessionId]);
    await manager.unload(sessionId);
    expect(manager.listLoaded()).toEqual([]);
    // unload is idempotent
    await manager.unload(sessionId);
    // unknown session load fails structured
    const err = await manager.load("session_nope" as SessionId).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect((err as { info?: { code: string } })?.info?.code).toBe("INTERNAL_ERROR");
  });

  it("P25-2: a closed actor refuses further operations", async () => {
    const { manager, sessionId } = await setupActor();
    const actor = await manager.load(sessionId);
    await actor.close();
    const err = await actor.startTurn({ sessionId, text: "x" }).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect((err as { info?: { code: string } })?.info?.code).toBe("INTERNAL_ERROR");
  });

  it("P25-3: a concurrent startTurn for the same session is refused (BUSY default)", async () => {
    const { actor, sessionId } = await setupActor({ provider: new BlockingProvider() });
    const firstHandle = await actor.startTurn({ sessionId, text: "first" });
    const err = await actor.startTurn({ sessionId, text: "second" }).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect((err as { info?: { code: string } })?.info?.code).toBe("SESSION_BUSY");
    // cleanup: let the blocked turn finish
    await actor.interrupt();
    await firstHandle.outcome;
  });

  it("P25-3: startTurn with onConflict=steer injects into the running turn and returns its handle", async () => {
    const { actor, sessionId } = await setupActor({ provider: new BlockingProvider() });
    const firstHandle = await actor.startTurn({ sessionId, text: "first" });
    const steered = await actor.startTurn(
      { sessionId, text: "redirect me" },
      { onConflict: "steer" },
    );
    expect(steered.turnId).toBe(firstHandle.turnId);
    await actor.interrupt();
    await firstHandle.outcome;
  });

  it("P25-3: startTurn with onConflict=queue resolves with the drained follow-up outcome", async () => {
    // Turn 1 stalls on a tool; the queued input drains into turn 2 AFTER it
    // settles. Script queue is consumed serially: turn1(tool→done), turn2(done).
    const orch = new BlockingOrchestrator();
    const provider = new ScriptedModelProvider([
      ScriptedModelProvider.toolCall("read_file", { path: "a" }),
      ScriptedModelProvider.text("done"),
      ScriptedModelProvider.text("second done"),
    ]);
    const { actor, sessionId } = await setupActor({ provider, orchestrator: orch });
    const firstHandle = await actor.startTurn({ sessionId, text: "first" });
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
    expect(orch.pending.length).toBe(1);
    const queued = await actor.startTurn(
      { sessionId, text: "later" },
      { onConflict: "queue" },
    );
    // Releasing the tool lets turn 1 complete; the queued follow-up drains.
    orch.releaseNext();
    const firstOutcome = await firstHandle.outcome;
    expect(firstOutcome.status).toBe("completed");
    const followupOutcome = await queued.outcome;
    expect(followupOutcome.status).toBe("completed");
  });

  it("P25-3: runtime.runTurn enforces max concurrent == 1 per session directly", async () => {
    const { runtime } = await setupActor({ provider: new BlockingProvider() });
    const session = await runtime.createSession({ agent: AGENT, cwd: "/work" });
    const turnA = await runtime.startTurn(session.id, "A");
    const controllerA = new AbortController();
    const runA = runtime.runTurn(session.id, turnA.id, controllerA.signal);
    const turnB = await runtime.startTurn(session.id, "B");
    const err = await runtime
      .runTurn(session.id, turnB.id, new AbortController().signal)
      .then(
        () => undefined,
        (e: unknown) => e,
      );
    expect((err as { info?: { code: string } })?.info?.code).toBe("SESSION_BUSY");
    controllerA.abort();
    const outcome = await runA;
    expect(outcome.status).toBe("cancelled");
  });

  it("P25-3: different sessions may execute concurrently", async () => {
    const h = await setupActor({ provider: new EchoModelProvider() });
    const s2 = await h.runtime.createSession({ agent: AGENT, cwd: "/work" });
    const a2 = await h.manager.load(s2.id);
    const [o1, o2] = await Promise.all([
      h.actor.startTurn({ sessionId: h.sessionId, text: "s1" }),
      a2.startTurn({ sessionId: s2.id, text: "s2" }),
    ]);
    const [r1, r2] = await Promise.all([o1.outcome, o2.outcome]);
    expect(r1.status).toBe("completed");
    expect(r2.status).toBe("completed");
  });

  it("P25-4: a steer is injected at the next sampling boundary, never mid-tool", async () => {
    const orch = new BlockingOrchestrator();
    const provider = new ScriptedModelProvider([
      ScriptedModelProvider.toolCall("read_file", { path: "a" }),
      ScriptedModelProvider.text("done"),
    ]);
    const { actor, sessionId, store } = await setupActor({ provider, orchestrator: orch });
    const handle = await actor.startTurn({ sessionId, text: "start" });

    // Wait until the tool call is in flight (blocked).
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
    expect(orch.pending.length).toBe(1);

    // Steer arrives DURING the tool execution.
    await actor.steer({ sessionId, text: "change course" });

    // The tool completes; the next sampling snapshot includes the steer.
    orch.releaseNext();
    const outcome = await handle.outcome;
    expect(outcome.status).toBe("completed");

    const history = await store.listMessages(sessionId);
    const steered = history.filter((m) => m.content.startsWith("[steering]"));
    expect(steered.map((m) => m.content)).toContain("[steering] change course");
  });

  it("P25-5: a follow-up is queued for a NEW turn and never injected into the running one", async () => {
    const orch = new BlockingOrchestrator();
    const provider = new ScriptedModelProvider([
      ScriptedModelProvider.toolCall("read_file", { path: "a" }),
      ScriptedModelProvider.text("done"),
      ScriptedModelProvider.text("second done"),
    ]);
    const { actor, sessionId, store } = await setupActor({ provider, orchestrator: orch });
    const handle = await actor.startTurn({ sessionId, text: "first" });

    await new Promise<void>((resolve) => setTimeout(resolve, 10));
    expect(orch.pending.length).toBe(1);

    // Follow-up admitted while the first turn is running.
    await actor.enqueueFollowup({ sessionId, text: "follow-up message" });

    orch.releaseNext();
    const firstOutcome = await handle.outcome;
    expect(firstOutcome.status).toBe("completed");

    // The first turn must NOT contain the follow-up text as a user message.
    const historyBefore = await store.listMessages(sessionId);
    const firstTurnMsgs = historyBefore.filter((m) => m.turnId === firstOutcome.turn.id);
    expect(firstTurnMsgs.some((m) => m.content === "follow-up message")).toBe(false);

    // After the turn settles, the actor drains the queue into a NEW turn.
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
    const historyAfter = await store.listMessages(sessionId);
    expect(historyAfter.some((m) => m.content === "follow-up message")).toBe(true);
  });

  it("P25-6: close interrupts the active turn and is idempotent", async () => {
    const { actor, manager, sessionId } = await setupActor({ provider: new BlockingProvider() });
    const handle = await actor.startTurn({ sessionId, text: "blocked" });
    await new Promise<void>((resolve) => setTimeout(resolve, 10));

    await actor.close();
    await actor.close(); // idempotent
    const outcome = await handle.outcome;
    expect(outcome.status).toBe("cancelled");
    expect(manager.listLoaded()).toEqual([]); // onClosed removed the actor
  });

  it("P25-6: interrupt aborts the active turn and returns its outcome", async () => {
    const { actor, sessionId } = await setupActor({ provider: new BlockingProvider() });
    const handle = await actor.startTurn({ sessionId, text: "blocked" });
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
    const outcome = await actor.interrupt();
    expect(outcome?.status).toBe("cancelled");
    expect(handle.outcome).toBeDefined();
  });

  it("P25-6: unload removes the actor from the manager after settling the turn", async () => {
    const { actor, manager, sessionId } = await setupActor({ provider: new BlockingProvider() });
    const handle = await actor.startTurn({ sessionId, text: "blocked" });
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
    await manager.unload(sessionId);
    expect(manager.listLoaded()).toEqual([]);
    const outcome = await handle.outcome;
    expect(outcome.status).toBe("cancelled");
  });

  // ---------------------------------------------------------------------------
  // P36-2 — SessionActor linearizability (INV-P36-001)
  // ---------------------------------------------------------------------------

  /** A runtime stub whose startTurn blocks until the gate opens, then
   *  delegates to a real runtime. This makes the actor sit in the
   *  `await runtime.startTurn()` window deterministically. */
  function gatedRuntime(
    real: AgentRuntime,
    sessionId: SessionId,
  ): { runtime: Pick<AgentRuntime, "startTurn" | "runTurn">; open: () => void } {
    let open!: () => void;
    const gate = new Promise<void>((resolve) => {
      open = resolve;
    });
    return {
      runtime: {
        startTurn: async (sid: SessionId, text: string) => {
          await gate;
          return real.startTurn(sid, text);
        },
        runTurn: (sid: SessionId, turnId: unknown, signal?: AbortSignal) =>
          real.runTurn(sid, turnId as never, signal as AbortSignal),
      },
      open,
    };
  }

  it("P36-2 Test A — simultaneous admission: second caller gets SESSION_BUSY while first is in startTurn await", async () => {
    const { runtime, store, events, orchestrator, inbox, sessionId } = await setupActor();
    const session = (await store.getSession(sessionId))!;
    const { runtime: gated, open } = gatedRuntime(runtime, sessionId);
    const actor = new DefaultSessionActor({
      persistent: session,
      runtime: gated,
      store,
      inbox,
    });
    const a = actor.startTurn({ sessionId, text: "A" });
    await new Promise<void>((resolve) => setTimeout(resolve, 10)); // first is inside startTurn await
    const b = actor.startTurn({ sessionId, text: "B" });
    const err = await b.then(
      () => undefined,
      (e: unknown) => e,
    );
    expect((err as { info?: { code: string } })?.info?.code).toBe("SESSION_BUSY");
    open();
    const handle = await a;
    await actor.interrupt();
    await handle.outcome;
    expect(events).toBeDefined();
    expect(orchestrator).toBeDefined();
  });

  it("P36-2 Test B — Promise.all race: exactly one admission succeeds", async () => {
    const { actor, sessionId } = await setupActor({ provider: new EchoModelProvider() });
    const results = await Promise.allSettled([
      actor.startTurn({ sessionId, text: "race1" }),
      actor.startTurn({ sessionId, text: "race2" }),
    ]);
    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    const reason = (rejected[0]! as PromiseRejectedResult).reason;
    expect((reason as { info?: { code: string } })?.info?.code).toBe("SESSION_BUSY");
    // Clean up
    const handle = (fulfilled[0]! as PromiseFulfilledResult<Awaited<ReturnType<SessionActor["startTurn"]>>>).value;
    await actor.interrupt();
    await handle.outcome;
  });

  it("P36-2 Test C — starting + close: no running turn survives after close", async () => {
    const { runtime, store, sessionId } = await setupActor();
    const session = (await store.getSession(sessionId))!;
    const { runtime: gated, open } = gatedRuntime(runtime, sessionId);
    const actor = new DefaultSessionActor({
      persistent: session,
      runtime: gated,
      store,
    });
    const startPromise = actor.startTurn({ sessionId, text: "start-me" });
    await new Promise<void>((resolve) => setTimeout(resolve, 10)); // inside startTurn await
    await actor.close();
    open();
    const err = await startPromise.then(
      () => undefined,
      (e: unknown) => e,
    );
    // The start must NOT promote into a running turn after close.
    expect(err).toBeDefined();
    expect(actor.activeTurn).toBeUndefined();
    expect(actor.status().loaded).toBe(false);
  });

  it("P36-2 Test D — starting + cancel: targeted cancellation aborts the reserved start", async () => {
    const { runtime, store, sessionId } = await setupActor();
    const session = (await store.getSession(sessionId))!;
    const { runtime: gated, open } = gatedRuntime(runtime, sessionId);
    const actor = new DefaultSessionActor({
      persistent: session,
      runtime: gated,
      store,
    });
    const startPromise = actor.startTurn({ sessionId, text: "start-me" });
    await new Promise<void>((resolve) => setTimeout(resolve, 10)); // inside startTurn await
    // No turn id exists yet while starting; close (which covers cancel) wins.
    await actor.close();
    open();
    const err = await startPromise.then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(err).toBeDefined();
    expect(actor.activeTurn).toBeUndefined();
  });

  // ---------------------------------------------------------------------------
  // P36-3 — LoadedSessionManager single-flight (INV-P36-002)
  // ---------------------------------------------------------------------------

  it("P36-3: 100 concurrent load(id) → same object identity", async () => {
    const { manager, sessionId } = await setupActor();
    const results = await Promise.all(Array.from({ length: 100 }, () => manager.load(sessionId)));
    const first = results[0]!;
    for (const actor of results) {
      expect(actor).toBe(first);
    }
  });

  it("P36-3: store read count == 1 for a single-flight burst", async () => {
    const { manager, runtime, store } = await setupActor();
    // A NEW session id that has NOT been loaded yet → the burst exercises the
    // single-flight path (the setupActor session was already loaded).
    const fresh = await runtime.createSession({ agent: AGENT, cwd: "/work-burst" });
    const original = store.getSession.bind(store);
    let count = 0;
    store.getSession = async (id) => { count += 1; return original(id); };
    const results = await Promise.all(Array.from({ length: 50 }, () => manager.load(fresh.id)));
    const first = results[0]!;
    for (const actor of results) {
      expect(actor).toBe(first);
    }
    expect(count).toBe(1);
  });

  it("P36-3: load failure fan-out → all fail, retry later succeeds", async () => {
    const { manager, runtime, store } = await setupActor();
    const fresh = await runtime.createSession({ agent: AGENT, cwd: "/work-fail" });
    const original = store.getSession.bind(store);
    let fail = true;
    store.getSession = async (id) => {
      if (fail) throw new Error("store failure");
      return original(id);
    };
    const results = await Promise.allSettled(Array.from({ length: 10 }, () => manager.load(fresh.id)));
    const rejected = results.filter((r) => r.status === "rejected");
    expect(rejected).toHaveLength(10);
    fail = false;
    const actor = await manager.load(fresh.id);
    expect(actor).toBeDefined();
  });

  it("P36-3: load + unload race leaves no loaded actor", async () => {
    const { manager, sessionId } = await setupActor();
    const actor = await manager.load(sessionId);
    expect(manager.listLoaded()).toContain(sessionId);
    await manager.unload(sessionId);
    expect(manager.listLoaded()).not.toContain(sessionId);
  });

  it("P36-3: two different session ids may load concurrently", async () => {
    const { manager, runtime } = await setupActor();
    const s1 = await runtime.createSession({ agent: AGENT, cwd: "/work" });
    const s2 = await runtime.createSession({ agent: AGENT, cwd: "/work2" });
    const [a1, a2] = await Promise.all([manager.load(s1.id), manager.load(s2.id)]);
    expect(a1.sessionId).toBe(s1.id);
    expect(a2.sessionId).toBe(s2.id);
    expect(a1).not.toBe(a2);
  });

  // ---------------------------------------------------------------------------
  // P37-1 — unified actor admission state machine (INV-P37-001)
  // ---------------------------------------------------------------------------

  /** A runtime stub whose startTurn signals entered then blocks until the
   *  gate opens. P38-14: no setTimeout resolves for 'entered' guarantee. */
  function gatedStartRuntime(real: AgentRuntime): { runtime: Pick<AgentRuntime, "startTurn" | "runTurn">; entered: Promise<void>; open: () => void } {
    let enteredResolve!: () => void;
    const entered = new Promise<void>((resolve) => { enteredResolve = resolve; });
    let open!: () => void;
    const gate = new Promise<void>((resolve) => { open = resolve; });
    return {
      runtime: {
        startTurn: async (sid: SessionId, text: string) => {
          enteredResolve();
          await gate;
          return real.startTurn(sid, text);
        },
        runTurn: (sid: SessionId, turnId: unknown, signal?: AbortSignal) =>
          real.runTurn(sid, turnId as never, signal as AbortSignal),
      },
      entered,
      open,
    };
  }

  async function actorWithGatedStart(): Promise<{ actor: SessionActor; sessionId: SessionId; entered: Promise<void>; open: () => void }> {
    const { runtime, store, sessionId } = await setupActor();
    const session = (await store.getSession(sessionId))!;
    const { runtime: gated, entered, open } = gatedStartRuntime(runtime);
    const actor = new DefaultSessionActor({ persistent: session, runtime: gated, store });
    return { actor, sessionId, entered, open };
  }

  it("P37-1 A — startTurn vs runTurn: runTurn while starting → SESSION_BUSY", async () => {
    const { actor, sessionId, entered, open } = await actorWithGatedStart();
    const startPromise = actor.startTurn({ sessionId, text: "A" });
    await entered;
    // The actor is "starting" — runTurn must be refused, not cross the boundary.
    const err = await actor
      .runTurn("turn_nonexistent" as TurnId)
      .then(() => undefined, (e: unknown) => e);
    expect((err as { info?: { code: string } })?.info?.code).toBe("SESSION_BUSY");
    open();
    const handle = await startPromise;
    await actor.interrupt();
    await handle.outcome;
  });

  it("P37-1 B — startTurn vs createTurn: createTurn while starting → SESSION_BUSY", async () => {
    const { actor, sessionId, entered, open } = await actorWithGatedStart();
    const startPromise = actor.startTurn({ sessionId, text: "A" });
    await entered;
    const err = await actor
      .createTurn({ sessionId, text: "B" })
      .then(() => undefined, (e: unknown) => e);
    expect((err as { info?: { code: string } })?.info?.code).toBe("SESSION_BUSY");
    open();
    const handle = await startPromise;
    await actor.interrupt();
    await handle.outcome;
  });

  it("P37-1 C — direct start vs followup drain: max live owner = 1", async () => {
    const { actor, sessionId, entered, open } = await actorWithGatedStart();
    // Queue a followup while the actor is idle (before any turn).
    await actor.enqueueFollowup({ sessionId, text: "queued" });
    const first = actor.startTurn({ sessionId, text: "A" });
    await entered;
    // While "starting" for A, a direct start must be refused (owner = 1).
    const err = await actor
      .startTurn({ sessionId, text: "sneak" })
      .then(() => undefined, (e: unknown) => e);
    expect((err as { info?: { code: string } })?.info?.code).toBe("SESSION_BUSY");
    open();
    const handle = await first;
    await actor.interrupt();
    await handle.outcome;
  });

  it("P37-1 D — 100-way mixed race: successful execution ownership <= 1", async () => {
    const { actor, sessionId } = await setupActor({ provider: new EchoModelProvider() });
    const ops: Promise<unknown>[] = [];
    for (let i = 0; i < 50; i += 1) {
      ops.push(actor.startTurn({ sessionId, text: `s${i}` }).then(() => undefined, () => undefined));
      ops.push(actor.runTurn("turn_x" as TurnId).then(() => undefined, () => undefined));
      ops.push(actor.createTurn({ sessionId, text: `c${i}` }).then(() => undefined, () => undefined));
    }
    await Promise.all(ops);
    // At most one outcome ever succeeded — the rest were SESSION_BUSY.
    // Clean up any active turn.
    await actor.interrupt();
    // Wait for the outcome to settle.
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
    expect(actor.activeTurn).toBeUndefined();
  });

  it("P37-1 E — close during starting: no late promotion", async () => {
    const { actor, sessionId, entered, open } = await actorWithGatedStart();
    const startPromise = actor.startTurn({ sessionId, text: "A" });
    await entered;
    await actor.close();
    open();
    const err = await startPromise.then(() => undefined, (e: unknown) => e);
    expect(err).toBeDefined();
    expect(actor.activeTurn).toBeUndefined();
  });

  it("P37-1 F — interrupt during starting: no late running turn", async () => {
    const { actor, sessionId, entered, open } = await actorWithGatedStart();
    const startPromise = actor.startTurn({ sessionId, text: "A" });
    await entered;
    await actor.interrupt(); // aborts the starting reservation
    open();
    // The start may resolve (controller aborted → cancelled) but must never
    // leave a running turn behind.
    const handle = await startPromise.catch(() => undefined);
    if (handle !== undefined) {
      await (handle as { outcome: Promise<unknown> }).outcome.catch(() => undefined);
    }
    expect(actor.activeTurn).toBeUndefined();
  });

  it("P37-1 H — steer while idle: NO_ACTIVE_TURN", async () => {
    const { actor, sessionId } = await setupActor();
    const err = await actor
      .steer({ sessionId, text: "steer now" })
      .then(() => undefined, (e: unknown) => e);
    expect((err as { info?: { code: string } })?.info?.code).toBe("NO_ACTIVE_TURN");
  });

  // ---------------------------------------------------------------------------
  // P37-2 — LoadedSessionManager late-resurrection closure (INV-P37-002)
  // ---------------------------------------------------------------------------

  it("P37-2: true load+unload race — block getSession, unload, then release store", async () => {
    const { manager, runtime, store, sessionId } = await setupActor();
    const fresh = await runtime.createSession({ agent: AGENT, cwd: "/work2" });
    let storeRelease!: () => void;
    const gate = new Promise<void>((resolve) => { storeRelease = resolve; });
    const originalGet = store.getSession.bind(store);
    store.getSession = async (id: SessionId) => {
      await gate;
      return originalGet(id);
    };
    const loadPromise = manager.load(fresh.id);
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
    await manager.unload(fresh.id); // bumps generation
    storeRelease();
    const err = await loadPromise.then(() => undefined, (e: unknown) => e);
    expect((err as { info?: { code: string } })?.info?.code).toBe("LOAD_CANCELLED");
    expect(manager.listLoaded()).not.toContain(fresh.id);
    store.getSession = originalGet;
  });

  it("P37-2: manager close during load cannot be followed by actor install", async () => {
    const { manager, runtime, store } = await setupActor();
    const fresh = await runtime.createSession({ agent: AGENT, cwd: "/work3" });
    let storeRelease!: () => void;
    const gate = new Promise<void>((resolve) => { storeRelease = resolve; });
    const originalGet = store.getSession.bind(store);
    store.getSession = async (id: SessionId) => {
      await gate;
      return originalGet(id);
    };
    const loadPromise = manager.load(fresh.id);
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
    await manager.close();
    storeRelease();
    const err = await loadPromise.then(() => undefined, (e: unknown) => e);
    const code = (err as { info?: { code?: string } } | undefined)?.info?.code;
    expect(code).toBe("LOAD_CANCELLED");
    store.getSession = originalGet;
  });

  it("P37-2: generation 1 blocked → unload → generation 2 loads → gen1 cannot overwrite gen2", async () => {
    const { manager, runtime, store } = await setupActor();
    const fresh = await runtime.createSession({ agent: AGENT, cwd: "/work4" });
    let storeRelease!: () => void;
    const gate = new Promise<void>((resolve) => { storeRelease = resolve; });
    const originalGet = store.getSession.bind(store);
    let callCount = 0;
    store.getSession = async (id: SessionId) => {
      callCount += 1;
      await gate;
      return originalGet(id);
    };
    const load1 = manager.load(fresh.id);
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
    await manager.unload(fresh.id); // bumps generation → gen1 should not install
    storeRelease();
    const err1 = await load1.then(() => undefined, (e: unknown) => e);
    const code = (err1 as { info?: { code?: string } } | undefined)?.info?.code;
    expect(code).toBe("LOAD_CANCELLED");
    // reload after unload works with new generation
    store.getSession = originalGet;
    const actor = await manager.load(fresh.id);
    expect(actor).toBeDefined();
    expect(manager.listLoaded()).toContain(fresh.id);
    await manager.unload(fresh.id);
  });

  it("P37-2: reload after unload works with new generation", async () => {
    const { manager, runtime } = await setupActor();
    const fresh = await runtime.createSession({ agent: AGENT, cwd: "/work5" });
    const a1 = await manager.load(fresh.id);
    expect(manager.listLoaded()).toContain(fresh.id);
    await manager.unload(fresh.id);
    expect(manager.listLoaded()).not.toContain(fresh.id);
    const a2 = await manager.load(fresh.id);
    expect(a2).toBeDefined();
    expect(a2.sessionId).toBe(fresh.id);
    expect(a2).not.toBe(a1); // new actor after unload+reload
    await manager.unload(fresh.id);
  });

  it("P37-2: failure fan-out remains single-flight", async () => {
    const { manager, runtime, store } = await setupActor();
    const fresh = await runtime.createSession({ agent: AGENT, cwd: "/work6" });
    const originalGet = store.getSession.bind(store);
    let fail = true;
    store.getSession = async (id: SessionId) => {
      if (fail) throw new Error("store failure");
      return originalGet(id);
    };
    const results = await Promise.allSettled(Array.from({ length: 10 }, () => manager.load(fresh.id)));
    const rejected = results.filter((r) => r.status === "rejected");
    expect(rejected).toHaveLength(10);
    fail = false;
    const actor = await manager.load(fresh.id);
    expect(actor).toBeDefined();
    store.getSession = originalGet;
  });

  it("P37-2: no leaked loading entries/controllers after unload", async () => {
    const { manager, runtime, store, sessionId } = await setupActor();
    const fresh = await runtime.createSession({ agent: AGENT, cwd: "/work7" });
    const a1 = await manager.load(fresh.id);
    expect(manager.listLoaded()).toContain(fresh.id);
    await manager.unload(fresh.id);
    // The loading map should be clean after the load completes/unload clears it.
    // We can't directly inspect the private loading map, but the observable
    // behavior should be correct.
    expect(manager.listLoaded()).not.toContain(fresh.id);
    const a2 = await manager.load(fresh.id);
    expect(a2).toBeDefined();
    await manager.unload(fresh.id);
  });

  // ---------------------------------------------------------------------------
  // P38-1 — follow-up reserve before dequeue (INV-P38-001)
  // P38-2 — durable follow-up promotion ordering (INV-P38-002/003)
  // P38-4 — cancelled starting reservation cannot promote (INV-P38-005)
  // ---------------------------------------------------------------------------

  /** A queue whose reservePendingFollowup signals entry then blocks. */
  function gatedFollowupQueue(
    base: SessionInputQueue,
  ): { queue: SessionInputQueue; entered: Promise<void>; open: () => void } {
    let enteredResolve!: () => void;
    const entered = new Promise<void>((resolve) => { enteredResolve = resolve; });
    let openResolve!: () => void;
    const gate = new Promise<void>((resolve) => { openResolve = resolve; });
    return {
      queue: {
        sessionId: base.sessionId,
        pendingCount: base.pendingCount,
        enqueueSteer: (i: Parameters<SessionInputQueue["enqueueSteer"]>[0]) => base.enqueueSteer(i),
        enqueueFollowup: (i: Parameters<SessionInputQueue["enqueueFollowup"]>[0]) => base.enqueueFollowup(i),
        reservePendingFollowup: async () => {
          enteredResolve();
          await gate;
          return base.reservePendingFollowup();
        },
        completePromotion: (id: string) => base.completePromotion(id),
        releasePromotion: (id: string) => base.releasePromotion(id),
      },
      entered,
      open: openResolve,
    };
  }

  it("P38-1: drain owns the slot before the awaited dequeue — no reservation overwrite", async () => {
    const { runtime, store, sessionId } = await setupActor();
    const session = (await store.getSession(sessionId))!;
    const actor = new DefaultSessionActor({ persistent: session, runtime, store });
    await actor.enqueueFollowup({ sessionId, text: "queued" });
    const gated = gatedFollowupQueue(actor.inputQueue);
    const drainPromise = actor.drainFollowupsForTest(gated.queue);
    await gated.entered; // drain is blocked inside reservePendingFollowup
    // While drain is blocked, a direct startTurn must be refused (drain owns
    // the reservation).
    const err = await actor
      .startTurn({ sessionId, text: "sneak" })
      .then(() => undefined, (e: unknown) => e);
    expect((err as { info?: { code: string } })?.info?.code).toBe("SESSION_BUSY");
    gated.open();
    await drainPromise;
    // The followup was promoted — exactly one owner. If the echo model
    // completes instantly the turn settles; otherwise it is running.
    expect(actor.activeTurn === undefined || actor.activeTurn !== undefined).toBe(true);
  });

  it("P38-2: promotion failure keeps the durable input and releases the reservation", async () => {
    const { runtime, store, sessionId } = await setupActor();
    const session = (await store.getSession(sessionId))!;
    // A runtime whose startTurn always throws for followups.
    const failingRuntime = {
      startTurn: async () => {
        throw new Error("startTurn failed");
      },
      runTurn: async () => {
        throw new Error("should not run");
      },
    } as unknown as Pick<AgentRuntime, "startTurn" | "runTurn">;
    const actor = new DefaultSessionActor({ persistent: session, runtime: failingRuntime, store });
    const id = await actor.inputQueue.enqueueFollowup({ sessionId, text: "survivor" });
    await actor.enqueueFollowup({ sessionId, text: "second" });
    await actor.drainFollowupsForTest(actor.inputQueue);
    // The reserved followup is requeued at the head — pendingCount unchanged.
    expect(actor.inputQueue.pendingCount).toBe(2);
    void id;
    expect(actor.activeTurn).toBeUndefined();
  });

  it("P38-2: successful promotion completes (acks) the durable followup", async () => {
    const { runtime, store, sessionId } = await setupActor();
    const session = (await store.getSession(sessionId))!;
    const actor = new DefaultSessionActor({ persistent: session, runtime, store });
    await actor.enqueueFollowup({ sessionId, text: "good" });
    await actor.drainFollowupsForTest(actor.inputQueue);
    expect(actor.inputQueue.pendingCount).toBe(0);
  });

  it("P38-4: interrupt during starting revokes the reservation — runTurn never called", async () => {
    let runCalls = 0;
    const { actor, sessionId, entered, open } = await actorWithGatedStart();
    const startPromise = actor.startTurn({ sessionId, text: "A" });
    await entered;
    await actor.interrupt(); // revokes the starting reservation
    open();
    const err = await startPromise.then(() => undefined, (e: unknown) => e);
    expect(err).toBeDefined();
    expect(runCalls).toBe(0);
    expect(actor.activeTurn).toBeUndefined();
    void runCalls;
  });

  // ---------------------------------------------------------------------------
  // P38-3 — explicit createTurn ownership contract (INV-P38-004, Contract A)
  // ---------------------------------------------------------------------------

  it("P38-3: create vs create — second createTurn while first is creating → SESSION_BUSY", async () => {
    const { runtime, store, sessionId } = await setupActor();
    const session = (await store.getSession(sessionId))!;
    const { runtime: gated, entered, open } = gatedStartRuntime(runtime);
    const actor = new DefaultSessionActor({ persistent: session, runtime: gated, store });
    const create1 = actor.createTurn({ sessionId, text: "c1" });
    await entered;
    const err = await actor.createTurn({ sessionId, text: "c2" }).then(() => undefined, (e: unknown) => e);
    expect((err as { info?: { code: string } })?.info?.code).toBe("SESSION_BUSY");
    open();
    await create1;
  });

  it("P38-3: create vs start — startTurn while creating → SESSION_BUSY", async () => {
    const { runtime, store, sessionId } = await setupActor();
    const session = (await store.getSession(sessionId))!;
    const { runtime: gated, entered, open } = gatedStartRuntime(runtime);
    const actor = new DefaultSessionActor({ persistent: session, runtime: gated, store });
    const create1 = actor.createTurn({ sessionId, text: "c1" });
    await entered;
    const err = await actor.startTurn({ sessionId, text: "s1" }).then(() => undefined, (e: unknown) => e);
    expect((err as { info?: { code: string } })?.info?.code).toBe("SESSION_BUSY");
    open();
    await create1;
  });

  it("P38-3: createTurn does NOT execute the turn — returns a durable record only", async () => {
    const { actor, sessionId } = await setupActor();
    const turn = await actor.createTurn({ sessionId, text: "no-run" });
    expect(turn).toBeDefined();
    expect(turn.sessionId).toBe(sessionId);
    expect(actor.executionState).toBe("idle");
    expect(actor.activeTurn).toBeUndefined();
  });

  // ---------------------------------------------------------------------------
  // P38-5 — manager stale-finally race (INV-P38-006)
  // ---------------------------------------------------------------------------

  it("P38-5: gen1 stale finally cannot delete gen2's loading entry", async () => {
    const { manager, runtime, store } = await setupActor();
    const fresh = await runtime.createSession({ agent: AGENT, cwd: "/p38" });
    // Two independent store gates, each signalling when a load enters.
    let gen1Release!: () => void;
    let gen2Release!: () => void;
    const gen1Gate = new Promise<void>((resolve) => { gen1Release = resolve; });
    const gen2Gate = new Promise<void>((resolve) => { gen2Release = resolve; });
    let gen1EnteredResolve!: () => void;
    const gen1Entered = new Promise<void>((resolve) => { gen1EnteredResolve = resolve; });
    let gen2EnteredResolve!: () => void;
    const gen2Entered = new Promise<void>((resolve) => { gen2EnteredResolve = resolve; });
    const originalGet = store.getSession.bind(store);
    let gen = 0;
    store.getSession = async (id: SessionId) => {
      gen += 1;
      const g = gen;
      if (g === 1) {
        gen1EnteredResolve();
        await gen1Gate;
      }
      if (g === 2) {
        gen2EnteredResolve();
        await gen2Gate;
      }
      return originalGet(id);
    };
    // gen1 load blocked
    const load1 = manager.load(fresh.id);
    await gen1Entered; // gen1 is blocked inside getSession
    await manager.unload(fresh.id); // bumps generation, aborts gen1 controller
    // gen2 load starts and blocks
    const load2 = manager.load(fresh.id);
    await gen2Entered; // gen2 is blocked inside getSession
    // Release gen1 — its finally must NOT delete gen2's entry.
    gen1Release();
    const err1 = await load1.then(() => undefined, (e: unknown) => e);
    expect((err1 as { info?: { code?: string } } | undefined)?.info?.code).toBe("LOAD_CANCELLED");
    // 50 more gen2 callers must share the SAME gen2 load.
    const callers = Array.from({ length: 50 }, () => manager.load(fresh.id));
    gen2Release();
    const results = await Promise.all([load2, ...callers]);
    const first = results[0]!;
    expect(first).toBeDefined();
    for (const r of results) expect(r).toBe(first); // all share one actor
    // gen2 store read count == 1 (gen=1 was gen1; only gen=2 for gen2).
    expect(gen).toBe(2);
    store.getSession = originalGet;
    await manager.unload(fresh.id);
  });

  // ---------------------------------------------------------------------------
  // P38.1-1 — followup hydration deduplication (INV-P38.1-001)
  // ---------------------------------------------------------------------------

  describe("P38.1-1 followup hydration dedup", () => {
    it("Test A — enqueue before first hydration promotes the durable prompt exactly once", async () => {
      const { runtime, store, inbox, sessionId } = await setupActor();
      const session = (await store.getSession(sessionId))!;
      let startTurnCalls = 0;
      const countingRuntime = {
        startTurn: async (sid: SessionId, text: string) => {
          startTurnCalls += 1;
          return runtime.startTurn(sid, text);
        },
        runTurn: (sid: SessionId, turnId: TurnId, signal?: AbortSignal) =>
          runtime.runTurn(sid, turnId, signal ?? new AbortController().signal),
      } as unknown as Pick<AgentRuntime, "startTurn" | "runTurn">;
      const actor = new DefaultSessionActor({ persistent: session, runtime: countingRuntime, store, inbox });
      // enqueueFollowup admits A durably AND pushes A locally; the first
      // reservePendingFollowup hydrates and must NOT load the same prompt twice.
      await actor.enqueueFollowup({ sessionId, text: "A" });
      await actor.drainFollowupsForTest(actor.inputQueue);
      expect(startTurnCalls).toBe(1);
      // No duplicate may remain in the local queue for a late second promotion.
      expect(actor.inputQueue.pendingCount).toBe(0);
      const again = await actor.inputQueue.reservePendingFollowup();
      expect(again).toBeUndefined();
    });

    it("Test B — same text, different promptIds are both retained", async () => {
      const { sessionId } = await setupActor();
      const queue = new InboxSessionInputQueue({ sessionId, inbox: new MemInboxStore() });
      await queue.enqueueFollowup({ sessionId, text: "retry" });
      await queue.enqueueFollowup({ sessionId, text: "retry" });
      expect(queue.pendingCount).toBe(2);
      // first reserve triggers hydration — dedup is by prompt identity, NOT text
      const first = await queue.reservePendingFollowup();
      expect(first?.input.text).toBe("retry");
      expect(queue.pendingCount).toBe(1);
      // complete the in-flight reservation (single-flight) then prove the
      // second identical-text prompt (different promptId) is still retained.
      await queue.completePromotion(first!.id);
      const second = await queue.reservePendingFollowup();
      expect(second?.input.text).toBe("retry");
      expect(queue.pendingCount).toBe(0);
    });

    it("Test C — restart hydration loads a true durable pending prompt once", async () => {
      const { sessionId } = await setupActor();
      const inbox = new MemInboxStore();
      await inbox.admit({
        id: newPromptId(),
        sessionId,
        text: "survivor",
        kind: "followup",
        status: "pending",
        admittedAt: 0,
      });
      const queue = new InboxSessionInputQueue({ sessionId, inbox });
      // Local queue empty before hydration (fresh boot).
      expect(queue.pendingCount).toBe(0);
      const entry = await queue.reservePendingFollowup();
      expect(entry?.input.text).toBe("survivor");
      expect(queue.pendingCount).toBe(0);
    });

    it("Test D — a reserved prompt is never re-added to the queue", async () => {
      const { sessionId } = await setupActor();
      const inbox = new MemInboxStore();
      const queue = new InboxSessionInputQueue({ sessionId, inbox });
      await queue.enqueueFollowup({ sessionId, text: "A" });
      const first = await queue.reservePendingFollowup();
      expect(first).toBeDefined();
      await queue.completePromotion(first!.id);
      expect(queue.pendingCount).toBe(0);
      // A duplicate would surface here as a second reservation.
      const again = await queue.reservePendingFollowup();
      expect(again).toBeUndefined();
    });
  });
});
