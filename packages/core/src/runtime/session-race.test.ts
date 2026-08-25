// PHASE 34-2 — Same-session race suite.
//
// Invariant: for a session, no two `runTurn()` instances may overlap. The
// SessionActor (and the runtime under it) enforces a single live run per
// session: concurrent turn start / steer / follow-up / cancel / interrupt /
// approval / ask / MCP refresh must either conflict-refuse
// (info.code === "SESSION_BUSY"), inject at a sampling boundary, or abort
// the live run — never run two turns concurrently.
//
// This is a behavior probe, not a sleeps-only suite: every race is driven by
// a deterministic gate that keeps a turn "in flight", and the single-live-run
// contract is asserted at each step.

import { describe, expect, it } from "vitest";
import type { AgentDefinition, ModelEvent, ModelProvider, SessionId, TurnId } from "@ar/contracts";
import { newAgentId } from "@ar/contracts";
import { AgentRuntime } from "./runtime.js";
import { DefaultLoadedSessionManager, type SessionActor } from "./session-actor.js";
import { MemoryEventStore, MemorySessionStore, defaultTestToolCatalog } from "../test/fakes.js";
import { FakeOrchestrator } from "../test/fake-orchestrator.js";

const AGENT = {
  id: newAgentId(),
  name: "race-agent",
  description: "test",
  mode: "primary",
  model: { providerId: "scripted", modelId: "scripted-model" },
  systemPrompt: "you are a race test",
  tools: {},
  permissions: { rules: [] },
  skills: {},
  limits: { maxToolCalls: 5 },
} as const satisfies AgentDefinition;

/** Deterministic gate provider: every generate() call blocks on a fresh
 *  gate until release(); whenEntered() resolves as soon as the NEXT turn is
 *  live. `entered` is treated as a border marker, not a persistent count, so
 *  later turns get their own gates. */
class GatedProvider implements ModelProvider {
  readonly id = "gated";
  private firstArmed = true; // first generate() of a turn parks on the gate
  private entryWaiters: Array<() => void> = [];
  private releaseGate?: () => void = undefined;

  whenEntered(): Promise<void> {
    if (!this.firstArmed) return Promise.resolve();
    return new Promise((r) => this.entryWaiters.push(() => r()));
  }
  /** Release the turn parked at the gate; later rounds stream instantly. */
  release(): void {
    this.firstArmed = false;
    const gate = this.releaseGate;
    this.releaseGate = undefined;
    gate?.();
  }

  listModels(): Promise<never[]> {
    return Promise.resolve([]);
  }
  createClient() {
    const self = this;
    return {
      async *generate(_request: unknown, signal: AbortSignal): AsyncGenerator<ModelEvent, void, void> {
        yield { type: "started", timestamp: 0 };
        yield { type: "text_delta", text: "thinking", timestamp: 0 };
        if (self.firstArmed) {
          // FIRST round of a turn: park here until release()
          self.firstArmed = false;
          self.entryWaiters.shift()?.();
          await new Promise<void>((resolve) => {
            if (signal.aborted) return resolve();
            self.releaseGate = resolve;
            signal.addEventListener("abort", () => resolve(), { once: true });
          });
        }
        yield { type: "completed", result: { finishReason: "stop", text: "done" }, timestamp: 0 };
      },
    };
  }
}
interface Harness {
  runtime: AgentRuntime;
  actor: SessionActor;
  provider: GatedProvider;
  sessionId: SessionId;
}

async function setup(): Promise<Harness> {
  const store = new MemorySessionStore();
  const events = new MemoryEventStore();
  const provider = new GatedProvider();
  const runtime = new AgentRuntime({
    store,
    events,
    modelProvider: provider,
    orchestrator: new FakeOrchestrator(),
    agents: [AGENT],
    toolRegistry: defaultTestToolCatalog(),
    permissiveToolResolution: true,
  });
  const manager = new DefaultLoadedSessionManager({ runtime, store });
  const session = await runtime.createSession({ agent: AGENT, cwd: "/work" });
  const actor = await manager.load(session.id);
  return { runtime, actor, provider, sessionId: session.id };
}

/** The concurrency probe: the actor must expose EXACTLY ONE live run. */
function assertOneLiveRun(actor: SessionActor, expected: TurnId): void {
  expect(actor.activeTurn?.turn.id).toBe(expected);
}

/** Create a second turn record WITHOUT executing it — the actor refuses
 *  createTurn while a turn is live, so use the runtime's own startTurn. */
async function createStandaloneTurn(h: Harness, text: string): Promise<TurnId> {
  const turn = await h.runtime.startTurn(h.sessionId, text);
  return turn.id;
}

/** Normalize a rejection into its info.code, or undefined when not thrown. */
async function catchCode(p: Promise<unknown>): Promise<string | undefined> {
  try {
    await p;
    return undefined;
  } catch (err) {
    return (err as { info?: { code?: string } })?.info?.code;
  }
}

