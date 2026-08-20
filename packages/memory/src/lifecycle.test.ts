import { describe, expect, it } from "vitest";
import type { MemoryEntry } from "@ar/contracts";
import { newMemoryId } from "@ar/contracts";
import {
  DEFAULT_CONFIDENCE_DECAY_FACTOR,
  DEFAULT_FAILURE_THRESHOLD,
  deprecate,
  evaluateLifecycle,
  isRetrievable,
  markConflicting,
  supersede,
} from "./lifecycle.js";

function makeEntry(overrides: Partial<MemoryEntry> = {}): MemoryEntry {
  return {
    id: newMemoryId(),
    content: "lesson content",
    type: "procedural",
    sourceSession: "session_a" as MemoryEntry["sourceSession"],
    scope: "session",
    importance: 0.7,
    confidence: 0.8,
    novelty: 0.5,
    stability: 0.5,
    createdAt: 1000,
    updatedAt: 1000,
    deleted: false,
    ...overrides,
  };
}

describe("P2-4 lifecycle states", () => {
  it("supersede marks the entry with the replacement id and keeps history", () => {
    const entry = makeEntry();
    const next = supersede(entry, "memory_new" as MemoryEntry["id"], {
      now: 5000,
      reason: "validated by benchmark",
    });

    expect(next.state).toEqual({
      kind: "superseded",
      byId: "memory_new",
      at: 5000,
      reason: "validated by benchmark",
    });
    expect(next.content).toBe(entry.content);
    expect(next.evidence).toBeUndefined();
  });

  it("deprecate is soft: content and evidence stay intact", () => {
    const entry = makeEntry({
      evidence: {
        sourceSessions: [],
        sourceEvents: ["event_1"],
        successCount: 1,
        failureCount: 2,
      },
    });
    const next = deprecate(entry, { now: 6000, reason: "no longer applies" });

    expect(next.state).toEqual({ kind: "deprecated", at: 6000, reason: "no longer applies" });
    expect(next.evidence!.failureCount).toBe(2);
  });

  it("markConflicting records the counterpart id", () => {
    const next = markConflicting(makeEntry(), "memory_other" as MemoryEntry["id"], { now: 7000 });
    expect(next.state).toEqual({ kind: "conflicting", withId: "memory_other", at: 7000 });
  });

  it("evaluateLifecycle fires stale on evidence failure threshold with confidence decay", () => {
    const entry = makeEntry({
      confidence: 0.8,
      evidence: {
        sourceSessions: [],
        sourceEvents: [],
        successCount: 0,
        failureCount: DEFAULT_FAILURE_THRESHOLD,
      },
    });
    const result = evaluateLifecycle(entry, { now: 5000 });

    expect(result.state).toEqual({ kind: "stale", at: 5000 });
    expect(result.confidence).toBeCloseTo(0.8 * DEFAULT_CONFIDENCE_DECAY_FACTOR, 6);
  });

  it("evaluateLifecycle fires stale for feedback-less idle memories", () => {
    const entry = makeEntry({ updatedAt: 1000 });
    const result = evaluateLifecycle(entry, { now: 1000 + 31 * 24 * 3600 * 1000 });

    expect(result.state).toEqual({ kind: "stale", at: 1000 + 31 * 24 * 3600 * 1000 });
    expect(result.confidence).toBeUndefined();
  });

  it("evaluateLifecycle keeps actively-used memories fresh regardless of age", () => {
    const entry = makeEntry({
      updatedAt: 1000,
      usefulness: {
        retrievedCount: 4,
        injectedCount: 2,
        usedCount: 1,
        taskSuccessCount: 1,
        verificationPassedCount: 0,
        score: 0.6,
      },
    });
    expect(evaluateLifecycle(entry, { now: 1000 + 200 * 24 * 3600 * 1000 })).toEqual({});
  });

  it("evaluateLifecycle leaves non-active states alone (stable history)", () => {
    const superseded = supersede(makeEntry(), "memory_new" as MemoryEntry["id"], { now: 100 });
    expect(evaluateLifecycle(superseded, { now: 999999 })).toEqual({});
  });

  it("isRetrievable is true for active or stateless entries, false otherwise", () => {
    expect(isRetrievable(makeEntry())).toBe(true);
    expect(isRetrievable(deprecate(makeEntry()))).toBe(false);
    expect(isRetrievable(supersede(makeEntry(), "x" as MemoryEntry["id"]))).toBe(false);
  });
});