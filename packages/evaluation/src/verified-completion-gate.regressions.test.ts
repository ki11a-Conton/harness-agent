/**
 * P 轮 — `verified_completion_gate_v1` (agent-strategy candidate).
 *
 * Motivation is MEASURED, not asserted: the N5 holdout record shows the arm went
 * from 38 to 42 FALSE COMPLETES (claiming success with no observed verification),
 * and the promotion gates allow ZERO new false-completes; about 10% of arms spent
 * the 30-model-call budget before the verifying run.
 *
 * These regressions pin what the plan requires:
 *   - the gate text and digest are their own, and no existing candidate's bytes or
 *     digest moved (frozen values are asserted literally);
 *   - the text carries the observable obligations that make completion an
 *     OBSERVED claim, and adds no tool, no parameter and no permission change;
 *   - the candidate is really wired (registry, arm factory, contract);
 *   - activation is pinned to the gate's own signal AND version, so no other
 *     prompt-guidance injection can corroborate it.
 */

import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  CONTEXT_SAFE_TOOL_CALL_EFFICIENCY_GUIDANCE_V1,
  CONTEXT_SAFE_TOOL_CALL_EFFICIENCY_GUIDANCE_V2,
  contextSafeToolCallEfficiencyGuidanceDigest,
  contextSafeToolCallEfficiencyV2GuidanceDigest,
  toolCallEfficiencyGuidanceDigest,
  VERIFIED_COMPLETION_GATE_GUIDANCE_V1,
  VERIFIED_COMPLETION_GATE_GUIDANCE_VERSION,
  verifiedCompletionGateGuidanceDigest,
} from "./mechanism-guidance.js";
import {
  CONTEXT_SAFE_TOOL_CALL_EFFICIENCY_CANDIDATE_ID,
  CONTEXT_SAFE_TOOL_CALL_EFFICIENCY_V2_CANDIDATE_ID,
  VERIFIED_COMPLETION_GATE_CANDIDATE_ID,
  createCandidateRegistry,
} from "./candidate-registry.js";
import { getArmFactory } from "./arm-factory.js";
import { mechanismContractFor } from "./mechanism-contract.js";
import { activationEvidenceFor } from "./activation-evidence.js";
import { buildActivationEvidenceFromSignalsV2 } from "./activation-evidence-execution.js";

const sha256 = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex");

/** Digests frozen by the earlier rounds: they must not move. */
const FROZEN_CONTEXT_SAFE_V1 = "ce66f3b091752fdb38774914d2d3e5f736c0684930d5162f25ecdb5bed2d56c2";
const GATE_SIGNAL = "verified_completion_gate_guidance_injected";

