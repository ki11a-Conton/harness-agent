import { describe, expect, it } from "vitest";
import {
  buildActivationEvidenceFromSignalsV2,
  type ActivationEvidenceExecutionInput,
} from "./activation-evidence-execution.js";
import {
  TOOL_CALL_EFFICIENCY_GUIDANCE_V1,
  TOOL_CALL_EFFICIENCY_GUIDANCE_VERSION,
  toolCallEfficiencyGuidanceDigest,
} from "./mechanism-guidance.js";

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

/**
 * P2 — the prompt-guidance activation event must be a digest of the ACTUAL
 * model-visible block bytes, not of a fixed {guidance:"…"} label. Editing the
 * strategy text one byte must change the evidence digest and be caught against
 * the approved arm's prompt-additions digest.
 */
describe("P2: prompt-guidance activation binds the real model-visible block bytes", () => {
  const guidanceSignal = (blockText: string) => ({
    type: "tool_call_efficiency_guidance_injected" as const,
    payload: { guidanceVersion: TOOL_CALL_EFFICIENCY_GUIDANCE_VERSION, blockText },
  });
  const build = (signals: ReturnType<typeof guidanceSignal>[]) =>
    buildActivationEvidenceFromSignalsV2({
      ...base,
      candidateId: "tool_call_efficiency_v1",
      eligible: true,
      approvedPromptAdditionsDigest: toolCallEfficiencyGuidanceDigest(),
      signals,
    });

  it("the event digest IS the digest of the injected block, equal to the approved arm digest", () => {
    const r = build([guidanceSignal(TOOL_CALL_EFFICIENCY_GUIDANCE_V1)]);
    const ev = r.events[0]!;
    expect(ev.payload.digest).toBe(toolCallEfficiencyGuidanceDigest());
    expect(ev.payload.blockLength).toBe(TOOL_CALL_EFFICIENCY_GUIDANCE_V1.length);
    expect(r.validation.ok).toBe(true);
    expect(r.aggregation.activated).toBe(1);
  });

  it("same block twice -> identical digest; one byte changed -> different digest and fail closed", () => {
    const a = build([guidanceSignal(TOOL_CALL_EFFICIENCY_GUIDANCE_V1)]);
    const b = build([guidanceSignal(TOOL_CALL_EFFICIENCY_GUIDANCE_V1)]);
    expect(a.events[0]!.payload.digest).toBe(b.events[0]!.payload.digest);

    // Same length, one byte different — the old label-only digest was invariant.
    const altered = TOOL_CALL_EFFICIENCY_GUIDANCE_V1.replace("Tool-call", "tool-call");
    expect(altered).not.toBe(TOOL_CALL_EFFICIENCY_GUIDANCE_V1);
    expect(altered.length).toBe(TOOL_CALL_EFFICIENCY_GUIDANCE_V1.length);
    const c = build([guidanceSignal(altered)]);
    expect(c.events[0]!.payload.digest).not.toBe(toolCallEfficiencyGuidanceDigest());
    expect(c.validation.ok).toBe(false);
    expect(c.validation.issues.some((i) => i.code === "PROMPT_GUIDANCE_UNBOUND")).toBe(true);
    expect(c.aggregation.activated).toBe(0);
  });

  it("label-only activation (no real block bytes) is rejected and never counts as activated", () => {
    const r = buildActivationEvidenceFromSignalsV2({
      ...base,
      candidateId: "tool_call_efficiency_v1",
      eligible: true,
      approvedPromptAdditionsDigest: toolCallEfficiencyGuidanceDigest(),
      // The legacy shape: a fixed label with no link to what the model saw.
      signals: [{ type: "tool_call_efficiency_guidance_injected", payload: { guidance: "tool-call-efficiency-v1" } }],
    });
    expect(r.validation.ok).toBe(false);
    expect(r.validation.issues.some((i) => i.code === "PROMPT_GUIDANCE_UNBOUND")).toBe(true);
    expect(r.aggregation.activated).toBe(0);
  });
});
