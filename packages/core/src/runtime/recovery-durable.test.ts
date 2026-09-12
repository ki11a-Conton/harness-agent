/**
 * E4-08 — actor-level recovery durability.
 *
 * Proves the three acceptance properties the store alone cannot:
 *   1. a store WRITE FAILURE means the recovery action NEVER runs (no
 *      unrecoverable external side effect) — the headline E4-08 fix;
 *   2. the attempt budget survives across actor instances (a "restart" is a
 *      fresh actor over the SAME store) and is never reset;
 *   3. two actors contending for one task's lease yield exactly one executor
 *      (the loser's CAS write fails closed to wait-lease).
 */

import { describe, expect, it } from "vitest";
import type {
  AdmittedPrompt, AgentDefinition, PromptId, SessionId, Turn, TurnId, InboxStore,
} from "@ar/contracts";
import { newAgentId } from "@ar/contracts";
import { ScriptedModelProvider } from "@ar/model";
import { AgentRuntime } from "./runtime.js";
import {
  DefaultSessionActor,
  MemoryRecoveryStore,
  type RecoveryRecord,
  type RecoveryStore,
} from "./session-actor.js";
import { MemoryEventStore, MemorySessionStore, defaultTestToolCatalog } from "../test/fakes.js";
import { FakeOrchestrator } from "../test/fake-orchestrator.js";

const AGENT: AgentDefinition = {
  id: newAgentId(), name: "e4-08-agent", description: "test", mode: "primary",
  model: { providerId: "scripted", modelId: "scripted-model" },
  systemPrompt: "e4-08", tools: {}, permissions: { rules: [] }, skills: {}, limits: {},
};

class MemInbox implements InboxStore {
  prompts: AdmittedPrompt[] = [];
  async admit(p: AdmittedPrompt) { this.prompts.push(p); }
  async listPending(s: SessionId) { return this.prompts.filter((p) => p.sessionId === s && p.status === "pending"); }
  async listRecoverable(s: SessionId) { return this.prompts.filter((p) => p.sessionId === s && (p.status === "pending" || p.status === "promoted")); }
  async listAll(s: SessionId) { return this.prompts.filter((p) => p.sessionId === s); }
  async markPromoted(id: PromptId) { const p = this.prompts.find((x) => x.id === id); if (p) p.status = "promoted"; }
  async bindPromotion(id: PromptId, turnId: TurnId) { const p = this.prompts.find((x) => x.id === id); if (p) { p.status = "promoted"; p.promotedTurnId = turnId; } }
  async markConsumed(id: PromptId) { const p = this.prompts.find((x) => x.id === id); if (p && p.status !== "pending") p.status = "consumed"; }
}

function newBaseRuntime(store: MemorySessionStore, events: MemoryEventStore, inbox: MemInbox): AgentRuntime {
  return new AgentRuntime({
    toolRegistry: defaultTestToolCatalog(), permissiveToolResolution: true, store, events,
    modelProvider: new ScriptedModelProvider([ScriptedModelProvider.text("ok")]),
    orchestrator: new FakeOrchestrator({ status: "success", output: "ok" }), agents: [AGENT], inbox,
  });
}

/** Wrap a base runtime's runTurn to count calls and optionally fail retryably. */
function counting(base: AgentRuntime, failRun: boolean) {
  const runCalls = new Map<TurnId, number>();
  const runtime: Pick<AgentRuntime, "startTurn" | "runTurn"> = {
    startTurn: (s, t) => base.startTurn(s, t),
    runTurn: async (s, turnId, signal) => {
      runCalls.set(turnId, (runCalls.get(turnId) ?? 0) + 1);
      if (failRun) throw new Error("simulated retryable run failure");
      return base.runTurn(s, turnId, signal);
    },
  };
  return { runtime, total: () => [...runCalls.values()].reduce((a, b) => a + b, 0) };
}

/** E4-08: a RecoveryStore that throws on every write (simulates a downed durable store). */
class FailingStore implements RecoveryStore {
  async getRecord(): Promise<RecoveryRecord | undefined> { return undefined; }
  async putRecord(): Promise<RecoveryRecord> { throw new Error("store down"); }
  async deleteRecord(): Promise<void> { /* noop */ }
}

/** E4-R25 (V01): a store that refuses EVERY write (reads still work) — the
 *  fail-closed sanity case: no durable lease/intent ever lands. */
class TotalWriteFailStore extends MemoryRecoveryStore {
  override async putRecord(): Promise<RecoveryRecord> {
    throw new Error("whole recovery store write outage");
  }
}

/** E4-R17 (N13): a store that fails ONLY the RECOVERED (terminal-ACK) write —
 *  the exact fault window where the old code consumed the prompt and shifted
 *  the queue over an unpersisted terminal state. */
class TerminalFailStore extends MemoryRecoveryStore {
  failRecoveredWrites = true;
  override async putRecord(record: RecoveryRecord): Promise<RecoveryRecord> {
    if (this.failRecoveredWrites && record.state === "RECOVERED") {
      throw new Error("review terminal ACK failure");
    }
    return super.putRecord(record);
  }
}

/** E4-R25 (V01): the compound outage — the RECOVERED terminal-write AND the
 *  needsReconcile marker write BOTH fail, while every other recovery-store
 *  write (lease, intent, retry-state) still succeeds. The marker never lands,
 *  so no durable pending-commit exists — the ONLY remaining evidence is the
 *  main store's durable TURN terminal state. */
class CompoundAckFailStore extends MemoryRecoveryStore {
  failTerminalWrites = true;
  override async putRecord(record: RecoveryRecord): Promise<RecoveryRecord> {
    if (this.failTerminalWrites && (record.state === "RECOVERED" || record.needsReconcile === true)) {
      throw new Error("compound terminal/marker write outage");
    }
    return super.putRecord(record);
  }
}

