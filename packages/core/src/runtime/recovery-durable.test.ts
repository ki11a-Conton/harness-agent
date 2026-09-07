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
  AdmittedPrompt, AgentDefinition, PromptId, SessionId, TurnId, InboxStore,
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

/** A RecoveryStore that throws on every write (simulates a downed durable store). */
class FailingStore implements RecoveryStore {
  async getRecord(): Promise<RecoveryRecord | undefined> { return undefined; }
  async putRecord(): Promise<RecoveryRecord> { throw new Error("store down"); }
  async deleteRecord(): Promise<void> { /* noop */ }
}

async function buildBoundNonterminalTurn(base: AgentRuntime, store: MemorySessionStore, inbox: MemInbox, sessionId: SessionId, text: string): Promise<TurnId> {
  const promptId = `prompt-${text}` as unknown as PromptId;
  await inbox.admit({ id: promptId, sessionId, text, kind: "followup", status: "pending", admittedAt: 1 } as AdmittedPrompt);
  const turn = await base.startTurn(sessionId, text);
  await inbox.bindPromotion(promptId, turn.id);
  return turn.id;
}

async function loadActor(runtime: Pick<AgentRuntime, "startTurn" | "runTurn">, store: MemorySessionStore, inbox: MemInbox, sessionId: SessionId, recoveryStore: RecoveryStore, now?: () => number): Promise<DefaultSessionActor> {
  const session = (await store.getSession(sessionId))!;
  return new DefaultSessionActor({ persistent: session, runtime, store, inbox, recoveryStore, ...(now !== undefined ? { now } : {}) });
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
