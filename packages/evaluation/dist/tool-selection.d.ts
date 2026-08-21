import type { EvalCase } from "./eval-case.js";
import type { EvalOutcome } from "./runner.js";
import { type CostModelOptions } from "./cost-model.js";
/**
 * P3-4 — Dynamic Tool Selection Experiment.
 *
 * A mechanism-CANDIDATE experiment (no main-runtime refactor). The hypothesis:
 * when the tool catalog is large, exposing only a task-relevant tool subset
 * (tool index → select relevant tools → expose subset) cuts per-run schema
 * tokens; the saved context budget lifts pass rate on long/context-hungry
 * tasks, while a deterministic selector still covers the tools a task needs.
 *
 * Two hard guards, matching plan.md P3-4 ("减少 schema token。安全边界不变。"):
 *  1. SAFETY SUBSET INVARIANT — the selected subset MUST always contain every
 *     safety-critical tool. A selection that omits one is a fail-closed
 *     violation (never silent): the subscript is rejected and must re-include it.
 *  2. COVERAGE-BASED PROMOTION — a subset that merely saves tokens while
 *     hurting pass rate (tool misses) is not promotable. Only promote when the
 *     token savings are material AND the pass rate does not regress (prefer an
 *     actual lift), AND the cost-model delta is positive.
 *
 * As with P3-1..P3-3, the challenger is a deterministic, seeded effect model
 * composed over the measured all-tools outcome — nothing is fabricated.
 */
/** Tool exposure policy variant. */
export type ToolExposurePolicy = "full_catalog" | "dynamic_subset";
/** A tool the runtime can expose. The selector may omit non-critical tools. */
export interface ToolDescriptor {
    name: string;
    /** Cue keywords / path patterns that signal this tool's relevance. */
    relatedCues: string[];
    /** Structural cue: which task-type families a tool serves (see P3-3 lanes). */
    servesTypes?: string[];
    /** Safety-critical tools can NEVER be omitted from any subset. */
    safetyCritical: boolean;
    /** Context cost of exposing this tool's schema. */
    schemaTokens: number;
}
/** Deterministic selector output for one task. */
export interface ToolSelection {
    caseId: string;
    /** Tools that ended up exposed. Ordered deterministically. */
    selected: string[];
    /** tools the subset omitted (for coverage accounting). */
    omitted: string[];
    /** schema-token cost of exposing `selected`. */
    schemaTokens: number;
    /** all-schema-token cost if the full catalog were exposed. */
    fullSchemaTokens: number;
    /** True when every safety-critical tool is present. Enforced fail-closed. */
    safetyComplete: boolean;
    /** True when the canonical "recovery/fallback" tools are still present
     *  (e.g. an exec/search escape-hatch) so a miss is recoverable. */
    hasFallback: boolean;
}
export interface ToolSet {
    tools: ToolDescriptor[];
    /** Tools that, if omitted, make a missed tool recoverable (escape hatch). */
    fallbackTools: string[];
}
/** Default tool catalog (illustrative). safety-critical ones are marked. */
export declare const DEFAULT_TOOL_CATALOG: ToolSet;
export declare const TOOL_SELECT_THRESHOLD = 1;
/**
 * Select the relevant tool subset. Scores each non-critical tool by cue hits
 * across the task text + fixture paths; a tool is included when its score
 * meets the threshold. Safety-critical tools are ALWAYS included. Returns a
 * fail-closed tool selection: if a safety-critical tool is somehow missing,
 * `safetyComplete` is false and the caller must reject the subset.
 */
