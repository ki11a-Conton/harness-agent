/**
 * N7 / N7-1 — `context_safe_tool_call_efficiency_v2` (agent-strategy candidate).
 *
 * The v2 challenger exists because of a MEASURED N5 diagnosis, not a guess: v1's
 * text always reached the model (activation 95/95 and 83/83), yet its trigger —
 * "the text you need is still visible" — was not reliably self-observable, so
 * the same rule was applied inconsistently (main group +7.29pp with a lower
 * bound of -4.69pp; the independent holdout did not transfer). v2 changes ONE
 * rule: the freshness precondition becomes an explicit, observable pre-edit step
 * (state the exact text about to change and confirm it is visible now; otherwise
 * re-read with versioned=true and compare sha256; locate oversized files with
 * grep_search because read_file has no offset/limit).
 *
 * These regressions pin what the N7 plan requires:
 *   - the v1 text, digest and arm identity are BYTE-IDENTICAL to what N5 froze;
 *   - v2 has its own id, text, digest, contract and arm wiring;
 *   - activation is bound to the v2 VERSION and the v2 DIGEST, so a v1 injection
 *     (or a flags-only / uninstalled run) can never corroborate v2;
 *   - the change is one rule: the shared bullets stay verbatim.
 */

import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  CONTEXT_SAFE_TOOL_CALL_EFFICIENCY_GUIDANCE_V1,
  CONTEXT_SAFE_TOOL_CALL_EFFICIENCY_GUIDANCE_V2,
  CONTEXT_SAFE_TOOL_CALL_EFFICIENCY_GUIDANCE_VERSION,
  CONTEXT_SAFE_TOOL_CALL_EFFICIENCY_V2_GUIDANCE_VERSION,
  contextSafeToolCallEfficiencyGuidanceDigest,
  contextSafeToolCallEfficiencyV2GuidanceDigest,
  TOOL_CALL_EFFICIENCY_GUIDANCE_VERSION,
  toolCallEfficiencyGuidanceDigest,
} from "./mechanism-guidance.js";
import {
  CONTEXT_SAFE_TOOL_CALL_EFFICIENCY_CANDIDATE_ID,
  CONTEXT_SAFE_TOOL_CALL_EFFICIENCY_V2_CANDIDATE_ID,
  createCandidateRegistry,
} from "./candidate-registry.js";
import { getArmFactory } from "./arm-factory.js";
import { mechanismContractFor } from "./mechanism-contract.js";
import { activationEvidenceFor } from "./activation-evidence.js";
import { buildActivationEvidenceFromSignalsV2 } from "./activation-evidence-execution.js";

const sha256 = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex");

/** The v1 digest the N5 pre-registration (#main-preregistration.json) froze. */
const FROZEN_V1_GUIDANCE_DIGEST = "ce66f3b091752fdb38774914d2d3e5f736c0684930d5162f25ecdb5bed2d56c2";

/** The bullets v2 deliberately reuses VERBATIM from v1. */
const SHARED_BULLETS = [
  "- A turn allows a limited number of model iterations (typically 30 model\n  calls). This limit counts MODEL CALLS, not tool calls: you may attach\n  several tool calls to one model call, so tool calls can outnumber model\n  calls.",
  "- Before repeating a tool call that just failed, change something — the\n  arguments, the target, or the approach. Re-issuing an identical call with\n  the same arguments against unchanged state tends to fail the same way and\n  only spends an iteration.",
  "- Only abandon a tool when it keeps failing the SAME way with unchanged\n  inputs and no change in state. Once you have fixed the underlying cause,\n  calling the same tool again (for example re-running the test command) is\n  expected and correct.",
  "- Make each edit complete before moving on, so the verification command you\n  run near the end reflects finished work rather than a half-applied change.",
];