describe("P — verified_completion_gate_v1", () => {
  it("1. the gate has its own version, text and digest, and disturbs no earlier candidate", () => {
    expect(VERIFIED_COMPLETION_GATE_GUIDANCE_VERSION).toBe("verified-completion-gate:v1");
    expect(verifiedCompletionGateGuidanceDigest()).toBe(sha256(VERIFIED_COMPLETION_GATE_GUIDANCE_V1));
    // Frozen earlier rounds, asserted literally: this round must not move them.
    expect(contextSafeToolCallEfficiencyGuidanceDigest()).toBe(FROZEN_CONTEXT_SAFE_V1);
    expect(contextSafeToolCallEfficiencyGuidanceDigest()).toBe(sha256(CONTEXT_SAFE_TOOL_CALL_EFFICIENCY_GUIDANCE_V1));
    expect(contextSafeToolCallEfficiencyV2GuidanceDigest()).toBe(
      sha256(CONTEXT_SAFE_TOOL_CALL_EFFICIENCY_GUIDANCE_V2),
    );
    const own = verifiedCompletionGateGuidanceDigest();
    expect(own).not.toBe(contextSafeToolCallEfficiencyGuidanceDigest());
    expect(own).not.toBe(contextSafeToolCallEfficiencyV2GuidanceDigest());
    expect(own).not.toBe(toolCallEfficiencyGuidanceDigest());
    expect(VERIFIED_COMPLETION_GATE_GUIDANCE_V1).not.toBe(CONTEXT_SAFE_TOOL_CALL_EFFICIENCY_GUIDANCE_V2);
  });

  it("2. the text makes completion an OBSERVED claim (the four obligations are present)", () => {
    const text = VERIFIED_COMPLETION_GATE_GUIDANCE_V1;
    // (a) rerun the deciding command AFTER the last change.
    expect(text).toContain("run the command that decides this task");
    expect(text).toContain("AFTER your last change to");
    // (b) success only from observed output, never from intent.
    expect(text).toContain("Report success only from output you actually observed");
    expect(text).toContain("is not a verified completion");
    expect(text).toContain("never a completion");
    // (c) an honest failure report is a correct outcome.
    expect(text).toContain("report the failure verbatim");
    expect(text).toContain("An honest failure report is a correct outcome");
    // (d) no-progress loops must change approach or stop.
    expect(text).toContain("change the approach or stop and report");
  });

  it("3. the text adds no tool, no new parameter and no permission/sandbox change", () => {
    const text = VERIFIED_COMPLETION_GATE_GUIDANCE_V1;
    // It may only reference capabilities that already exist.
    expect(text.toLowerCase()).not.toContain("bypass");
    expect(text.toLowerCase()).not.toContain("skip the check");
    expect(text.toLowerCase()).not.toContain("disable");
    expect(text).not.toMatch(/offset\s*[:=]/);
    expect(text).not.toMatch(/\blimit\s*[:=]/);
    // It is guidance, never a runtime interception claim.
    expect(text.toLowerCase()).not.toContain("i will intercept");
    expect(text.toLowerCase()).not.toContain("permission engine");
  });

  it("4. the candidate is really wired: registry, arm factory and mechanism contract", () => {
    const registry = createCandidateRegistry();
    expect(VERIFIED_COMPLETION_GATE_CANDIDATE_ID).toBe("verified_completion_gate_v1");
    expect(registry.find(VERIFIED_COMPLETION_GATE_CANDIDATE_ID)).toBeDefined();
    expect(() => registry.validateActive(VERIFIED_COMPLETION_GATE_CANDIDATE_ID)).not.toThrow();
    const resolved = registry.resolve(VERIFIED_COMPLETION_GATE_CANDIDATE_ID);
    expect(resolved.hasSemanticDelta).toBe(true);
    expect(resolved.semanticDigest).not.toBe(registry.resolveBaseline().semanticDigest);
    // A real semantic delta that is its OWN: not the v1 nor the v2 arm.
    expect(resolved.semanticDigest).not.toBe(registry.resolve(CONTEXT_SAFE_TOOL_CALL_EFFICIENCY_CANDIDATE_ID).semanticDigest);
    expect(resolved.semanticDigest).not.toBe(
      registry.resolve(CONTEXT_SAFE_TOOL_CALL_EFFICIENCY_V2_CANDIDATE_ID).semanticDigest,
    );

    const factory = getArmFactory();
    const arm = factory.resolveRuntimeMechanisms(VERIFIED_COMPLETION_GATE_CANDIDATE_ID);
    expect(arm.verifiedCompletionGate).toBe(true);
    // The gate does not piggyback on any other mechanism's switch.
    expect(arm.contextSafeToolCallEfficiency).toBeUndefined();
    expect(arm.contextSafeToolCallEfficiencyV2).toBeUndefined();
    expect(arm.toolCallEfficiency).toBe(false);
    expect(arm.promptAdditionsDigest).toBe(verifiedCompletionGateGuidanceDigest());
    expect(factory.preflight(VERIFIED_COMPLETION_GATE_CANDIDATE_ID).ok).toBe(true);

    const contract = mechanismContractFor(VERIFIED_COMPLETION_GATE_CANDIDATE_ID);
    expect(contract).toBeDefined();
    expect(contract!.candidateId).toBe(VERIFIED_COMPLETION_GATE_CANDIDATE_ID);
    expect(contract!.requiredActivationEvents).toEqual(["verified-completion-gate-guidance-injected"]);
    expect(contract!.expectedFailureCluster).toContain("false-complete");
    expect(contract!.forbiddenNoOpConditions.join("\n")).toContain("completion claimed from intent");
  });

  it("5. no pre-existing arm gains the gate, and their identities are untouched", () => {
    const factory = getArmFactory();
    const baseline = factory.resolveRuntimeMechanisms(null);
    const v1 = factory.resolveRuntimeMechanisms(CONTEXT_SAFE_TOOL_CALL_EFFICIENCY_CANDIDATE_ID);
    const v2 = factory.resolveRuntimeMechanisms(CONTEXT_SAFE_TOOL_CALL_EFFICIENCY_V2_CANDIDATE_ID);
    for (const arm of [baseline, v1, v2]) {
      expect("verifiedCompletionGate" in arm).toBe(false);
    }
    expect(baseline.promptAdditionsDigest).toBeNull();
    expect(v1.promptAdditionsDigest).toBe(FROZEN_CONTEXT_SAFE_V1);
    expect(v2.promptAdditionsDigest).toBe(contextSafeToolCallEfficiencyV2GuidanceDigest());

    const gate = factory.resolveRuntimeMechanisms(VERIFIED_COMPLETION_GATE_CANDIDATE_ID);
    expect(JSON.stringify(gate)).not.toBe(JSON.stringify(baseline));
    expect(JSON.stringify(gate)).not.toBe(JSON.stringify(v1));
    expect(JSON.stringify(gate)).not.toBe(JSON.stringify(v2));
  });

  it("6. legacy activation evidence is pinned to the gate's signal AND version", () => {
    const caseDef = { id: "n7e-compact-01-build-jobs" };
    const own = [
      {
        type: GATE_SIGNAL as "verified_completion_gate_guidance_injected",
        payload: { guidanceVersion: VERIFIED_COMPLETION_GATE_GUIDANCE_VERSION, blockText: VERIFIED_COMPLETION_GATE_GUIDANCE_V1 },
      },
    ];
    const activated = activationEvidenceFor(VERIFIED_COMPLETION_GATE_CANDIDATE_ID, caseDef, own);
    expect(activated.activated).toBe(true);
    expect(activated.activationCount).toBe(1);
    expect(activated.reasonCodes).toEqual([GATE_SIGNAL]);

    // Another candidate's injection does NOT activate the gate.
    const foreign = [
      {
        type: "context_safe_tool_call_efficiency_guidance_injected" as const,
        payload: { guidanceVersion: "context-safe-tool-call-efficiency:v2", blockText: CONTEXT_SAFE_TOOL_CALL_EFFICIENCY_GUIDANCE_V2 },
      },
    ];
    expect(activationEvidenceFor(VERIFIED_COMPLETION_GATE_CANDIDATE_ID, caseDef, foreign).activated).toBe(false);
    // The gate's own signal with a WRONG version is likewise not activation.
    const wrongVersion = [
      { type: GATE_SIGNAL as "verified_completion_gate_guidance_injected", payload: { guidanceVersion: "verified-completion-gate:v2" } },
    ];
    expect(activationEvidenceFor(VERIFIED_COMPLETION_GATE_CANDIDATE_ID, caseDef, wrongVersion).activated).toBe(false);
    // A run that never reached the model reports nothing.
    expect(activationEvidenceFor(VERIFIED_COMPLETION_GATE_CANDIDATE_ID, caseDef, []).activated).toBe(false);
  });

  it("7. execution-bound evidence digests the bytes the model actually saw", () => {
    const base = {
      candidateId: VERIFIED_COMPLETION_GATE_CANDIDATE_ID,
      caseId: "n7e-compact-01-build-jobs",
      armId: "arm-b",
      attempt: 1,
      repetition: 1,
      eligible: true,
      approvedPromptAdditionsDigest: verifiedCompletionGateGuidanceDigest(),
    };
    const own = buildActivationEvidenceFromSignalsV2({
      ...base,
      signals: [
        {
          type: GATE_SIGNAL as "verified_completion_gate_guidance_injected",
          payload: { guidanceVersion: VERIFIED_COMPLETION_GATE_GUIDANCE_VERSION, blockText: VERIFIED_COMPLETION_GATE_GUIDANCE_V1 },
        },
      ],
    });
    expect(own.validation.ok).toBe(true);
    expect(own.events[0]!.payload.digest).toBe(verifiedCompletionGateGuidanceDigest());

    // A different block reaching the model is NOT this candidate's activation.
    const other = buildActivationEvidenceFromSignalsV2({
      ...base,
      signals: [
        {
          type: "context_safe_tool_call_efficiency_guidance_injected" as const,
          payload: { guidanceVersion: "context-safe-tool-call-efficiency:v2", blockText: CONTEXT_SAFE_TOOL_CALL_EFFICIENCY_GUIDANCE_V2 },
        },
      ],
    });
    expect(other.events[0]!.payload.digest).not.toBe(verifiedCompletionGateGuidanceDigest());
    // No signal → no activation claim at all.
    expect(buildActivationEvidenceFromSignalsV2({ ...base, signals: [] }).events).toHaveLength(0);
  });
});