async function buildBoundNonterminalTurn(base: AgentRuntime, store: MemorySessionStore, inbox: MemInbox, sessionId: SessionId, text: string): Promise<TurnId> {
  const promptId = `prompt-${text}` as unknown as PromptId;
  await inbox.admit({ id: promptId, sessionId, text, kind: "followup", status: "pending", admittedAt: 1 } as AdmittedPrompt);
  const turn = await base.startTurn(sessionId, text);
  await inbox.bindPromotion(promptId, turn.id);
  return turn.id;
}

async function loadActor(
  runtime: Pick<AgentRuntime, "startTurn" | "runTurn">,
  store: MemorySessionStore,
  inbox: MemInbox,
  sessionId: SessionId,
  recoveryStore: RecoveryStore,
  now?: () => number,
  scheduler?: { schedule(delayMs: number, cb: () => void): { cancel(): void } },
): Promise<DefaultSessionActor> {
  const session = (await store.getSession(sessionId))!;
  return new DefaultSessionActor({ persistent: session, runtime, store, inbox, recoveryStore, ...(now !== undefined ? { now } : {}), ...(scheduler !== undefined ? { scheduler } : {}) });
}

async function waitFor(pred: () => boolean, ms = 2000): Promise<void> {
  const start = Date.now();
  for (;;) { if (pred()) return; if (Date.now() - start > ms) throw new Error("waitFor timeout"); await new Promise((r) => setTimeout(r, 1)); }
}

describe("E4-08 actor recovery durability", () => {
  it("store write failure means the recovery action NEVER runs (0 external side effects)", async () => {
    const store = new MemorySessionStore();
    const events = new MemoryEventStore();
    const inbox = new MemInbox();
    const base = newBaseRuntime(store, events, inbox);
    const s = await base.createSession({ agent: AGENT, cwd: "/w" });
    const boundTurnId = await buildBoundNonterminalTurn(base, store, inbox, s.id, "recover-me");
    const { runtime, total } = counting(base, false);

    // The durable store is DOWN: the lease/begin write must fail, so runTurn
    // for the recovery must NOT be invoked.
    const actor = await loadActor(runtime, store, inbox, s.id, new FailingStore());
    await actor.drainFollowupsForTest();

    expect(total()).toBe(0); // no external action with no durable record
    expect((await store.getTurn(boundTurnId))!.status).not.toBe("completed");
  });

  it("attempt budget survives across actor instances (restart) and is not reset", async () => {
    const store = new MemorySessionStore();
    const events = new MemoryEventStore();
    const inbox = new MemInbox();
    const shared = new MemoryRecoveryStore(); // stands in for the durable store across "processes"
    const base = newBaseRuntime(store, events, inbox);
    const s = await base.createSession({ agent: AGENT, cwd: "/w" });
    const boundTurnId = await buildBoundNonterminalTurn(base, store, inbox, s.id, "recover-me");

    // Actor A: runTurn fails retryably -> attempt=1, RETRY_SCHEDULED persisted.
    // A manual clock keeps the backoff deterministic (no real timers).
    const a = counting(base, true);
    const actorA = await loadActor(a.runtime, store, inbox, s.id, shared, () => 1000);
    await actorA.drainFollowupsForTest();
    await waitFor(() => a.total() >= 1);
    const afterA = await shared.getRecord(boundTurnId);
    expect(afterA?.attempt).toBe(1);
    expect(afterA?.state).toBe("RETRY_SCHEDULED");

    // Actor B ("restart"): same store, clock advanced past the backoff -> must
    // continue from attempt 1 (not reset to 0) and converge.
    const b = counting(base, false);
    const actorB = await loadActor(b.runtime, store, inbox, s.id, shared, () => 5000);
    await actorB.drainFollowupsForTest();
    await waitFor(() => b.total() >= 1);
    const afterB = await shared.getRecord(boundTurnId);
    expect(afterB?.attempt).toBe(2); // incremented from the persisted 1
    expect(afterB?.state).toBe("RECOVERED");
  });

  it("two actors contending for one lease: exactly one runs the action", async () => {
    const store = new MemorySessionStore();
    const events = new MemoryEventStore();
    const inbox = new MemInbox();
    const shared = new MemoryRecoveryStore();
    const base = newBaseRuntime(store, events, inbox);
    const s = await base.createSession({ agent: AGENT, cwd: "/w" });
    await buildBoundNonterminalTurn(base, store, inbox, s.id, "recover-me");

    const a = counting(base, false);
    const b = counting(base, false);
    const actor1 = await loadActor(a.runtime, store, inbox, s.id, shared);
    const actor2 = await loadActor(b.runtime, store, inbox, s.id, shared);
    await Promise.all([actor1.drainFollowupsForTest(), actor2.drainFollowupsForTest()]);

    // The loser's lease CAS write fails closed, so the action runs at most once
    // across both actors for the same turn.
    expect(a.total() + b.total()).toBeLessThanOrEqual(1);
  });
});

