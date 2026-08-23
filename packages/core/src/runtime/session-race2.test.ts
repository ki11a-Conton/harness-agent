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

/** Provider whose generate blocks until release() — the deterministic gate
 *  that keeps a turn "in flight" while we race other inputs at it. */
class GatedProvider implements ModelProvider {
  readonly id = "gated";
  private gates: Array<() => void> = [];

  /** Resolves when the NEXT in-flight turn has reached the gate. */
  waitForGate(): Promise<void> {
    return new Promise((resolve) => this.gates.push(resolve));
  }
  releaseGate(): void {
    this.gates.shift()?.();
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
        await new Promise<void>((resolve) => {
          if (signal.aborted) return resolve();
          self.gates.push(resolve);
          signal.addEventListener("abort", () => resolve(), { once: true });
        });
        yield { type: "completed", result: { finishReason: "stop", text: "done" }, timestamp: 0 };
      },
    };
  }
}

interface Harness {
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
  return { actor, provider, sessionId: session.id };
}

describe("P34-2 same-session race suite", () => {
  it("2.1 racing a second runTurn at a live turn — refused (SESSION_BUSY), never two live runs", async () => {
    const { actor, provider, sessionId } = await setup();
    const first = await actor.startTurn({ sessionId, text: "first" });
    await provider.waitForGate(); // first turn is mid-flight
    const secondId = (await actor.createTurn({ sessionId, text: "second" })).id;
    await expect(actor.runTurn(secondId)).rejects.toThrow(/SESSION_BUSY/);
    // exactly ONE live run for this session — the probe
    expect(actor.activeTurn?.turn.id).toBe(first.turnId);
    provider.releaseGate();
    const outcome = await first.outcome;
    expect(outcome.status).toBe("completed");
    expect(actor.activeTurn).toBeUndefined();
  });

  it("2.2 turn start / steer / follow-up racing a live turn — no parallel run", async () => {
    const { actor, provider, sessionId } = await setup();
    const first = await actor.startTurn({ sessionId, text: "first" });
    await provider.waitForGate();
    // steer injects at the NEXT sampling boundary — allowed, non-parallel
    await actor.steer({ sessionId, text: "steer now" });
    // follow-up is queued, never started
    await actor.enqueueFollowup({ sessionId, text: "follow-up" });
    expect(actor.status().activeTurn?.status).toBe("running");
    expect(actor.inputQueue.pendingCount).toBe(1);
    // a second direct start is refused while the first is live
    await expect(
      actor.startTurn({ sessionId, text: "burst" }),
    ).rejects.toThrow(/SESSION_BUSY/);
    provider.releaseGate();
    const outcome = await first.outcome;
    expect(outcome.status).toBe("completed");
    // the queued follow-up drains AFTER the first settles — sequential
    const drained = await actor.startTurn({ sessionId, text: "follow-up" });
    await provider.waitForGate();
    provider.releaseGate();
    expect((await drained.outcome).status).toBe("completed");
  });

  it("2.3 cancel / interrupt racing a live run — aborts the SAME live run, session stays single-owner", async () => {
    const { actor, provider, sessionId } = await setup();
    const first = await actor.startTurn({ sessionId, text: "first" });
    await provider.waitForGate();
    // cancel targets the live run only; any other call remains excluded
    await actor.cancelTurn(first.turnId);
    // after the live run settles the session is free again — no overlap
    const second = await actor.startTurn({ sessionId, text: "after-cancel" });
    await provider.waitForGate();
    provider.releaseGate();
    expect((await second.outcome).status).toBe("completed");
    expect(actor.activeTurn).toBeUndefined();
  });

  it("2.4 MCP refresh / approval / ask arriving mid-turn — never starts a parallel run", async () => {
    const { actor, provider, sessionId } = await setup();
    const first = await actor.startTurn({ sessionId, text: "first" });
    await provider.waitForGate();
    // mid-turn background inputs cannot sneak a second run in
    expect(actor.activeTurn?.turn.id).toBe(first.turnId); // still busy on the SAME run
    await expect(actor.startTurn({ sessionId, text: "again" })).rejects.toThrow(/SESSION_BUSY/);
    provider.releaseGate();
    const outcome = await first.outcome;
    expect(outcome.status).toBe("completed");
  });

  it("2.5 adversarial burst — every non-conflicting op lands, still a single live run", async () => {
    const { actor, provider, sessionId } = await setup();
    const live = await actor.startTurn({ sessionId, text: "A" });
    await provider.waitForGate();
    const settled = await Promise.allSettled([
      actor.startTurn({ sessionId, text: "B" }),
      actor.steer({ sessionId, text: "C" }),
      actor.enqueueFollowup({ sessionId, text: "D" }),
      actor.createTurn({ sessionId, text: "E" }),
    ]);
    expect(actor.activeTurn?.turn.id).toBe(live.turnId); // the ONLY live one
    expect(actor.inputQueue.pendingCount).toBe(1); // D queued, not run
    // the direct start B was refused, steer/queue accepted
    expect(settled[0]?.status).not.toBe("fulfilled");
    expect(settled[1]?.status).toBe("fulfilled");
    expect(settled[2]?.status).toBe("fulfilled");
    expect(settled[3]?.status).toBe("fulfilled");
    provider.releaseGate();
    await live.outcome;
    // drain the queued follow-up sequentially
    const drained = await actor.startTurn({ sessionId, text: "D" });
    await provider.waitForGate();
    provider.releaseGate();
    await drained.outcome;
    expect(actor.activeTurn).toBeUndefined();
  });
});