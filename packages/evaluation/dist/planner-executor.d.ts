import type { EvalCase } from "./eval-case.js";
import type { EvalOutcome } from "./runner.js";
import { type CostModelOptions } from "./cost-model.js";
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
export type PlannerExecutorDecisionCode = "promote" | "no_complex_gain" | "simple_regression" | "cost_negative";
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
/** Extract deterministic complexity cues from a benchmark/eval case. */
export declare function complexityCuesOf(caseDef: Pick<EvalCase, "id" | "task" | "verification" | "suite"> & {
    fixture?: Record<string, string>;
}): ComplexityCues;
/**
 * Deterministic complexity score in [0,1]. Derives from structural cues only:
 * more fixture files, a verification gate, harder suite labels and a longer
 * request all push the score up. A two-file task with a verification gate
 * scores ~0.8 → complex by default; an empty-fixture one-liner stays simple.
 */
export declare function classifyCaseComplexity(caseDef: Pick<EvalCase, "id" | "task" | "verification" | "suite"> & {
    fixture?: Record<string, string>;
}, threshold?: number): CaseComplexity;
/** Tiny seeded PRNG (mulberry32) so the challenger model is reproducible. */
export declare function seededRandom(seed: number): () => number;
/** Default effect model (documented hypothesis, not a measured result). */
export declare const DEFAULT_PLANNER_EXECUTOR_MODEL: PlannerExecutorEffectModel;
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
export declare function simulateArchitectureRun(baseline: Pick<EvalOutcome, "caseId" | "status" | "violations"> & {
    metrics: Pick<EvalOutcome["metrics"], "tool_call_count" | "tokens_input" | "tokens_output" | "duration_ms">;
}, architecture: ExecutionArchitecture, complexity: CaseComplexity, options?: {
    model?: Partial<PlannerExecutorEffectModel>;
    seed?: number;
}): ArchitectureRunMetrics;
/** Aggregate per-architecture runs and score them with the cost model. */
export declare function aggregateArchitecture(runs: ArchitectureRunMetrics[], architecture: ExecutionArchitecture, cost?: CostModelOptions): ArchitectureAggregate;
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
export declare function runPlannerExecutorExperiment(cases: EvalCase[], runBaseline: (caseDef: EvalCase) => Promise<EvalOutcome>, options?: RunPlannerExecutorOptions): Promise<PlannerExecutorComparison>;
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
export declare function decidePromotion(input: PromotionInput): PlannerExecutorDecision;
/** Render the experiment as plain text for CLI output. */
export declare function renderPlannerExecutorComparison(cmp: PlannerExecutorComparison): string;
export {};
//# sourceMappingURL=planner-executor.d.ts.map