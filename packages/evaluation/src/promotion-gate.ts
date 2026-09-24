/**
 * P21-4 — promotion gate.
 *
 * A candidate enters the Champion only when BOTH gate classes pass:
 *
 * HARD gates (CI/production hygiene — supplied by the pipeline, never
 * self-reported by the candidate):
 *   - typecheck / test / build / coverage green
 *   - Linux + Windows matrix green
 *   - critical adversarial escapes = 0
 *   - no new fail-open path
 *   - no crash-recovery duplicate side effect
 *
 * QUALITY gates (from the P21-3 paired report, real-model or stub):
 *   - no net regression on the paired suite (netPassedDelta >= 0)
 *   - verified completion does not drop beyond tolerance
 *   - token/cost growth > 15% requires a success-rate benefit (explained)
 *   - a pass-rate gain that comes ONLY from unbounded tool/retry counts is
 *     NOT a gain (no free "more attempts" promotion)
 *
 * Small-sample honesty: for a ~30-case suite the gate never emits fake
 * precision — it reports per-case wins/losses/ties (already in the paired
 * report) and recommends repetitions when the net delta is below a
 * meaningful threshold.
 */

import type { PairedEvalReport } from "./paired-eval.js";

/** Pipeline-supplied hygiene signals (fail-closed: false = gate fails). */
export interface HardGateStatus {
  typecheck: boolean;
  test: boolean;
  build: boolean;
  coverage: boolean;
  /** Linux + Windows matrix green. */
  crossPlatformMatrix: boolean;
  /** Number of critical adversarial escapes observed. */
  adversarialEscapes: number;
  /** True when a NEW fail-open path was introduced. */
  newFailOpenPath: boolean;
  /** True when crash recovery can duplicate a committed side effect. */
  crashRecoveryDuplicateSideEffect: boolean;
}

export interface PromotionQualityOptions {
  /** Max verified-completion drop tolerated (default 0.05). */
  maxVerifiedDrop?: number;
  /** Token/cost growth ratio beyond which a success benefit is required
   *  (default 0.15 = 15%). */
  maxTokenGrowthRatio?: number;
  /** Minimum net passed delta for a small sample to be conclusive
   *  (below this, the gate recommends repetition instead of promoting). */
  minConclusiveNetDelta?: number;
}

export interface PromotionVerdict {
  promoted: boolean;
  hardGatesPassed: boolean;
  qualityGatesPassed: boolean;
  hardFailures: string[];
  qualityFailures: string[];
  /** Recommendation when the sample is too small to be conclusive. */
  recommendsRepetition: boolean;
}

/**
 * P21-4 — evaluate the hard gates. Every signal is pipeline-supplied; a
 * missing/false signal fails the gate (never a silent pass).
 */
export function evaluateHardGates(status: HardGateStatus): {
  passed: boolean;
  failures: string[];
} {
  const failures: string[] = [];
  if (!status.typecheck) failures.push("typecheck not green");
  if (!status.test) failures.push("test suite not green");
  if (!status.build) failures.push("build not green");
  if (!status.coverage) failures.push("coverage gate not green");
  if (!status.crossPlatformMatrix) failures.push("Linux+Windows matrix not green");
  if (status.adversarialEscapes > 0) {
    failures.push(`critical adversarial escapes: ${status.adversarialEscapes} (must be 0)`);
  }
  if (status.newFailOpenPath) failures.push("new fail-open path introduced");
  if (status.crashRecoveryDuplicateSideEffect) {
    failures.push("crash recovery can duplicate a committed side effect");
  }
  return { passed: failures.length === 0, failures };
}

/**
 * P21-4 — evaluate the quality gates from a paired report. Small-sample
 * honest: no fake precision; a below-threshold net delta recommends
 * repetition rather than a conclusive promote.
 */
