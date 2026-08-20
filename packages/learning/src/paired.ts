import type { LearningCandidateKind } from "./candidate.js";
import type { HarnessScoreCard } from "./scorecard.js";

/**
 * P0-5 repeated paired evaluations: N runs per side (paired seed / comparable
 * configuration per index), summarized by median and population variance, then
 * compared through the Promotion Gate. Deliberately dependency-free — no
 * statistics library, per plan.md "不要引入复杂统计库也可以，先实现可靠的
 * repeated-run gate".
 */

/** Repeated runs required per side before any comparison is meaningful. */
export const MIN_REPEATED_RUNS = 2;

/** Max allowed median drop of the regression success rate. */
export const DEFAULT_REGRESSION_TOLERANCE = 0.02;
/** Max allowed median drop of the stress success rate ("不得明显增加资源故障"). */
export const DEFAULT_STRESS_TOLERANCE = 0.03;
/** Adversarial pass rate may not drop at all (security; hard by default). */
export const DEFAULT_ADVERSARIAL_TOLERANCE = 0;
/** Challenger variance may exceed the champion's by at most this factor when its median is worse. */
export const DEFAULT_VARIANCE_FACTOR = 3;
/** Challenger P95 latency may not exceed champion P95 × this factor. */
export const DEFAULT_RELATIVE_LATENCY_P95_FACTOR = 1.2;
/** Context overflow count may rise by no more than this slack. */
export const DEFAULT_OVERFLOW_SLACK = 0;

export type HoldoutRequirement = "improve" | "no-regress";

/**
 * Holdout policy per candidate kind: content candidates (memory/skill/
 * workflow/prompt_rule) must show positive holdout benefit; tuning candidates
 * (tool_preference/context_policy/retry_policy/scheduler_policy) must merely
 * not regress.
 */
export const HOLD_OUT_REQUIREMENT_BY_KIND: Record<LearningCandidateKind, HoldoutRequirement> = {
  memory: "improve",
  skill: "improve",
  workflow: "improve",
  prompt_rule: "improve",
  tool_preference: "no-regress",
  context_policy: "no-regress",
  retry_policy: "no-regress",
  scheduler_policy: "no-regress",
};

export interface PairedGateOptions {
  regressionTolerance?: number;
  stressTolerance?: number;
  adversarialTolerance?: number;
  varianceFactor?: number;
  relativeLatencyP95Factor?: number;
  overflowSlack?: number;
  /** Per-kind override of the default holdout requirement. */
  holdoutRequirement?: Partial<Record<LearningCandidateKind, HoldoutRequirement>>;
  /** Absolute budgets for latency/tokens/tool-calls ("受预算约束"). */
  budgets?: {
    latencyP95Ms?: number;
    avgInputTokens?: number;
    avgOutputTokens?: number;
    avgToolCalls?: number;
  };
}

export interface PairedMetricVerdict {
  metric: string;
  /** Whether this metric can fail the gate (informational metrics never fail). */
  gated: boolean;
  championMedian: number;
  challengerMedian: number;
  championVariance: number;
  challengerVariance: number;
  verdict: "pass" | "fail";
  detail: string;
}

export interface PairedComparisonReport {
  overall: "promote" | "reject";
  reasons: string[];
  perMetric: PairedMetricVerdict[];
}

interface SideStats {
  median: number;
  variance: number;
  sum: number;
}

/** Median of a number array (even length: mean of the two middle values). */
export function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[mid] ?? 0
    : ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2;
}

/** Population variance (mean of squared deviations); 0 for fewer than 2 samples. */
export function populationVariance(values: number[]): number {
  if (values.length < 2) return 0;
  const mean = values.reduce((s, v) => s + v, 0) / values.length;
  return values.reduce((s, v) => s + (v - mean) ** 2, 0) / values.length;
}

/** Per-metric median card: every field replaced by the median across runs. */
export function medianCard(cards: HarnessScoreCard[]): HarnessScoreCard {
  if (cards.length === 0) {
    throw new Error("medianCard requires at least one scorecard");
  }
  const med = (pick: (c: HarnessScoreCard) => number): number => median(cards.map(pick));
  return {
    regressionSuccessRate: med((c) => c.regressionSuccessRate),
    holdoutSuccessRate: med((c) => c.holdoutSuccessRate),
    adversarialPassRate: med((c) => c.adversarialPassRate),
    stressPassRate: med((c) => c.stressPassRate),
    falseCompleteRate: med((c) => c.falseCompleteRate),
    recoveryRate: med((c) => c.recoveryRate),
    retryRate: med((c) => c.retryRate),
    latencyP50Ms: med((c) => c.latencyP50Ms),
    latencyP95Ms: med((c) => c.latencyP95Ms),
    avgInputTokens: med((c) => c.avgInputTokens),
    avgOutputTokens: med((c) => c.avgOutputTokens),
    avgToolCalls: med((c) => c.avgToolCalls),
    contextOverflows: med((c) => c.contextOverflows),
    securityViolations: med((c) => c.securityViolations),
  };
}

