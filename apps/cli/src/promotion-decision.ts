/**
 * E1-08 — champion eval decision state machine (CLI layer).
 *
 * Four verdicts, fail-closed:
 *
 *   INVALID      → Not comparable (provenance mismatch, no activation…)
 *   REJECT       → Comparable but quality gates failed
 *   INCONCLUSIVE → Comparable, gates pass, but sample too small / no delta
 *   ACCEPT       → Comparable, gates pass, evidence sufficient for promotion
 *
 * The comparability gate (E1-07) runs FIRST — an INVALID pair is never
 * REJECTed or ACCEPTed regardless of pass deltas.
 */

import type { EvalOutcome } from "@ar/evaluation";
import { judgePairComparability, type PairComparabilityVerdict } from "@ar/evaluation";
import type { PairedEvalReport } from "@ar/evaluation";
import { evaluateChampionQuality, type ChampionQualityVerdict } from "./champion-eval.js";

export type PromotionDecision = "ACCEPT" | "REJECT" | "INCONCLUSIVE" | "INVALID";

export interface ChampionEvalDecision {
  decision: PromotionDecision;
  reasonCode: string;
  explanation: string;
  comparability: PairComparabilityVerdict | null;
  quality: ChampionQualityVerdict | null;
}

/**
 * Evaluate a baseline/candidate comparison into a single decision.
 * Comparability gate first (E1-07); quality gates only when comparable.
 * `strict: true` requires full provenance + activation for promotion.
 */
export function evaluateChampionDecision(
  baselineRuns: EvalOutcome[],
  candidateRuns: EvalOutcome[],
  report: PairedEvalReport,
  opts: { strict: boolean; candidateId?: string | null } = { strict: true },
): ChampionEvalDecision {
  const comparability = judgePairComparability(baselineRuns, candidateRuns, {
    strict: opts.strict,
    candidateId: opts.candidateId,
  });

  if (!comparability.comparable) {
    return {
      decision: "INVALID",
      reasonCode: "INCOMPARABLE",
      explanation: `Comparison is INVALID (not comparable): ${comparability.reasons.join(", ")}. Evidence cannot be used for promotion.`,
      comparability,
      quality: null,
    };
  }

  const quality = evaluateChampionQuality(baselineRuns, candidateRuns, report, {
    strictPromotion: opts.strict,
  });

  if (!quality.passed) {
    return {
      decision: "REJECT",
      reasonCode: "QUALITY_GATES_FAILED",
      explanation: `Candidate is comparable but fails ${quality.failures.length} quality check(s): ${quality.failures.join("; ")}`,
      comparability,
      quality,
    };
  }

  if (baselineRuns.length < 10) {
    return {
      decision: "INCONCLUSIVE",
      reasonCode: "SMALL_SAMPLE",
      explanation: `Only ${baselineRuns.length} paired cases — insufficient for a statistically significant promotion verdict.`,
      comparability,
      quality,
    };
  }

  const netDelta = report.aggregated.netPassedDelta;
  if (netDelta < 1) {
    return {
      decision: "INCONCLUSIVE",
      reasonCode: "NO_PASS_DELTA",
      explanation: `Net pass delta is ${netDelta} — candidate does not materially improve the pass rate.`,
      comparability,
      quality,
    };
  }

  return {
    decision: "ACCEPT",
    reasonCode: "ALL_GATES_PASSED",
    explanation: "All comparability and quality gates pass with sufficient evidence for promotion.",
    comparability,
    quality,
  };
}
