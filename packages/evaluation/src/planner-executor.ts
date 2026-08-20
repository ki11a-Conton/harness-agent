import type { EvalCase, EvalSuite } from "./eval-case.js";
import type { EvalOutcome } from "./runner.js";
import { scoreCost, type CostModelOptions, type CostResult } from "./cost-model.js";

/**
 * P3-1 — Planner / Executor Separation Experiment.
 *
 * A mechanism-CANDIDATE experiment, deliberately NOT a main-runtime refactor.
 * It models two execution architectures against the same benchmark cases:
 *
 *   single_loop        champion — the current continuous act/decide loop.
 *   planner_executor   challenger — a bounded planning phase before execution.
 *
 * The core hypothesis to validate on benchmark: separation raises the pass
 * rate on COMPLEX tasks (multi-file / multi-tool / verification-gated) by
 * front-loading planning, at the price of a planning pass (extra tokens +
 * latency) on every case. If it only inflates tokens/latency without a
 * complex-task quality gain, we must NOT promote it (plan.md P3: "如果只是
 * 增加 token/latency，不推广").
 *
 * Because the runtime's loop is not being refactored here, the challenger is
 * expressed as a deterministic EFFECT MODEL on top of measured baseline
 * per-case outcomes. The model is explicit (config fields), not fabricated:
 * given a baseline `EvalOutcome`, a seeded PRNG reproduces what the
 * architectural change would do to pass/fail, tokens and latency. The
 * promotion decision then folds the cost model in, so a pure token/latency
 * gain can never be promoted.
 *
 * Counting / thresholds are explicit and defaults are documented; every
 * derived number is a pure function of the baseline data + the config.
 */
export type ExecutionArchitecture = "single_loop" | "planner_executor";

/** Structural cues used to classify task complexity — real case fields, never
 *  model wording. Case suites are cast defensively from the string label. */
export interface ComplexityCues {
  fixtureFileCount: number;
  verificationSpecCount: number;
  requestLength: number;
  suite: string;
  hasVerification: boolean;
}

/** Deterministic complexity score for one case, in [0,1]. */
export interface CaseComplexity {
  caseId: string;
  score: number;
  complex: boolean;
}

/** The challenger's effect model — the experiment's tunable hypothesis. */
export interface PlannerExecutorEffectModel {
  /** Extra tokens the planning phase burns on every case (challenger only). */
  planningTokensPerCase: number;
  /** Extra wall-clock (ms) the planning phase adds on every case. */
  planningLatencyMsPerCase: number;
  /** Absolute increase in pass probability on COMPLEX tasks (0..1). */
  complexPassGain: number;
  /** Absolute decrease in pass probability on SIMPLE tasks (0..1, >=0).
   *  Simple tasks should not be separated; this models the overhead. */
  simplePassPenalty: number;
  /** Complexity score >= this → complex (default 0.5). */
  complexityThreshold: number;
}

/** Per-case model result for one architecture. */
export interface ArchitectureRunMetrics {
  caseId: string;
  architecture: ExecutionArchitecture;
  complex: boolean;
  passed: boolean;
  tokens: number;
  durationMs: number;
  toolCalls: number;
}

/** Aggregated metrics for one architecture over the whole bench. */
export interface ArchitectureAggregate {
  architecture: ExecutionArchitecture;
  passRateComplex: number;
  passRateSimple: number;
  passRateOverall: number;
  totalTokens: number;
  totalDurationMs: number;
  totalToolCalls: number;
  costScore: number;
}

/** The core comparison + promotion gate output. */
export interface PlannerExecutorComparison {
  baseline: ArchitectureAggregate;
  challenger: ArchitectureAggregate;
  cases: ArchitectureRunMetrics[];
  complexCount: number;
  simpleCount: number;
  complexPassDelta: number;
  simplePassDelta: number;
  passRateOverallDelta: number;
  tokenDeltaRatio: number;
  latencyDeltaRatio: number;
  costScoreDelta: number;
  decision: PlannerExecutorDecision;
}

