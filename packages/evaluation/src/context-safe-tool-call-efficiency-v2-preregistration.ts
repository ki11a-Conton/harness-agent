/**
 * N7 / N7-3 — the fail-closed pre-registration for
 * `context_safe_tool_call_efficiency_v2`.
 *
 * Purpose: freeze, BEFORE any model result, everything that could otherwise be
 * tuned after seeing one — the exact strategy bytes of both arms, the case set
 * with its content and verifier digests, the provider/model/params, the AB/BA
 * schedule, the budget and the decision gates. Any change to any of those
 * changes `preregistrationDigest`, so an old approval can never authorize a
 * rewritten plan.
 *
 * Relationship to the N6 module: this file does NOT copy the builder. It reuses
 * `buildContextSafePreregistration` / `dryRunContextSafePreregistration` with an
 * explicit `ContextSafePlanSpec` (added in N7 with N6-equal defaults), so the N6
 * artifacts stay byte-identical while the v2 plan binds its own text digest, its
 * own 64-case corpus and its own 512 logical arm runs. No digest is ever
 * hand-edited.
 *
 * Power design (the plan's N7-3 acceptance): the MAIN experiment is
 * 64 cases × 4 repetitions × 2 arms = **512 logical arm runs**. The independent
 * HOLDOUT keeps its own frozen 24-case corpus, i.e. 24 × 4 × 2 = **192 logical
 * arm runs**; the plan text's shorthand "512 runs/实验" is arithmetically the
 * main-set figure (2×64×4), and this module records both numbers explicitly
 * rather than inflating the holdout to match a slogan.
 *
 * Honest scope: this module BUILDS and DRY-RUNS the plan. It makes no provider
 * call (`dryRun` reports `providerCalls: 0`) and it does not execute the
 * experiment. By the operator's decision the N7 campaign is NOT run in this
 * round, so no model-quality or promotion claim is made anywhere in the artifact.
 */

import { getArmFactory } from "./arm-factory.js";
import { CONTEXT_SAFE_TOOL_CALL_EFFICIENCY_V2_CANDIDATE_ID } from "./candidate-registry.js";
import {
  CONTEXT_SAFE_GATES,
  CONTEXT_SAFE_V1_PLAN_SPEC,
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
  CONTEXT_SAFE_TOOL_CALL_EFFICIENCY_GUIDANCE_V2,
  CONTEXT_SAFE_TOOL_CALL_EFFICIENCY_V2_GUIDANCE_VERSION,
  contextSafeToolCallEfficiencyV2GuidanceDigest,
  TOOL_CALL_EFFICIENCY_GUIDANCE_V1,
  TOOL_CALL_EFFICIENCY_GUIDANCE_VERSION,
  toolCallEfficiencyGuidanceDigest,
} from "./mechanism-guidance.js";

export const CONTEXT_SAFE_V2_PREREGISTRATION_SCHEMA =
  "context-safe-tool-call-efficiency-v2-preregistration-v1";

/** The candidate under test (the v2 text) and the arm it is compared against.
 *  A = `tool_call_efficiency_v1` (the production prompt-guidance text), B = v2:
 *  the SAME comparison the N6 main experiment used, so the two rounds are
 *  readable on one axis. */
export const CONTEXT_SAFE_V2_CANDIDATE_ID = CONTEXT_SAFE_TOOL_CALL_EFFICIENCY_V2_CANDIDATE_ID;
export const CONTEXT_SAFE_V2_COMPARISON_ARM_ID = "tool_call_efficiency_v1";

export const CONTEXT_SAFE_V2_REPETITIONS = 4;
export const CONTEXT_SAFE_V2_MAIN_CASES = 64;
/** 2 × 64 × 4 = 512 logical ARM RUNS (never model calls). */
export const CONTEXT_SAFE_V2_LOGICAL_RUNS_PER_EXPERIMENT =
  CONTEXT_SAFE_V2_MAIN_CASES * CONTEXT_SAFE_V2_REPETITIONS * 2;
export const CONTEXT_SAFE_V2_HOLDOUT_CASES = 24;
/** 2 × 24 × 4 = 192 logical arm runs — the holdout's own frozen corpus size. */
export const CONTEXT_SAFE_V2_HOLDOUT_LOGICAL_RUNS =
  CONTEXT_SAFE_V2_HOLDOUT_CASES * CONTEXT_SAFE_V2_REPETITIONS * 2;

/**
 * The N7 gates are the N6 gates VALUE FOR VALUE. N7 is a re-test at a larger
 * sample size; it does not loosen a single threshold. Frozen as its own object
 * so the round's identity is explicit, and asserted equal to the N6 gates by the
 * regression suite.
 */
export const CONTEXT_SAFE_V2_GATES: Readonly<ContextSafeGates> = Object.freeze({
  ...CONTEXT_SAFE_GATES,
});

