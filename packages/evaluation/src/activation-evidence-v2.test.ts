import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import {
  ACTIVATION_EVIDENCE_V2_SCHEMA_VERSION,
  createActivationRecorderV2,
  validateActivationV2,
  aggregateActivationV2,
  attributeQualityV2,
  type ActivationEventV2,
  type ActivationValidationResultV2,
} from "./activation-evidence-v2.js";

const sha = (s: string): string => createHash("sha256").update(s, "utf8").digest("hex");

function mkEvent(overrides: Partial<ActivationEventV2> = {}): ActivationEventV2 {
  return {
    eventId: "ev-1",
    schemaVersion: ACTIVATION_EVIDENCE_V2_SCHEMA_VERSION,
    candidateId: "adaptive_recovery_v2",
    mechanism: "recovery",
    evidenceType: "recovery-decided",
    lineage: { caseId: "ho-01", armId: "candidate", attempt: 1, repetition: 1 },
    payload: { digest: sha("recovery-action"), action: "retry_safe", budget: 1 },
    ...overrides,
  };
}

const outcomes = new Map([
  ["ho-01", [{ caseId: "ho-01", armId: "candidate", attempt: 1, repetition: 1 }]],
  ["ho-02", [{ caseId: "ho-02", armId: "candidate", attempt: 1, repetition: 1 }]],
]);

