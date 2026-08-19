import { describe, expect, it } from "vitest";
import type { Session } from "./session.js";
import type { Turn } from "./session.js";
import type { AgentEvent } from "./event.js";
import {
  fixtureAgentId,
  makeEvent,
  makeEventId,
  makeSeed,
  makeSession,
  makeSessionId,
  makeTurn,
  makeTurnId,
} from "./testing.js";

describe("Q-9 test fixture builders — determinism", () => {
  it("makeSessionId / makeTurnId / makeEventId are stable for a given n", () => {
    expect(makeSessionId(3)).toBe("session_0003");
    expect(makeTurnId(25)).toBe("turn_0025");
    expect(makeEventId(1)).toBe("event_0001");
    expect(fixtureAgentId(2)).toBe("agent_0002");
    // Re-calling with the same n yields the same value (pure).
    expect(makeSessionId(3)).toBe("session_0003");
  });

  it("distinct n yield distinct ids", () => {
    expect(makeSessionId(1)).not.toBe(makeSessionId(2));
    expect(makeEventId(1)).not.toBe(makeEventId(2));
  });

  it("makeSession produces a valid Session with sensible defaults", () => {
    const s: Session = makeSession();
    expect(s.id).toBe("session_0001");
    expect(s.agentId).toBe("agent_test-fixture");
    expect(s.model).toEqual({ providerId: "test-provider", modelId: "test-model" });
    expect(s.cwd).toBe("/workspace");
    expect(s.status).toBe("active");
  });

  it("makeSession overrides apply and keep types", () => {
    const s = makeSession({ n: 9, cwd: "/elsewhere", status: "completed", parentId: makeSessionId(1) });
    expect(s.id).toBe("session_0009");
    expect(s.cwd).toBe("/elsewhere");
    expect(s.status).toBe("completed");
    expect(s.parentId).toBe("session_0001");
  });

  it("makeTurn produces a valid Turn tied to the matching session id by default", () => {
    const t: Turn = makeTurn({ n: 4 });
    expect(t.id).toBe("turn_0004");
    expect(t.sessionId).toBe("session_0004");
    expect(t.status).toBe("running");
    expect(t.input.text).toBe("prompt 4");
  });

  it("makeEvent produces a deterministic event snapshot", () => {
    const e: AgentEvent = makeEvent({ n: 2, seed: makeSeed() });
    expect(e.id).toBe("event_0001"); // seed counter #1
    expect(e.type).toBe("turn.started");
    expect(e.sessionId).toBe("session_0001"); // stable default session
    expect(e.turnId).toBe("turn_0002"); // derives from n when given
    expect(e.sequence).toBe(0);
    expect(e.timestamp).toBe(1000); // injected clock
    expect(e.payload).toEqual({});
  });

  it("makeEvent respects overrides and leaves payload a fresh object", () => {
    const e = makeEvent({ type: "model.failed", payload: { code: "MODEL_ERROR" } });
    expect(e.type).toBe("model.failed");
    expect(e.payload).toEqual({ code: "MODEL_ERROR" });
    const other = makeEvent({ n: 3 });
    expect(other.payload).toEqual({});
    expect(other).not.toBe(e); // distinct objects, distinct ids
  });

  it("makeSeed yields a strictly monotone id counter and fixed clock", () => {
    const seed = makeSeed();
    expect(seed.ids()).toBe(1);
    expect(seed.ids()).toBe(2);
    expect(seed.ids()).toBe(3);
    expect(seed.now()).toBe(1000);
  });

  it("two events from one seed get unique event ids (no collision)", () => {
    const seed = makeSeed();
    const a = makeEvent({ seed });
    const b = makeEvent({ seed });
    expect(a.id).not.toBe(b.id);
    expect(a.timestamp).toBe(b.timestamp); // fixed clock, same instant
  });
});