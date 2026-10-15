/**
 * Regression: a session whose projected journal starts above 0 (owner/alias
 * retirement offsets the coordinate space) must not be rejected as "not
 * contiguous".
 *
 * Defect (shipped build, main 2a141309, reproduced in a real browser):
 *   - `apps/web/src/deepseek/owners.ts:548-558` `projectEvent()` remaps an
 *     aliased session's events into the GLOBAL coordinate space
 *     `sequence = offset + event.sequence`, where `offset` is the sum of the
 *     retired owners' `eventCount`.
 *   - `apps/web/src/deepseek/session.ts` `projectUnlocked()` fed that journal to
 *     `projectSessionHistory()`, whose validator required a dense 0-based
 *     journal, so validation threw
 *     "source event sequence is not contiguous: expected 0, received 2".
 *   - The failing stream is `session/control`; the browser client reports it as
 *     `[connection] connection lost, retry #1` forever, leaving the UI stuck on
 *     "重新连接中…" with no usable composer.
 *
 * The fix keeps the projection's strict 0-based contract and adds an explicit
 * `sourceBaseline` that only the owner-aware caller declares. These cases pin
 * both halves: the baseline is honoured, and every other invariant still holds.
 */
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

describe("projection source baseline (owner retirement offset)", () => {
  it("keeps the strict 0-based contract when no baseline is declared", () => {
    expect(() => project([0, 1, 2])).not.toThrow();
    // The existing contract test relies on exactly this rejection.
    expect(() => project([1])).toThrow(/not contiguous/);
    expect(() => project([2, 3])).toThrow(/not contiguous/);
  });

  it("honours a declared non-zero baseline produced by a retired owner prefix", () => {
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