export type PlannerExecutorDecisionCode =
  | "promote"
  | "no_complex_gain"
  | "simple_regression"
  | "cost_negative";

export interface PlannerExecutorDecision {
  promote: boolean;
  code: PlannerExecutorDecisionCode;
  reason: string;
  minimumComplexGain: number;
  simpleRegressTolerance: number;
}

export interface RunPlannerExecutorOptions {
  /** Effect model for the challenger. Defaults documented below. */
  model?: Partial<PlannerExecutorEffectModel>;
  /** Cost-model budgets forwarded to scoreCost. */
  cost?: CostModelOptions;
  /** PRNG seed for reproducible challenger simulation (default 11). */
  seed?: number;
  /** Promotion gate knobs (defaults below). */
  gate?: {
    /** Minimum required complex-task pass-rate improvement to consider promotion. */
    minimumComplexGain?: number;
    /** Below this, a simple-task regression blocks promotion. */
    simpleRegressTolerance?: number;
  };
}

// ---------------------- Complexity classification -------------------------

/** Extract deterministic complexity cues from a benchmark/eval case. */
export function complexityCuesOf(
  caseDef: Pick<EvalCase, "id" | "task" | "verification" | "suite"> & {
    fixture?: Record<string, string>;
  },
): ComplexityCues {
  return {
    fixtureFileCount: caseDef.fixture !== undefined ? Object.keys(caseDef.fixture).length : 0,
    verificationSpecCount: caseDef.verification?.length ?? 0,
    requestLength: caseDef.task.length,
    suite: caseDef.suite ?? "regression",
    hasVerification: (caseDef.verification?.length ?? 0) > 0,
  };
}

/**
 * Deterministic complexity score in [0,1]. Derives from structural cues only:
 * more fixture files, a verification gate, harder suite labels and a longer
 * request all push the score up. A two-file task with a verification gate
 * scores ~0.8 → complex by default; an empty-fixture one-liner stays simple.
 */
export function classifyCaseComplexity(
  caseDef: Pick<EvalCase, "id" | "task" | "verification" | "suite"> & {
    fixture?: Record<string, string>;
  },
  threshold = 0.5,
): CaseComplexity {
  const cues = complexityCuesOf(caseDef);
  let score = 0;
  // fixture breadth
  score += Math.min(1, cues.fixtureFileCount / 4) * 0.35;
  // verification gate
  if (cues.hasVerification) score += 0.3 + Math.min(0.15, cues.verificationSpecCount * 0.05);
  // hard suites count as complex
  if (cues.suite === "adversarial" || cues.suite === "stress") score += 0.15;
  // longer requests are more likely multi-step
  score += Math.min(0.2, cues.requestLength / 2000);
  const clamped = Math.min(1, score);
  return { caseId: caseDef.id, score: clamped, complex: clamped >= threshold };
}

// ---------------------- Deterministic challenger simulation -----------------