describe("N7/N7-1 — context_safe_tool_call_efficiency_v2", () => {
  it("1. the v1 candidate is untouched: same bytes, same digest, same version", () => {
    expect(sha256(CONTEXT_SAFE_TOOL_CALL_EFFICIENCY_GUIDANCE_V1)).toBe(FROZEN_V1_GUIDANCE_DIGEST);
    expect(contextSafeToolCallEfficiencyGuidanceDigest()).toBe(FROZEN_V1_GUIDANCE_DIGEST);
    expect(CONTEXT_SAFE_TOOL_CALL_EFFICIENCY_GUIDANCE_VERSION).toBe("context-safe-tool-call-efficiency:v1");
    // The v1 text still carries its own freshness rule, unchanged.
    expect(CONTEXT_SAFE_TOOL_CALL_EFFICIENCY_GUIDANCE_V1).toContain(
      "- Do not re-read a file whose current content and version you can still see,",
    );
  });

  it("2. v2 has its own version, text and digest — never equal to v1 or to any earlier guidance", () => {
    expect(CONTEXT_SAFE_TOOL_CALL_EFFICIENCY_V2_GUIDANCE_VERSION).toBe("context-safe-tool-call-efficiency:v2");
    expect(CONTEXT_SAFE_TOOL_CALL_EFFICIENCY_V2_GUIDANCE_VERSION).not.toBe(
      CONTEXT_SAFE_TOOL_CALL_EFFICIENCY_GUIDANCE_VERSION,
    );
    expect(contextSafeToolCallEfficiencyV2GuidanceDigest()).toBe(
      sha256(CONTEXT_SAFE_TOOL_CALL_EFFICIENCY_GUIDANCE_V2),
    );
    expect(contextSafeToolCallEfficiencyV2GuidanceDigest()).not.toBe(contextSafeToolCallEfficiencyGuidanceDigest());
    expect(contextSafeToolCallEfficiencyV2GuidanceDigest()).not.toBe(toolCallEfficiencyGuidanceDigest());
    expect(CONTEXT_SAFE_TOOL_CALL_EFFICIENCY_GUIDANCE_V2).not.toBe(CONTEXT_SAFE_TOOL_CALL_EFFICIENCY_GUIDANCE_V1);
  });

  it("3. v2 is a ONE-RULE change: the shared bullets are reused byte-for-byte", () => {
    for (const bullet of SHARED_BULLETS) {
      expect(CONTEXT_SAFE_TOOL_CALL_EFFICIENCY_GUIDANCE_V1, `v1 lost a shared bullet`).toContain(bullet);
      expect(CONTEXT_SAFE_TOOL_CALL_EFFICIENCY_GUIDANCE_V2, `v2 dropped a shared bullet`).toContain(bullet);
    }
    // v1's freshness sentences are gone from v2 …
    expect(CONTEXT_SAFE_TOOL_CALL_EFFICIENCY_GUIDANCE_V2).not.toContain("do not re-read a\n  file you have already read");
    expect(CONTEXT_SAFE_TOOL_CALL_EFFICIENCY_GUIDANCE_V2).not.toContain(
      "but never edit a file from memory, from a summary or from a citation",
    );
    // … and v2's observable step is absent from v1 (so the two are distinguishable).
    expect(CONTEXT_SAFE_TOOL_CALL_EFFICIENCY_GUIDANCE_V1).not.toContain("make the freshness check an explicit step");
    expect(CONTEXT_SAFE_TOOL_CALL_EFFICIENCY_GUIDANCE_V1).not.toContain("versioned=true");
    expect(CONTEXT_SAFE_TOOL_CALL_EFFICIENCY_GUIDANCE_V1).not.toContain("grep_search");
    // The observable pre-edit step really is in v2, with the real tools named.
    expect(CONTEXT_SAFE_TOOL_CALL_EFFICIENCY_GUIDANCE_V2).toContain("confirm that text is visible");
    expect(CONTEXT_SAFE_TOOL_CALL_EFFICIENCY_GUIDANCE_V2).toContain("with versioned=true and");
    expect(CONTEXT_SAFE_TOOL_CALL_EFFICIENCY_GUIDANCE_V2).toContain("use grep_search to locate the exact key or line");
    expect(CONTEXT_SAFE_TOOL_CALL_EFFICIENCY_GUIDANCE_V2).toContain("read_file takes no offset/limit parameter");
    expect(CONTEXT_SAFE_TOOL_CALL_EFFICIENCY_GUIDANCE_V2).toContain("Never edit a file from a summary");
  });

  it("4. the candidate is really wired: registry, arm factory and mechanism contract", () => {
    const registry = createCandidateRegistry();
    expect(registry.find(CONTEXT_SAFE_TOOL_CALL_EFFICIENCY_V2_CANDIDATE_ID)).toBeDefined();
    expect(() => registry.validateActive(CONTEXT_SAFE_TOOL_CALL_EFFICIENCY_V2_CANDIDATE_ID)).not.toThrow();
    const resolved = registry.resolve(CONTEXT_SAFE_TOOL_CALL_EFFICIENCY_V2_CANDIDATE_ID);
    expect(resolved.hasSemanticDelta).toBe(true);
    expect(resolved.semanticDigest).not.toBe(registry.resolveBaseline().semanticDigest);
    // …and its semantic digest differs from the v1 candidate's, so the two
    // versions are never interchangeable in a manifest.
    expect(resolved.semanticDigest).not.toBe(
      registry.resolve(CONTEXT_SAFE_TOOL_CALL_EFFICIENCY_CANDIDATE_ID).semanticDigest,
    );

    const factory = getArmFactory();
    const arm = factory.resolveRuntimeMechanisms(CONTEXT_SAFE_TOOL_CALL_EFFICIENCY_V2_CANDIDATE_ID);
    expect(arm.contextSafeToolCallEfficiencyV2).toBe(true);
    // v1's field is NOT set: the two mechanisms can never be confused.
    expect(arm.contextSafeToolCallEfficiency).toBeUndefined();
    expect(arm.promptAdditionsDigest).toBe(contextSafeToolCallEfficiencyV2GuidanceDigest());
    expect(factory.preflight(CONTEXT_SAFE_TOOL_CALL_EFFICIENCY_V2_CANDIDATE_ID).ok).toBe(true);

    const contract = mechanismContractFor(CONTEXT_SAFE_TOOL_CALL_EFFICIENCY_V2_CANDIDATE_ID);
    expect(contract).toBeDefined();
    expect(contract!.candidateId).toBe(CONTEXT_SAFE_TOOL_CALL_EFFICIENCY_V2_CANDIDATE_ID);
    expect(contract!.requiredActivationEvents).toEqual(["context-safe-tool-call-efficiency-guidance-injected"]);
  });

  it("5. the v1 arm keeps its own identity while the baseline is unperturbed", () => {
    const factory = getArmFactory();
    const baseline = factory.resolveRuntimeMechanisms(null);
    expect("contextSafeToolCallEfficiency" in baseline).toBe(false);
    expect("contextSafeToolCallEfficiencyV2" in baseline).toBe(false);

    const v1 = factory.resolveRuntimeMechanisms(CONTEXT_SAFE_TOOL_CALL_EFFICIENCY_CANDIDATE_ID);
    expect(v1.contextSafeToolCallEfficiency).toBe(true);
    expect(v1.contextSafeToolCallEfficiencyV2).toBeUndefined();
    expect(v1.promptAdditionsDigest).toBe(FROZEN_V1_GUIDANCE_DIGEST);

    const v2 = factory.resolveRuntimeMechanisms(CONTEXT_SAFE_TOOL_CALL_EFFICIENCY_V2_CANDIDATE_ID);
    expect(v2.promptAdditionsDigest).not.toBe(v1.promptAdditionsDigest);
    // The v2 arm's mechanism snapshot differs from the v1 arm's, so the two
    // arms can never hash to the same execution identity.
    expect(JSON.stringify(v2)).not.toBe(JSON.stringify(v1));
  });

  it("6. legacy activation evidence is pinned to the v2 VERSION (a v1 injection does not activate v2)", () => {
    const v2Events = [
      {
        type: "context_safe_tool_call_efficiency_guidance_injected" as const,
        payload: { guidanceVersion: CONTEXT_SAFE_TOOL_CALL_EFFICIENCY_V2_GUIDANCE_VERSION, blockText: CONTEXT_SAFE_TOOL_CALL_EFFICIENCY_GUIDANCE_V2 },
      },
    ];
    const v1Events = [
      {
        type: "context_safe_tool_call_efficiency_guidance_injected" as const,
        payload: { guidanceVersion: CONTEXT_SAFE_TOOL_CALL_EFFICIENCY_GUIDANCE_VERSION, blockText: CONTEXT_SAFE_TOOL_CALL_EFFICIENCY_GUIDANCE_V1 },
      },
    ];
    const caseDef = { id: "n7e-compact-01-build-jobs" };

    const activated = activationEvidenceFor(CONTEXT_SAFE_TOOL_CALL_EFFICIENCY_V2_CANDIDATE_ID, caseDef, v2Events);
    expect(activated.activated).toBe(true);
    expect(activated.activationCount).toBe(1);
    expect(activated.reasonCodes).toEqual(["context_safe_tool_call_efficiency_guidance_injected"]);

    const notActivated = activationEvidenceFor(CONTEXT_SAFE_TOOL_CALL_EFFICIENCY_V2_CANDIDATE_ID, caseDef, v1Events);
    expect(notActivated.activated).toBe(false);
    expect(notActivated.reasonCodes).toEqual(["activation_zero"]);

    const uninstalled = activationEvidenceFor(CONTEXT_SAFE_TOOL_CALL_EFFICIENCY_V2_CANDIDATE_ID, caseDef, []);
    expect(uninstalled.activated).toBe(false);
  });

  it("7. execution-bound evidence: the digest of the block the model SAW must be the v2 digest", () => {
    const base = {
      candidateId: CONTEXT_SAFE_TOOL_CALL_EFFICIENCY_V2_CANDIDATE_ID,
      caseId: "n7e-compact-01-build-jobs",
      armId: "arm-b",
      attempt: 1,
      repetition: 1,
      eligible: true,
      approvedPromptAdditionsDigest: contextSafeToolCallEfficiencyV2GuidanceDigest(),
    };
    const signal = {
      type: "context_safe_tool_call_efficiency_guidance_injected" as const,
      payload: { guidanceVersion: CONTEXT_SAFE_TOOL_CALL_EFFICIENCY_V2_GUIDANCE_VERSION, blockText: CONTEXT_SAFE_TOOL_CALL_EFFICIENCY_GUIDANCE_V2 },
    };
    const own = buildActivationEvidenceFromSignalsV2({ ...base, signals: [signal] });
    expect(own.validation.ok).toBe(true);
    expect(own.events[0]!.payload.digest).toBe(contextSafeToolCallEfficiencyV2GuidanceDigest());

    // The v1 block reaching the model is NOT v2 activation.
    const wrongBlock = buildActivationEvidenceFromSignalsV2({
      ...base,
      signals: [
        {
          type: "context_safe_tool_call_efficiency_guidance_injected" as const,
          payload: { guidanceVersion: CONTEXT_SAFE_TOOL_CALL_EFFICIENCY_GUIDANCE_VERSION, blockText: CONTEXT_SAFE_TOOL_CALL_EFFICIENCY_GUIDANCE_V1 },
        },
      ],
    });
    expect(wrongBlock.events[0]!.payload.digest).not.toBe(contextSafeToolCallEfficiencyV2GuidanceDigest());

    // A run that never reached the model reports no activation at all.
    const noSignal = buildActivationEvidenceFromSignalsV2({ ...base, signals: [] });
    expect(noSignal.events).toHaveLength(0);
  });

  it("8. v2 introduces no new event type and no new tool parameter", () => {
    // The activation signal is the EXISTING prompt-guidance signal; v2 is
    // distinguished by its version/digest, not by a new Core event type.
    const contract = mechanismContractFor(CONTEXT_SAFE_TOOL_CALL_EFFICIENCY_V2_CANDIDATE_ID)!;
    expect(contract.requiredActivationEvents).toEqual(
      mechanismContractFor(CONTEXT_SAFE_TOOL_CALL_EFFICIENCY_CANDIDATE_ID)!.requiredActivationEvents,
    );
    // The guidance may only name the existing tools/parameters.
    expect(CONTEXT_SAFE_TOOL_CALL_EFFICIENCY_GUIDANCE_V2).not.toMatch(/offset\s*:/);
    expect(CONTEXT_SAFE_TOOL_CALL_EFFICIENCY_GUIDANCE_V2).not.toMatch(/\blimit\s*:/);
    // And it stays guidance: it never claims to bypass permissions or sandbox.
    expect(CONTEXT_SAFE_TOOL_CALL_EFFICIENCY_GUIDANCE_V2.toLowerCase()).not.toContain("bypass");
    expect(TOOL_CALL_EFFICIENCY_GUIDANCE_VERSION.length).toBeGreaterThan(0);
    expect(TOOL_CALL_EFFICIENCY_GUIDANCE_VERSION).not.toBe(CONTEXT_SAFE_TOOL_CALL_EFFICIENCY_GUIDANCE_VERSION);
    expect(TOOL_CALL_EFFICIENCY_GUIDANCE_VERSION).not.toBe(CONTEXT_SAFE_TOOL_CALL_EFFICIENCY_V2_GUIDANCE_VERSION);
  });
});