/** P38-14: wait until the actor reaches idle (no running turn, no drain
 *  reservation). Polls the diagnostic executionState — no arbitrary sleeps. */
async function waitUntilIdle(actor: SessionActor, timeoutMs = 2000): Promise<void> {
  const started = Date.now();
  while (actor.executionState !== "idle") {
    if (Date.now() - started > timeoutMs) {
      throw new Error(`actor did not reach idle (state=${actor.executionState})`);
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 2));
  }
}

describe("P34-2 same-session race suite", () => {
  it("2.1 racing a second runTurn at a live turn — refused (SESSION_BUSY), never two live runs", async () => {
    const h = await setup();
    const first = await h.actor.startTurn({ sessionId: h.sessionId, text: "first" });
    await h.provider.whenEntered(); // first turn is mid-flight
    const secondId = await createStandaloneTurn(h, "second");
    expect(await catchCode(h.actor.runTurn(secondId))).toBe("SESSION_BUSY");
    assertOneLiveRun(h.actor, first.turnId);
    h.provider.release();
    const outcome = await first.outcome;
    expect(outcome.status).toBe("completed");
    expect(h.actor.activeTurn).toBeUndefined();
  });

  it("2.2 turn start / steer / follow-up racing a live turn — no parallel run", async () => {
    const h = await setup();
    const first = await h.actor.startTurn({ sessionId: h.sessionId, text: "first" });
    await h.provider.whenEntered();
    // steer injects at the NEXT sampling boundary — allowed, non-parallel
    await h.actor.steer({ sessionId: h.sessionId, text: "steer now" });
    // follow-up queues — never starts a parallel run
    await h.actor.enqueueFollowup({ sessionId: h.sessionId, text: "follow-up" });
    assertOneLiveRun(h.actor, first.turnId);
    expect(h.actor.inputQueue.pendingCount).toBe(1);
    expect(await catchCode(h.actor.startTurn({ sessionId: h.sessionId, text: "burst" }))).toBe("SESSION_BUSY");
    h.provider.release();
    const outcome = await first.outcome;
    expect(outcome.status).toBe("completed");
    // P37-1: the queued follow-up is drained automatically by the actor.
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
    expect(h.actor.activeTurn).toBeUndefined();
  });

  it("2.3 cancel / interrupt racing a live run — aborts the SAME live turn, session stays single-owner", async () => {
    const h = await setup();
    const first = await h.actor.startTurn({ sessionId: h.sessionId, text: "first" });
    await h.provider.whenEntered();
    const status = await h.actor.cancelTurn(first.turnId); // aborts the live one
    expect(status).toBe("cancelled");
    // P38-1: after cancellation the drain (if any) releases the reservation —
    // wait for the actor to be genuinely idle before starting a fresh turn.
    await waitUntilIdle(h.actor);
    const second = await h.actor.startTurn({ sessionId: h.sessionId, text: "after-cancel" });
    await h.provider.whenEntered();
    h.provider.release();
    expect((await second.outcome).status).toBe("completed");
    expect(h.actor.activeTurn).toBeUndefined();
  });

  it("2.4 approval / ask / MCP refresh mid-turn — never starts a parallel run", async () => {
    const h = await setup();
    const first = await h.actor.startTurn({ sessionId: h.sessionId, text: "first" });
    await h.provider.whenEntered();
    assertOneLiveRun(h.actor, first.turnId);
    expect(await catchCode(h.actor.startTurn({ sessionId: h.sessionId, text: "again" }))).toBe("SESSION_BUSY");
    const sneakId = await createStandaloneTurn(h, "sneak");
    expect(await catchCode(h.actor.runTurn(sneakId))).toBe("SESSION_BUSY");
    h.provider.release();
    const outcome = await first.outcome;
    expect(outcome.status).toBe("completed");
  });

  it("2.5 adversarial interleave — non-conflicting ops land around ONE live run; follow-up drains serially", async () => {
    const h = await setup();
    const live = await h.actor.startTurn({ sessionId: h.sessionId, text: "A" });
    await h.provider.whenEntered();
    const settled = await Promise.allSettled([
      h.actor.startTurn({ sessionId: h.sessionId, text: "B" }), // refused (BUSY)
      h.actor.steer({ sessionId: h.sessionId, text: "C" }), // steered
      h.actor.enqueueFollowup({ sessionId: h.sessionId, text: "D" }), // queued
    ]);
    assertOneLiveRun(h.actor, live.turnId);
    expect(settled[0]?.status).not.toBe("fulfilled"); // B refused
    expect(settled[1]?.status).toBe("fulfilled"); // steer C allowed
    expect(settled[2]?.status).toBe("fulfilled"); // follow-up D queued
    expect(h.actor.inputQueue.pendingCount).toBe(1);
    h.provider.release();
    await live.outcome;
    // P37-1: queued follow-up drains automatically after the live run settles.
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
    expect(h.actor.activeTurn).toBeUndefined();
  });
});