/** Tiny seeded PRNG (mulberry32) so the challenger model is reproducible. */
export function seededRandom(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Default effect model (documented hypothesis, not a measured result). */
export const DEFAULT_PLANNER_EXECUTOR_MODEL: PlannerExecutorEffectModel = {
  planningTokensPerCase: 600,
  planningLatencyMsPerCase: 800,
  complexPassGain: 0.15,
  simplePassPenalty: 0.02,
  complexityThreshold: 0.5,
};

function resolveModel(partial?: Partial<PlannerExecutorEffectModel>): PlannerExecutorEffectModel {
  const m = DEFAULT_PLANNER_EXECUTOR_MODEL;
  return {
    planningTokensPerCase: partial?.planningTokensPerCase ?? m.planningTokensPerCase,
    planningLatencyMsPerCase: partial?.planningLatencyMsPerCase ?? m.planningLatencyMsPerCase,
    complexPassGain: partial?.complexPassGain ?? m.complexPassGain,
    simplePassPenalty: partial?.simplePassPenalty ?? m.simplePassPenalty,
    complexityThreshold: partial?.complexityThreshold ?? m.complexityThreshold,
  };
}

/**
 * Simulate one architecture on one case, given the baseline (single-loop)
 * outcome and the challenger effect model.
 *
 * `architecture === "single_loop"` is the identity (champion). For the
 * challenger, a seeded draw is used so the outcome is reproducible:
 * - COMPLEX task: if the baseline failed, it may flip to passed with prob
 *   `complexPassGain` (the planning phase catching what the loop missed).
 * - SIMPLE task: if the baseline passed, it may flip to failed with prob
 *   `simplePassPenalty` (separation overhead on a task that needed none).
 * - tokens / latency grow by the fixed planning cost on every case.
 */
export function simulateArchitectureRun(
  baseline: Pick<EvalOutcome, "caseId" | "status" | "violations"> & {
    metrics: Pick<
      EvalOutcome["metrics"],
      "tool_call_count" | "tokens_input" | "tokens_output" | "duration_ms"
    >;
  },
  architecture: ExecutionArchitecture,
  complexity: CaseComplexity,
  options: { model?: Partial<PlannerExecutorEffectModel>; seed?: number } = {},
): ArchitectureRunMetrics {
  const model = resolveModel(options.model);
  const random = seededRandom(options.seed ?? 11);

  const basePassed = baseline.status === "passed";
  let passed = basePassed;

  if (architecture === "planner_executor") {
    if (complexity.complex && !basePassed && random() < model.complexPassGain) {
      passed = true;
    }
    if (!complexity.complex && basePassed && random() < model.simplePassPenalty) {
      passed = false;
    }
  }

  const tokens =
    baseline.metrics.tokens_input +
    baseline.metrics.tokens_output +
    (architecture === "planner_executor" ? model.planningTokensPerCase : 0);
  const durationMs =
    baseline.metrics.duration_ms +
    (architecture === "planner_executor" ? model.planningLatencyMsPerCase : 0);

  return {
    caseId: baseline.caseId,
    architecture,
    complex: complexity.complex,
    passed,
    tokens,
    durationMs,
    toolCalls: baseline.metrics.tool_call_count,
  };
}

// ---------------------- Aggregation & cost ---------------------------------

function toCostInput(
  runs: ArchitectureRunMetrics[],
): {
  status: "passed" | "failed";
  metrics: EvalOutcome["metrics"];
} {
  const total: EvalOutcome["metrics"] = {
    turn_count: runs.length,
    tool_call_count: 0,
    tokens_input: 0,
    tokens_output: 0,
    context_tokens: 0,
    duration_ms: 0,
    retry_count: 0,
    verification_failures: 0,
    human_interventions: 0,
    compaction_count: 0,
    estimated_cost: 0,
  };
  let passed = 0;
  for (const run of runs) {
    if (run.passed) passed += 1;
    total.tool_call_count += run.toolCalls;
    total.duration_ms += run.durationMs;
  }
  // Tokens: split input/output by the calibrated ratio (input dominates).
  // Both architectures consume the same measured split except the added
  // planning tokens, which are output-side (the plan the executor consumes).
  let input = 0;
  let output = 0;
  for (const run of runs) {
    // Re-derive the split from the per-case totals is not possible here, so
    // we use the calibrated 70/30 split over the aggregate. This is a model
    // assumption on token composition, documented as such.
    input += run.tokens * 0.7;
    output += run.tokens * 0.3;
  }
  total.tokens_input = Math.round(input);
  total.tokens_output = Math.round(output);
  return {
    status: passed >= runs.length / 2 ? ("passed" as const) : ("failed" as const),
    metrics: total,
  };
}

/** Aggregate per-architecture runs and score them with the cost model. */
export function aggregateArchitecture(
  runs: ArchitectureRunMetrics[],
  architecture: ExecutionArchitecture,
  cost?: CostModelOptions,
): ArchitectureAggregate {
  const complex = runs.filter((r) => r.complex);
  const simple = runs.filter((r) => !r.complex);
  const pass = (list: ArchitectureRunMetrics[]): number =>
    list.length === 0 ? 0 : list.filter((r) => r.passed).length / list.length;

  const costResult: CostResult = scoreCost(
    {
      // The architecture comparison considers the security dimension neutral
      // (the separation changes planning, not the security boundary), so the
      // cost input carries no security events.
      status: toCostInput(runs).status,
      violations: [],
      metrics: toCostInput(runs).metrics,
      events: [],
    },
    cost ?? {},
  );

  return {
    architecture,
    passRateComplex: pass(complex),
    passRateSimple: pass(simple),
    passRateOverall: pass(runs),
    totalTokens: runs.reduce((sum, r) => sum + r.tokens, 0),
    totalDurationMs: runs.reduce((sum, r) => sum + r.durationMs, 0),
    totalToolCalls: runs.reduce((sum, r) => sum + r.toolCalls, 0),
    costScore: costResult.score,
  };
}

// ---------------------- Experiment runner & gate ---------------------------

/**
 * Run the planner/executor experiment over a set of cases.
 *
 * @param cases benchmark cases (for complexity classification + baseline runs).
 * @param runBaseline per-case runner producing the single-loop `EvalOutcome`.
 * @param options effect model, cost budgets, gate knobs.
 *
 * Baseline aggregate = single_loop champion; challenger aggregate = the
 * effect-model-simulated planner/executor. The promotion decision folds the
 * cost model in.
 */
export async function runPlannerExecutorExperiment(
  cases: EvalCase[],
  runBaseline: (caseDef: EvalCase) => Promise<EvalOutcome>,
  options: RunPlannerExecutorOptions = {},
): Promise<PlannerExecutorComparison> {
  const model = resolveModel(options.model);
  const baselineRuns: ArchitectureRunMetrics[] = [];
  const challengerRuns: ArchitectureRunMetrics[] = [];
  let complexCount = 0;
  let simpleCount = 0;

  for (const caseDef of cases) {
    const complexity = classifyCaseComplexity(caseDef, model.complexityThreshold);
    const baseline = await runBaseline(caseDef);
    const baseRun = simulateArchitectureRun(baseline, "single_loop", complexity, options);
    const chalRun = simulateArchitectureRun(baseline, "planner_executor", complexity, options);
    baselineRuns.push(baseRun);
    challengerRuns.push(chalRun);
    if (complexity.complex) complexCount += 1;
    else simpleCount += 1;
  }

  const baselineAgg = aggregateArchitecture(baselineRuns, "single_loop", options.cost);
  const challengerAgg = aggregateArchitecture(challengerRuns, "planner_executor", options.cost);

  const complexPassDelta = challengerAgg.passRateComplex - baselineAgg.passRateComplex;
  const simplePassDelta = challengerAgg.passRateSimple - baselineAgg.passRateSimple;
  const passRateOverallDelta = challengerAgg.passRateOverall - baselineAgg.passRateOverall;
  const tokenDeltaRatio =
    baselineAgg.totalTokens === 0 ? 0 : (challengerAgg.totalTokens - baselineAgg.totalTokens) / baselineAgg.totalTokens;
  const latencyDeltaRatio =
    baselineAgg.totalDurationMs === 0 ? 0 : (challengerAgg.totalDurationMs - baselineAgg.totalDurationMs) / baselineAgg.totalDurationMs;
  const costScoreDelta = challengerAgg.costScore - baselineAgg.costScore;

  const decision = decidePromotion({
    complexPassDelta,
    simplePassDelta,
    costScoreDelta,
    gate: options.gate,
  });

  return {
    baseline: baselineAgg,
    challenger: challengerAgg,
    cases: challengerRuns,
    complexCount,
    simpleCount,
    complexPassDelta,
    simplePassDelta,
    passRateOverallDelta,
    tokenDeltaRatio,
    latencyDeltaRatio,
    costScoreDelta,
    decision,
  };
}

interface PromotionInput {
  complexPassDelta: number;
  simplePassDelta: number;
  costScoreDelta: number;
  gate?: {
    minimumComplexGain?: number;
    simpleRegressTolerance?: number;
  };
}

/**
 * The promotion gate. Encodes plan.md's rule: separation is promoted ONLY if
 * it lifts complex tasks by at least `minimumComplexGain` (default 0.03),
 * does not regress simple tasks beyond `simpleRegressTolerance`, and the
 * cost-model score is not net-negative. A run whose only effect was extra
 * tokens/latency cannot clear the complex-gain bar and lands on
 * "no_complex_gain" → NOT promoted.
 */
export function decidePromotion(input: PromotionInput): PlannerExecutorDecision {
  const minimumComplexGain = input.gate?.minimumComplexGain ?? 0.03;
  const simpleRegressTolerance = input.gate?.simpleRegressTolerance ?? 0.03;

  if (input.complexPassDelta < minimumComplexGain) {
    return {
      promote: false,
      code: "no_complex_gain",
      reason: `rejected: planner/executor did not lift complex-task pass rate by >= ${minimumComplexGain} (delta ${round(input.complexPassDelta)}); a token/latency-only change is not promotable`,
      minimumComplexGain,
      simpleRegressTolerance,
    };
  }
  if (input.simplePassDelta < -simpleRegressTolerance) {
    return {
      promote: false,
      code: "simple_regression",
      reason: `rejected: simple-task pass rate regressed by ${round(-input.simplePassDelta)} beyond tolerance ${simpleRegressTolerance}`,
      minimumComplexGain,
      simpleRegressTolerance,
    };
  }
  if (input.costScoreDelta <= 0) {
    return {
      promote: false,
      code: "cost_negative",
      reason: `rejected: cost-model score delta ${round(input.costScoreDelta)} is not positive, so added tokens/latency ate the quality gain`,
      minimumComplexGain,
      simpleRegressTolerance,
    };
  }
  return {
    promote: true,
    code: "promote",
    reason: `promote: complex pass +${round(input.complexPassDelta)} (>= ${minimumComplexGain}), cost score +${round(input.costScoreDelta)}`,
    minimumComplexGain,
    simpleRegressTolerance,
  };
}

/** Render the experiment as plain text for CLI output. */
export function renderPlannerExecutorComparison(cmp: PlannerExecutorComparison): string {
  const lines: string[] = [
    `Planner/Executor Separation Experiment`,
    `cases: ${cmp.cases.length} (complex ${cmp.complexCount}, simple ${cmp.simpleCount})`,
    `decision: ${cmp.decision.promote ? "PROMOTE" : "REJECT"} (${cmp.decision.code})`,
    cmp.decision.reason,
    "",
    `  pass complex         ${formatRate(cmp.baseline.passRateComplex)} → ${formatRate(cmp.challenger.passRateComplex)}  (Δ ${round(cmp.complexPassDelta, 3)})`,
    `  pass simple          ${formatRate(cmp.baseline.passRateSimple)} → ${formatRate(cmp.challenger.passRateSimple)}  (Δ ${round(cmp.simplePassDelta, 3)})`,
    `  pass overall         ${formatRate(cmp.baseline.passRateOverall)} → ${formatRate(cmp.challenger.passRateOverall)}  (Δ ${round(cmp.passRateOverallDelta, 3)})`,
    `  tokens               ${cmp.baseline.totalTokens} → ${cmp.challenger.totalTokens}  (Δ ${round(cmp.tokenDeltaRatio * 100, 1)}%)`,
    `  latency (ms)         ${cmp.baseline.totalDurationMs} → ${cmp.challenger.totalDurationMs}  (Δ ${round(cmp.latencyDeltaRatio * 100, 1)}%)`,
    `  tool calls           ${cmp.baseline.totalToolCalls} → ${cmp.challenger.totalToolCalls}`,
    `  cost score           ${cmp.baseline.costScore.toFixed(3)} → ${cmp.challenger.costScore.toFixed(3)}  (Δ ${round(cmp.costScoreDelta, 3)})`,
  ];
  return lines.join("\n");
}

function formatRate(value: number): string {
  return `${Math.round(value * 100)}%`;
}

function round(value: number, digits = 4): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}