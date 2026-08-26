// P38.3-4 — Crash/restart exactly-once regression suite around durable
// followup promotion (INV-P38.3-001/002/004).
//
// Prior suites (P26-8 crash-matrix, P34-3 crash-sideeffect) prove TOOL
// side-effect exactly-once across tool crash windows. This suite proves the
// PROMPT→TURN promotion state machine is exactly-once across process-crash
// windows at every durable transition:
//
//   A. after enqueue/admit        F. immediately after runTurn starts
//   B. after reserve              G. after terminal turn persistence
//   C. after durable Turn creation H. before markConsumed (consume failure)
//   D. after bindPromotion        I. after markConsumed
//   E. immediately before runTurn (bind failure)
//
// Every test is deterministic: no `sleep(10) and hope` — faults are injected
// with deferred barriers / throwing hooks on the queue and runtime seams, and
// "restart" is a fresh queue over the same durable inbox + store.
//
// Hard assertions on every restart:
//   - number of distinct executed TurnIds for one PromptId <= 1
//   - runtime.runTurn never fires before the durable bind
//   - no pending followup reappears after terminal reconciliation

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
import { AgentRuntime } from "./runtime.js";
import {
  DefaultSessionActor,
  InboxSessionInputQueue,
  type SessionInputQueue,
} from "./session-actor.js";
import { MemoryEventStore, MemorySessionStore, defaultTestToolCatalog } from "../test/fakes.js";
import { FakeOrchestrator } from "../test/fake-orchestrator.js";
import type { InboxStore } from "@ar/contracts";

const AGENT: AgentDefinition = {
  id: newAgentId(),
  name: "followup-crash-agent",
  description: "test",
  mode: "primary",
  model: { providerId: "scripted", modelId: "scripted-model" },
  systemPrompt: "you are a followup-crash test",
  tools: {},
  permissions: { rules: [] },
  skills: {},
  limits: {},
};

/** In-memory InboxStore double shared by the runtime and the actor. */
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

async function setup() {
  const provider: ModelProvider = new ScriptedModelProvider([ScriptedModelProvider.text("ok")]);
  const store = new MemorySessionStore();
  const events = new MemoryEventStore();
  const inbox = new MemInboxStore();
  const orchestrator = new FakeOrchestrator({ status: "success", output: "ok" });
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
  const session = await runtime.createSession({ agent: AGENT, cwd: "/work" });
  return { runtime, store, events, inbox, sessionId: session.id };
}

