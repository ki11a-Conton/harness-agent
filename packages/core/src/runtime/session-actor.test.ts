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
} from "@ar/contracts";
import { newAgentId } from "@ar/contracts";
import { EchoModelProvider, ScriptedModelProvider } from "@ar/model";
import { AgentRuntime } from "./runtime.js";
import { DefaultLoadedSessionManager, type SessionActor } from "./session-actor.js";
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
});
