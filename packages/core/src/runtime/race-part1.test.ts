// PHASE 34-2 — Same-session race suite.
//
// Invariant: for a session, no two `runTurn()` instances may overlap. The
// SessionActor (and the runtime under it) enforces a single live run per
// session: concurrent turn start / steer / follow-up / cancel / interrupt /
// approval / ask / MCP refresh must either conflict-refuse (SESSION_BUSY),
// inject at a sampling boundary, or abort the live run — never run two
// turns concurrently.
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

/** Deterministic gate provider: the generate() of each in-flight turn blocks
 *  until release(); whenEntered() resolves as soon as a turn is live. */
class GatedProvider implements ModelProvider {
  readonly id = "gated";
  private entered = 0;
  private entryWaiters: Array<() => void> = [];
  private releases: Array<(value: void | PromiseLike<void>) => void> = [];

  whenEntered(): Promise<void> {
    if (this.entered > 0) return Promise.resolve();
    return new Promise((r) => this.entryWaiters.push(r));
  }
  /** P36-9: resolve after the N-th generate() has entered — poll-based. */
  whenNEntered(n: number, timeoutMs = 5000): Promise<void> {
    return new Promise((resolve, reject) => {
      const started = Date.now();
      const check = () => {
        if (this.entered >= n) return resolve();
        if (Date.now() - started > timeoutMs) return reject(new Error(`whenNEntered(${n}) timed out (entered=${this.entered})`));
        setTimeout(check, 5);
      };
      check();
    });
  }
  release(): void {
    this.releases.shift()?.(undefined);
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
        self.entered += 1;
        self.entryWaiters.shift()?.();
        await new Promise<void>((resolve) => {
          if (signal.aborted) return resolve();
          self.releases.push(resolve);
          signal.addEventListener("abort", () => resolve(), { once: true });
        });
        yield { type: "completed", result: { finishReason: "stop", text: "done" }, timestamp: 0 };
      },
    };
  }
}


/** P36-9: assert the typed error CODE (SESSION_BUSY), never message text. */
async function expectSessionBusy(promise: Promise<unknown>): Promise<void> {
  await expect(promise).rejects.toMatchObject({ info: { code: "SESSION_BUSY" } });
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

/** Create a second turn record WITHOUT executing it — the only way to have a
 *  distinct turnId while a turn is live (actor.createTurn refuses BUSY). */
async function createStandaloneTurn(h: Harness, text: string): Promise<TurnId> {
  const turn = await h.runtime.startTurn(h.sessionId, text);
  return turn.id;
}

describe("P34-2 part1", () => {
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
    await expectSessionBusy(h.actor.startTurn({ sessionId: h.sessionId, text: "burst" }));
    h.provider.release();
    const outcome = await first.outcome;
    expect(outcome.status).toBe("completed");
    // P37-1: the queued follow-up is drained automatically by the actor.
    await h.provider.whenNEntered(2);
    h.provider.release();
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
    expect(h.actor.activeTurn).toBeUndefined();
  });
});