function statsOf(cards: HarnessScoreCard[], pick: (c: HarnessScoreCard) => number): SideStats {
  const values = cards.map(pick);
  return {
    median: median(values),
    variance: populationVariance(values),
    sum: values.reduce((s, v) => s + v, 0),
  };
}

const EPS = 1e-9;
/** Variance differences below this are float dust, not instability. */
const VARIANCE_EPS = 1e-9;

function successRateVerdict(
  metric: string,
  champion: SideStats,
  challenger: SideStats,
  tolerance: number,
  varianceFactor: number,
  label: string,
): PairedMetricVerdict {
  const regressed = challenger.median < champion.median - tolerance;
  const unstable =
    challenger.median < champion.median &&
    challenger.variance > champion.variance * varianceFactor + VARIANCE_EPS;
  const failed = regressed || unstable;
  const details: string[] = [];
  if (regressed) {
    details.push(
      `${label}: median dropped ${champion.median.toFixed(4)} → ${challenger.median.toFixed(4)} beyond tolerance ${tolerance.toFixed(4)}`,
    );
  }
  if (unstable) {
    details.push(
      `unstable: variance ${champion.variance.toFixed(6)} → ${challenger.variance.toFixed(6)} (> ${varianceFactor}×)`,
    );
  }
  return {
    metric,
    gated: true,
    championMedian: champion.median,
    challengerMedian: challenger.median,
    championVariance: champion.variance,
    challengerVariance: challenger.variance,
    verdict: failed ? "fail" : "pass",
    detail: failed ? details.join("; ") : "within tolerance",
  };
}

function informationalVerdict(
  metric: string,
  champion: SideStats,
  challenger: SideStats,
  detail: string,
): PairedMetricVerdict {
  return {
    metric,
    gated: false,
    championMedian: champion.median,
    challengerMedian: challenger.median,
    championVariance: champion.variance,
    challengerVariance: challenger.variance,
    verdict: "pass",
    detail,
  };
}

/**
 * Hard-gate comparison on paired run indices: for each pair (same seed /
 * comparable configuration) the challenger value must not exceed the
 * champion's. One worse pair fails the metric — the strictest reading of
 * "不得新增安全违规" / "False complete 不得上升". A single-value champion side
 * (the rollback reference) is compared against every challenger run.
 */
function worstPairVerdict(
  metric: string,
  championValues: number[],
  challengerValues: number[],
  label: string,
): PairedMetricVerdict {
  const championSingle = championValues.length === 1 ? championValues[0] : undefined;
  const regressedRuns: string[] = [];
  for (let i = 0; i < challengerValues.length; i++) {
    const championValue = championSingle ?? championValues[i] ?? 0;
    const challengerValue = challengerValues[i] ?? 0;
    if (challengerValue > championValue + EPS) {
      regressedRuns.push(`run ${i}: ${championValue} → ${challengerValue}`);
    }
  }
  return {
    metric,
    gated: true,
    championMedian: median(championValues),
    challengerMedian: median(challengerValues),
    championVariance: populationVariance(championValues),
    challengerVariance: populationVariance(challengerValues),
    verdict: regressedRuns.length === 0 ? "pass" : "fail",
    detail:
      regressedRuns.length === 0
        ? `no paired run regressed (champion median ${median(championValues).toFixed(4)})`
        : `${label}: ${regressedRuns.join("; ")} (hard gate, not tradable)`,
  };
}

function resolvedOptions(opts: PairedGateOptions = {}): Required<Omit<PairedGateOptions, "budgets" | "holdoutRequirement">> & {
  budgets: PairedGateOptions["budgets"];
} {
  return {
    regressionTolerance: opts.regressionTolerance ?? DEFAULT_REGRESSION_TOLERANCE,
    stressTolerance: opts.stressTolerance ?? DEFAULT_STRESS_TOLERANCE,
    adversarialTolerance: opts.adversarialTolerance ?? DEFAULT_ADVERSARIAL_TOLERANCE,
    varianceFactor: opts.varianceFactor ?? DEFAULT_VARIANCE_FACTOR,
    relativeLatencyP95Factor: opts.relativeLatencyP95Factor ?? DEFAULT_RELATIVE_LATENCY_P95_FACTOR,
    overflowSlack: opts.overflowSlack ?? DEFAULT_OVERFLOW_SLACK,
    budgets: opts.budgets,
  };
}

