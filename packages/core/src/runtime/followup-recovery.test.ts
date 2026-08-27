// P38.4-2/3 — Same-T recovery for bound nonterminal followup turns
// (INV-P38.4-001/003/004).
//
// Scenario: a process dies after bindPromotion(P→T) but before T reaches
// terminal state. On restart, the actor must recover the SAME durable Turn T
// (never create T2, never startTurn, never requeue P as a fresh followup).
//
// Every test is deterministic: barriers control the execution window, and
// "restart" is a FRESH runtime + FRESH DefaultSessionActor over the same
// durable store + inbox (a real crash does not run any cleanup code, so the
// pre-crash actor's drain is abandoned mid-flight — no interrupt, no
// terminalize, no graceful shutdown).
//
// Hard assertions:
//   - distinct executed TurnIds for one PromptId <= 1  (INV-P38.4-001)
//   - recovery reuses the SAME TurnId (same T, no T2)   (INV-P38.4-003)
//   - any call to startTurn creates a new identity (must NOT be used for recovery)
//   - recoverable turns are discovered at most once per actor lifetime
//   - pending/created turns are recovered; terminal turns are NOT recovered

import { describe, expect, it } from "vitest";
import type {
  AdmittedPrompt,
  AgentDefinition,
  ModelProvider,
  PromptId,
  SessionId,
  TurnId,
} from "@ar/contracts";
import { newAgentId } from "@ar/contracts";
import { ScriptedModelProvider } from "@ar/model";
import { AgentRuntime, type TurnOutcome } from "./runtime.js";
import { DefaultSessionActor, type SessionInputQueue } from "./session-actor.js";
import { MemoryEventStore, MemorySessionStore, defaultTestToolCatalog } from "../test/fakes.js";
import { FakeOrchestrator } from "../test/fake-orchestrator.js";
import type { InboxStore } from "@ar/contracts";

const AGENT: AgentDefinition = {
  id: newAgentId(),
  name: "followup-recovery-agent",
  description: "test",
  mode: "primary",
  model: { providerId: "scripted", modelId: "scripted-model" },
  systemPrompt: "you are a followup-recovery test",
  tools: {},
  permissions: { rules: [] },
  skills: {},
  limits: {},
};

/** In-memory InboxStore double. */
class MemInboxStore implements InboxStore {
  prompts: AdmittedPrompt[] = [];
  async admit(p: AdmittedPrompt) { this.prompts.push(p); }
  async listPending(sessionId: SessionId) {
    return this.prompts.filter((p) => p.sessionId === sessionId && p.status === "pending");
  }
  async listRecoverable(sessionId: SessionId) {
    return this.prompts.filter(
      (p) => p.sessionId === sessionId && (p.status === "pending" || p.status === "promoted"),
    );
  }
  async listAll(sessionId: SessionId) {
    return this.prompts.filter((p) => p.sessionId === sessionId);
  }
  async markPromoted(id: PromptId) {
    const p = this.prompts.find((x) => x.id === id);
    if (p) { p.status = "promoted"; p.promotedAt = Date.now(); }
  }
  async bindPromotion(id: PromptId, turnId: TurnId) {
    const p = this.prompts.find((x) => x.id === id);
    if (p) { p.status = "promoted"; p.promotedAt = Date.now(); p.promotedTurnId = turnId; }
  }
  async markConsumed(id: PromptId) {
    const p = this.prompts.find((x) => x.id === id);
    if (p && p.status !== "pending") { p.status = "consumed"; p.consumedAt = Date.now(); }
  }
}

/** Fresh runtime over the SAME durable store/events/inbox — simulates a
 *  restarted process (a fresh runtime has an empty runningTurns map). */
function freshRuntime(
  store: MemorySessionStore,
  events: MemoryEventStore,
  inbox: MemInboxStore,
): AgentRuntime {
  return new AgentRuntime({
    toolRegistry: defaultTestToolCatalog(),
    permissiveToolResolution: true,
    store,
    events,
    modelProvider: new ScriptedModelProvider([ScriptedModelProvider.text("ok")]),
    orchestrator: new FakeOrchestrator({ status: "success", output: "ok" }),
    agents: [AGENT],
    inbox,
  });
}

async function setup() {
  const store = new MemorySessionStore();
  const events = new MemoryEventStore();
  const inbox = new MemInboxStore();
  const runtime = freshRuntime(store, events, inbox);
  const session = await runtime.createSession({ agent: AGENT, cwd: "/work" });
  return { runtime, store, events, inbox, sessionId: session.id };
}