export declare function selectRelevantTools(caseDef: Pick<EvalCase, "id"> & {
    task?: string;
    fixture?: Record<string, string>;
}, toolset?: ToolSet, threshold?: number): ToolSelection;
/** Dynamic tool selection effect model — tunable experiment hypothesis. */
export interface ToolSelectionEffectModel {
    /** Fraction savings of schema tokens actually realized per run. */
    schemaSavingsReach: number;
    /** Chance a needed-but-omitted tool actually causes a hard miss (uncalled). */
    missRate: number;
    /** Extra tokens a miss on a non-critical tool costs (recovery / fallback). */
    missRecoveryTokens: number;
    /** Extra latency (ms) a miss costs. */
    missRecoveryLatencyMs: number;
    /** Pass-rate lift applied when schema savings materially relieve context. */
    contextLift: number;
    /** Context size above which savings are assumed to matter. */
    longContextThresholdTokens: number;
}
export declare const DEFAULT_TOOL_MODEL: ToolSelectionEffectModel;
export interface ToolRunMetrics {
    caseId: string;
    policy: ToolExposurePolicy;
    schemaTokens: number;
    /** Full-catalog schema cost (savings are computed against this, never a
     *  policy-dependent value). */
    fullSchemaTokens: number;
    tokens: number;
    durationMs: number;
    missed: boolean;
    safetyComplete: boolean;
    passed: boolean;
}
export interface ToolAggregate {
    policy: ToolExposurePolicy;
    passRate: number;
    schemaTokensTotal: number;
    schemaSavingsRatio: number;
    misses: number;
    safetyCompleteAll: boolean;
    totalTokens: number;
    totalDurationMs: number;
    costScore: number;
}
export interface ToolComparison {
    baseline: ToolAggregate;
    challenger: ToolAggregate;
    cases: ToolRunMetrics[];
    passDelta: number;
    schemaSavingsRatio: number;
    missedToolCount: number;
    tokenDeltaRatio: number;
    latencyDeltaRatio: number;
    costScoreDelta: number;
    decision: ToolDecisionSummary;
}
export type ToolDecisionCode = "promote" | "safety_invariant_failed" | "no_lift" | "coverage_regression" | "savings_trivial" | "cost_negative";
export interface ToolDecisionSummary {
    promote: boolean;
    code: ToolDecisionCode;
    reason: string;
    minimumPassLift: number;
    minimumSchemaSavings: number;
    maxMissRatio: number;
}
export interface RunToolSelectionOptions {
    toolset?: ToolSet;
    model?: Partial<ToolSelectionEffectModel>;
    cost?: CostModelOptions;
    seed?: number;
    gate?: {
        minimumPassLift?: number;
        minimumSchemaSavings?: number;
        maxMissRatio?: number;
    };
}
/**
 * Simulate an exposure-policy run. `full_catalog` is the identity champion
 * (no omitted tools, full schema cost, baseline pass). `dynamic_subset` applies
 * the selected subset: schema tokens drop, and each run may pay a miss
 * (omitted tool needed → rework) or receive a context lift on long tasks.
 * Safety-completeness is carried through and, if ever violated, marks a hard
 * failure. Seeded for reproducibility.
 */
export declare function simulateToolSelectionRun(outcome: EvalOutcome, selection: ToolSelection, policy: ToolExposurePolicy, options?: {
    model?: Partial<ToolSelectionEffectModel>;
    seed?: number;
}): ToolRunMetrics;
export declare function aggregateToolSelection(runs: ToolRunMetrics[], policy: ToolExposurePolicy, cost?: CostModelOptions): ToolAggregate;
interface ToolGateInput {
    passDelta: number;
    schemaSavingsRatio: number;
    missRatio: number;
    safetyComplete: boolean;
    costScoreDelta: number;
    gate?: {
        minimumPassLift?: number;
        minimumSchemaSavings?: number;
        maxMissRatio?: number;
    };
}
export declare function decideToolSelectionPromotion(input: ToolGateInput): ToolDecisionSummary;
/** Run the Dynamic Tool Selection experiment end-to-end. */
export declare function runToolSelectionExperiment(cases: EvalCase[], runWorker: (caseDef: EvalCase) => Promise<EvalOutcome>, options?: RunToolSelectionOptions): Promise<ToolComparison>;
export declare function renderToolComparison(cmp: ToolComparison): string;
export {};
//# sourceMappingURL=tool-selection.d.ts.map