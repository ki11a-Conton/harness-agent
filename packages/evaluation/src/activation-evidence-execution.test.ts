import { describe, expect, it } from "vitest";
import {
  buildActivationEvidenceFromSignalsV2,
  type ActivationEvidenceExecutionInput,
} from "./activation-evidence-execution.js";

const base: Omit<ActivationEvidenceExecutionInput, "signals" | "eligible"> = {
  candidateId: "adaptive_recovery",
  caseId: "case-1",
  armId: "candidate",
  attempt: 1,
  repetition: 1,
};

describe("E4-04: activation evidence V2 from real signals", () => {
  it("records one event per observed signal with a real payload digest + lineage", () => {
    const r = buildActivationEvidenceFromSignalsV2({
      ...base,
      eligible: true,
      signals: [
        { type: "recovery_decision", payload: { action: "retry", policyId: "p1" } },
        { type: "tool_lookup_called", payload: { name: "tool_lookup" } },
      ],
    });
    expect(r.events).toHaveLength(2);
    expect(r.events[0]!.mechanism).toBe("recovery");
    expect(r.events[0]!.evidenceType).toBe("recovery-decided");
    expect(r.events[1]!.mechanism).toBe("tool-schema");
    // lineage threaded through from the input.
    expect(r.events[0]!.lineage).toEqual({ caseId: "case-1", armId: "candidate", attempt: 1, repetition: 1 });
    // digest is a 64-hex sha256, not a hard-coded string.
    expect(r.events[0]!.payload.digest).toMatch(/^[0-9a-f]{64}$/);
    expect(r.validation.ok).toBe(true);
    expect(r.aggregation.activated).toBe(2);
  });

  it("E4-04 #1: a candidate that flips only a flag (NO signals) is eligibleButNotActivated, never activated", () => {
    const r = buildActivationEvidenceFromSignalsV2({ ...base, eligible: true, signals: [] });
    expect(r.events).toHaveLength(0);
    expect(r.aggregation.activated).toBe(0);
    expect(r.aggregation.eligibleButNotActivated).toBe(1);
  });

  it("digest is a real function of the payload (different payloads differ; same payload repeats)", () => {
    const a = buildActivationEvidenceFromSignalsV2({
      ...base, eligible: true,
      signals: [{ type: "recovery_decision", payload: { action: "retry" } }],
    });
    const b = buildActivationEvidenceFromSignalsV2({
      ...base, eligible: true,
      signals: [{ type: "recovery_decision", payload: { action: "abort" } }],
    });
    const c = buildActivationEvidenceFromSignalsV2({
      ...base, eligible: true,
      signals: [{ type: "recovery_decision", payload: { action: "retry" } }],
    });
    expect(a.events[0]!.payload.digest).not.toBe(b.events[0]!.payload.digest);
    expect(a.events[0]!.payload.digest).toBe(c.events[0]!.payload.digest);
  });

  it("memory retrieval with an empty injection is flagged (eligibleButNotActivated, not activated)", () => {
    const r = buildActivationEvidenceFromSignalsV2({
      ...base, candidateId: "memory_retrieval", eligible: true,
      signals: [{ type: "memory_retrieved", payload: { count: 0 } }],
    });
    expect(r.events[0]!.payload.entryCount).toBe(0);
    // EMPTY_MEMORY_INJECTION makes validation fail closed → counted invalid, not activated.
    expect(r.validation.ok).toBe(false);
    expect(r.validation.issues.some((i) => i.code === "EMPTY_MEMORY_INJECTION")).toBe(true);
    expect(r.aggregation.activated).toBe(0);
    expect(r.aggregation.invalid).toBeGreaterThan(0);
  });

  it("an ineligible case contributes to the ineligible bucket, not activation", () => {
    const r = buildActivationEvidenceFromSignalsV2({
      ...base, eligible: false,
      signals: [{ type: "recovery_decision", payload: { action: "retry" } }],
    });
    expect(r.aggregation.ineligible).toBe(1);
    expect(r.aggregation.activated).toBe(0);
  });

  it("unknown signal types are ignored (never fabricate an event)", () => {
    const r = buildActivationEvidenceFromSignalsV2({
      ...base, eligible: true,
      signals: [{ type: "not_a_real_signal" as never, payload: {} }],
    });
    expect(r.events).toHaveLength(0);
  });
});