describe("E2-04 activation evidence V2 validator", () => {
  it("1. flag-only candidate branch (no real request change) is rejected — digest cannot be recomputed", () => {
    const events = [
      mkEvent({
        eventId: "flag-only",
        payload: { digest: "deferred-schema+tool_lookup", action: "n/a" }, // hard-coded string
      }),
    ];
    // With a recompute function, a hard-coded digest never matches the source.
    const result = validateActivationV2(events, {
      expectedCandidateId: "adaptive_recovery_v2",
      expectedArmId: "candidate",
      outcomeLineages: outcomes,
      digestSources: new Map([["flag-only", { nothing: true }]]),
      recomputeDigest: () => sha("real-model-request-content"),
    });
    expect(result.ok).toBe(false);
    expect(result.issues.some((i) => i.code === "DIGEST_MISMATCH")).toBe(true);
  });

  it("2. memory source exists but empty injection -> EMPTY_MEMORY_INJECTION (eligibleButNotActivated, never activated)", () => {
    const events = [
      mkEvent({
        eventId: "empty-mem",
        mechanism: "memory",
        evidenceType: "memory-block-injected",
        payload: { digest: sha("empty"), entryCount: 0 },
      }),
    ];
    const result = validateActivationV2(events, {
      expectedCandidateId: "adaptive_recovery_v2",
      expectedArmId: "candidate",
    });
    expect(result.ok).toBe(false);
    expect(result.issues.some((i) => i.code === "EMPTY_MEMORY_INJECTION")).toBe(true);
  });

  it("3. memory baseline/candidate separation: only candidate digest carries the memory block", () => {
    // Baseline arm must NOT show memory events; candidate arm does.
    const candidateEvents = [
      mkEvent({
        eventId: "mem-cand",
        candidateId: "memory_retrieval",
        mechanism: "memory",
        evidenceType: "memory-block-injected",
        lineage: { caseId: "ho-31", armId: "candidate", attempt: 1, repetition: 1 },
        payload: { digest: sha("real-memory-block"), entryCount: 3, sourceCategories: ["seed-memory"] },
      }),
    ];
    const result = validateActivationV2(candidateEvents, {
      expectedCandidateId: "memory_retrieval",
      expectedArmId: "candidate",
    });
    expect(result.ok).toBe(true);
    // Baseline with the same events (wrong arm) fails CROSS_CASE_EVENT.
    const asBaseline = validateActivationV2(candidateEvents, {
      expectedCandidateId: "memory_retrieval",
      expectedArmId: "baseline",
    });
    expect(asBaseline.ok).toBe(false);
    expect(asBaseline.issues.some((i) => i.code === "CROSS_CASE_EVENT")).toBe(true);
  });

  it("4. recovery event lineage mismatching outcome lineage -> LINEAGE_MISMATCH", () => {
    const events = [
      mkEvent({
        eventId: "bad-lineage",
        lineage: { caseId: "ho-01", armId: "candidate", attempt: 9, repetition: 9 }, // not a known outcome
      }),
    ];
    const result = validateActivationV2(events, {
      expectedCandidateId: "adaptive_recovery_v2",
      expectedArmId: "candidate",
      outcomeLineages: outcomes,
    });
    expect(result.ok).toBe(false);
    expect(result.issues.some((i) => i.code === "LINEAGE_MISMATCH")).toBe(true);
  });

  it("5. duplicate id / wrong case / wrong candidate / unknown schema produce distinct stable errors", () => {
    const events = [
      mkEvent({ eventId: "dup", payload: { digest: sha("a") } }),
      mkEvent({ eventId: "dup", payload: { digest: sha("b") } }),
      mkEvent({ eventId: "wrong-cand", candidateId: "other", payload: { digest: sha("c") } }),
      mkEvent({ eventId: "wrong-schema", schemaVersion: "1.0.0" as never, payload: { digest: sha("d") } }),
      mkEvent({ eventId: "wrong-arm", lineage: { caseId: "ho-01", armId: "baseline", attempt: 1, repetition: 1 }, payload: { digest: sha("e") } }),
    ];
    const result = validateActivationV2(events, {
      expectedCandidateId: "adaptive_recovery_v2",
      expectedArmId: "candidate",
    });
    const codes = new Set(result.issues.map((i) => i.code));
    expect(codes.has("DUPLICATE_EVENT_ID")).toBe(true);
    expect(codes.has("CROSS_CANDIDATE_EVENT")).toBe(true);
    expect(codes.has("UNKNOWN_SCHEMA_VERSION")).toBe(true);
    expect(codes.has("CROSS_CASE_EVENT")).toBe(true);
  });

  it("6. +2 overall but all wins in ineligible/unactivated cases -> mechanism causality unsupported", () => {
    const pairs = [
      { caseId: "ho-01", baselinePassed: false, candidatePassed: true, eligible: false, activated: false }, // win but ineligible
      { caseId: "ho-02", baselinePassed: false, candidatePassed: true, eligible: true, activated: false },  // win but NOT activated
      { caseId: "ho-03", baselinePassed: true, candidatePassed: true, eligible: true, activated: false },
      { caseId: "ho-04", baselinePassed: true, candidatePassed: false, eligible: false, activated: false },
    ];
    const attr = attributeQualityV2(pairs);
    expect(attr.allPairs.netDelta).toBe(1); // 2 wins - 1 loss
    expect(attr.eligiblePairs.netDelta).toBe(1); // ho-02 win is eligible (+1)
    expect(attr.activatedPairs.netDelta).toBe(0); // nothing activated
    expect(attr.mechanismCausalSupported).toBe(false);
  });

  it("6b. wins on eligible AND activated pairs -> mechanism causality supported", () => {
    const pairs = [
      { caseId: "ho-01", baselinePassed: false, candidatePassed: true, eligible: true, activated: true },
      { caseId: "ho-02", baselinePassed: true, candidatePassed: false, eligible: true, activated: true },
      { caseId: "ho-03", baselinePassed: true, candidatePassed: true, eligible: false, activated: false },
    ];
    const attr = attributeQualityV2(pairs);
    expect(attr.eligiblePairs.netDelta).toBe(0);
    expect(attr.mechanismCausalSupported).toBe(false);
    // With a second activated win:
    const pairs2 = [
      { caseId: "ho-01", baselinePassed: false, candidatePassed: true, eligible: true, activated: true },
      { caseId: "ho-02", baselinePassed: true, candidatePassed: true, eligible: true, activated: true },
    ];
    const attr2 = attributeQualityV2(pairs2);
    expect(attr2.eligiblePairs.netDelta).toBe(1);
    expect(attr2.activatedPairs.netDelta).toBe(1);
    expect(attr2.mechanismCausalSupported).toBe(true);
  });

  it("7. recorder round-trips through JSON and revalidates (production writer->loader)", () => {
    const recorder = createActivationRecorderV2();
    recorder.record(mkEvent({
      eventId: "rt-1",
      mechanism: "context",
      evidenceType: "context-selection",
      payload: { digest: sha("context-digest"), entryCount: 12 },
    }));
    const serialized = JSON.stringify(recorder.events());
    const loaded = JSON.parse(serialized) as ActivationEventV2[];
    const result = validateActivationV2(loaded, {
      expectedCandidateId: "adaptive_recovery_v2",
      expectedArmId: "candidate",
    });
    expect(result.ok).toBe(true);
    expect(loaded[0]!.payload.digest).toBe(sha("context-digest"));
  });

  it("aggregator counts activated/eligibleButNotActivated/ineligible/invalid; unknown legacy is its own bucket", () => {
    const events = [
      mkEvent({ eventId: "a1", lineage: { caseId: "ho-01", armId: "candidate", attempt: 1, repetition: 1 }, payload: { digest: sha("x") } }),
      mkEvent({ eventId: "a2", lineage: { caseId: "ho-02", armId: "candidate", attempt: 1, repetition: 1 }, payload: { digest: sha("y") } }),
      mkEvent({ eventId: "bad", candidateId: "wrong", payload: { digest: sha("z") } }),
    ];
    const validation = validateActivationV2(events, {
      expectedCandidateId: "adaptive_recovery_v2",
      expectedArmId: "candidate",
    }) as ActivationValidationResultV2;
    const aggregation = aggregateActivationV2(events, {
      eligible: new Map([
        ["ho-01", true],
        ["ho-02", true],
        ["ho-03", false],
      ]),
    }, validation);
    expect(aggregation.activated).toBe(2);
    expect(aggregation.eligibleButNotActivated).toBe(0);
    expect(aggregation.ineligible).toBe(1);
    expect(aggregation.invalid).toBeGreaterThan(0);
  });
});