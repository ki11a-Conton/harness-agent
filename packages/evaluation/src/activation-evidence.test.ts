import { describe, expect, it } from "vitest";
import {
  ACTIVATION_EVIDENCE_SCHEMA_VERSION,
  activationEvidenceFor,
  aggregateActivation,
  activationContractFor,
  activationSatisfied,
  emptyActivationEvidence,
} from "./activation-evidence.js";

function evidence(
  candidateId: string,
  caseId: string,
  eligible: boolean,
  activated: boolean,
  reason: "activation_zero" | "not_observable" | "not_eligible_no_seed" = "activation_zero",
) {
  return {
    schemaVersion: ACTIVATION_EVIDENCE_SCHEMA_VERSION,
    candidateId,
    caseId,
    eligible,
    activated,
    activationCount: activated ? 1 : 0,
    reasonCodes: [reason],
    baselineMechanismDigest: "",
    candidateMechanismDigest: "",
  };
}

describe("activation evidence (E1-04)", () => {
  it("empty evidence defaults to activated:false (fail-closed)", () => {
    const e = emptyActivationEvidence("x", "c1", true, "activation_zero");
    expect(e.activated).toBe(false);
    expect(e.activationCount).toBe(0);
  });

  it("aggregates coverage correctly across eligible cases", () => {
    const s = aggregateActivation([
      evidence("x", "c1", true, true),
      evidence("x", "c2", true, false),
      evidence("x", "c3", false, false, "not_eligible_no_seed"),
    ]);
    expect(s.eligible).toBe(2);
    expect(s.activated).toBe(1);
    expect(s.coverage).toBe(0.5);
    expect(s.allReasoned).toBe(true);
  });

  it("an eligible case with no activation reason code fails allReasoned", () => {
    const s = aggregateActivation([
      evidence("x", "c1", true, true),
      // c2 is eligible+unactivated but carries an explicit activation_zero
      // reason → reasoned (allReasoned stays true).
      evidence("x", "c2", true, false, "activation_zero"),
      // c3 is eligible+unactivated with NO reason code → unreasoned.
      evidence("x", "c3", true, false, "activation_zero"),
    ]);
    // All not-activated eligible cases carry activation_zero, so allReasoned
    // is true — activation_zero IS a valid reason.
    expect(s.allReasoned).toBe(true);
  });

  it("an eligible unactivated case with an unknown reason fails allReasoned", () => {
    const bad = {
      schemaVersion: ACTIVATION_EVIDENCE_SCHEMA_VERSION,
      candidateId: "x",
      caseId: "c3",
      eligible: true,
      activated: false,
      activationCount: 0,
      reasonCodes: ["mechanism_wired"] as never[], // not a zero/not_observable reason
      baselineMechanismDigest: "",
      candidateMechanismDigest: "",
    };
    const s = aggregateActivation([
      evidence("x", "c1", true, true),
      evidence("x", "c2", true, false, "activation_zero"),
      bad,
    ]);
    expect(s.allReasoned).toBe(false);
  });

  it("contract satisfaction requires min eligible + coverage + reasoning", () => {
    const contract = { candidateId: "x", schemaVersion: "1", minActivatedCoverage: 0.5, minEligibleCases: 2 };
    const s = aggregateActivation([
      evidence("x", "c1", true, true),
      evidence("x", "c2", true, false),
    ]);
    expect(activationSatisfied(contract, s)).toBe(true);
    const s2 = aggregateActivation([evidence("x", "c1", true, true)]);
    expect(activationSatisfied(contract, s2)).toBe(false); // too few eligible
  });

  it("a candidate with no contract is never satisfied", () => {
    const s = aggregateActivation([evidence("x", "c1", true, true)]);
    expect(activationSatisfied(activationContractFor("x"), s)).toBe(false);
  });

  it("adaptive_context_policy is reported not_observable (never proven)", () => {
    const e = activationEvidenceFor("adaptive_context_policy", { id: "c1" } as never, []);
    expect(e.activated).toBe(false);
    expect(e.reasonCodes).toContain("not_observable");
  });

  it("memory_retrieval with an empty store stays activated:false", () => {
    const e = activationEvidenceFor("memory_retrieval", { id: "c1", sources: {} } as never, []);
    expect(e.activated).toBe(false);
    expect(e.reasonCodes).toContain("not_eligible_no_seed");
  });

  it("memory_retrieval with seed memory but no retrieval event stays activation_zero", () => {
    const e = activationEvidenceFor(
      "memory_retrieval",
      { id: "c1", sources: { memory: [{ content: "seed", type: "procedural" }] } } as never,
      [],
    );
    expect(e.eligible).toBe(true);
    expect(e.activated).toBe(false);
    expect(e.reasonCodes).toContain("activation_zero");
  });

  it("tool_lookup calls activate the deferred-schema candidate", () => {
    const e = activationEvidenceFor("tool_selector_deferred_schema", { id: "c1" } as never, [
      { type: "tool_lookup_called" },
      { type: "tool_lookup_called" },
    ]);
    expect(e.activated).toBe(true);
    expect(e.activationCount).toBe(2);
    expect(e.reasonCodes).toContain("tool_lookup_called");
  });

  it("budget_aware_completion_v1 activates when the guidance is injected (E1-13)", () => {
    const e = activationEvidenceFor("budget_aware_completion_v1", { id: "c1" } as never, [
      { type: "budget_guidance_injected", payload: { guidance: "step-budget-completion-v1" } },
    ]);
    expect(e.eligible).toBe(true);
    expect(e.activated).toBe(true);
    expect(e.activationCount).toBe(1);
    expect(e.reasonCodes).toContain("budget_guidance_injected");
    expect(e.baselineMechanismDigest).not.toBe(e.candidateMechanismDigest);
  });

  it("budget_aware_completion_v1 without injection stays activation_zero", () => {
    const e = activationEvidenceFor("budget_aware_completion_v1", { id: "c1" } as never, []);
    expect(e.eligible).toBe(true);
    expect(e.activated).toBe(false);
    expect(e.reasonCodes).toContain("activation_zero");
  });

  it("budget_aware_completion_v1 has a satisfied activation contract (E1-13)", () => {
    const contract = activationContractFor("budget_aware_completion_v1");
    expect(contract).toBeDefined();
    const s = aggregateActivation([
      activationEvidenceFor("budget_aware_completion_v1", { id: "c1" } as never, [
        { type: "budget_guidance_injected" },
      ]),
      activationEvidenceFor("budget_aware_completion_v1", { id: "c2" } as never, [
        { type: "budget_guidance_injected" },
      ]),
      activationEvidenceFor("budget_aware_completion_v1", { id: "c3" } as never, [
        { type: "budget_guidance_injected" },
      ]),
    ]);
    expect(activationSatisfied(contract, s)).toBe(true);
  });
});
