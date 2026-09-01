/**
 * E2-06 — ChampionDecisionEnvelopeV3: statistically honest, machine-readable
 * promotion decisions.
 *
 * The E1-08 decision layer could ACCEPT a single 10→11 pass delta because its
 * only requirement was `netDelta >= 1`; the quality gate's
 * `recommendsRepetition=true` was a report-only warning the decision ignored.
 * This module makes those gates BINDING and emits a single structured envelope
 * that distinguishes:
 *
 *   INVALID      — inputs/protocol cannot support inference (provenance
 *                  mismatch, artifact digest corruption, incomparability)
 *   INCONCLUSIVE — experiment valid but evidence insufficient (single run,
 *                  effect below the pre-registered threshold, unstable
 *                  direction across repetitions, activation coverage short)
 *   REJECT       — evidence sufficient and quality/cost/security gates fail
 *   ACCEPT       — every hard gate passes AND the pre-registered positive
 *                  effect threshold is reached
 *
 * Hard gates ALWAYS run before quality statistics: artifact integrity,
 * comparability/provenance, pair completeness, activation, security, verified
 * completion, runtime errors — any failure forbids ACCEPT.
 *
 * Everything here is a PURE function over structured inputs (no I/O, no
 * provider) so the golden-case matrix is directly testable.
 */

import { createHash } from "node:crypto";
import { stableStringify } from "./manifest.js";

export const CHAMPION_DECISION_ENVELOPE_V3_VERSION = "3.0.0";
export const CHAMPION_DECISION_V3_POLICY_VERSION = "e2-06-policy-v1";

export type ChampionDecisionV3 = "ACCEPT" | "REJECT" | "INCONCLUSIVE" | "INVALID";

export type ChampionDecisionReasonCodeV3 =
  | "ARTIFACT_DIGEST_MISMATCH"
  | "INCOMPARABLE"
  | "PAIR_INCOMPLETE"
  | "ACTIVATION_UNSATISFIED"
  | "SECURITY_BREACH"
  | "VERIFIED_REGRESSION"
  | "RUNTIME_ERROR_ASYMMETRY"
  | "SINGLE_RUN_REQUIRES_REPETITION"
  | "EFFECT_BELOW_THRESHOLD"
  | "DIRECTION_UNSTABLE"
  | "COST_CEILING_EXCEEDED";

// ---------------------------------------------------------------------------
// Input contract
// ---------------------------------------------------------------------------

export interface DecisionGateInputV3 {
  /** Artifact integrity: baseline/candidate content digests recomputed OK. */
  digestValid: boolean;
  /** Pair completeness: every baseline case has a candidate twin. */
  pairComplete: boolean;
  /** E2-02 strict provenance comparability (dirty/cross-SHA fail). */
  comparable: boolean;
  incomparabilityReasons: string[];
  /** Activation coverage (eligible cases that actually activated) 0..1. */
  activationCoverage: number | null;
  activationEligibleCases: number;
  minActivationEligibleCases: number;
  minActivationCoverage: number;
  /** Typed security breaches (candidate). */
  securityBreachesCandidate: number;
  securityBreachesBaseline: number;
  /** Verified-completion rates (candidate must not regress). */
  baselineVerifiedRate: number;
  candidateVerifiedRate: number;
  maxVerifiedDrop: number;
  /** Infrastructure/runtime symmetric failures (excluded-but-reported). */
  infraFailuresBaseline: number;
  infraFailuresCandidate: number;
  /** Paired statistics. */
  cases: number;
  netPassedDelta: number;
  /** Independent repetitions (1 = single run; single run is never ACCEPT). */
  repetitions: number;
  /** Per-repetition net-passed deltas (for direction stability). */
  perRepetitionDeltas: number[];
  /** Pre-registered effect threshold (ACCEPT requires >= this). */
  minConclusiveNetDelta: number;
  /** Token/cost growth (ACCEPT requires bounded). */
  tokensDelta: number;
  maxTokensDelta: number;
  /** Whether the quality gate recommends repetition (BINDING). */
  recommendsRepetition: boolean;
}

export interface ChampionDecisionEnvelopeV3 {
  schemaVersion: string;
  policyVersion: string;
  generatedAtIso: string;
  decision: ChampionDecisionV3;
  reasonCodes: ChampionDecisionReasonCodeV3[];
  gates: {
    artifactIntegrity: boolean;
    provenanceComparable: boolean;
    pairComplete: boolean;
    activationSatisfied: boolean;
    securityClear: boolean;
    verifiedNonRegression: boolean;
    runtimeErrorSymmetry: boolean;
    repetitionSufficient: boolean;
    effectSufficient: boolean;
    directionStable: boolean;
    costBounded: boolean;
  };
  statistics: {
    cases: number;
    netPassedDelta: number;
    repetitions: number;
    perRepetitionDeltas: number[];
    activationCoverage: number | null;
    securityBreaches: { baseline: number; candidate: number };
    verifiedRates: { baseline: number; candidate: number };
    tokensDelta: number;
  };
  explanation: string;
  nextStep: string;
}

/** Stable envelope id over the decision inputs (content-addressed). */
export function envelopeDigestV3(input: DecisionGateInputV3): string {
  return createHash("sha256").update(stableStringify(input), "utf8").digest("hex").slice(0, 24);
}

// ---------------------------------------------------------------------------
// Decision
// ---------------------------------------------------------------------------

