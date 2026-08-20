import { describe, expect, it } from "vitest";
import type { MemoryCandidate, MemoryEntry, SessionId } from "@ar/contracts";
import { newMemoryId } from "@ar/contracts";
import { evidenceFromCandidate, mergeEvidence, recordValidation } from "./evidence.js";

const SESSION_A = "session_a" as SessionId;
const SESSION_B = "session_b" as SessionId;

function makeEntry(overrides: Partial<MemoryEntry> = {}): MemoryEntry {
  return {
    id: newMemoryId(),
    content: "lesson content",
    type: "procedural",
    sourceSession: SESSION_A,
    scope: "session",
    importance: 0.7,
    confidence: 0.6,
    novelty: 0.5,
    stability: 0.5,
    createdAt: 1000,
    updatedAt: 1000,
    deleted: false,
    ...overrides,
  };
}

function makeCandidate(overrides: Partial<MemoryCandidate> = {}): MemoryCandidate {
  return {
    content: "lesson content",
    type: "procedural",
    sourceSession: SESSION_A,
    importance: 0.7,
    confidence: 0.6,
    novelty: 0.5,
    stability: 0.5,
    ...overrides,
  };
}

describe("P2-2 evidence model", () => {
  it("recordValidation bumps success and stamps lastValidated", () => {
    const entry = makeEntry();
    const next = recordValidation(entry, true, { at: 2000 });

    expect(next.evidence!.successCount).toBe(1);
    expect(next.evidence!.failureCount).toBe(0);
    expect(next.evidence!.lastValidated).toBe(2000);
    expect(entry.evidence).toBeUndefined();
  });

  it("recordValidation bumps failure on a failed validation", () => {
    const entry = makeEntry({
      evidence: { sourceSessions: [], sourceEvents: [], successCount: 1, failureCount: 0 },
    });
    const next = recordValidation(entry, false, { at: 3000 });

    expect(next.evidence!.successCount).toBe(1);
    expect(next.evidence!.failureCount).toBe(1);
    expect(next.evidence!.lastValidated).toBe(3000);
  });

  it("recordValidation appends the backing event id once, deduped", () => {
    const entry = makeEntry();
    const once = recordValidation(entry, true, { eventId: "event_9", at: 2000 });
    const twice = recordValidation(once, true, { eventId: "event_9", at: 3000 });
    const another = recordValidation(once, false, { eventId: "event_10", at: 4000 });

    expect(once.evidence!.sourceEvents).toEqual(["event_9"]);
    expect(twice.evidence!.sourceEvents).toEqual(["event_9"]);
    expect(twice.evidence!.successCount).toBe(2);
    expect(another.evidence!.sourceEvents).toEqual(["event_9", "event_10"]);
  });

  it("evidenceFromCandidate seeds the session and P2-1 evidence refs", () => {
    const candidate = makeCandidate({
      structured: {
        when: "read_file failed with ENOENT",
        do: "search the tree first",
        avoid: "guessing paths",
        rootCause: "tool",
        outcome: "failure",
        evidenceRefs: ["event_1", "event_2"],
      },
    });

    const evidence = evidenceFromCandidate(candidate);
    expect(evidence.sourceSessions).toEqual([SESSION_A]);
    expect(evidence.sourceEvents).toEqual(["event_1", "event_2"]);
    expect(evidence.successCount).toBe(0);
    expect(evidence.failureCount).toBe(0);
    expect(evidence.lastValidated).toBeUndefined();
  });

  it("evidenceFromCandidate without structured evidence starts empty", () => {
    const evidence = evidenceFromCandidate(makeCandidate());
    expect(evidence.sourceSessions).toEqual([SESSION_A]);
    expect(evidence.sourceEvents).toEqual([]);
  });

  it("mergeEvidence combines sessions, events, counts, and latest validation", () => {
    const base = {
      sourceSessions: [SESSION_A],
      sourceEvents: ["event_1"],
      successCount: 2,
      failureCount: 0,
      lastValidated: 1000,
    };
    const other = {
      sourceSessions: [SESSION_B, SESSION_A],
      sourceEvents: ["event_2", "event_1"],
      successCount: 1,
      failureCount: 1,
      lastValidated: 5000,
    };

    const merged = mergeEvidence(base, other);
    expect(merged.sourceSessions).toEqual([SESSION_A, SESSION_B]);
    expect(merged.sourceEvents).toEqual(["event_1", "event_2"]);
    expect(merged.successCount).toBe(3);
    expect(merged.failureCount).toBe(1);
    expect(merged.lastValidated).toBe(5000);
  });
});