/**
 * P 轮 — the fail-closed pre-registration for `verified_completion_gate_v1`.
 *
 * Purpose: freeze, BEFORE any model result, everything that could otherwise be
 * tuned after seeing one — the exact gated text of both arms, the case set with
 * its content and verifier digests, the provider/model/params, the AB/BA schedule,
 * the budget and the decision gates. Any change to any of those changes
 * `preregistrationDigest`, so an old approval can never authorize a rewritten plan.
 *
 * Relationship to the earlier rounds: this file does NOT copy the builder. It
 * reuses `buildContextSafePreregistration` / `dryRunContextSafePreregistration`
 * with an explicit `ContextSafePlanSpec`, exactly like the N7 (v2) plan does, so
 * the N6 and N7 artifacts stay byte-identical while this plan binds the gate text,
 * the frozen 88-case corpus and its own logical-run counts.
 *
 * Power (the plan's own acceptance): the MAIN experiment is 64 cases × 4
 * repetitions × 2 arms = **512 logical arm runs**; the INDEPENDENT HOLDOUT keeps
 * its own frozen 24-case corpus → **192**. The eight decision gates are the N6/N7
 * gates VALUE FOR VALUE — this round loosens nothing.
 *
 * Corpus provenance (matters for "no contamination"): the 88-case corpus was
 * authored and frozen in N7-2 (commit e99cb3f1, with its own verifier-discrimination
 * proof) BEFORE this candidate's text existed, so the text could not have been
 * tuned case-by-case against it. The corpus is reused rather than re-authored, and
 * the shared comparison axis (A = `tool_call_efficiency_v1` for the main
 * experiment; the resolved champion for the holdout) is identical to N6/N7, so the
 * three rounds are readable on one axis.
 *
 * Interaction recorded honestly: the HOLDOUT comparison arm is the champion
 * resolved from `docs/evolution/champion-state.json`, and the baseline arm's
 * resolved snapshot lists every registered candidate as OFF. Freezing this plan
 * therefore binds the CURRENT snapshot; registering any FUTURE candidate will move
 * that baseline arm digest again and require a re-freeze (the same class of event
 * documented in docs/evidence/agent-p-20261006/P-COMPLETION.md §4.1).
 *
 * Honest scope: this module BUILDS and DRY-RUNS the plan. It makes no provider
 * call (`dryRun` reports `providerCalls: 0`) and it does not execute the
 * experiment. No model-quality or promotion claim is made anywhere in the
 * artifact; the campaign is NOT run in this round.
 */

import { getArmFactory } from "./arm-factory.js";
import { VERIFIED_COMPLETION_GATE_CANDIDATE_ID } from "./candidate-registry.js";
import {
  CONTEXT_SAFE_GATES,
  ContextSafePreregistrationError,
  buildContextSafePreregistration,
  dryRunContextSafePreregistration,
  type ContextSafeDryRunReport,
  type ContextSafeGates,
  type ContextSafePlanSpec,
  type ContextSafePreregistration,
  type ContextSafePreregistrationOptions,
} from "./context-safe-tool-call-efficiency-preregistration.js";
import {
  TOOL_CALL_EFFICIENCY_GUIDANCE_V1,
  TOOL_CALL_EFFICIENCY_GUIDANCE_VERSION,
  toolCallEfficiencyGuidanceDigest,
  VERIFIED_COMPLETION_GATE_GUIDANCE_V1,
  VERIFIED_COMPLETION_GATE_GUIDANCE_VERSION,
  verifiedCompletionGateGuidanceDigest,
} from "./mechanism-guidance.js";

export const VERIFIED_COMPLETION_GATE_PREREGISTRATION_SCHEMA = "verified-completion-gate-preregistration-v1";

/** The candidate under test and the arm the MAIN experiment compares it with. */
export const VERIFIED_COMPLETION_GATE_COMPARISON_ARM_ID = "tool_call_efficiency_v1";

export const VERIFIED_COMPLETION_GATE_REPETITIONS = 4;
export const VERIFIED_COMPLETION_GATE_MAIN_CASES = 64;
/** 2 × 64 × 4 = 512 logical ARM RUNS (never model calls). */
export const VERIFIED_COMPLETION_GATE_LOGICAL_RUNS_PER_EXPERIMENT =
  VERIFIED_COMPLETION_GATE_MAIN_CASES * VERIFIED_COMPLETION_GATE_REPETITIONS * 2;
export const VERIFIED_COMPLETION_GATE_HOLDOUT_CASES = 24;
/** The holdout's own frozen corpus: 2 × 24 × 4 = 192. */
export const VERIFIED_COMPLETION_GATE_HOLDOUT_LOGICAL_RUNS =
  VERIFIED_COMPLETION_GATE_HOLDOUT_CASES * VERIFIED_COMPLETION_GATE_REPETITIONS * 2;

/** The N6/N7 gates, value for value. No threshold is relaxed for this round. */
export const VERIFIED_COMPLETION_GATE_GATES: Readonly<ContextSafeGates> = Object.freeze({
  ...CONTEXT_SAFE_GATES,
});

