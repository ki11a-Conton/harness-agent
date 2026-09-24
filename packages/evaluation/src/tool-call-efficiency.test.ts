import { describe, expect, it } from "vitest";
import { getArmFactory } from "./arm-factory.js";
import { mechanismContractFor } from "./mechanism-contract.js";
import { activationEvidenceFor } from "./activation-evidence.js";
import { buildActivationEvidenceFromSignalsV2 } from "./activation-evidence-execution.js";
import {
  TOOL_CALL_EFFICIENCY_GUIDANCE_V1,
  TOOL_CALL_EFFICIENCY_GUIDANCE_VERSION,
  toolCallEfficiencyGuidanceDigest,
} from "./mechanism-guidance.js";
import {
  BUDGET_AWARE_COMPLETION_GUIDANCE_V1,
  budgetAwareCompletionGuidanceDigest,
} from "./mechanism-guidance.js";

/**
 * N5 (agent_limit failure cluster) — tool_call_efficiency_v1.
 *
 * The N4 evidence scan (§10.4 of docs/E4-R99-R101-report.md) found the dominant
 * REAL failure cluster is `agent_limit` (27/59): every failing case exhausted the
 * 30-model-call budget while issuing many FAILED tool calls. This candidate's
 * mechanism is a system-prompt strategy block that attacks *why* the iterations
 * are wasted (repeat/retry of failing tool calls), which is a DIFFERENT mechanism
 * from the already-REJECTED budget_aware_completion_v1 (which changed how the last
 * iterations are spent).
 *
 * Everything here is offline and deterministic: no provider, no API key, no cost.
 * The activation surface asserted below (guidance present in the model-visible
 * prompt) is what the real runner wires in apps/cli/src/benchmark-command.ts.
 */
describe("N5 tool_call_efficiency_v1 — agent-strategy challenger", () => {
  it("guidance text + digest are deterministic and distinct from budget guidance (no-op guard)", () => {
    expect(TOOL_CALL_EFFICIENCY_GUIDANCE_VERSION).toBe("tool-call-efficiency:v1");
    expect(TOOL_CALL_EFFICIENCY_GUIDANCE_V1.length).toBeGreaterThan(0);
    // Forbidden no-op condition (mechanism-contract): the text must NOT be a
    // copy of the budget guidance — otherwise it is the rejected mechanism again.
    expect(TOOL_CALL_EFFICIENCY_GUIDANCE_V1).not.toBe(BUDGET_AWARE_COMPLETION_GUIDANCE_V1);
    expect(toolCallEfficiencyGuidanceDigest()).not.toBe(budgetAwareCompletionGuidanceDigest());
    // The digest is a real sha256 over the actual text, deterministic.
    expect(toolCallEfficiencyGuidanceDigest()).toMatch(/^[0-9a-f]{64}$/);
    expect(toolCallEfficiencyGuidanceDigest()).toBe(
      toolCallEfficiencyGuidanceDigest(),
    );
  });

  it("arm wiring turns the mechanism ON and binds the digest of the real text", () => {
    const factory = getArmFactory();
    const baseline = factory.resolveArm(null);
    const candidate = factory.resolveArm("tool_call_efficiency_v1");

    // Baseline must NOT already have the mechanism (no causal contamination).
    expect(baseline.runtimeMechanisms.toolCallEfficiency).toBe(false);
    expect(baseline.runtimeMechanisms.promptAdditionsDigest).toBeNull();

    expect(candidate.runtimeMechanisms.toolCallEfficiency).toBe(true);
    expect(candidate.runtimeMechanisms.promptAdditionsDigest).toBe(
      toolCallEfficiencyGuidanceDigest(),
    );
    // A real semantic delta: candidate identity ≠ baseline identity.
    expect(candidate.digest).not.toBe(baseline.digest);
  });

  it("mechanism contract targets the agent_limit cluster and is causally ready", () => {
    const contract = mechanismContractFor("tool_call_efficiency_v1");
    expect(contract).toBeDefined();
    expect(contract!.expectedFailureCluster).toContain("agent_limit");
    expect(contract!.minEligibleCases).toBe(5);
    expect(contract!.requiredActivationEvents).toContain(
      "tool-call-efficiency-guidance-injected",
    );
    expect(contract!.forbiddenNoOpConditions.join(" ")).toContain(
      "budget_aware_completion_v1",
    );
  });

  it("RED/GREEN: activation requires the guidance to be really injected (fail closed)", () => {
    const caseDef = { id: "reg-08-quicksort" };

    // GREEN: the runner injected the guidance into the model-visible prompt.
    const injected = activationEvidenceFor("tool_call_efficiency_v1", caseDef, [
      { type: "tool_call_efficiency_guidance_injected", payload: { guidance: "tool-call-efficiency-v1" } },
    ]);
    expect(injected.eligible).toBe(true);
    expect(injected.activated).toBe(true);
    expect(injected.activationCount).toBe(1);
    expect(injected.reasonCodes).toContain("tool_call_efficiency_guidance_injected");
    expect(injected.candidateMechanismDigest).not.toBe(injected.baselineMechanismDigest);

    // RED: a candidate that only flips a flag and injects nothing is NOT activated.
    const zero = activationEvidenceFor("tool_call_efficiency_v1", caseDef, []);
    expect(zero.activated).toBe(false);
    expect(zero.activationCount).toBe(0);
    expect(zero.reasonCodes).toEqual(["activation_zero"]);
  });

  it("V2 recorder maps the new signal to a real prompt-guidance activation event", () => {
    const result = buildActivationEvidenceFromSignalsV2({
      candidateId: "tool_call_efficiency_v1",
      caseId: "reg-08-quicksort",
      armId: "candidate",
      attempt: 1,
      repetition: 1,
      eligible: true,
      signals: [
        { type: "tool_call_efficiency_guidance_injected", payload: { guidance: "tool-call-efficiency-v1" } },
      ],
    });
    expect(result.validation.ok).toBe(true);
    expect(result.events.length).toBe(1);
    const event = result.events[0]!;
    expect(event.mechanism).toBe("prompt-guidance");
    expect(event.evidenceType).toBe("prompt-guidance-injected");
    expect(event.payload.digest).toMatch(/^[0-9a-f]{64}$/);
    expect(result.aggregation.activated).toBe(1);
  });

  it("regression guard: the mechanism is OFF for every other candidate", () => {
    const factory = getArmFactory();
    for (const id of ["memory_retrieval", "adaptive_recovery_v2", "budget_aware_completion_v1"]) {
      expect(factory.resolveArm(id).runtimeMechanisms.toolCallEfficiency).toBe(false);
    }
  });
});