/**
 * Decide the champion verdict from pre-validated gate inputs. HARD gates run
 * first; ACCEPT requires EVERY gate (including repetition sufficiency, effect
 * threshold, direction stability, cost ceiling) to pass.
 */
export function decideChampionV3(input: DecisionGateInputV3): ChampionDecisionEnvelopeV3 {
  const gates = {
    artifactIntegrity: input.digestValid,
    provenanceComparable: input.comparable,
    pairComplete: input.pairComplete,
    activationSatisfied:
      input.activationCoverage !== null
      && input.activationEligibleCases >= input.minActivationEligibleCases
      && input.activationCoverage >= input.minActivationCoverage,
    securityClear: input.securityBreachesCandidate === 0,
    verifiedNonRegression: input.candidateVerifiedRate >= input.baselineVerifiedRate - input.maxVerifiedDrop,
    runtimeErrorSymmetry: input.infraFailuresCandidate <= input.infraFailuresBaseline,
    repetitionSufficient: input.repetitions >= 2 && !input.recommendsRepetition,
    effectSufficient: input.netPassedDelta >= input.minConclusiveNetDelta,
    directionStable: input.perRepetitionDeltas.length === 0
      ? true
      : input.perRepetitionDeltas.every((d) => d >= 0),
    costBounded: input.tokensDelta <= input.maxTokensDelta,
  };

  const reasons: ChampionDecisionReasonCodeV3[] = [];
  const hardFail = (code: ChampionDecisionReasonCodeV3): void => { reasons.push(code); };
  if (!gates.artifactIntegrity) hardFail("ARTIFACT_DIGEST_MISMATCH");
  if (!gates.provenanceComparable) hardFail("INCOMPARABLE");
  if (!gates.pairComplete) hardFail("PAIR_INCOMPLETE");
  if (!gates.activationSatisfied) hardFail("ACTIVATION_UNSATISFIED");
  if (!gates.securityClear) hardFail("SECURITY_BREACH");
  if (!gates.verifiedNonRegression) hardFail("VERIFIED_REGRESSION");
  if (!gates.runtimeErrorSymmetry) hardFail("RUNTIME_ERROR_ASYMMETRY");
  if (!gates.effectSufficient) hardFail("EFFECT_BELOW_THRESHOLD");
  if (!gates.repetitionSufficient) hardFail("SINGLE_RUN_REQUIRES_REPETITION");
  if (!gates.directionStable) hardFail("DIRECTION_UNSTABLE");
  if (!gates.costBounded) hardFail("COST_CEILING_EXCEEDED");

  // INVALID: the inputs/protocol cannot support inference at all.
  if (!gates.artifactIntegrity || !gates.provenanceComparable || !gates.pairComplete) {
    return envelope(input, "INVALID", reasons, gates,
      "Inputs are not comparable: artifact digest mismatch, provenance differences, or incomplete pairs — evidence cannot be used for promotion.",
      "Fix provenance/artifact integrity (E2-01/E2-02) and re-run the paired eval with the V3 protocol.",
    );
  }

  // REJECT: experiment valid but a quality/security/cost gate fails.
  if (!gates.securityClear || !gates.verifiedNonRegression || !gates.runtimeErrorSymmetry || !gates.costBounded) {
    return envelope(input, "REJECT", reasons, gates,
      "Experiment is comparable but a hard quality/security/cost gate failed — the candidate must not be promoted.",
      "Address the failing gate (security breach, verified-completion regression, runtime-error asymmetry, or cost ceiling) before re-evaluating.",
    );
  }

  // INCONCLUSIVE: valid experiment, insufficient or unstable evidence.
  if (!gates.repetitionSufficient || !gates.directionStable || !gates.effectSufficient || !gates.activationSatisfied) {
    const why = reasons.join(", ");
    return envelope(input, "INCONCLUSIVE", reasons, gates,
      `Experiment is valid but evidence is insufficient: ${why}.`,
      "Repeat the paired protocol with pre-registered repetitions and re-evaluate against the pre-registered effect threshold.",
    );
  }

  return envelope(input, "ACCEPT", reasons, gates,
    "All hard gates pass and the pre-registered positive effect threshold is reached across sufficient repetitions.",
    "Promote the candidate under the E2-07 promotion envelope; runtime application is proven by E2-08.",
  );
}

function envelope(
  input: DecisionGateInputV3,
  decision: ChampionDecisionV3,
  reasons: ChampionDecisionReasonCodeV3[],
  gates: ChampionDecisionEnvelopeV3["gates"],
  explanation: string,
  nextStep: string,
): ChampionDecisionEnvelopeV3 {
  return {
    schemaVersion: CHAMPION_DECISION_ENVELOPE_V3_VERSION,
    policyVersion: CHAMPION_DECISION_V3_POLICY_VERSION,
    generatedAtIso: new Date().toISOString(),
    decision,
    reasonCodes: [...new Set(reasons)].sort(),
    gates,
    statistics: {
      cases: input.cases,
      netPassedDelta: input.netPassedDelta,
      repetitions: input.repetitions,
      perRepetitionDeltas: [...input.perRepetitionDeltas],
      activationCoverage: input.activationCoverage,
      securityBreaches: { baseline: input.securityBreachesBaseline, candidate: input.securityBreachesCandidate },
      verifiedRates: { baseline: input.baselineVerifiedRate, candidate: input.candidateVerifiedRate },
      tokensDelta: input.tokensDelta,
    },
    explanation,
    nextStep,
  };
}