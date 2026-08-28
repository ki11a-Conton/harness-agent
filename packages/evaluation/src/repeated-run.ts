/**
 * E1-11 — repeated / interleaved / paired real-model protocol.
 *
 * A single run is a MEASUREMENT, not a statistical baseline. The historical
 * 25/84 pass rate and the "+1 pass" delta were single-run measurements that
 * must not be presented as significant. This module turns a benchmark into a
 * protocol with variance:
 *
 *   REPEAT       — run the same suite N times; report per-repeat pass rates
 *                  plus mean/min/max/std so spread is visible.
 *   INTERLEAVE   — each repeat uses a distinct PRNG seed so execution order
 *                  differs between repeats (order effects cannot align).
 *   PAIRED       — baseline and candidate are compared REPEAT-TO-REPEAT (same
 *                  repeat index), not by cherry-picking the best run.
 *
 * Everything here is deterministic and FREE (the runner executes whatever
 * provider/cases it is given — the protocol layer adds no randomness beyond
 * the seeded shuffle and no cost). It is protocol/statistics, not a verdict:
 * the decision gate remains E1-08 (champion eval) / E1-14 (promotion).
 */

import { runBaseline, type BaselineReport, type BenchmarkCase, type BaselineMeta, type RunBaselineOptions } from "./baseline.js";
import { judgePairComparability, type PairComparabilityVerdict } from "./provenance-v2.js";

export const REPEATED_PROTOCOL_SCHEMA_VERSION = "1.0.0";

/** Aggregate statistics over N repeats. */
export interface RepeatAggregate {
  repeats: number;
  passRateMean: number;
  passRateStd: number;
  passRateMin: number;
  passRateMax: number;
  /** Per-repeat pass rates (index = repeat number, fixed case order). */
  perRepeatPassRates: number[];
  /** Per-repeat casesTotal. */
  perRepeatTotals: number[];
}

export interface RepeatedRunResult {
  schemaVersion: string;
  /** One report per repeat (index = repeat number). */
  repeats: BaselineReport[];
  aggregate: RepeatAggregate;
}

/**
 * Run the same suite N times. Each repeat may use a distinct seed (interleave);
 * the per-repeat reports stay in fixed input order for comparability.
 */
export async function runRepeatedBaseline(
  cases: BenchmarkCase[],
  runCase: (caseDef: BenchmarkCase) => Promise<import("./runner.js").EvalOutcome>,
  meta: BaselineMeta,
  opts: RunBaselineOptions & { repeat?: number; interleave?: boolean } = {},
): Promise<RepeatedRunResult> {
  const repeat = Math.max(1, Math.floor(opts.repeat ?? 1));
  const interleave = opts.interleave ?? false;
  const reports: BaselineReport[] = [];
  for (let r = 0; r < repeat; r++) {
    // Interleave: each repeat gets its own deterministic seed (base + r), so
    // no two repeats share an execution order. Same seed → same order → same
    // result (reproducibility preserved when a specific seed is requested).
    const seed = interleave ? (opts.seed ?? 0) + r : opts.seed;
    reports.push(await runBaseline(cases, runCase, meta, { ...opts, seed }));
  }
  const perRepeatPassRates = reports.map((rep) => rep.summary.success_rate);
  const perRepeatTotals = reports.map((rep) => rep.summary.total);
  return {
    schemaVersion: REPEATED_PROTOCOL_SCHEMA_VERSION,
    repeats: reports,
    aggregate: {
      repeats: repeat,
      passRateMean: mean(perRepeatPassRates),
      passRateStd: std(perRepeatPassRates),
      passRateMin: perRepeatPassRates.length > 0 ? Math.min(...perRepeatPassRates) : 0,
      passRateMax: perRepeatPassRates.length > 0 ? Math.max(...perRepeatPassRates) : 0,
      perRepeatPassRates,
      perRepeatTotals,
    },
  };
}