/** The frozen identity of the N7 MAIN experiment (512 logical arm runs). */
export const CONTEXT_SAFE_V2_MAIN_PLAN_SPEC: ContextSafePlanSpec = Object.freeze({
  schemaVersion: CONTEXT_SAFE_V2_PREREGISTRATION_SCHEMA,
  candidateId: CONTEXT_SAFE_V2_CANDIDATE_ID,
  comparisonArmId: CONTEXT_SAFE_V2_COMPARISON_ARM_ID,
  candidateGuidanceVersion: CONTEXT_SAFE_TOOL_CALL_EFFICIENCY_V2_GUIDANCE_VERSION,
  candidateGuidanceDigest: contextSafeToolCallEfficiencyV2GuidanceDigest(),
  comparisonGuidanceVersion: TOOL_CALL_EFFICIENCY_GUIDANCE_VERSION,
  comparisonGuidanceDigest: toolCallEfficiencyGuidanceDigest(),
  gates: CONTEXT_SAFE_V2_GATES,
  repetitions: CONTEXT_SAFE_V2_REPETITIONS,
  expectedCases: CONTEXT_SAFE_V2_MAIN_CASES,
  expectedLogicalRuns: CONTEXT_SAFE_V2_LOGICAL_RUNS_PER_EXPERIMENT,
});

/**
 * The frozen identity of the N7 INDEPENDENT HOLDOUT. Same candidate, same
 * repetitions; the comparison arm is the production champion RESOLVED from
 * `docs/evolution/champion-state.json` (never assumed), and the corpus is the
 * holdout's own 24 cases → 192 logical arm runs.
 */
export const CONTEXT_SAFE_V2_HOLDOUT_PLAN_SPEC: ContextSafePlanSpec = Object.freeze({
  schemaVersion: CONTEXT_SAFE_V2_PREREGISTRATION_SCHEMA,
  candidateId: CONTEXT_SAFE_V2_CANDIDATE_ID,
  comparisonArmId: CONTEXT_SAFE_V2_COMPARISON_ARM_ID,
  candidateGuidanceVersion: CONTEXT_SAFE_TOOL_CALL_EFFICIENCY_V2_GUIDANCE_VERSION,
  candidateGuidanceDigest: contextSafeToolCallEfficiencyV2GuidanceDigest(),
  comparisonGuidanceVersion: TOOL_CALL_EFFICIENCY_GUIDANCE_VERSION,
  comparisonGuidanceDigest: toolCallEfficiencyGuidanceDigest(),
  gates: CONTEXT_SAFE_V2_GATES,
  repetitions: CONTEXT_SAFE_V2_REPETITIONS,
  expectedCases: CONTEXT_SAFE_V2_HOLDOUT_CASES,
  expectedLogicalRuns: CONTEXT_SAFE_V2_HOLDOUT_LOGICAL_RUNS,
});

/** The plan spec for a role. Default: the main experiment. */
export function contextSafeV2PlanSpec(role: "main" | "holdout" = "main"): ContextSafePlanSpec {
  return role === "holdout" ? CONTEXT_SAFE_V2_HOLDOUT_PLAN_SPEC : CONTEXT_SAFE_V2_MAIN_PLAN_SPEC;
}

/** The two arm texts, exposed so a reader can diff the single variable. */
export const CONTEXT_SAFE_V2_ARM_TEXTS = Object.freeze({
  candidate: CONTEXT_SAFE_TOOL_CALL_EFFICIENCY_GUIDANCE_V2,
  comparison: TOOL_CALL_EFFICIENCY_GUIDANCE_V1,
});

/**
 * Build the N7 artifact. Fail-closed beyond the shared builder's checks:
 *
 *   - the candidate arm's prompt-additions digest must be the digest of the v2
 *     TEXT (so the plan can never bind a label to different bytes);
 *   - `subject.candidateArmDigest` must be the REAL resolved arm digest for the
 *     v2 candidate (a hand-written digest is refused);
 *   - the comparison arm may not be the candidate arm (no causal delta).
 */
export function buildContextSafeV2Preregistration(
  opts: ContextSafePreregistrationOptions,
): ContextSafePreregistration {
  const role = opts.role ?? "main";
  const spec = contextSafeV2PlanSpec(role);

  const arm = getArmFactory().resolveArm(CONTEXT_SAFE_V2_CANDIDATE_ID);
  const armTextDigest = arm.promptAdditionsDigest;
  if (armTextDigest !== contextSafeToolCallEfficiencyV2GuidanceDigest()) {
    throw new ContextSafePreregistrationError(
      "ARM_TEXT_NOT_V2",
      `the resolved v2 arm's prompt-additions digest ${String(armTextDigest)} is not the v2 text digest ` +
        `${contextSafeToolCallEfficiencyV2GuidanceDigest()}`,
    );
  }
  if (opts.subject?.candidateArmDigest !== arm.digest) {
    throw new ContextSafePreregistrationError(
      "CANDIDATE_ARM_NOT_RESOLVED",
      `subject.candidateArmDigest ${String(opts.subject?.candidateArmDigest)} is not the resolved v2 arm digest ${arm.digest}`,
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

/** Dry-run an N7 artifact against its own frozen plan spec. Zero provider calls. */
export function dryRunContextSafeV2Preregistration(
  a: ContextSafePreregistration,
): ContextSafeDryRunReport {
  return dryRunContextSafePreregistration(a, contextSafeV2PlanSpec(a.role === "holdout" ? "holdout" : "main"));
}

/** The N6 plan spec, re-exported so an N7 reader can prove the default is intact. */
export { CONTEXT_SAFE_V1_PLAN_SPEC };