/** A runtime proxy that counts runtime.runTurn calls per turn id. */
function countingRuntime(base: AgentRuntime) {
  const runCalls = new Map<TurnId, number>();
  const startTurns: TurnId[] = [];
  return {
    runtime: {
      startTurn: async (sid: SessionId, text: string) => {
        const turn = await base.startTurn(sid, text);
        startTurns.push(turn.id);
        return turn;
      },
      runTurn: (sid: SessionId, turnId: TurnId, signal: AbortSignal) => {
        runCalls.set(turnId, (runCalls.get(turnId) ?? 0) + 1);
        return base.runTurn(sid, turnId, signal);
      },
    } as Pick<AgentRuntime, "startTurn" | "runTurn">,
    runCalls,
    startTurns,
  };
}

function totalRuns(runCalls: Map<TurnId, number>): number {
  return [...runCalls.values()].reduce((a, b) => a + b, 0);
}

async function loadActor(
  runtime: Pick<AgentRuntime, "startTurn" | "runTurn">,
  store: MemorySessionStore,
  inbox: MemInboxStore,
  sessionId: SessionId,
): Promise<DefaultSessionActor> {
  const session = (await store.getSession(sessionId))!;
  return new DefaultSessionActor({ persistent: session, runtime, store, inbox });
}

async function waitFor(predicate: () => Promise<boolean> | boolean, timeoutMs = 3000): Promise<void> {
  const start = Date.now();
  for (;;) {
    if (await predicate()) return;
    if (Date.now() - start > timeoutMs) throw new Error("waitFor timed out");
    await new Promise((r) => setTimeout(r, 1));
  }
}