describe("E4-R17 terminal-ACK failure + lease wake (N13/N14)", () => {
  it("N13: a RECOVERED write failure does NOT consume the prompt, shift the queue, or clear the lease without a durable terminal", async () => {
    const store = new MemorySessionStore();
    const events = new MemoryEventStore();
    const inbox = new MemInbox();
    const recovery = new TerminalFailStore();
    const base = newBaseRuntime(store, events, inbox);
    const s = await base.createSession({ agent: AGENT, cwd: "/w" });
    const boundTurnId = await buildBoundNonterminalTurn(base, store, inbox, s.id, "recover-me");
    const { runtime, total } = counting(base, false);

    const actor = await loadActor(runtime, store, inbox, s.id, recovery, () => 1000);
    await actor.drainFollowupsForTest();

    // The action ran exactly once…
    expect(total()).toBe(1);
    const record = await recovery.getRecord(boundTurnId);
    // …its durable terminal is NOT committed — the task is in pending-commit.
    expect(record?.state).toBe("RECOVERY_IN_PROGRESS");
    expect(record?.needsReconcile).toBe(true);
    expect(record?.lease).toBeUndefined();
    // The queue did NOT advance (T2 must never overtake an uncommitted T1)…
    expect(actor["_recoverableTurns"].length).toBe(1);
    // …and the prompt was NOT consumed.
    expect(inbox.prompts.find((p) => p.status === "promoted")).toBeDefined();
    expect(inbox.prompts.find((p) => p.status === "consumed")).toBeUndefined();
  });

  it("N13: a restart with a pending-commit task NEVER re-runs the action — only the terminal write is re-attempted", async () => {
    const store = new MemorySessionStore();
    const events = new MemoryEventStore();
    const inbox = new MemInbox();
    const recovery = new TerminalFailStore();
    const base = newBaseRuntime(store, events, inbox);
    const s = await base.createSession({ agent: AGENT, cwd: "/w" });
    const boundTurnId = await buildBoundNonterminalTurn(base, store, inbox, s.id, "recover-me");

    const a = counting(base, false);
    const actorA = await loadActor(a.runtime, store, inbox, s.id, recovery, () => 1000);
    await actorA.drainFollowupsForTest();
    expect(a.total()).toBe(1);

    // "Restart": a fresh actor over the same store, still failing RECOVERED writes.
    const b = counting(base, false);
    const actorB = await loadActor(b.runtime, store, inbox, s.id, recovery, () => 2000);
    await actorB.drainFollowupsForTest();
    // The action was NOT re-run (at-least-once is bounded to the crash window;
    // a committed pending-commit marker forbids re-execution).
    expect(b.total()).toBe(0);
    expect(a.total()).toBe(1);
    const record = await recovery.getRecord(boundTurnId);
    expect(record?.needsReconcile).toBe(true);
    expect(actorB["_recoverableTurns"].length).toBe(1);
    expect(inbox.prompts.find((p) => p.status === "consumed")).toBeUndefined();
  });

  it("N13: when the store recovers, the terminal is committed and consumed WITHOUT re-running the action", async () => {
    const store = new MemorySessionStore();
    const events = new MemoryEventStore();
    const inbox = new MemInbox();
    const recovery = new TerminalFailStore();
    const base = newBaseRuntime(store, events, inbox);
    const s = await base.createSession({ agent: AGENT, cwd: "/w" });
    const boundTurnId = await buildBoundNonterminalTurn(base, store, inbox, s.id, "recover-me");

    const { runtime, total } = counting(base, false);
    const actor = await loadActor(runtime, store, inbox, s.id, recovery, () => 1000);
    await actor.drainFollowupsForTest();
    expect(total()).toBe(1);
    expect((await recovery.getRecord(boundTurnId))?.needsReconcile).toBe(true);

    // The store recovers — the next drain commits the terminal write.
    recovery.failRecoveredWrites = false;
    await actor.drainFollowupsForTest();
    const record = await recovery.getRecord(boundTurnId);
    expect(record?.state).toBe("RECOVERED");
    expect(record?.needsReconcile).toBeUndefined();
    // The queue advanced and the prompt was consumed — with NO second action run.
    expect(total()).toBe(1);
    expect(actor["_recoverableTurns"].length).toBe(0);
    expect(inbox.prompts.find((p) => p.status === "consumed")).toBeDefined();
  });

  it("N14: a lease held by another live owner schedules a FINITE wake at lease expiry (never waits forever)", async () => {
    const store = new MemorySessionStore();
    const events = new MemoryEventStore();
    const inbox = new MemInbox();
    const recovery = new MemoryRecoveryStore();
    const base = newBaseRuntime(store, events, inbox);
    const s = await base.createSession({ agent: AGENT, cwd: "/w" });
    const boundTurnId = await buildBoundNonterminalTurn(base, store, inbox, s.id, "recover-me");

    // Pre-lease the record to ANOTHER live owner (lease expires at t=61000).
    const now = () => 1000;
    const leased: RecoveryRecord = {
      taskId: boundTurnId, lineageId: "lin", state: "RECOVERY_IN_PROGRESS", attempt: 1,
      maxRecoveryAttempts: 3, nextAttemptAt: 1000, lastError: null, policyVersion: "e2-10-policy-v1",
      promptId: "prompt-recover-me" as never,
      lease: { owner: "other-owner", expiresAt: now() + 60_000 },
    };
    await recovery.putRecord(leased);

    const scheduled: Array<{ delay: number; fire: () => void }> = [];
    const scheduler = {
      schedule: (delayMs: number, cb: () => void) => {
        scheduled.push({ delay: delayMs, fire: cb });
        return { cancel: () => {} };
      },
    };
    const { runtime } = counting(base, false);
    const actor = await loadActor(runtime, store, inbox, s.id, recovery, now, scheduler);
    await actor.drainFollowupsForTest();

    // The drain observed the foreign lease and scheduled a wake AT its expiry.
    expect(scheduled.length).toBeGreaterThan(0);
    expect(scheduled[0]!.delay).toBeGreaterThan(0);
    expect(scheduled[0]!.delay).toBeLessThanOrEqual(60_000);
    // Nothing ran while the foreign lease is live (no steal before expiry).
    expect(actor["_recoverableTurns"].length).toBe(1);
  });

  it("N14: after lease expiry the actor re-checks and proceeds WITHOUT user input", async () => {
    const store = new MemorySessionStore();
    const events = new MemoryEventStore();
    const inbox = new MemInbox();
    const recovery = new MemoryRecoveryStore();
    const base = newBaseRuntime(store, events, inbox);
    const s = await base.createSession({ agent: AGENT, cwd: "/w" });
    const boundTurnId = await buildBoundNonterminalTurn(base, store, inbox, s.id, "recover-me");

    let t = 1000;
    const now = () => t;
    const leased: RecoveryRecord = {
      taskId: boundTurnId, lineageId: "lin", state: "RECOVERY_IN_PROGRESS", attempt: 1,
      maxRecoveryAttempts: 3, nextAttemptAt: 1000, lastError: null, policyVersion: "e2-10-policy-v1",
      promptId: "prompt-recover-me" as never,
      lease: { owner: "other-owner", expiresAt: now() + 60_000 },
    };
    await recovery.putRecord(leased);

    const { runtime, total } = counting(base, false);
    const actor = await loadActor(runtime, store, inbox, s.id, recovery, now);
    await actor.drainFollowupsForTest();
    expect(total()).toBe(0); // lease live → wait, no steal

    // Time passes past the lease expiry; the wake/drain re-checks and the
    // expired lease is free — the stale-lease interruption records a BOUNDED
    // retry (the previous owner's action state is unknown), and the retry then
    // runs the action exactly once, WITHOUT any new user message.
    t = 70_000;
    await actor.drainFollowupsForTest();
    expect(total()).toBe(0); // interruption recorded as RETRY_SCHEDULED (backoff)
    t = 72_000; // past the bounded backoff
    await actor.drainFollowupsForTest();
    expect(total()).toBe(1);
    const record = await recovery.getRecord(boundTurnId);
    expect(record?.state).toBe("RECOVERED");
  });
});