/** Per-repeat paired comparability verdict. */
export interface RepeatedPairVerdict {
  schemaVersion: string;
  /** Number of repeats compared. */
  repeats: number;
  /** Every repeat must be comparable for the pair to be comparable. */
  comparable: boolean;
  /** Incomparability reasons across repeats (union, deduped). */
  reasons: string[];
  /** Per-repeat detail. */
  perRepeat: Array<{
    repeat: number;
    verdict: PairComparabilityVerdict;
    netDelta: number;
  }>;
  /** Distribution of net passed deltas across repeats. */
  delta: {
    mean: number;
    min: number;
    max: number;
    /** All deltas strictly positive / strictly negative / mixed. */
    sign: "positive" | "negative" | "mixed";
  };
}

/**
 * Compare baseline vs candidate REPEAT-TO-REPEAT (same index). The pair is
 * comparable only when EVERY repeat passes E1-07 comparability (same context
 * hash, different config hash, activation satisfied). Deltas are then reported
 * as a distribution — a single favorable repeat is never a win.
 */
export function judgeRepeatedPair(
  baseline: RepeatedRunResult,
  candidate: RepeatedRunResult,
  opts: { candidateId?: string | null } = {},
): RepeatedPairVerdict {
  const repeats = Math.min(baseline.aggregate.repeats, candidate.aggregate.repeats);
  const reasons = new Set<string>();
  const perRepeat: RepeatedPairVerdict["perRepeat"] = [];
  const deltas: number[] = [];

  for (let r = 0; r < repeats; r++) {
    const b = baseline.repeats[r]!;
    const c = candidate.repeats[r]!;
    // Per-case E1-07 comparability on each repeat.
    const verdict = judgePairComparability(convertReport(b), convertReport(c), {
      strict: true,
      candidateId: opts.candidateId ?? null,
    });
    const netDelta = (c.summary.passed ?? 0) - (b.summary.passed ?? 0);
    deltas.push(netDelta);
    perRepeat.push({ repeat: r, verdict, netDelta });
    for (const reason of verdict.reasons) reasons.add(reason);
  }

  const deltaMean = mean(deltas);
  const deltaMin = deltas.length > 0 ? Math.min(...deltas) : 0;
  const deltaMax = deltas.length > 0 ? Math.max(...deltas) : 0;
  const sign: "positive" | "negative" | "mixed" =
    deltas.length === 0 ? "mixed"
    : deltas.every((d) => d > 0) ? "positive"
    : deltas.every((d) => d < 0) ? "negative"
    : "mixed";

  return {
    schemaVersion: REPEATED_PROTOCOL_SCHEMA_VERSION,
    repeats,
    comparable: reasons.size === 0,
    reasons: [...reasons],
    perRepeat,
    delta: { mean: deltaMean, min: deltaMin, max: deltaMax, sign },
  };
}

/** Convert a BaselineReport into EvalOutcome[] for E1-07 comparability. */
function convertReport(report: BaselineReport): import("./runner.js").EvalOutcome[] {
  return report.results.map((r) => ({
    caseId: r.task_id,
    status: r.success ? "passed" : "failed",
    actualStatus: r.actual_status,
    events: [],
    metrics: {
      turn_count: 0,
      tool_call_count: r.tool_calls ?? 0,
      tokens_input: r.input_tokens ?? 0,
      tokens_output: r.output_tokens ?? 0,
      context_tokens: 0,
      compaction_count: r.compactions ?? 0,
      duration_ms: r.duration_ms ?? 0,
      retry_count: r.retries ?? 0,
      verification_failures: r.verification_failures ?? 0,
      human_interventions: r.human_interventions ?? 0,
      estimated_cost: 0,
      usage_unknown: 0,
      cache_tokens_read: 0,
      cache_tokens_created: 0,
      model_call_count: r.model_calls ?? 0,
    },
    violations: r.violations ?? [],
    suite: (r.suite ?? "regression") as import("./eval-case.js").EvalSuite,
    judgeVersion: r.judge_version,
    evaluationContextHash: r.evaluationContextHash,
    candidateConfigHash: r.candidateConfigHash,
    controlledDifference: r.controlledDifference,
    activationEvidence: r.activation_evidence,
  }));
}

function mean(xs: number[]): number {
  if (xs.length === 0) return 0;
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

/** Sample standard deviation (n-1); 0 for a single repeat. */
function std(xs: number[]): number {
  if (xs.length <= 1) return 0;
  const m = mean(xs);
  const variance = xs.reduce((acc, x) => acc + (x - m) * (x - m), 0) / (xs.length - 1);
  return Math.sqrt(variance);
}
