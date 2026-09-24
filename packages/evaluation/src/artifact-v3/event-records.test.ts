/**
 * E4-02 #5/#6 — eventRecords chunking + integrity.
 */
import { describe, expect, it } from "vitest";
import {
  buildEventRecordsV3,
  buildExperimentArtifactV3,
  computeEventChunkDigestV3,
} from "./writer.js";
import { findEventRecordViolations, parseExperimentArtifactV3 } from "./schema.js";
import type { CaseOutcomeV3, ExperimentArtifactV3 } from "./types.js";

const HEX64 = "a".repeat(64);

function outcomeWithEvents(events: Record<string, unknown>[], chunkSize = 2): CaseOutcomeV3 {
  return {
    caseId: "c1",
    suite: "s",
    armId: "candidate",
    attempt: 1,
    repetition: 1,
    order: 1,
    passed: true,
    grade: null,
    verificationPassed: true,
    terminationReason: "verified_complete",
    failureCategory: null,
    inputTokens: 1,
    outputTokens: 1,
    costUsd: null,
    latencyMs: 10,
    toolCalls: 0,
    recoveryDecisions: [],
    activationRef: null,
    securityOutcomeRef: null,
    outputDigest: null,
    workspaceDigest: null,
    judgeVersion: "2.1.0",
    evaluationContextHash: HEX64,
    candidateConfigHash: HEX64,
    eventRecords: buildEventRecordsV3(events, chunkSize),
  };
}

function artifactWith(outcome: CaseOutcomeV3): ExperimentArtifactV3 {
  return buildExperimentArtifactV3({
    arm: { armId: "candidate", candidateId: "x", candidateConfigHash: HEX64 },
    manifest: { suiteVersion: "2.1.0", judgeVersion: "2.1.0" },
    outcomes: [outcome],
    provenance: { sourceManifestPath: null, gitSha: HEX64.slice(0, 40), dirty: false, model: "m", provider: "p", runtimeConfigHash: HEX64 },
  });
}

const EVENTS = Array.from({ length: 5 }, (_, i) => ({ type: "model.completed", seq: i, payload: { n: i } }));

describe("E4-02 eventRecords chunking", () => {
  it("builds contiguous, digest-anchored chunks; digest recomputes from events", () => {
    const er = buildEventRecordsV3(EVENTS, 2);
    expect(er.mode).toBe("embedded");
    expect(er.totalEvents).toBe(5);
    expect(er.chunks.map((c) => c.count)).toEqual([2, 2, 1]);
    expect(er.chunks.map((c) => [c.firstSeq, c.lastSeq])).toEqual([[0, 1], [2, 3], [4, 4]]);
    for (const c of er.chunks) {
      expect(c.digest).toBe(computeEventChunkDigestV3(c.events));
    }
  });

  it("a clean artifact with eventRecords has no violations and strict-parses", () => {
    const artifact = artifactWith(outcomeWithEvents(EVENTS));
    expect(findEventRecordViolations(artifact)).toEqual([]);
    // round-trips through the strict parser
    const reparsed = parseExperimentArtifactV3(JSON.parse(JSON.stringify(artifact)));
    expect(reparsed.outcomes[0]!.eventRecords?.totalEvents).toBe(5);
  });

  it("rejects a tampered event (digest mismatch)", () => {
    const artifact = artifactWith(outcomeWithEvents(EVENTS));
    const er = artifact.outcomes[0]!.eventRecords!;
    er.chunks[0]!.events[0]!.payload = { n: 999 }; // tamper
    const v = findEventRecordViolations(artifact);
    expect(v.some((s) => s.includes("digest mismatch"))).toBe(true);
  });

  it("rejects a lost chunk (seq gap)", () => {
    const artifact = artifactWith(outcomeWithEvents(EVENTS));
    const er = artifact.outcomes[0]!.eventRecords!;
    er.chunks.splice(1, 1); // drop the middle chunk
    const v = findEventRecordViolations(artifact);
    expect(v.some((s) => s.includes("lost chunk") || s.includes("firstSeq"))).toBe(true);
  });

  it("rejects out-of-order chunks (chunkIndex not in position)", () => {
    const artifact = artifactWith(outcomeWithEvents(EVENTS));
    const er = artifact.outcomes[0]!.eventRecords!;
    er.chunks.reverse(); // reorder
    const v = findEventRecordViolations(artifact);
    expect(v.some((s) => s.includes("out-of-order") || s.includes("firstSeq"))).toBe(true);
  });

  it("rejects a duplicated seq (chunk overlap)", () => {
    const artifact = artifactWith(outcomeWithEvents(EVENTS));
    const er = artifact.outcomes[0]!.eventRecords!;
    // make chunk 1 start where chunk 0 started → overlap
    er.chunks[1]!.firstSeq = er.chunks[0]!.firstSeq;
    const v = findEventRecordViolations(artifact);
    expect(v.some((s) => s.includes("firstSeq") || s.includes("duplicate"))).toBe(true);
  });

  it("omits eventRecords for an outcome with no events (absent, not empty)", () => {
    const o = outcomeWithEvents([]);
    expect(o.eventRecords?.chunks).toEqual([]);
    expect(o.eventRecords?.totalEvents).toBe(0);
    // an outcome WITHOUT eventRecords is never flagged
    const artifact = artifactWith({ ...o, eventRecords: undefined });
    expect(findEventRecordViolations(artifact)).toEqual([]);
  });
});