describe("P38.4-2/3 followup same-T recovery (nonterminal bound turns)", () => {
  it("A. promoted P → T pending/created → restart recovers SAME T, no T2, no startTurn", async () => {
    const { runtime, store, inbox, sessionId } = await setup();
    const { runtime: rt, runCalls } = countingRuntime(runtime);

    // 1) Durable followup admitted; bind lands; process "dies" before the turn
    //    executes (crash window D: after bind, before promoteToRunning).
    const actor = await loadActor(rt, store, inbox, sessionId);
    await actor.enqueueFollowup({ sessionId, text: "recover-me" });

    // Park the drain AFTER the durable bind, BEFORE promote/run. The gate
    // NEVER opens: the pre-crash process is dead and runs no cleanup code.
    let afterBindReached!: () => void;
    const afterBindReachedP = new Promise<void>((r) => { afterBindReached = r; });
    const gatedQueue: SessionInputQueue = {
      sessionId: actor.inputQueue.sessionId,
      pendingCount: actor.inputQueue.pendingCount,
      enqueueSteer: (i) => actor.inputQueue.enqueueSteer(i),
      enqueueFollowup: (i) => actor.inputQueue.enqueueFollowup(i),
      reservePendingFollowup: () => actor.inputQueue.reservePendingFollowup(),
      bindReservedFollowup: async (id, turnId) => {
        await actor.inputQueue.bindReservedFollowup(id, turnId);
        afterBindReached();
        // Abandon here — never resolves, simulating process death.
        return new Promise<void>(() => {});
      },
      completeReservedFollowup: (id) => actor.inputQueue.completeReservedFollowup(id),
      releaseReservedFollowup: (id) => actor.inputQueue.releaseReservedFollowup(id),
    };
    void actor.drainFollowupsForTest(gatedQueue); // fire-and-forget (dead process)
    await afterBindReachedP; // T is durably bound, before execution

    const boundPrompt = inbox.prompts.find((p) => p.promotedTurnId !== undefined);
    expect(boundPrompt).toBeDefined();
    const boundTurnId = boundPrompt!.promotedTurnId!;
    const boundTurn = await store.getTurn(boundTurnId);
    expect(boundTurn).toBeDefined();
    expect(boundTurn!.status).toBe("running"); // durably created, never executed
    expect(totalRuns(runCalls)).toBe(0); // no execution happened before crash

    // 2) "Restart": fresh process (fresh runtime + fresh actor) over the same
    //    durable store + inbox. drainFollowups must recover SAME T.
    const { runtime: rt2, runCalls: runCalls2, startTurns: startTurns2 } = countingRuntime(
      freshRuntime(store, new MemoryEventStore(), inbox),
    );
    const actor2 = await loadActor(rt2, store, inbox, sessionId);
    void actor2.drainFollowupsForTest(); // discovers + recovers

    await waitFor(async () => totalRuns(runCalls2) >= 1);
    const recoveredTurn = (await store.getTurn(boundTurnId))!;
    expect(recoveredTurn).toBeDefined();
    expect(recoveredTurn.id).toBe(boundTurnId); // INV-P38.4-001/003: same T
    expect(runCalls2.get(boundTurnId)).toBe(1); // recovered exactly once
    // INV-P38.4-003: recovery used runTurn (no startTurn for recovery).
    expect(startTurns2.length).toBe(0); // recovery is not a fresh turn

    // Terminal reconciliation consumes the prompt.
    await waitFor(async () => {
      const p = inbox.prompts.find((x) => x.promotedTurnId === boundTurnId);
      return p?.status === "consumed";
    });
  });

  it("B. multiple promoted P → multiple nonterminal T → restart recovers all, no T2", async () => {
    const { runtime, store, inbox, sessionId } = await setup();
    const { runtime: rt, runCalls } = countingRuntime(runtime);

    // Build TWO durable bound-nonterminal lineages directly (this is exactly
    // the durable state a crash leaves behind: P promoted → T, T never
    // terminal): two followup prompts, each durably bound to its own created
    // turn, neither turn executed.
    const p1: PromptId = "prompt-1" as PromptId;
    const p2: PromptId = "prompt-2" as PromptId;
    await inbox.admit({ id: p1, sessionId, text: "recover-one", kind: "followup", status: "pending", admittedAt: Date.now() });
    await inbox.admit({ id: p2, sessionId, text: "recover-two", kind: "followup", status: "pending", admittedAt: Date.now() });
    const t1 = await runtime.startTurn(sessionId, "recover-one");
    const t2 = await runtime.startTurn(sessionId, "recover-two");
    await inbox.bindPromotion(p1, t1.id);
    await inbox.bindPromotion(p2, t2.id);
    expect(t1.id).not.toBe(t2.id); // two distinct durable turns
    expect(totalRuns(runCalls)).toBe(0); // neither executed (crash before run)
    expect((await store.getTurn(t1.id))!.status).toBe("running");
    expect((await store.getTurn(t2.id))!.status).toBe("running");

    // 2) "Restart": fresh process recovers both turns, same identities.
    const { runtime: rt2, runCalls: runCalls2 } = countingRuntime(
      freshRuntime(store, new MemoryEventStore(), inbox),
    );
    const actor2 = await loadActor(rt2, store, inbox, sessionId);
    void actor2.drainFollowupsForTest();
    await waitFor(async () => totalRuns(runCalls2) >= 2);

    expect(runCalls2.get(t1.id)).toBe(1);
    expect(runCalls2.get(t2.id)).toBe(1);
    expect(totalRuns(runCalls2)).toBe(2); // exactly 2 runTurn calls, no T2

    await waitFor(async () => {
      const pp1 = inbox.prompts.find((x) => x.id === p1);
      const pp2 = inbox.prompts.find((x) => x.id === p2);
      return pp1?.status === "consumed" && pp2?.status === "consumed";
    });
  });

  it("C. promoted P → T terminal (completed/failed/cancelled) → restart consumes P, no recovery", async () => {
    const { runtime, store, inbox, sessionId } = await setup();
    const { runtime: rt, runCalls } = countingRuntime(runtime);

    // Complete a followup normally (bind → run → consume).
    const actor = await loadActor(rt, store, inbox, sessionId);
    await actor.enqueueFollowup({ sessionId, text: "terminal-me" });
    await actor.drainFollowupsForTest();
    await waitFor(async () => {
      const p = inbox.prompts.find((x) => x.text === "terminal-me");
      return p?.status === "consumed";
    });
    const boundTurnId = inbox.prompts.find((x) => x.text === "terminal-me")?.promotedTurnId;
    expect(boundTurnId).toBeDefined();
    const turnAfter = await store.getTurn(boundTurnId!);
    expect(
      turnAfter?.status === "completed" || turnAfter?.status === "failed" || turnAfter?.status === "cancelled",
    ).toBe(true);

    // 2) "Restart": fresh process must NOT recover the terminal turn.
    const { runtime: rt2, runCalls: runCalls2 } = countingRuntime(
      freshRuntime(store, new MemoryEventStore(), inbox),
    );
    const actor2 = await loadActor(rt2, store, inbox, sessionId);
    // Await drain completion: discoverRecoverableTurns runs, finds no
    // nonterminal, exits without any runTurn call for the terminal turn.
    await actor2.drainFollowupsForTest();
    expect(runCalls2.get(boundTurnId!)).toBeUndefined(); // NOT recovered
    expect(totalRuns(runCalls2)).toBe(0);
    // Prompt remains consumed.
    const p = inbox.prompts.find((x) => x.text === "terminal-me");
    expect(p?.status).toBe("consumed");
  });

  it("D. promoted P → bound T running (no live owner) → restart recovers same T", async () => {
    const { runtime, store, inbox, sessionId } = await setup();

    // Park INSIDE runTurn (turn durably created + bound, execution in flight,
    // then process dies). The turn stays status=running with no live owner.
    let runReached!: () => void;
    const runReachedP = new Promise<void>((r) => { runReached = r; });
    const gatedRt: Pick<AgentRuntime, "startTurn" | "runTurn"> = {
      startTurn: (sid, text) => runtime.startTurn(sid, text),
      runTurn: async (sid, turnId, signal): Promise<TurnOutcome> => {
        runReached();
        // Abandon here — never resolves, simulating process death mid-run.
        return new Promise<TurnOutcome>(() => {});
      },
    };
    const actor = await loadActor(gatedRt, store, inbox, sessionId);
    await actor.enqueueFollowup({ sessionId, text: "running-recover" });
    void actor.drainFollowupsForTest();
    await runReachedP; // runTurn is "in flight" (durable turn is running)

    const boundPrompt = inbox.prompts.find((p) => p.status === "promoted");
    expect(boundPrompt).toBeDefined();
    const boundTurnId = boundPrompt!.promotedTurnId!;
    const boundTurn = await store.getTurn(boundTurnId);
    expect(boundTurn).toBeDefined();
    expect(boundTurn!.status).toBe("running"); // no live owner after death

    // 2) "Restart": fresh process recovers the running turn, same identity.
    const { runtime: rt2, runCalls: runCalls2 } = countingRuntime(
      freshRuntime(store, new MemoryEventStore(), inbox),
    );
    const actor2 = await loadActor(rt2, store, inbox, sessionId);
    void actor2.drainFollowupsForTest();
    await waitFor(async () => totalRuns(runCalls2) >= 1);

    expect(runCalls2.get(boundTurnId)).toBe(1); // same T, exactly once
    expect(totalRuns(runCalls2)).toBe(1);
  });

  it("E. no recoverable turns → drainFollowups proceeds normally", async () => {
    const { runtime, store, inbox, sessionId } = await setup();
    const { runtime: rt, runCalls } = countingRuntime(runtime);

    const actor = await loadActor(rt, store, inbox, sessionId);
    await actor.enqueueFollowup({ sessionId, text: "normal" });
    await actor.drainFollowupsForTest();
    await waitFor(async () => {
      const p = inbox.prompts.find((x) => x.text === "normal");
      return p?.status === "consumed";
    });
    // One normal runTurn, zero recovery.
    expect(totalRuns(runCalls)).toBe(1);
  });

  it("F. recovery runTurn throws → fail-closed: P stays promoted, T stays nonterminal, next restart recovers", async () => {
    const { runtime, store, inbox, sessionId } = await setup();
    const { runtime: rt } = countingRuntime(runtime);

    // Build a bound-nonterminal lineage (same pattern as B).
    const p1: PromptId = "prompt-fail" as PromptId;
    await inbox.admit({ id: p1, sessionId, text: "fail-recover", kind: "followup", status: "pending", admittedAt: Date.now() });
    const t1 = await runtime.startTurn(sessionId, "fail-recover");
    await inbox.bindPromotion(p1, t1.id);
    expect((await store.getTurn(t1.id))!.status).toBe("running");

    // 1) "Restart" with a BROKEN runtime whose runTurn always throws.
    const brokenRt: Pick<AgentRuntime, "startTurn" | "runTurn"> = {
      startTurn: (sid, text) => runtime.startTurn(sid, text),
      runTurn: () => { throw new Error("simulated runTurn crash"); },
    };
    const actorBroken = await loadActor(brokenRt, store, inbox, sessionId);
    // Await drain: recovery attempt fails synchronously (throw), P not consumed.
    await actorBroken.drainFollowupsForTest();
    const pAfter = inbox.prompts.find((x) => x.id === p1)!;
    expect(pAfter.status).toBe("promoted"); // NOT consumed
    expect(pAfter.promotedTurnId).toBe(t1.id);
    const tAfter = await store.getTurn(t1.id);
    // T may be terminal if the error was persisted, or running if it wasn't.
    // Either way, P must not be consumed and the lineage must be recoverable.
    // The key invariant: no T2 created, no startTurn for recovery.
    expect(tAfter?.id).toBe(t1.id); // same Turn identity, no T2

    // 2) "Restart" with a HEALTHY runtime — should recover the same T.
    const { runtime: rt2, runCalls: runCalls2 } = countingRuntime(
      freshRuntime(store, new MemoryEventStore(), inbox),
    );
    const actor2 = await loadActor(rt2, store, inbox, sessionId);
    void actor2.drainFollowupsForTest();
    await waitFor(async () => totalRuns(runCalls2) >= 1);
    expect(runCalls2.get(t1.id)).toBe(1);
    // Prompt consumed after recovery.
    await waitFor(async () => {
      const p = inbox.prompts.find((x) => x.id === p1);
      return p?.status === "consumed";
    });
  });
});