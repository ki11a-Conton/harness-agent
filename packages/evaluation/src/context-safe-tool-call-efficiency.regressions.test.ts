/**
 * N6 — `context_safe_tool_call_efficiency_v1` (agent-strategy candidate).
 *
 * The candidate is the v2 tool-call-efficiency guidance with EXACTLY ONE rule
 * replaced: an earlier read may be re-used only while its text is still visible
 * and the version matches, and a file whose original text was dropped by
 * compaction / truncation / rehydration must be read again before editing.
 *
 * These regressions pin the facts the plan requires:
 *   - the candidate text is a one-rule change and the v2 text is untouched;
 *   - activation is bound to the candidate's OWN signal + digest (a v2
 *     injection can never corroborate this candidate, and a flags-only /
 *     not-installed / identical-text prompt is not activation);
 *   - the candidate is really wired (registry, arm factory, contract) while the
 *     baseline and the v2 arm keep their identities.
 */

import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import {
  CONTEXT_SAFE_TOOL_CALL_EFFICIENCY_GUIDANCE_V1,
  CONTEXT_SAFE_TOOL_CALL_EFFICIENCY_GUIDANCE_VERSION,
  contextSafeToolCallEfficiencyGuidanceDigest,
  TOOL_CALL_EFFICIENCY_GUIDANCE_V1,
  TOOL_CALL_EFFICIENCY_GUIDANCE_VERSION,
  toolCallEfficiencyGuidanceDigest,
} from "./mechanism-guidance.js";
import { CONTEXT_SAFE_TOOL_CALL_EFFICIENCY_CANDIDATE_ID, createCandidateRegistry } from "./candidate-registry.js";
import { getArmFactory } from "./arm-factory.js";
import { mechanismContractFor } from "./mechanism-contract.js";
import { buildActivationEvidenceFromSignalsV2, type ObservedActivationSignal } from "./activation-evidence-execution.js";

const sha256 = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex");

/** The v2 text with ONLY the re-read bullet replaced — the candidate's contract. */
function candidateTextFromV2(): string {
  const v2Reread =
    "- Read each file you need in as few calls as possible, and do not re-read a\n" +
    "  file you have already read unless it changed.";
  const candidateReread =
    "- Read each file you need in as few calls as possible. Re-use an earlier read\n" +
    "  ONLY while the text you need is still visible in this conversation and the\n" +
    "  version you already have matches the current file.\n" +
    "- Do not re-read a file whose current content and version you can still see,\n" +
    "  but never edit a file from memory, from a summary or from a citation: after\n" +
    "  compaction, truncation or rehydration has dropped the original text you need\n" +
    "  to change, read the file again before editing it. If the file changed, read\n" +
    "  it again as before.";
  expect(TOOL_CALL_EFFICIENCY_GUIDANCE_V1).toContain(v2Reread);
  return TOOL_CALL_EFFICIENCY_GUIDANCE_V1.replace(v2Reread, candidateReread);
}

