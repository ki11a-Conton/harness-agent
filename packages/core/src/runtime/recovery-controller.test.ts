// P15-4 — terminal lifecycle EXACTLY ONCE.
//
// finishTurn is the single terminal-transition path. Once a turn's stored
// status is terminal (completed/failed/cancelled), repeated calls — duplicate
// cancel, duplicate approval reply, retry after crash that resumed a finished
// turn — MUST converge on the first terminal record+event and never emit a
// second one.

import { describe, expect, it } from "vitest";
import type { SessionId, TurnId } from "@ar/contracts";
import { DEFAULT_TOOL_SEMANTICS, newAgentId, newSessionId, newTurnId, errorInfo } from "@ar/contracts";
import { MemoryEventStore, MemorySessionStore } from "../test/fakes.js";
import { AgentState } from "../state/agent-state.js";
import { newWorkingState } from "@ar/contracts";
import { RecoveryController } from "./recovery-controller.js";
import type { TurnContext } from "./turn-helpers.js";

function makeController(store: MemorySessionStore, events: MemoryEventStore) {
  return new RecoveryController({
    store,
    events,
    emit: (sessionId, type, payload, turnId) =>
      events.append({
        id: `e-${Math.random().toString(36).slice(2)}` as never,
        sessionId,
        turnId,
        sequence: 0,
        timestamp: Date.now(),
        type,
        payload,
      }),
    now: () => 1000,
    semanticsOf: () => DEFAULT_TOOL_SEMANTICS,
  });
}

async function newTurn(
  store: MemorySessionStore,
  sessionId: SessionId,
  turnId: TurnId,
): Promise<void> {
  await store.createSession({
    id: sessionId,
    agentId: newAgentId(),
    model: { providerId: "p", modelId: "m" },
    cwd: "/w",
    status: "active",
    createdAt: 1,
    updatedAt: 1,
  });
  await store.createTurn({
    id: turnId,
    sessionId,
    input: { sessionId, text: "hi" },
    status: "running",
    startedAt: 1,
  });
}

function ctx(sessionId: SessionId, turnId: TurnId): TurnContext {
  return {
    sessionId,
    turnId,
    signal: new AbortController().signal,
    session: {
      id: sessionId,
      agentId: newAgentId(),
      model: { providerId: "p", modelId: "m" },
      cwd: "/w",
      status: "active",
      createdAt: 1,
      updatedAt: 1,
    },
    agent: {
      id: newAgentId(),
      name: "a",
      description: "a",
      mode: "primary",
      model: { providerId: "p", modelId: "m" },
      systemPrompt: "s",
      tools: {},
      permissions: { rules: [] },
      skills: {},
      limits: {},
    },
  };
}

function state(sessionId: SessionId): AgentState {
  const s = new AgentState(sessionId, newAgentId(), () => 1);
  s.beginTurn(newTurnId());
  return s;
}

describe("P15-4: terminal lifecycle exactly once", () => {
  it("a second finishTurn on an already-completed turn emits no second terminal event", async () => {
    const store = new MemorySessionStore();
    const events = new MemoryEventStore();
    const sessionId = newSessionId();
    const turnId = newTurnId();
    await newTurn(store, sessionId, turnId);
    const controller = makeController(store, events);
    const working = newWorkingState("hi");

    const first = await controller.finishTurn(ctx(sessionId, turnId), "completed", state(sessionId), working);
    const second = await controller.finishTurn(ctx(sessionId, turnId), "completed", state(sessionId), working);

    expect(first.status).toBe("completed");
    expect(second.status).toBe("completed");
    const terminals = events.events.filter((e) => e.type === "turn.completed");
    expect(terminals).toHaveLength(1); // exactly once
  });

  it("a cancelled turn stays cancelled under repeated cancel (duplicate cancel)", async () => {
    const store = new MemorySessionStore();
    const events = new MemoryEventStore();
    const sessionId = newSessionId();
    const turnId = newTurnId();
    await newTurn(store, sessionId, turnId);
    const controller = makeController(store, events);
    const working = newWorkingState("hi");

    await controller.finishTurn(ctx(sessionId, turnId), "cancelled", state(sessionId), working);
    // duplicate cancel: the same turn is cancelled again
    await controller.finishTurn(ctx(sessionId, turnId), "cancelled", state(sessionId), working);

    const cancelled = events.events.filter((e) => e.type === "turn.cancelled");
    expect(cancelled).toHaveLength(1);
    const turn = await store.getTurn(turnId);
    expect(turn?.status).toBe("cancelled");
  });

  it("crash recovery: a turn restored as already-terminal never re-emits its terminal event", async () => {
    const store = new MemorySessionStore();
    const events = new MemoryEventStore();
    const sessionId = newSessionId();
    const turnId = newTurnId();
    await newTurn(store, sessionId, turnId);
    // Simulate the crashed run: the terminal record was persisted but the
    // process died before/during the completion event fan-out.
    await store.updateTurn({
      id: turnId,
      sessionId,
      input: { sessionId, text: "hi" },
      status: "completed",
      startedAt: 1,
      completedAt: 500,
    });
    const controller = makeController(store, events);
    const working = newWorkingState("hi");

    const outcome = await controller.finishTurn(ctx(sessionId, turnId), "completed", state(sessionId), working, errorInfo("VERIFICATION_FAILED", "late"));

    expect(outcome.status).toBe("completed");
    const terminals = events.events.filter((e) => e.type === "turn.completed");
    expect(terminals).toHaveLength(0); // already recorded — no duplicate
  });

  it("duplicate approval reply cannot produce two terminal records", async () => {
    const store = new MemorySessionStore();
    const events = new MemoryEventStore();
    const sessionId = newSessionId();
    const turnId = newTurnId();
    await newTurn(store, sessionId, turnId);
    const controller = makeController(store, events);
    const working = newWorkingState("hi");
    const st = state(sessionId);

    await controller.finishTurn(ctx(sessionId, turnId), "failed", st, working, errorInfo("APPROVAL_DENIED", "denied"));
    // a racing duplicate reply resolves the same turn again
    await controller.finishTurn(ctx(sessionId, turnId), "failed", st, working, errorInfo("APPROVAL_DENIED", "denied again"));

    const failed = events.events.filter((e) => e.type === "turn.failed");
    expect(failed).toHaveLength(1);
  });
});
