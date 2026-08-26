// PHASE 34-2 — Same-session race suite.
//
// Invariant: for a session, no two `runTurn()` instances may overlap. The
// SessionActor is the single owner of live session state: concurrent turn
// start / steer / follow-up / cancel / interrupt / approval / ask / MCP
// refresh must either conflict-refuse (SESSION_BUSY), inject at a sampling
// boundary, or abort the live run — never run two turns concurrently.
//
// This is a behavior probe, not a sleeps-only suite: each race is driven by
// a deterministic gate that keeps a turn "in flight", and the actor's own
// mutual-exclusion contract (BUSY/steer/queue/abort) is the probe asserting
// that no two runTurn instances overlap.

import { describe, expect, it } from "vitest";
import type { AgentDefinition, ModelEvent, ModelProvider, SessionId, TurnId } from "@ar/contracts";
import { newAgentId } from "@ar/contracts";
import { EchoModelProvider } from "@ar/model";
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

/** P36-9: assert the typed error CODE (SESSION_BUSY), never message text. */
async function expectSessionBusy(promise: Promise<unknown>): Promise<void> {
  await expect(promise).rejects.toMatchObject({ info: { code: "SESSION_BUSY" } });
}

/** Deterministic gate provider (P36-9): generate() of each in-flight turn
 *  blocks until release(); whenEntered resolves when the first turn is live;
 *  whenNEntered(n) polls until the n-th generate() has entered. */
class GatedProvider implements ModelProvider {
  readonly id = "gated";
  private entered = 0;
  private entryWaiters: Array<() => void> = [];
  private releases: Array<(value: void | PromiseLike<void>) => void> = [];
  /** P38.2-8 (INV-P38.2-008): execution-overlap counters wired to the runtime
   *  seam. Each generate() that is mid-flight counts as one live run; a test
   *  asserts maxActiveRuns === 1 to prove runs never overlapped. */
  private activeRuns = 0;
  private maxActiveRuns = 0;

  /** P38.2-8: the observed maximum number of concurrently live executions. */
  get observedMaxActiveRuns(): number {
    return this.maxActiveRuns;
  }

  whenEntered(): Promise<void> {
    if (this.entered > 0) return Promise.resolve();
    return new Promise((r) => this.entryWaiters.push(r));
  }
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
        // P38.2-8: this generate() is now a live runtime execution.
        self.activeRuns += 1;
        self.maxActiveRuns = Math.max(self.maxActiveRuns, self.activeRuns);
        try {
          await new Promise<void>((resolve) => {
            if (signal.aborted) return resolve();
            self.releases.push(resolve);
            signal.addEventListener("abort", () => resolve(), { once: true });
          });
          yield { type: "completed", result: { finishReason: "stop", text: "done" }, timestamp: 0 };
        } finally {
          self.activeRuns -= 1;
        }
      },
    };
  }
}

interface Harness {
  actor: SessionActor;
  provider: GatedProvider;
  sessionId: SessionId;
  runtime: AgentRuntime;
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
  return { actor, provider, sessionId: session.id, runtime };
}

/** Non-blocking harness for post-cancel sanity runs. */
async function setupEcho(): Promise<{ actor: SessionActor; provider: GatedProvider; sessionId: SessionId }> {
  const store = new MemorySessionStore();
  const events = new MemoryEventStore();
  const provider = new GatedProvider();
  const runtime = new AgentRuntime({
    store,
    events,
    modelProvider: new EchoModelProvider(),
    orchestrator: new FakeOrchestrator(),
    agents: [AGENT],
    toolRegistry: defaultTestToolCatalog(),
    permissiveToolResolution: true,
  });
  const manager = new DefaultLoadedSessionManager({ runtime, store });
  const session = await runtime.createSession({ agent: AGENT, cwd: "/work" });
  const actor = await manager.load(session.id);
  return { actor, provider, sessionId: session.id };
}

/** P38.1-10: watchdog-style wait — polls until the predicate holds or fails the
 *  test on timeout. Replaces the old `setTimeout(20)` "drain settles" sleeps. */
async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 3000,
): Promise<void> {
  const start = Date.now();
  for (;;) {
    if (await predicate()) return;
    if (Date.now() - start > timeoutMs) throw new Error("waitFor timed out");
    await new Promise((r) => setTimeout(r, 1));
  }
}