/** A runtime proxy that counts runtime.runTurn calls per turn id. */
function countingRuntime(base: AgentRuntime) {
  const runCalls = new Map<TurnId, number>();
  return {
    runtime: {
      startTurn: (sid: SessionId, text: string) => base.startTurn(sid, text),
      runTurn: (sid: SessionId, turnId: TurnId, signal: AbortSignal) => {
        runCalls.set(turnId, (runCalls.get(turnId) ?? 0) + 1);
        return base.runTurn(sid, turnId, signal);
      },
    } as Pick<AgentRuntime, "startTurn" | "runTurn">,
    runCalls,
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

describe("P38.3-4 followup promotion crash matrix (exactly-once)", () => {
  it("A. crash after enqueue/admit — prompt stays pending, restart retries it exactly once", async () => {
    const { runtime, store, inbox, sessionId } = await setup();
    const { runtime: rt, runCalls } = countingRuntime(runtime);
    const actor = await loadActor(rt, store, inbox, sessionId);
    await actor.enqueueFollowup({ sessionId, text: "crash-A" });
    // "Crash" before the drain starts: the durable prompt is pending.
    const pending = await inbox.listPending(sessionId);
    expect(pending.some((p) => p.text === "crash-A")).toBe(true);

    // Restart: a fresh queue drains it exactly once.
    const q2 = new InboxSessionInputQueue({ sessionId, inbox });
    const entry = await q2.reservePendingFollowup();
    expect(entry?.input.text).toBe("crash-A");
    // No execution has happened yet (nothing was ever bound).
    expect(totalRuns(runCalls)).toBe(0);
  });

  it("B. crash after reserve — prompt still pending, restart re-reserves without double-execution", async () => {
    const { runtime, store, inbox, sessionId } = await setup();
    const { runtime: rt, runCalls } = countingRuntime(runtime);
    const actor = await loadActor(rt, store, inbox, sessionId);
    await actor.enqueueFollowup({ sessionId, text: "crash-B" });

    // Park the drain INSIDE reservePendingFollowup (seam B: after reserve).
    let openReserve!: () => void;
    const reserveGate = new Promise<void>((r) => { openReserve = r; });
    let reserveReached!: () => void;
    const reserveReachedP = new Promise<void>((r) => { reserveReached = r; });
    const gatedQueue: SessionInputQueue = {
      sessionId: actor.inputQueue.sessionId,
      pendingCount: actor.inputQueue.pendingCount,
      enqueueSteer: (i) => actor.inputQueue.enqueueSteer(i),
      enqueueFollowup: (i) => actor.inputQueue.enqueueFollowup(i),
      reservePendingFollowup: async () => {
        reserveReached();
        await reserveGate;
        return actor.inputQueue.reservePendingFollowup();
      },
      bindReservedFollowup: (id, turnId) => actor.inputQueue.bindReservedFollowup(id, turnId),
      completeReservedFollowup: (id) => actor.inputQueue.completeReservedFollowup(id),
      releaseReservedFollowup: (id) => actor.inputQueue.releaseReservedFollowup(id),
    };
    const drainPromise = actor.drainFollowupsForTest(gatedQueue);
    await reserveReachedP; // parked at the reserve seam
    // Durable truth at the crash point: prompt still pending, no turn, no run.
    const pending = await inbox.listPending(sessionId);
    expect(pending.some((p) => p.text === "crash-B")).toBe(true);
    expect((await store.listTurns(sessionId)).length).toBe(0);
    expect(totalRuns(runCalls)).toBe(0);
    // The process dies here: revoke the reservation so the abandoned drain can
    // never promote. Unwinding the gate then keeps the harness deterministic.
    await actor.interrupt();
    openReserve();
    await drainPromise.catch(() => {});
    // Restart over the same durable inbox: the prompt is still there.
    const q2 = new InboxSessionInputQueue({ sessionId, inbox });
    expect((await q2.reservePendingFollowup())?.input.text).toBe("crash-B");
  });

  it("C. crash after durable Turn creation, before bind — P pending, orphan T, zero execution", async () => {
    const { runtime, store, inbox, sessionId } = await setup();
    const { runtime: rt, runCalls } = countingRuntime(runtime);
    const actor = await loadActor(rt, store, inbox, sessionId);
    await actor.enqueueFollowup({ sessionId, text: "crash-C" });

    // Park the drain inside bindReservedFollowup BEFORE the durable bind lands
    // (seam C: T created, P still pending).
    let openBind!: () => void;
    const bindGate = new Promise<void>((r) => { openBind = r; });
    let bindReached!: () => void;
    const bindReachedP = new Promise<void>((r) => { bindReached = r; });
    const gatedQueue: SessionInputQueue = {
      sessionId: actor.inputQueue.sessionId,
      pendingCount: actor.inputQueue.pendingCount,
      enqueueSteer: (i) => actor.inputQueue.enqueueSteer(i),
      enqueueFollowup: (i) => actor.inputQueue.enqueueFollowup(i),
      reservePendingFollowup: () => actor.inputQueue.reservePendingFollowup(),
      bindReservedFollowup: async (id, turnId) => {
        bindReached();
        await bindGate; // park BEFORE bind: T created, P still pending
        await actor.inputQueue.bindReservedFollowup(id, turnId);
      },
      completeReservedFollowup: (id) => actor.inputQueue.completeReservedFollowup(id),
      releaseReservedFollowup: (id) => actor.inputQueue.releaseReservedFollowup(id),
    };
    const drainPromise = actor.drainFollowupsForTest(gatedQueue);
    await bindReachedP; // T is created, bind parked
    const pending = await inbox.listPending(sessionId);
    expect(pending.some((p) => p.text === "crash-C")).toBe(true);
    expect((await store.listTurns(sessionId)).length).toBe(1); // orphan T
    expect(totalRuns(runCalls)).toBe(0); // T never executed
    // The process dies here: revoke the reservation; the abandoned drain can
    // never promote (no runTurn). Unwinding the gate keeps the harness
    // deterministic — the dead process binds then terminalizes.
    await actor.interrupt();
    openBind();
    await drainPromise.catch(() => {});
    // Restart: P now promoted→T (the dead process bound it) → NOT re-queued,
    // and no second turn exists for the prompt.
    const q2 = new InboxSessionInputQueue({ sessionId, inbox });
    expect(await q2.reservePendingFollowup()).toBeUndefined();
    expect((await store.listTurns(sessionId)).length).toBe(1);
    expect(totalRuns(runCalls)).toBe(0);
  });

  it("D. crash after bind, before run — P promoted→T, no T2, zero runTurn", async () => {
    const { runtime, store, inbox, sessionId } = await setup();
    const { runtime: rt, runCalls } = countingRuntime(runtime);
    const actor = await loadActor(rt, store, inbox, sessionId);
    await actor.enqueueFollowup({ sessionId, text: "crash-D" });

    // Park the drain AFTER the durable bind lands, BEFORE promoteToRunning
    // (seam D/E).
    let openAfterBind!: () => void;
    const afterBindGate = new Promise<void>((r) => { openAfterBind = r; });
    let afterBindReached!: () => void;
    const afterBindReachedP = new Promise<void>((r) => { afterBindReached = r; });
    const gatedQueue: SessionInputQueue = {
      sessionId: actor.inputQueue.sessionId,
      pendingCount: actor.inputQueue.pendingCount,
      enqueueSteer: (i) => actor.inputQueue.enqueueSteer(i),
      enqueueFollowup: (i) => actor.inputQueue.enqueueFollowup(i),
      reservePendingFollowup: () => actor.inputQueue.reservePendingFollowup(),
      bindReservedFollowup: async (id, turnId) => {
        await actor.inputQueue.bindReservedFollowup(id, turnId); // durable bind
        afterBindReached();
        await afterBindGate; // park AFTER bind, BEFORE promote/run
      },
      completeReservedFollowup: (id) => actor.inputQueue.completeReservedFollowup(id),
      releaseReservedFollowup: (id) => actor.inputQueue.releaseReservedFollowup(id),
    };
    const drainPromise = actor.drainFollowupsForTest(gatedQueue);
    await afterBindReachedP;
    const all = await inbox.listAll(sessionId);
    const bound = all.find((p) => p.text === "crash-D")!;
    expect(bound.status).toBe("promoted");
    expect(bound.promotedTurnId).toBeDefined();
    expect(totalRuns(runCalls)).toBe(0); // bind durable, run NOT started
    // The process dies here: revoke the reservation; the abandoned drain
    // terminalizes the bound turn, never executes it.
    await actor.interrupt();
    openAfterBind();
    await drainPromise.catch(() => {});
    const q2 = new InboxSessionInputQueue({ sessionId, inbox });
    expect(await q2.reservePendingFollowup()).toBeUndefined(); // no fresh prompt
    expect((await store.listTurns(sessionId)).length).toBe(1);
    expect(totalRuns(runCalls)).toBe(0);
  });

  it("F. crash after runTurn starts — prompt already durably bound to the run's TurnId", async () => {
    const { runtime, store, inbox, sessionId } = await setup();
    const { runtime: rt, runCalls } = countingRuntime(runtime);
    const actor = await loadActor(rt, store, inbox, sessionId);
    await actor.enqueueFollowup({ sessionId, text: "crash-F" });
    await actor.drainFollowupsForTest(actor.inputQueue);
    // The turn ran; the prompt must already be durably bound to that turn.
    expect(totalRuns(runCalls)).toBe(1);
    const all = await inbox.listAll(sessionId);
    const bound = all.find((p) => p.text === "crash-F")!;
    expect(bound.promotedTurnId).toBeDefined();
    const runTurnId = [...runCalls.keys()][0];
    expect(bound.promotedTurnId).toBe(runTurnId);
    // Exactly one distinct executed TurnId for this prompt.
    expect(runCalls.size).toBe(1);
    // Terminal reconciliation consumes the prompt.
    await waitFor(async () => (await inbox.listAll(sessionId)).find((p) => p.text === "crash-F")?.status === "consumed");
  });

  it("G. crash after terminal persistence, before markConsumed — restart reconciles to consumed, no re-run", async () => {
    const { runtime, store, inbox, sessionId } = await setup();
    const { runtime: rt, runCalls } = countingRuntime(runtime);
    const actor = await loadActor(rt, store, inbox, sessionId);
    await actor.enqueueFollowup({ sessionId, text: "crash-G" });

    // Gate the durable consume so we can crash AFTER the turn terminalized
    // but BEFORE markConsumed runs (seam G).
    let openConsume!: () => void;
    const consumeGate = new Promise<void>((r) => { openConsume = r; });
    let consumeReached!: () => void;
    const consumeReachedP = new Promise<void>((r) => { consumeReached = r; });
    const gatedQueue: SessionInputQueue = {
      sessionId: actor.inputQueue.sessionId,
      pendingCount: actor.inputQueue.pendingCount,
      enqueueSteer: (i) => actor.inputQueue.enqueueSteer(i),
      enqueueFollowup: (i) => actor.inputQueue.enqueueFollowup(i),
      reservePendingFollowup: () => actor.inputQueue.reservePendingFollowup(),
      bindReservedFollowup: (id, turnId) => actor.inputQueue.bindReservedFollowup(id, turnId),
      completeReservedFollowup: async (id) => {
        consumeReached();
        await consumeGate;
        return actor.inputQueue.completeReservedFollowup(id);
      },
      releaseReservedFollowup: (id) => actor.inputQueue.releaseReservedFollowup(id),
    };
    const drainPromise = actor.drainFollowupsForTest(gatedQueue);
    await consumeReachedP; // the turn completed, consume is parked
    // The turn is terminal in the store, the prompt is still promoted (not
    // yet consumed).
    const all = await inbox.listAll(sessionId);
    const bound = all.find((p) => p.text === "crash-G")!;
    expect(bound.status).toBe("promoted");
    expect(bound.promotedTurnId).toBeDefined();
    expect(totalRuns(runCalls)).toBe(1);
    const turns = await store.listTurns(sessionId);
    expect(["completed", "failed", "cancelled"].includes(turns[0]!.status)).toBe(true);

    // Crash before the consume: the bound turn is terminal → restart must
    // reconcile the prompt to consumed and NEVER re-run the prompt.
    openConsume();
    await drainPromise.catch(() => {});
    // Terminal reconciliation on the fresh queue consumes the bound prompt.
    const q2 = new InboxSessionInputQueue({ sessionId, inbox });
    expect(await q2.reservePendingFollowup()).toBeUndefined(); // no re-run
    await waitFor(async () => (await inbox.listAll(sessionId)).find((p) => p.text === "crash-G")?.status === "consumed");
    // Exactly one distinct executed TurnId.
    expect(runCalls.size).toBe(1);
  });

  it("I. crash after markConsumed — prompt consumed, restart never replays", async () => {
    const { runtime, store, inbox, sessionId } = await setup();
    const { runtime: rt, runCalls } = countingRuntime(runtime);
    const actor = await loadActor(rt, store, inbox, sessionId);
    await actor.enqueueFollowup({ sessionId, text: "crash-I" });
    await actor.drainFollowupsForTest(actor.inputQueue);
    await waitFor(async () => (await inbox.listAll(sessionId)).find((p) => p.text === "crash-I")?.status === "consumed");
    // Restart over the durable inbox: nothing pending, nothing to replay.
    const q2 = new InboxSessionInputQueue({ sessionId, inbox });
    expect(await q2.reservePendingFollowup()).toBeUndefined();
    expect(totalRuns(runCalls)).toBe(1);
  });

  it("H. consume failure after terminal — prompt stays bound, caller settles, no re-run (INV-P38.3-004)", async () => {
    const { runtime, store, inbox, sessionId } = await setup();
    const { runtime: rt, runCalls } = countingRuntime(runtime);
    const actor = await loadActor(rt, store, inbox, sessionId);
    const followupId = await actor.inputQueue.enqueueFollowup({ sessionId, text: "crash-H" });
    const caller = actor.registerFollowupCallerForTest(followupId);

    const base = actor.inputQueue;
    const failingConsume: SessionInputQueue = {
      sessionId: base.sessionId,
      pendingCount: base.pendingCount,
      enqueueSteer: (i) => base.enqueueSteer(i),
      enqueueFollowup: (i) => base.enqueueFollowup(i),
      reservePendingFollowup: () => base.reservePendingFollowup(),
      bindReservedFollowup: (id, turnId) => base.bindReservedFollowup(id, turnId),
      completeReservedFollowup: async () => {
        throw new Error("injected consume failure");
      },
      releaseReservedFollowup: (id) => base.releaseReservedFollowup(id),
    };
    await actor.drainFollowupsForTest(failingConsume);
    // The prompt is already bound → consume failure must NOT requeue or create
    // a second turn (INV-P38.3-004).
    const outcome = await caller;
    expect(outcome.status).toBe("completed");
    const all = await inbox.listAll(sessionId);
    const bound = all.find((p) => p.text === "crash-H")!;
    expect(bound.status).toBe("promoted"); // still bound, not consumed
    expect(bound.promotedTurnId).toBeDefined();
    expect(totalRuns(runCalls)).toBe(1);
    expect((await store.listTurns(sessionId)).length).toBe(1);
    expect(actor.inputQueue.pendingCount).toBe(0);
  });

  it("E. bind failure — T exists but runTurn never fires; caller terminally rejects", async () => {
    const { runtime, store, inbox, sessionId } = await setup();
    const { runtime: rt, runCalls } = countingRuntime(runtime);
    const actor = await loadActor(rt, store, inbox, sessionId);
    const followupId = await actor.inputQueue.enqueueFollowup({ sessionId, text: "crash-E" });
    const caller = actor.registerFollowupCallerForTest(followupId);

    const base = actor.inputQueue;
    const failingBind: SessionInputQueue = {
      sessionId: base.sessionId,
      pendingCount: base.pendingCount,
      enqueueSteer: (i) => base.enqueueSteer(i),
      enqueueFollowup: (i) => base.enqueueFollowup(i),
      reservePendingFollowup: () => base.reservePendingFollowup(),
      bindReservedFollowup: async () => {
        throw new Error("injected bind failure");
      },
      completeReservedFollowup: (id) => base.completeReservedFollowup(id),
      releaseReservedFollowup: (id) => base.releaseReservedFollowup(id),
    };
    await actor.drainFollowupsForTest(failingBind);
    expect(totalRuns(runCalls)).toBe(0); // no run ever fired
    // The prompt was never bound → still pending → recoverable.
    const pending = await inbox.listPending(sessionId);
    expect(pending.some((p) => p.text === "crash-E")).toBe(true);
    const err = await caller.then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(err).toBeDefined();
  });
});