describe("N6 — context_safe_tool_call_efficiency_v1", () => {
  it("1. the candidate is the v2 text with EXACTLY the re-read rule replaced", () => {
    expect(CONTEXT_SAFE_TOOL_CALL_EFFICIENCY_GUIDANCE_V1).toBe(candidateTextFromV2());
  });

  it("2. the v2 candidate's version, bytes and digest are unchanged (frozen identity)", () => {
    // The sha256 the N1 boundary review recorded for the live v2 text
    // (docs/evidence/agent-next6-plan-20261005/review-result.json). A rewrite of
    // a shipped candidate would change this and invalidate its evaluation.
    expect(TOOL_CALL_EFFICIENCY_GUIDANCE_VERSION).toBe("tool-call-efficiency:v2");
    expect(toolCallEfficiencyGuidanceDigest()).toBe("ebddf5eb125cbbe8ed25d7ecb1ea3554809494aea70716adf3a9f62924939619");
    // The candidate has its own identity, and its digest is a function of its own
    // bytes (never a label and never the v2 value).
    expect(CONTEXT_SAFE_TOOL_CALL_EFFICIENCY_GUIDANCE_VERSION).toBe("context-safe-tool-call-efficiency:v1");
    expect(contextSafeToolCallEfficiencyGuidanceDigest()).toBe(sha256(CONTEXT_SAFE_TOOL_CALL_EFFICIENCY_GUIDANCE_V1));
    expect(contextSafeToolCallEfficiencyGuidanceDigest()).not.toBe(toolCallEfficiencyGuidanceDigest());
  });

  it("3. requires a fresh read after the evidence is gone — and keeps the v2 saving while it is visible", () => {
    const text = CONTEXT_SAFE_TOOL_CALL_EFFICIENCY_GUIDANCE_V1;
    // The v2 blanket prohibition is GONE …
    expect(text).not.toContain("do not re-read a\n  file you have already read unless it changed.");
    // … replaced by: re-use only while visible + version matches,
    expect(text).toMatch(/Re-use an earlier read\s+ONLY while the text you need is still visible/);
    // … re-read once compaction/truncation/rehydration dropped the original text,
    expect(text).toMatch(/compaction, truncation or rehydration has dropped the original text/);
    expect(text).toMatch(/read the file again before editing it/);
    // … a summary / citation / memory is explicitly not the current file,
    expect(text).toMatch(/never edit a file from memory, from a summary or from a citation/);
    // … and a changed file is still read again, exactly as in v2.
    expect(text).toMatch(/If the file changed, read\s+it again as before\./);
    // No invented tool parameters: the plan's boundary forbids offset/limit.
    expect(text).not.toMatch(/offset|lineStart|lineEnd/);
    // Soft guidance only: it never claims to intercept or cache the tool.
    expect(text).not.toMatch(/cache|intercept|block the tool/i);
  });

  it("4. the candidate is really wired (registry, arm factory, contract)", () => {
    const registry = createCandidateRegistry();
    const reg = registry.find(CONTEXT_SAFE_TOOL_CALL_EFFICIENCY_CANDIDATE_ID);
    expect(reg).toBeDefined();
    expect(reg!.status).toBe("experimental");
    expect(reg!.layer).toBe("agent-strategy");
    expect(() => registry.validateActive(CONTEXT_SAFE_TOOL_CALL_EFFICIENCY_CANDIDATE_ID)).not.toThrow();
    // A real semantic delta against the baseline — never a name-only candidate.
    const resolved = registry.resolve(CONTEXT_SAFE_TOOL_CALL_EFFICIENCY_CANDIDATE_ID);
    expect(resolved.hasSemanticDelta).toBe(true);
    expect(resolved.semanticDigest).not.toBe(registry.resolveBaseline().semanticDigest);

    const factory = getArmFactory();
    const arm = factory.resolveRuntimeMechanisms(CONTEXT_SAFE_TOOL_CALL_EFFICIENCY_CANDIDATE_ID);
    expect(arm.contextSafeToolCallEfficiency).toBe(true);
    expect(arm.toolCallEfficiency).toBe(false);
    expect(arm.promptAdditionsDigest).toBe(contextSafeToolCallEfficiencyGuidanceDigest());
    expect(factory.preflight(CONTEXT_SAFE_TOOL_CALL_EFFICIENCY_CANDIDATE_ID).ok).toBe(true);

    const contract = mechanismContractFor(CONTEXT_SAFE_TOOL_CALL_EFFICIENCY_CANDIDATE_ID);
    expect(contract).toBeDefined();
    expect(contract!.requiredActivationEvents).toEqual(["context-safe-tool-call-efficiency-guidance-injected"]);
    expect(contract!.candidateId).toBe(CONTEXT_SAFE_TOOL_CALL_EFFICIENCY_CANDIDATE_ID);
  });

  it("5. no existing arm gains the candidate's mechanism (baseline and v2 identities untouched)", () => {
    const factory = getArmFactory();
    const baseline = factory.resolveRuntimeMechanisms(null);
    const v2 = factory.resolveRuntimeMechanisms("tool_call_efficiency_v1");
    // The new key is ABSENT (not merely false) on every pre-existing arm, so
    // their resolved configs and digests are byte-identical to before.
    expect("contextSafeToolCallEfficiency" in baseline).toBe(false);
    expect("contextSafeToolCallEfficiency" in v2).toBe(false);
    expect(baseline.promptAdditionsDigest).toBeNull();
    expect(v2.promptAdditionsDigest).toBe(toolCallEfficiencyGuidanceDigest());
    expect(v2.toolCallEfficiency).toBe(true);
    // The candidate does not piggyback on the v2 mechanism switch.
    expect(factory.resolveRuntimeMechanisms(CONTEXT_SAFE_TOOL_CALL_EFFICIENCY_CANDIDATE_ID).toolCallEfficiency).toBe(false);
  });

  it("6. activation is a separate fact site: a v2 injection never activates the candidate", () => {
    const block = CONTEXT_SAFE_TOOL_CALL_EFFICIENCY_GUIDANCE_V1;
    const ownSignal: ObservedActivationSignal = {
      type: "context_safe_tool_call_efficiency_guidance_injected",
      payload: { guidanceVersion: CONTEXT_SAFE_TOOL_CALL_EFFICIENCY_GUIDANCE_VERSION, blockText: block },
    };
    const v2Signal: ObservedActivationSignal = {
      type: "tool_call_efficiency_guidance_injected",
      payload: { guidanceVersion: TOOL_CALL_EFFICIENCY_GUIDANCE_VERSION, blockText: TOOL_CALL_EFFICIENCY_GUIDANCE_V1 },
    };
    const build = (signals: readonly ObservedActivationSignal[]) =>
      buildActivationEvidenceFromSignalsV2({
        candidateId: CONTEXT_SAFE_TOOL_CALL_EFFICIENCY_CANDIDATE_ID,
        caseId: "n6-case",
        armId: "candidate",
        attempt: 1,
        repetition: 1,
        signals,
        eligible: true,
        approvedPromptAdditionsDigest: contextSafeToolCallEfficiencyGuidanceDigest(),
      });

    const own = build([ownSignal]);
    expect(own.events).toHaveLength(1);
    expect(own.events[0]!.mechanism).toBe("prompt-guidance");
    expect(own.events[0]!.evidenceType).toBe("prompt-guidance-injected");
    expect(own.events[0]!.payload.digest).toBe(contextSafeToolCallEfficiencyGuidanceDigest());
    expect(own.events[0]!.payload.guidanceVersion).toBe(CONTEXT_SAFE_TOOL_CALL_EFFICIENCY_GUIDANCE_VERSION);
    expect(own.validation.ok).toBe(true);
    expect(own.aggregation.activated).toBeGreaterThanOrEqual(1);

    // A run that injected the v2 text can never PASS validation for this
    // candidate: the recorded digest is the v2 digest, which is not the digest
    // the arm approved — cross-candidate contamination fails closed instead of
    // silently corroborating the candidate.
    const other = build([v2Signal]);
    expect(other.events).toHaveLength(1);
    expect(other.events[0]!.payload.digest).toBe(toolCallEfficiencyGuidanceDigest());
    expect(other.events[0]!.payload.digest).not.toBe(contextSafeToolCallEfficiencyGuidanceDigest());
    expect(other.validation.ok).toBe(false);

    // Flags-only / not-installed: no signal at all is never activation.
    const none = build([]);
    expect(none.events).toHaveLength(0);
    expect(none.aggregation.activated).toBe(0);
  });

  it("7. activation fails closed when the injected block is not the approved candidate text", () => {
    const wrongBlock: ObservedActivationSignal = {
      type: "context_safe_tool_call_efficiency_guidance_injected",
      // A "similar meaning" rewrite is NOT the approved strategy: the digest the
      // arm authorized must match the bytes the model actually saw.
      payload: { guidanceVersion: CONTEXT_SAFE_TOOL_CALL_EFFICIENCY_GUIDANCE_VERSION, blockText: `${CONTEXT_SAFE_TOOL_CALL_EFFICIENCY_GUIDANCE_V1} ` },
    };
    const result = buildActivationEvidenceFromSignalsV2({
      candidateId: CONTEXT_SAFE_TOOL_CALL_EFFICIENCY_CANDIDATE_ID,
      caseId: "n6-case",
      armId: "candidate",
      attempt: 1,
      repetition: 1,
      signals: [wrongBlock],
      eligible: true,
      approvedPromptAdditionsDigest: contextSafeToolCallEfficiencyGuidanceDigest(),
    });
    expect(result.events).toHaveLength(1);
    expect(result.events[0]!.payload.digest).not.toBe(contextSafeToolCallEfficiencyGuidanceDigest());
    expect(result.validation.ok).toBe(false);
  });
});
