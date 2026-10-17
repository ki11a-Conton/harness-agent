/** Explicit bounded-range projection checks. Complete production owner journals
 * remain dense from 0; a nonzero range is never inferred from received events. */
import { describe, expect, it } from "vitest";
import { newAgentId, newEventId, newSessionId } from "@ar/contracts";
import type { AgentEvent, EventType, Session } from "@ar/contracts";
import { projectSessionHistory } from "./projections.js";

function makeSession(): Session {
  return {
    id: newSessionId(),
    agentId: newAgentId(),
    model: { providerId: "loopback", modelId: "coding" },
    cwd: "/workspace/project",
    status: "active",
    createdAt: 1,
    updatedAt: 1,
  } as Session;
}

function journal(sessionId: Session["id"], sequences: number[]): AgentEvent[] {
  return sequences.map((sequence) => ({
    id: newEventId(),
    sessionId,
    sequence,
    timestamp: 1000 + sequence,
    schemaVersion: 1,
    type: "session.created" as EventType,
    payload: {},
  }) as AgentEvent);
}

function project(sequences: number[], sourceBaseline?: number) {
  const session = makeSession();
  return projectSessionHistory({
    session,
    events: journal(session.id, sequences),
    messages: [],
    ...(sourceBaseline === undefined ? {} : { sourceBaseline }),
  });
}

describe("explicit projection source baseline", () => {
  it("keeps the strict 0-based contract when no baseline is declared", () => {
    expect(() => project([0, 1, 2])).not.toThrow();
    // The existing contract test relies on exactly this rejection.
    expect(() => project([1])).toThrow(/not contiguous/);
    expect(() => project([2, 3])).toThrow(/not contiguous/);
  });

  it("honours an independently declared non-zero bounded range", () => {
    expect(() => project([2, 3, 4], 2)).not.toThrow();
    expect(() => project([3, 4, 5], 3)).not.toThrow();
  });

  it("still rejects a real gap under a declared baseline, so dropped events stay detectable", () => {
    expect(() => project([2, 4], 2)).toThrow(/not contiguous/);
    expect(() => project([3, 5], 3)).toThrow(/not contiguous/);
  });

  it("rejects a baseline that disagrees with the first event", () => {
    expect(() => project([3, 4], 2)).toThrow(/not contiguous/);
    expect(() => project([2, 3], 3)).toThrow(/not contiguous/);
  });

  it("rejects an invalid declared baseline", () => {
    expect(() => project([0], -1)).toThrow(/baseline/);
    expect(() => project([0], 1.5)).toThrow(/baseline/);
  });

  it("rejects a source coordinate that overflows a valid declared baseline", () => {
    const session = makeSession();
    const events = journal(session.id, [Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER + 1]).map(event => ({ ...event, timestamp: 1 }));
    expect(() => projectSessionHistory({ session, messages: [], events: events.slice(0, 1), sourceBaseline: Number.MAX_SAFE_INTEGER })).not.toThrow();
    expect(() => projectSessionHistory({ session, messages: [], events, sourceBaseline: Number.MAX_SAFE_INTEGER })).toThrow(/safe integer/);
  });

  it("still rejects a duplicate sequence under a declared baseline", () => {
    expect(() => project([2, 2], 2)).toThrow(/not contiguous/);
  });

  it("still rejects an event belonging to another session", () => {
    const session = makeSession();
    const foreign = journal(newSessionId(), [0]);
    expect(() => projectSessionHistory({ session, events: foreign, messages: [] })).toThrow(/another session/);
  });

  it("carries the real (offset) source sequence through to the wire mapping", () => {
    const session = makeSession();
    const projection = projectSessionHistory({ session, events: journal(session.id, [2, 3]), messages: [], sourceBaseline: 2 });
    // The projection's own wire seq stays dense from 0, while the source
    // sequence it maps back to is the real global one (fork cursors rely on it).
    expect(projection.sourceSequenceBySeq.length).toBeGreaterThan(0);
    expect(projection.sourceSequenceBySeq[0]).toBe(2);
  });
});