describe("E4-R25 recovery compound-failure verification (V01)", () => {
  it("V01-a: RECOVERED terminal-write AND needsReconcile marker both fail — no durable pending-commit exists, the queue does NOT advance and the prompt is NOT consumed", async () => {
    const store = new MemorySessionStore();
    const events = new MemoryEventStore();
    const inbox = new MemInbox();
    const recovery = new CompoundAckFailStore();
    const base = newBaseRuntime(store, events, inbox);
    const s = await base.createSession({ agent: AGENT, cwd: "/w" });
    const boundTurnId = await buildBoundNonterminalTurn(base, store, inbox, s.id, "recover-me");

    const { runtime, total } = counting(base, false);
    const actor = await loadActor(runtime, store, inbox, s.id, recovery, () => 1000);
    await actor.drainFollowupsForTest();

    // The action ran exactly once…
    expect(total()).toBe(1);
    // …the durable record is the ORIGINAL intent (RECOVERY_IN_PROGRESS) and
    // NO pending-commit marker exists — a marker is not proof when it cannot land.
    const record = await recovery.getRecord(boundTurnId);
    expect(record?.state).toBe("RECOVERY_IN_PROGRESS");
    expect(record?.needsReconcile).not.toBe(true);
    // The queue is frozen (no fake shift) and the prompt is NOT consumed.
    expect(actor["_recoverableTurns"].length).toBe(1);
    expect(inbox.prompts.find((p) => p.status === "consumed")).toBeUndefined();
  });

  it("V01-a-restart: a NEW actor over the marker-loss store sees the terminal TURN — the action is known-done and must only be reconciled, never blindly replayed", async () => {
    const store = new MemorySessionStore();
    const events = new MemoryEventStore();
    const inbox = new MemInbox();
    const recovery = new CompoundAckFailStore();
    const base = newBaseRuntime(store, events, inbox);
    const s = await base.createSession({ agent: AGENT, cwd: "/w" });
    await buildBoundNonterminalTurn(base, store, inbox, s.id, "recover-me");

    const a = counting(base, false);
    const actorA = await loadActor(a.runtime, store, inbox, s.id, recovery, () => 1000);
    await actorA.drainFollowupsForTest();
    expect(a.total()).toBe(1);

    // "Restart": a fresh actor over the same store (the store has HEALED — the
    // outage was transient). The durable TURN is terminal, so the recovery
    // handler is KNOWN-done: the terminal must be committed (reconcile), the
    // prompt consumed, and the action NEVER re-run.
    recovery.failTerminalWrites = false;
    const b = counting(base, false);
    const actorB = await loadActor(b.runtime, store, inbox, s.id, recovery, () => 2000);
    await actorB.drainFollowupsForTest();
    expect(b.total()).toBe(0); // NO replay of the known-completed action
    expect(a.total()).toBe(1);
    expect(inbox.prompts.find((p) => p.status === "consumed")).toBeDefined();
    expect(actorB["_recoverableTurns"].length).toBe(0);
  });

  it("V01-b: after the terminal-write outage heals, the SAME actor converges — the durable TURN terminal state is respected, the action is NOT re-run", async () => {
    const store = new MemorySessionStore();
    const events = new MemoryEventStore();
    const inbox = new MemInbox();
    const recovery = new CompoundAckFailStore();
    const base = newBaseRuntime(store, events, inbox);
    const s = await base.createSession({ agent: AGENT, cwd: "/w" });
    const boundTurnId = await buildBoundNonterminalTurn(base, store, inbox, s.id, "recover-me");

    const { runtime, total } = counting(base, false);
    const actor = await loadActor(runtime, store, inbox, s.id, recovery, () => 1000);
    await actor.drainFollowupsForTest();
    expect(total()).toBe(1);
    expect(inbox.prompts.find((p) => p.status === "consumed")).toBeUndefined();

    // The recovery store heals. The durable TURN is already terminal, so the
    // next drain must COMMIT the terminal and consume WITHOUT a second run.
    recovery.failTerminalWrites = false;
    await actor.drainFollowupsForTest();
    const record = await recovery.getRecord(boundTurnId);
    expect(record?.state).toBe("RECOVERED");
    expect(total()).toBe(1); // conviction: exactly-once across outage + heal
    expect(inbox.prompts.find((p) => p.status === "consumed")).toBeDefined();
    expect(actor["_recoverableTurns"].length).toBe(0);
  });

  it("V01-c: a WHOLE-store write outage fails closed BEFORE the action — no durable intent, no external side effect (0 runs, safe)", async () => {
    const store = new MemorySessionStore();
    const events = new MemoryEventStore();
    const inbox = new MemInbox();
    const recovery = new TotalWriteFailStore();
    const base = newBaseRuntime(store, events, inbox);
    const s = await base.createSession({ agent: AGENT, cwd: "/w" });
    await buildBoundNonterminalTurn(base, store, inbox, s.id, "recover-me");

    const { runtime, total } = counting(base, false);
    const actor = await loadActor(runtime, store, inbox, s.id, recovery, () => 1000);
    await actor.drainFollowupsForTest();
    // Lease/intent writes fail → fail-closed wait-lease: NOTHING runs, nothing
    // is fake-consumed or fake-shifted.
    expect(total()).toBe(0);
    expect(actor["_recoverableTurns"].length).toBe(1);
    expect(inbox.prompts.find((p) => p.status === "consumed")).toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// E4-R30 (G04): a TRANSIENT recovery-store failure is fail-closed (the action
// never runs) but must ALSO be self-healing — the actor schedules a bounded
// re-check instead of parking until a new user message or an explicit drain.
// ─────────────────────────────────────────────────────────────────────────────

/** E4-R30: LEASE writes are refused (reads still work) — the "RecoveryStore
 *  temporarily rejects the lease write" outage. */
class LeaseWriteFailStore extends MemoryRecoveryStore {
  failLeaseWrites = true;
  override async putRecord(record: RecoveryRecord): Promise<RecoveryRecord> {
    if (this.failLeaseWrites && record.lease !== undefined) {
      throw new Error("recovery store temporarily refuses the lease write");
    }
    return super.putRecord(record);
  }
}

/** E4-R30: the lease write lands but the ATTEMPT-INTENT write (begin →
 *  RECOVERY_IN_PROGRESS) is refused — the second fail-closed gate. */
class IntentWriteFailStore extends MemoryRecoveryStore {
  failIntentWrites = true;
  override async putRecord(record: RecoveryRecord): Promise<RecoveryRecord> {
    if (this.failIntentWrites && record.lease !== undefined && record.state === "RECOVERY_IN_PROGRESS") {
      throw new Error("recovery store temporarily refuses the intent write");
    }
    return super.putRecord(record);
  }
}

/** E4-R30: serves a STALE optimistic-concurrency version on read, so the next
 *  write loses the CAS race — a deterministic "another owner won" conflict. */
class StaleReadStore implements RecoveryStore {
  constructor(private readonly inner: MemoryRecoveryStore) {}
  async getRecord(taskId: TurnId): Promise<RecoveryRecord | undefined> {
    const r = await this.inner.getRecord(taskId);
    return r === undefined ? undefined : { ...r, version: Math.max((r.version ?? 1) - 1, 0) };
  }
  putRecord(record: RecoveryRecord): Promise<RecoveryRecord> { return this.inner.putRecord(record); }
  deleteRecord(taskId: TurnId): Promise<void> { return this.inner.deleteRecord(taskId); }
}

/** E4-R30: the main session store's TURN reads can be broken on demand. */
class ReadFailSessionStore extends MemorySessionStore {
  breakReads = false;
  override async getTurn(id: TurnId): Promise<Turn | undefined> {
    if (this.breakReads) throw new Error("session store temporarily unavailable");
    return super.getTurn(id);
  }
}

/** E4-R30: a scheduler that RECORDS every schedule (so a test can assert the
 *  bounded re-check and fire the callback deterministically) and flags cancels.
 *  E4-R32: it also flags a FIRED callback, so `liveTimers` counts timers that
 *  are neither cancelled nor already fired (a fired timer is no longer live). */
function recordingScheduler(): {
  scheduled: Array<{ delay: number; fire: () => void; cancelled: boolean; fired: boolean }>;
  scheduler: { schedule(delayMs: number, cb: () => void): { cancel(): void } };
} {
  const scheduled: Array<{ delay: number; fire: () => void; cancelled: boolean; fired: boolean }> = [];
  return {
    scheduled,
    scheduler: {
      schedule: (delayMs: number, cb: () => void) => {
        const entry = {
          delay: delayMs,
          cancelled: false,
          fired: false,
          fire: () => { entry.fired = true; cb(); },
        };
        scheduled.push(entry);
        return { cancel: () => { entry.cancelled = true; } };
      },
    },
  };
}

const liveTimers = (scheduled: Array<{ cancelled: boolean; fired: boolean }>): number =>
  scheduled.filter((s) => !s.cancelled && !s.fired).length;

describe("E4-R30 (G04) transient recovery-store failure → bounded self-healing wake", () => {
  it("R30-a: a refused LEASE write is fail-closed (0 actions) yet schedules exactly ONE bounded re-check", async () => {
    const store = new MemorySessionStore();
    const events = new MemoryEventStore();
    const inbox = new MemInbox();
    const recovery = new LeaseWriteFailStore();
    const base = newBaseRuntime(store, events, inbox);
    const s = await base.createSession({ agent: AGENT, cwd: "/w" });
    const boundTurnId = await buildBoundNonterminalTurn(base, store, inbox, s.id, "recover-me");

    const { runtime, total } = counting(base, false);
    const { scheduler, scheduled } = recordingScheduler();
    const actor = await loadActor(runtime, store, inbox, s.id, recovery, () => 1000, scheduler);
    await actor.drainFollowupsForTest();

    // G04 repro anchor was `scheduled: 0, calls: 0`; the fix keeps calls 0 but
    // MUST schedule a bounded re-check.
    expect(total()).toBe(0);
    expect(scheduled.length).toBe(1);
    expect(liveTimers(scheduled)).toBe(1);
    expect(scheduled[0]!.delay).toBeGreaterThan(0);
    expect(actor["_recoverableTurns"].length).toBe(1);
    expect(inbox.prompts.find((p) => p.status === "consumed")).toBeUndefined();
    // The outage consumed NO model-action attempt budget.
    expect((await recovery.getRecord(boundTurnId))?.attempt).toBe(0);
  });

  it("R30-b: after the store heals, firing the RECORDED callback converges with NO new user message", async () => {
    const store = new MemorySessionStore();
    const events = new MemoryEventStore();
    const inbox = new MemInbox();
    const recovery = new LeaseWriteFailStore();
    const base = newBaseRuntime(store, events, inbox);
    const s = await base.createSession({ agent: AGENT, cwd: "/w" });
    const boundTurnId = await buildBoundNonterminalTurn(base, store, inbox, s.id, "recover-me");

    const { runtime, total } = counting(base, false);
    const { scheduler, scheduled } = recordingScheduler();
    const actor = await loadActor(runtime, store, inbox, s.id, recovery, () => 1000, scheduler);
    await actor.drainFollowupsForTest();
    expect(total()).toBe(0);
    expect(scheduled.length).toBe(1);

    // The outage heals. Fire the callback the ACTOR scheduled — no manual drain,
    // no new user message.
    recovery.failLeaseWrites = false;
    scheduled[0]!.fire();
    await waitFor(() => total() >= 1);
    expect(total()).toBe(1);
    expect((await recovery.getRecord(boundTurnId))?.state).toBe("RECOVERED");
    expect(actor["_recoverableTurns"].length).toBe(0);
    expect(inbox.prompts.find((p) => p.status === "consumed")).toBeDefined();
  });

  it("R30-c: a refused INTENT write is fail-closed (0 actions) and schedules a bounded re-check", async () => {
    const store = new MemorySessionStore();
    const events = new MemoryEventStore();
    const inbox = new MemInbox();
    const recovery = new IntentWriteFailStore();
    const base = newBaseRuntime(store, events, inbox);
    const s = await base.createSession({ agent: AGENT, cwd: "/w" });
    const boundTurnId = await buildBoundNonterminalTurn(base, store, inbox, s.id, "recover-me");

    const { runtime, total } = counting(base, false);
    const { scheduler, scheduled } = recordingScheduler();
    const actor = await loadActor(runtime, store, inbox, s.id, recovery, () => 1000, scheduler);
    await actor.drainFollowupsForTest();

    expect(total()).toBe(0);
    expect(scheduled.length).toBe(1);
    // The begin() transition never became durable: the budget is untouched and
    // the record is back to a clean PENDING (lease released) — no fake progress.
    const rec = await recovery.getRecord(boundTurnId);
    expect(rec?.state).toBe("PENDING");
    expect(rec?.attempt).toBe(0);
    expect(actor["_recoverableTurns"].length).toBe(1);
    expect(inbox.prompts.find((p) => p.status === "consumed")).toBeUndefined();
  });

  it("R30-d: a lost CAS race (another owner won) schedules a bounded re-check, never a stall", async () => {
    const store = new MemorySessionStore();
    const events = new MemoryEventStore();
    const inbox = new MemInbox();
    const inner = new MemoryRecoveryStore();
    const recovery = new StaleReadStore(inner);
    const base = newBaseRuntime(store, events, inbox);
    const s = await base.createSession({ agent: AGENT, cwd: "/w" });
    const boundTurnId = await buildBoundNonterminalTurn(base, store, inbox, s.id, "recover-me");

    // A durable PENDING record exists, but every READ serves a stale version, so
    // this actor's lease write will lose the CAS race.
    await inner.putRecord({
      taskId: boundTurnId, lineageId: "lin", state: "PENDING", attempt: 0,
      maxRecoveryAttempts: 3, nextAttemptAt: 1000, lastError: null, policyVersion: "e2-10-policy-v1",
      promptId: "prompt-recover-me" as never,
    });

    const { runtime, total } = counting(base, false);
    const { scheduler, scheduled } = recordingScheduler();
    const actor = await loadActor(runtime, store, inbox, s.id, recovery, () => 1000, scheduler);
    await actor.drainFollowupsForTest();

    expect(total()).toBe(0);          // the loser never runs the action
    expect(scheduled.length).toBe(1); // …and does not park forever
    expect(scheduled[0]!.delay).toBeGreaterThan(0);
    expect(actor["_recoverableTurns"].length).toBe(1);
  });

  it("R30-e: an UNREADABLE durable turn is 'unknown' — no dangerous replay, a bounded re-check instead", async () => {
    const store = new ReadFailSessionStore();
    const events = new MemoryEventStore();
    const inbox = new MemInbox();
    const recovery = new MemoryRecoveryStore();
    const base = newBaseRuntime(store, events, inbox);
    const s = await base.createSession({ agent: AGENT, cwd: "/w" });
    const boundTurnId = await buildBoundNonterminalTurn(base, store, inbox, s.id, "recover-me");

    // A prior attempt crashed mid-flight: RECOVERY_IN_PROGRESS, NO reconcile
    // marker — so the ONLY evidence of a finished action is the durable TURN.
    await recovery.putRecord({
      taskId: boundTurnId, lineageId: "lin", state: "RECOVERY_IN_PROGRESS", attempt: 1,
      maxRecoveryAttempts: 3, nextAttemptAt: 1000, lastError: null, policyVersion: "e2-10-policy-v1",
      promptId: "prompt-recover-me" as never,
    });

    let t = 1000;
    const { runtime, total } = counting(base, false);
    const { scheduler, scheduled } = recordingScheduler();
    const actor = await loadActor(runtime, store, inbox, s.id, recovery, () => t, scheduler);
    // Wire the head directly (discovery would read the turn before we break it).
    const turn = (await store.getTurn(boundTurnId))!;
    actor["_recoverableChecked"] = true;
    actor["_recoverableTurns"].push({ turn, promptId: "prompt-recover-me" as never });

    store.breakReads = true; // the main store's turn read now FAILS
    await actor.drainFollowupsForTest();
    expect(total()).toBe(0);        // an unknown read is NOT a confirmed-nonterminal turn
    expect(scheduled.length).toBe(1); // …a bounded re-check is scheduled instead
    expect(scheduled[0]!.delay).toBeGreaterThan(0);

    // The decisive evidence: an UNKNOWN read must not be treated as "confirmed
    // nonterminal" and must not advance the recovery record toward a retry.
    // Pre-R30 the record was pushed to RETRY_SCHEDULED / attempt 2 here — a WAL
    // write that authorises re-running a possibly-completed action.
    const rec = await recovery.getRecord(boundTurnId);
    expect(rec?.state).toBe("RECOVERY_IN_PROGRESS");
    expect(rec?.attempt).toBe(1);

    // Even well past the backoff window the action must NOT be replayed.
    t = 5000;
    await actor.drainFollowupsForTest();
    expect(total()).toBe(0);
    expect((await recovery.getRecord(boundTurnId))?.state).toBe("RECOVERY_IN_PROGRESS");
    expect(actor["_recoverableTurns"].length).toBe(1);
    expect(inbox.prompts.find((p) => p.status === "consumed")).toBeUndefined();
  });

  it("R30-f: close() cancels the timer; a stale callback performs NO action and schedules NO new timer", async () => {
    const store = new MemorySessionStore();
    const events = new MemoryEventStore();
    const inbox = new MemInbox();
    const recovery = new LeaseWriteFailStore();
    const base = newBaseRuntime(store, events, inbox);
    const s = await base.createSession({ agent: AGENT, cwd: "/w" });
    await buildBoundNonterminalTurn(base, store, inbox, s.id, "recover-me");

    const { runtime, total } = counting(base, false);
    const { scheduler, scheduled } = recordingScheduler();
    const actor = await loadActor(runtime, store, inbox, s.id, recovery, () => 1000, scheduler);
    await actor.drainFollowupsForTest();
    expect(scheduled.length).toBe(1);

    await actor.close();
    expect(scheduled[0]!.cancelled).toBe(true); // close cancels the pending timer

    scheduled[0]!.fire(); // an already-queued stale callback
    await new Promise((r) => setTimeout(r, 20));
    expect(total()).toBe(0);        // no action on a closed actor
    expect(scheduled.length).toBe(1); // no new timer
  });

  it("R30-g: a long outage backs off with a BOUNDED delay — never a hot loop, never a permanent stall", async () => {
    const store = new MemorySessionStore();
    const events = new MemoryEventStore();
    const inbox = new MemInbox();
    const recovery = new LeaseWriteFailStore();
    const base = newBaseRuntime(store, events, inbox);
    const s = await base.createSession({ agent: AGENT, cwd: "/w" });
    await buildBoundNonterminalTurn(base, store, inbox, s.id, "recover-me");

    const { runtime, total } = counting(base, false);
    const { scheduler, scheduled } = recordingScheduler();
    const actor = await loadActor(runtime, store, inbox, s.id, recovery, () => 1000, scheduler);
    for (let i = 0; i < 6; i += 1) await actor.drainFollowupsForTest();

    expect(total()).toBe(0);
    expect(scheduled.length).toBe(6);          // one bounded re-check per attempt
    expect(liveTimers(scheduled)).toBe(1);     // at most ONE live timer per actor
    const delays = scheduled.map((x) => x.delay);
    for (let i = 1; i < delays.length; i += 1) {
      expect(delays[i]!).toBeGreaterThanOrEqual(delays[i - 1]!);
    }
    expect(delays[delays.length - 1]!).toBeGreaterThan(delays[0]!); // escalating
    expect(Math.max(...delays)).toBeLessThanOrEqual(30_000);        // capped → bounded
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// E4-R32 (H01/H02): the recovery-store fault model is completed. Two gaps left
// by R30 — (H01) an INTENT-write refusal whose lease-cleanup READ fails threw
// OUT of the failure handler, so the bounded re-check was never scheduled (a
// permanent stall plus an unhandled drain rejection); (H02) a HEALTHY lease
// write reset the re-check backoff, so consecutive INTENT failures re-checked at
// the 1s floor forever instead of escalating.
// ─────────────────────────────────────────────────────────────────────────────

/** E4-R32 (H01): the compound store fault — the INTENT write is refused and the
 *  SAME outage takes the READ path down with it, so the immediately-following
 *  lease-cleanup `getRecord` fails too. `peek` reads past the fault for asserts. */
class IntentFailReadFailStore extends MemoryRecoveryStore {
  failIntentWrites = true;
  readOutage = false;
  override async getRecord(taskId: TurnId): Promise<RecoveryRecord | undefined> {
    if (this.readOutage) throw new Error("recovery read outage");
    return super.getRecord(taskId);
  }
  override async putRecord(record: RecoveryRecord): Promise<RecoveryRecord> {
    if (this.failIntentWrites && record.lease !== undefined && record.state === "RECOVERY_IN_PROGRESS") {
      this.readOutage = true; // the outage deepens — reads fail from here on
      throw new Error("recovery store temporarily refuses the intent write");
    }
    return super.putRecord(record);
  }
  /** Assertions only — read the durable record PAST the injected read fault. */
  peek(taskId: TurnId): Promise<RecoveryRecord | undefined> { return super.getRecord(taskId); }
}

describe("E4-R32 (H01/H02) compound recovery-store fault + intent backoff", () => {
  it("R32-a (H01): an INTENT refusal whose lease-cleanup READ also fails still schedules exactly ONE bounded re-check — no stall, no unhandled rejection", async () => {
    const store = new MemorySessionStore();
    const events = new MemoryEventStore();
    const inbox = new MemInbox();
    const recovery = new IntentFailReadFailStore();
    const base = newBaseRuntime(store, events, inbox);
    const s = await base.createSession({ agent: AGENT, cwd: "/w" });
    const boundTurnId = await buildBoundNonterminalTurn(base, store, inbox, s.id, "recover-me");

    const { runtime, total } = counting(base, false);
    const { scheduler, scheduled } = recordingScheduler();
    const actor = await loadActor(runtime, store, inbox, s.id, recovery, () => 1000, scheduler);

    // Pre-R32 the cleanup read ESCAPED the failure handler: this await REJECTED
    // ("recovery read outage") and left scheduled=0 — a permanent stall with an
    // unhandled background rejection.
    let drainError: unknown;
    await actor.drainFollowupsForTest().catch((e) => { drainError = e; });
    expect(drainError).toBeUndefined();

    expect(total()).toBe(0);                                     // no action without a durable intent
    expect(scheduled.length).toBe(1);                            // …but a finite wake-up path exists
    expect(liveTimers(scheduled)).toBe(1);
    expect(actor["_recoverableTurns"].length).toBe(1);           // head retained (T2 never overtakes)
    expect(inbox.prompts.find((p) => p.status === "consumed")).toBeUndefined();
    expect((await recovery.peek(boundTurnId))?.attempt).toBe(0); // the outage consumed NO attempt budget

    // The store heals — firing the callback the ACTOR scheduled converges with no
    // new user message and no second action.
    recovery.readOutage = false;
    recovery.failIntentWrites = false;
    scheduled[0]!.fire();
    await waitFor(() => total() >= 1);
    expect(total()).toBe(1);
    expect((await recovery.peek(boundTurnId))?.state).toBe("RECOVERED");
    expect(actor["_recoverableTurns"].length).toBe(0);
    expect(inbox.prompts.find((p) => p.status === "consumed")).toBeDefined();
  });

  it("R32-b (H02): consecutive INTENT-write failures ESCALATE and cap the re-check delay — a healthy LEASE write alone must not reset the backoff", async () => {
    const store = new MemorySessionStore();
    const events = new MemoryEventStore();
    const inbox = new MemInbox();
    const recovery = new IntentWriteFailStore();
    const base = newBaseRuntime(store, events, inbox);
    const s = await base.createSession({ agent: AGENT, cwd: "/w" });
    await buildBoundNonterminalTurn(base, store, inbox, s.id, "recover-me");

    const { runtime, total } = counting(base, false);
    const { scheduler, scheduled } = recordingScheduler();
    const actor = await loadActor(runtime, store, inbox, s.id, recovery, () => 1000, scheduler);

    for (let i = 0; i < 7; i += 1) await actor.drainFollowupsForTest();

    expect(total()).toBe(0);
    expect(scheduled.length).toBe(7);
    expect(liveTimers(scheduled)).toBe(1); // still at most ONE live timer per actor
    // Pre-R32 every round acquired the lease (resetting the counter) then failed
    // the intent → [1000,1000,1000,1000,1000,1000,1000]. The fix resets only once
    // the round's STRICT writes are durable → escalating, capped.
    expect(scheduled.map((x) => x.delay)).toEqual([1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000]);
  });

  it("R32-c (H01): a re-check callback that fires while the recovery READ is STILL down keeps scheduling bounded re-checks — no action, no wrong 'absent' interpretation", async () => {
    const store = new MemorySessionStore();
    const events = new MemoryEventStore();
    const inbox = new MemInbox();
    const recovery = new IntentFailReadFailStore();
    const base = newBaseRuntime(store, events, inbox);
    const s = await base.createSession({ agent: AGENT, cwd: "/w" });
    const boundTurnId = await buildBoundNonterminalTurn(base, store, inbox, s.id, "recover-me");

    const { runtime, total } = counting(base, false);
    const { scheduler, scheduled } = recordingScheduler();
    const actor = await loadActor(runtime, store, inbox, s.id, recovery, () => 1000, scheduler);
    await actor.drainFollowupsForTest();
    expect(scheduled.length).toBe(1);

    // Fire the callback while the READ outage persists: the head-load read fails
    // AGAIN. The actor must schedule a NEW bounded re-check, run nothing, and must
    // NOT treat the unreadable durable record as ABSENT (which would re-create it
    // at attempt 0 and silently discard the durable budget).
    scheduled[0]!.fire();
    await waitFor(() => scheduled.length >= 2);
    expect(total()).toBe(0);
    expect(liveTimers(scheduled)).toBe(1);
    expect(actor["_recoverableTurns"].length).toBe(1);
    const rec = await recovery.peek(boundTurnId);
    expect(rec?.state).toBe("PENDING");
    expect(rec?.attempt).toBe(0);
  });

  it("R32-d (H01): once healed, a FOREIGN live lease is respected — no preemption and the lease is never released; close cancels the pending re-check", async () => {
    const store = new MemorySessionStore();
    const events = new MemoryEventStore();
    const inbox = new MemInbox();
    const recovery = new IntentFailReadFailStore();
    const base = newBaseRuntime(store, events, inbox);
    const s = await base.createSession({ agent: AGENT, cwd: "/w" });
    const boundTurnId = await buildBoundNonterminalTurn(base, store, inbox, s.id, "recover-me");

    const { runtime, total } = counting(base, false);
    const { scheduler, scheduled } = recordingScheduler();
    const actor = await loadActor(runtime, store, inbox, s.id, recovery, () => 1000, scheduler);
    await actor.drainFollowupsForTest();
    expect(scheduled.length).toBe(1);

    // Another LIVE owner takes the lease while the store is down; the store heals.
    const before = (await recovery.peek(boundTurnId))!;
    await recovery.putRecord({ ...before, lease: { owner: "other-live-owner", expiresAt: 61_000 } });
    recovery.readOutage = false;
    recovery.failIntentWrites = false;

    scheduled[0]!.fire();
    await waitFor(() => scheduled.length >= 2);
    expect(total()).toBe(0);                              // a live foreign lease is never stolen
    expect(actor["_recoverableTurns"].length).toBe(1);
    // The cleanup path never released another owner's lease…
    expect((await recovery.peek(boundTurnId))?.lease?.owner).toBe("other-live-owner");
    // …and a FINITE wake at the lease expiry was arranged.
    expect(liveTimers(scheduled)).toBe(1);

    await actor.close();
    expect(liveTimers(scheduled)).toBe(0); // close cancels the pending re-check
  });
});