export function evaluateQualityGates(
  report: PairedEvalReport,
  options: PromotionQualityOptions = {},
): {
  passed: boolean;
  failures: string[];
  recommendsRepetition: boolean;
} {
  const failures: string[] = [];
  const agg = report.aggregated;
  const maxVerifiedDrop = options.maxVerifiedDrop ?? 0.05;
  const maxTokenGrowth = options.maxTokenGrowthRatio ?? 0.15;
  void maxTokenGrowth; // reserved: absolute baseline tokens are needed to apply the 15% ratio
  const minConclusive = options.minConclusiveNetDelta ?? 2;

  // Q1: no net regression on the paired suite.
  if (agg.netPassedDelta < 0) {
    failures.push(`net regression: candidate is ${-agg.netPassedDelta} passed case(s) behind baseline`);
  }

  // Q2: verified completion must not drop.
  const verifiedDrop = agg.baselineVerifiedRate - agg.candidateVerifiedRate;
  if (verifiedDrop > maxVerifiedDrop) {
    failures.push(
      `verified completion dropped ${verifiedDrop.toFixed(3)} (tolerance ${maxVerifiedDrop}); ` +
        "a candidate that ships more false-completes is not an improvement",
    );
  }

  // Q3: token/cost growth requires a success-rate benefit. The paired
  // aggregate carries deltas, so the rule is: cost grew AND there was no net
  // gain (or no win at all) → the growth is unjustified.
  if (agg.tokensDelta > 0 && agg.netPassedDelta <= 0) {
    failures.push(
      `token cost +${agg.tokensDelta} with no net success gain — cost growth without benefit (P21-4 Q3)`,
    );
  } else if (agg.tokensDelta > 0 && agg.candidateWins === 0) {
    failures.push(
      `cost +${agg.tokensDelta} tokens but candidate won no cases — needs success-rate justification`,
    );
  }

  // Q4: a pass-rate gain that comes ONLY from more tool calls / retries is
  // not a gain (unbounded attempt counts buy success, not capability).
  if (agg.netPassedDelta > 0 && agg.candidateWins > 0) {
    const gainPerAttempt = agg.candidateWins / Math.max(1, Math.abs(agg.toolCallsDelta));
    if (agg.toolCallsDelta > agg.cases && agg.recoveryDelta >= agg.candidateWins) {
      failures.push(
        `pass-rate gain appears bought by unbounded attempts: +${agg.toolCallsDelta} tool calls / ` +
          `+${agg.recoveryDelta} recoveries for ${agg.candidateWins} wins (gain-per-attempt ${gainPerAttempt.toFixed(3)})`,
      );
    }
  }

  // Small-sample honesty: below-threshold net delta → recommend repetition.
  const recommendsRepetition = report.mode === "real-model" && Math.abs(agg.netPassedDelta) < minConclusive;

  return { passed: failures.length === 0, failures, recommendsRepetition };
}

/** P21-4 — full promotion verdict (hard + quality gates together). */
export function evaluatePromotion(
  report: PairedEvalReport,
  hard: HardGateStatus,
  options: PromotionQualityOptions = {},
): PromotionVerdict {
  const hardResult = evaluateHardGates(hard);
  const qualityResult = evaluateQualityGates(report, options);
  return {
    promoted: hardResult.passed && qualityResult.passed && !qualityResult.recommendsRepetition,
    hardGatesPassed: hardResult.passed,
    qualityGatesPassed: qualityResult.passed,
    hardFailures: hardResult.failures,
    qualityFailures: qualityResult.failures,
    recommendsRepetition: qualityResult.recommendsRepetition,
  };
}

/** Render the verdict for CLI/report output. */
export function renderPromotionVerdict(verdict: PromotionVerdict): string[] {
  const lines = ["# P21-4 promotion gate", ""];
  lines.push(verdict.hardGatesPassed ? "hard gates: PASS" : "hard gates: FAIL");
  for (const f of verdict.hardFailures) lines.push(`  - ${f}`);
  lines.push(verdict.qualityGatesPassed ? "quality gates: PASS" : "quality gates: FAIL");
  for (const f of verdict.qualityFailures) lines.push(`  - ${f}`);
  if (verdict.recommendsRepetition) {
    lines.push("note: net delta below conclusive threshold — repeat the paired eval before promoting");
  }
  lines.push("", verdict.promoted ? "VERDICT: PROMOTE" : "VERDICT: DO NOT PROMOTE");
  return lines;
}