/** Frozen identity of the MAIN experiment (512 logical arm runs). */
export const VERIFIED_COMPLETION_GATE_MAIN_PLAN_SPEC: ContextSafePlanSpec = Object.freeze({
  schemaVersion: VERIFIED_COMPLETION_GATE_PREREGISTRATION_SCHEMA,
  candidateId: VERIFIED_COMPLETION_GATE_CANDIDATE_ID,
  comparisonArmId: VERIFIED_COMPLETION_GATE_COMPARISON_ARM_ID,
  candidateGuidanceVersion: VERIFIED_COMPLETION_GATE_GUIDANCE_VERSION,
  candidateGuidanceDigest: verifiedCompletionGateGuidanceDigest(),
  comparisonGuidanceVersion: TOOL_CALL_EFFICIENCY_GUIDANCE_VERSION,
  comparisonGuidanceDigest: toolCallEfficiencyGuidanceDigest(),
  gates: VERIFIED_COMPLETION_GATE_GATES,
  repetitions: VERIFIED_COMPLETION_GATE_REPETITIONS,
  expectedCases: VERIFIED_COMPLETION_GATE_MAIN_CASES,
  expectedLogicalRuns: VERIFIED_COMPLETION_GATE_LOGICAL_RUNS_PER_EXPERIMENT,
});

/**
 * Frozen identity of the INDEPENDENT HOLDOUT. Same candidate and repetitions; the
 * comparison arm is the production champion RESOLVED from the state file (never
 * assumed). `comparisonGuidanceDigest` records the production guidance text the
 * comparison arm would carry; the RESOLVED comparison arm is recorded separately
 * as `subject.baselineArmDigest`, so the two facts are never conflated.
 */
export const VERIFIED_COMPLETION_GATE_HOLDOUT_PLAN_SPEC: ContextSafePlanSpec = Object.freeze({
  schemaVersion: VERIFIED_COMPLETION_GATE_PREREGISTRATION_SCHEMA,
  candidateId: VERIFIED_COMPLETION_GATE_CANDIDATE_ID,
  comparisonArmId: VERIFIED_COMPLETION_GATE_COMPARISON_ARM_ID,
  candidateGuidanceVersion: VERIFIED_COMPLETION_GATE_GUIDANCE_VERSION,
  candidateGuidanceDigest: verifiedCompletionGateGuidanceDigest(),
  comparisonGuidanceVersion: TOOL_CALL_EFFICIENCY_GUIDANCE_VERSION,
  comparisonGuidanceDigest: toolCallEfficiencyGuidanceDigest(),
  gates: VERIFIED_COMPLETION_GATE_GATES,
  repetitions: VERIFIED_COMPLETION_GATE_REPETITIONS,
  expectedCases: VERIFIED_COMPLETION_GATE_HOLDOUT_CASES,
  expectedLogicalRuns: VERIFIED_COMPLETION_GATE_HOLDOUT_LOGICAL_RUNS,
});

/** The plan spec for a role. Default: the main experiment. */
export function verifiedCompletionGatePlanSpec(role: "main" | "holdout" = "main"): ContextSafePlanSpec {
  return role === "holdout" ? VERIFIED_COMPLETION_GATE_HOLDOUT_PLAN_SPEC : VERIFIED_COMPLETION_GATE_MAIN_PLAN_SPEC;
}

/** The two arm texts, exposed so a reader can diff the single variable. */
export const VERIFIED_COMPLETION_GATE_ARM_TEXTS = Object.freeze({
  candidate: VERIFIED_COMPLETION_GATE_GUIDANCE_V1,
  comparison: TOOL_CALL_EFFICIENCY_GUIDANCE_V1,
});

/**
 * Build the artifact. Fail-closed beyond the shared builder's checks:
 *   - the resolved candidate arm's prompt-additions digest must be the digest of
 *     the gate TEXT (a label can never be bound to different bytes);
 *   - `subject.candidateArmDigest` must be the REAL resolved arm digest for the
 *     gate candidate (a hand-written digest is refused);
 *   - the comparison arm may not be the candidate arm (no causal delta).
 */
export function buildVerifiedCompletionGatePreregistration(
  opts: ContextSafePreregistrationOptions,
): ContextSafePreregistration {
  const role = opts.role ?? "main";
  const spec = verifiedCompletionGatePlanSpec(role);

  const arm = getArmFactory().resolveArm(VERIFIED_COMPLETION_GATE_CANDIDATE_ID);
  if (arm.promptAdditionsDigest !== verifiedCompletionGateGuidanceDigest()) {
    throw new ContextSafePreregistrationError(
      "ARM_TEXT_NOT_GATE",
      `the resolved gate arm's prompt-additions digest ${String(arm.promptAdditionsDigest)} is not the gate text digest ` +
        `${verifiedCompletionGateGuidanceDigest()}`,
    );
  }
  if (opts.subject?.candidateArmDigest !== arm.digest) {
    throw new ContextSafePreregistrationError(
      "CANDIDATE_ARM_NOT_RESOLVED",
      `subject.candidateArmDigest ${String(opts.subject?.candidateArmDigest)} is not the resolved gate arm digest ${arm.digest}`,
    );
  }
  if (opts.subject?.baselineArmDigest === arm.digest) {
    throw new ContextSafePreregistrationError(
      "ARMS_IDENTICAL",
      "the comparison arm is the candidate arm — no causal delta to measure",
    );
  }

  return buildContextSafePreregistration({ ...opts, planSpec: spec });
}

/** Dry-run a P artifact against its own frozen plan spec. Zero provider calls. */
export function dryRunVerifiedCompletionGatePreregistration(
  a: ContextSafePreregistration,
): ContextSafeDryRunReport {
  return dryRunContextSafePreregistration(
    a,
    verifiedCompletionGatePlanSpec(a.role === "holdout" ? "holdout" : "main"),
  );
}