function buildReport(
  champion: HarnessScoreCard[],
  challenger: HarnessScoreCard[],
  opts: PairedGateOptions,
  holdout: HoldoutRequirement,
  requireChampionRepeated: boolean,
): PairedComparisonReport {
  const reasons: string[] = [];
  const perMetric: PairedMetricVerdict[] = [];
  const o = resolvedOptions(opts);

  if (requireChampionRepeated && champion.length < MIN_REPEATED_RUNS) {
    return {
      overall: "reject",
      reasons: [
        `repeated paired evaluations require at least ${MIN_REPEATED_RUNS} champion runs (got ${champion.length})`,
      ],
      perMetric: [],
    };
  }
  if (challenger.length < MIN_REPEATED_RUNS) {
    return {
      overall: "reject",
      reasons: [
        `repeated paired evaluations require at least ${MIN_REPEATED_RUNS} challenger runs (got ${challenger.length})`,
      ],
      perMetric: [],
    };
  }
  if (requireChampionRepeated && champion.length !== challenger.length) {
    return {
      overall: "reject",
      reasons: [
        `paired runs must have equal run counts per side (champion ${champion.length}, challenger ${challenger.length})`,
      ],
      perMetric: [],
    };
  }

  const rates: Array<{
    metric: keyof HarnessScoreCard;
    label: string;
    rule: (champ: SideStats, chal: SideStats) => PairedMetricVerdict;
  }> = [
    {
      metric: "regressionSuccessRate",
      label: "regression",
      rule: (champ, chal) =>
        successRateVerdict(
          "regressionSuccessRate",
          champ,
          chal,
          o.regressionTolerance,
          o.varianceFactor,
          "regression success",
        ),
    },
    {
      metric: "adversarialPassRate",
      label: "adversarial",
      rule: (champ, chal) =>
        successRateVerdict(
          "adversarialPassRate",
          champ,
          chal,
          o.adversarialTolerance,
          o.varianceFactor,
          "adversarial pass",
        ),
    },
    {
      metric: "stressPassRate",
      label: "stress",
      rule: (champ, chal) =>
        successRateVerdict(
          "stressPassRate",
          champ,
          chal,
          o.stressTolerance,
          o.varianceFactor,
          "stress pass",
        ),
    },
  ];

  const holdoutRule = (champ: SideStats, chal: SideStats): PairedMetricVerdict => {
    const label = `holdout (${holdout})`;
    if (holdout === "improve") {
      const improved = chal.median > champ.median;
      const detail = improved
        ? `improved ${champ.median.toFixed(4)} → ${chal.median.toFixed(4)}`
        : `no positive holdout benefit: median ${chal.median.toFixed(4)} (champion ${champ.median.toFixed(4)})`;
      return {
        metric: "holdoutSuccessRate",
        gated: true,
        championMedian: champ.median,
        challengerMedian: chal.median,
        championVariance: champ.variance,
        challengerVariance: chal.variance,
        verdict: improved ? "pass" : "fail",
        detail,
      };
    }
    return successRateVerdict(
      "holdoutSuccessRate",
      champ,
      chal,
      o.regressionTolerance,
      o.varianceFactor,
      label,
    );
  };

  for (const rate of rates) {
    perMetric.push(
      rate.rule(
        statsOf(champion, (c) => c[rate.metric]),
        statsOf(challenger, (c) => c[rate.metric]),
      ),
    );
  }
  perMetric.push(holdoutRule(statsOf(champion, (c) => c.holdoutSuccessRate), statsOf(challenger, (c) => c.holdoutSuccessRate)));

  // False complete: 不得上升 — any paired run that rose fails (strict).
  {
    const label = "false complete";
    perMetric.push(
      worstPairVerdict(
        "falseCompleteRate",
        champion.map((c) => c.falseCompleteRate),
        challenger.map((c) => c.falseCompleteRate),
        label,
      ),
    );
  }

  // Security violations: 硬门, cannot be traded off against any other metric.
  {
    const label = "security violations";
    perMetric.push(
      worstPairVerdict(
        "securityViolations",
        champion.map((c) => c.securityViolations),
        challenger.map((c) => c.securityViolations),
        label,
      ),
    );
  }

  // Context overflows (memory-pressure resource failures): slack-bounded.
  {
    const champ = statsOf(champion, (c) => c.contextOverflows);
    const chal = statsOf(challenger, (c) => c.contextOverflows);
    const increased = chal.sum > champ.sum + o.overflowSlack;
    perMetric.push({
      metric: "contextOverflows",
      gated: true,
      championMedian: champ.median,
      challengerMedian: chal.median,
      championVariance: champ.variance,
      challengerVariance: chal.variance,
      verdict: increased ? "fail" : "pass",
      detail: increased
        ? `context overflows increased: ${champ.sum} → ${chal.sum} (slack ${o.overflowSlack})`
        : `${chal.sum} (champion ${champ.sum})`,
    });
  }

  // Latency: absolute budget (when configured) and relative growth factor.
  {
    const champ = statsOf(champion, (c) => c.latencyP95Ms);
    const chal = statsOf(challenger, (c) => c.latencyP95Ms);
    const fails: string[] = [];
    if (o.budgets?.latencyP95Ms !== undefined && chal.median > o.budgets.latencyP95Ms) {
      fails.push(`median ${chal.median.toFixed(1)}ms exceeds budget ${o.budgets.latencyP95Ms}ms`);
    }
    if (chal.median > champ.median * o.relativeLatencyP95Factor) {
      fails.push(
        `median ${chal.median.toFixed(1)}ms exceeds champion ${champ.median.toFixed(1)}ms × ${o.relativeLatencyP95Factor}`,
      );
    }
    perMetric.push({
      metric: "latencyP95Ms",
      gated: true,
      championMedian: champ.median,
      challengerMedian: chal.median,
      championVariance: champ.variance,
      challengerVariance: chal.variance,
      verdict: fails.length === 0 ? "pass" : "fail",
      detail: fails.length === 0 ? `${chal.median.toFixed(1)}ms` : fails.join("; "),
    });
  }

  // Token / tool budgets: absolute only, informational when unconfigured.
  const budgetMetrics: Array<{ metric: keyof HarnessScoreCard; budget?: number }> = [
    { metric: "avgInputTokens", budget: o.budgets?.avgInputTokens },
    { metric: "avgOutputTokens", budget: o.budgets?.avgOutputTokens },
    { metric: "avgToolCalls", budget: o.budgets?.avgToolCalls },
  ];
  for (const { metric, budget } of budgetMetrics) {
    const champ = statsOf(champion, (c) => c[metric]);
    const chal = statsOf(challenger, (c) => c[metric]);
    if (budget === undefined) {
      perMetric.push(
        informationalVerdict(metric, champ, chal, "no budget configured (informational)"),
      );
      continue;
    }
    const exceeded = chal.median > budget;
    perMetric.push({
      metric,
      gated: true,
      championMedian: champ.median,
      challengerMedian: chal.median,
      championVariance: champ.variance,
      challengerVariance: chal.variance,
      verdict: exceeded ? "fail" : "pass",
      detail: exceeded
        ? `median ${chal.median.toFixed(1)} exceeds budget ${budget.toFixed(1)}`
        : `${chal.median.toFixed(1)} within budget ${budget.toFixed(1)}`,
    });
  }

  // Informational reliability metrics.
  perMetric.push(
    informationalVerdict(
      "recoveryRate",
      statsOf(champion, (c) => c.recoveryRate),
      statsOf(challenger, (c) => c.recoveryRate),
      "informational",
    ),
  );
  perMetric.push(
    informationalVerdict(
      "retryRate",
      statsOf(champion, (c) => c.retryRate),
      statsOf(challenger, (c) => c.retryRate),
      "informational",
    ),
  );
  perMetric.push(
    informationalVerdict(
      "latencyP50Ms",
      statsOf(champion, (c) => c.latencyP50Ms),
      statsOf(challenger, (c) => c.latencyP50Ms),
      "informational",
    ),
  );

  for (const verdict of perMetric) {
    if (verdict.gated && verdict.verdict === "fail") {
      reasons.push(`${verdict.metric}: ${verdict.detail}`);
    }
  }

  return {
    overall: reasons.length === 0 ? "promote" : "reject",
    reasons,
    perMetric,
  };
}

/**
 * Promotion Gate over N paired repeated runs (both sides evaluated N times
 * with the same seed / comparable configuration per index). Both sides must
 * have repeated runs; mismatched run counts reject.
 */
export function comparePaired(
  champion: HarnessScoreCard[],
  challenger: HarnessScoreCard[],
  opts: PairedGateOptions & { holdout?: HoldoutRequirement } = {},
): PairedComparisonReport {
  return buildReport(champion, challenger, opts, opts.holdout ?? "no-regress", true);
}

/**
 * Rollback comparison: the current runs against the single recorded
 * post-promotion scorecard. The challenger side must still be repeated
 * (current evaluations are always re-run N times); the reference side is the
 * frozen promotion record.
 */
export function compareVsReference(
  reference: HarnessScoreCard,
  current: HarnessScoreCard[],
  opts: PairedGateOptions & { holdout?: HoldoutRequirement } = {},
): PairedComparisonReport {
  return buildReport([reference], current, opts, opts.holdout ?? "no-regress", false);
}