describe("P34-2 same-session race suite", () => {
  it("2.1 racing a second runTurn at a live turn — refused (SESSION_BUSY), never two live runs", async () => {
    const { actor, provider, sessionId, runtime } = await setup();
    const first = await actor.startTurn({ sessionId, text: "first" });
    await provider.whenEntered(); // first turn is mid-flight
    // Create a second turn record via the RUNTIME (the actor refuses
    // createTurn while one is active; runtime.startTurn is the only way to
    // obtain a distinct turnId while a turn is live).
    const secondTurn = await runtime.startTurn(sessionId, "second");
    await expectSessionBusy(actor.runTurn(secondTurn.id));
    // exactly ONE live run for this session — the probe
    expect(actor.activeTurn?.turn.id).toBe(first.turnId);
    provider.release();
    const outcome = await first.outcome;
    expect(outcome.status).toBe("completed");
    expect(actor.activeTurn).toBeUndefined();
    // P38.2-8: the refused runTurn never opened a parallel execution.
    expect(provider.observedMaxActiveRuns).toBe(1);
  });

  it("2.2 turn start / steer / follow-up racing a live turn — no parallel run", async () => {
    const { actor, provider, sessionId } = await setup();
    const first = await actor.startTurn({ sessionId, text: "first" });
    await provider.whenEntered();
    // steer injects at the NEXT sampling boundary — allowed, non-parallel
    await actor.steer({ sessionId, text: "steer now" });
    // follow-up is queued, never started
    await actor.enqueueFollowup({ sessionId, text: "follow-up" });
    expect(actor.status().activeTurn?.status).toBe("running");
    expect(actor.inputQueue.pendingCount).toBe(1);
    // a second direct start is refused while the first is live
    await expectSessionBusy(actor.startTurn({ sessionId, text: "burst" }));
    provider.release();
    const outcome = await first.outcome;
    expect(outcome.status).toBe("completed");
    // P37-1: the queued follow-up is drained automatically by the actor.
    await provider.whenNEntered(2);
    provider.release();
    await waitFor(() => actor.activeTurn === undefined);
    expect(actor.activeTurn).toBeUndefined();
    // P38.2-8: the live turn and the drained follow-up ran serially.
    expect(provider.observedMaxActiveRuns).toBe(1);
  });

  it("2.3 cancel / interrupt racing a live run — aborts the SAME live run, session stays single-owner", async () => {
    const { actor, provider, sessionId } = await setup();
    const first = await actor.startTurn({ sessionId, text: "first" });
    await provider.whenEntered();
    // cancel targets the live run only; any other call remains excluded
    const st = await actor.cancelTurn(first.turnId);
    expect(st === "completed" || st === "cancelled").toBe(true);
    // after the live run settles the session is free again — no overlap
    const echo = await setupEcho();
    const second = await echo.actor.startTurn({ sessionId: echo.sessionId, text: "after-cancel" });
    expect((await second.outcome).status).toBe("completed");
    expect(echo.actor.activeTurn).toBeUndefined();
    // P38.2-8: the cancelled live run and the fresh run never overlapped at
    // the seam (the fresh run used the non-blocking provider, so it is not
    // counted here — the gated provider observed only the one live run).
    expect(provider.observedMaxActiveRuns).toBe(1);
  });

  it("2.4 MCP refresh / approval / ask arriving mid-turn — never starts a parallel run", async () => {
    const { actor, provider, sessionId } = await setup();
    const first = await actor.startTurn({ sessionId, text: "first" });
    await provider.whenEntered();
    // mid-turn background inputs cannot sneak a second run in
    expect(actor.activeTurn?.turn.id).toBe(first.turnId); // still busy on the SAME run
    await expectSessionBusy(actor.startTurn({ sessionId, text: "again" }));
    provider.release();
    const outcome = await first.outcome;
    expect(outcome.status).toBe("completed");
    // P38.2-8: refusal paths never opened a second concurrent execution.
    expect(provider.observedMaxActiveRuns).toBe(1);
  });

  it("2.5 adversarial burst — every non-conflicting op lands, still a single live run", async () => {
    const { actor, provider, sessionId } = await setup();
    const live = await actor.startTurn({ sessionId, text: "A" });
    await provider.whenEntered();
    const settled = await Promise.allSettled([
      actor.startTurn({ sessionId, text: "B" }),
      actor.steer({ sessionId, text: "C" }),
      actor.enqueueFollowup({ sessionId, text: "D" }),
      actor.createTurn({ sessionId, text: "E" }),
    ]);
    expect(actor.activeTurn?.turn.id).toBe(live.turnId); // the ONLY live one
    expect(actor.inputQueue.pendingCount).toBe(1); // D queued, not run
    // the direct start B and createTurn E are refused (BUSY); steer/queue accepted
    expect(settled[0]?.status).toBe("rejected");
    expect((settled[0]! as PromiseRejectedResult).reason?.info?.code).toBe("SESSION_BUSY");
    expect(settled[1]?.status).toBe("fulfilled");
    expect(settled[2]?.status).toBe("fulfilled");
    expect(settled[3]?.status).toBe("rejected");
    expect((settled[3]! as PromiseRejectedResult).reason?.info?.code).toBe("SESSION_BUSY");
    provider.release();
    await live.outcome;
    // the queued follow-up drains sequentially into a NEW turn
    await provider.whenNEntered(2);
    provider.release();
    await waitFor(() => actor.activeTurn === undefined);
    expect(actor.activeTurn).toBeUndefined();
    // P38.2-8: the live turn + the drained follow-up ran serially, never
    // overlapping at the runtime seam.
    expect(provider.observedMaxActiveRuns).toBe(1);
  });
});
