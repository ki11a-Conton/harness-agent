import type { EvalCase } from "./eval-case.js";
import type { EvalOutcome } from "./runner.js";
/**
 * P3-14 — Model Routing Experiment.
 *
 * A mechanism-CANDIDATE experiment (no main-runtime refactor). If routing ever
 * grows to multiple models, plan.md P3-14 sketches the motivating split:
 *
 *   cheap model  → simple / read-only planning
 *   strong model → complex coding / review
 *
 * Two hard rules:
 *
 *   1. EVALUATE FIRST — routing is decided on benchmark cost/quality, never on
 *      fashion. There is NO default that "more models is better".
 *   2. COST/QUALITY WIN REQUIRED — the routed policy is promoted only when it
 *      actually spends fewer tokens AND keeps quality within tolerance (never
 *      letting the complex split regress without a real saving). Otherwise the
 *      single-model champion stays.
 *
 * The challenger is a deterministic, seeded effect model composed over measured
 * outcomes — nothing is fabricated.
 */
export type ModelClass = "cheap" | "strong";
export type TaskClass = "simple" | "complex";
/** Route a task to a model class by structural cues (suite / verification /
 *  fixture cardinality) — deterministic, never model wording. */
export declare function classifyTask(c: Pick<EvalCase, "suite" | "verification" | "workspace" | "tags">): TaskClass;
export type RoutingPolicy = Record<TaskClass, ModelClass>;
/** The single-model champion: everything on the strong model. */
export declare const CHAMPION_ROUTING: RoutingPolicy;
export interface RoutingEffectModel {
    /** Token fraction a cheap model costs vs the strong model (1 = same). */
    cheapTokenFactor: number;
    /** Pass-rate loss a cheap model suffers on COMPLEX tasks (0..1). */
    complexCheapPenalty: number;
    /** Pass-rate loss a cheap model suffers on SIMPLE tasks (0..1). Small. */
    simpleCheapPenalty: number;
    /** Notional cost per token for the strong model (fixed, so relative). */
    strongTokenCost: number;
}
export declare const DEFAULT_ROUTING_MODEL: RoutingEffectModel;
export interface RoutedRunMetrics {
    caseId: string;
    policy: "single_strong" | "routed";
    taskClass: TaskClass;
    model: ModelClass;
    passed: boolean;
    tokens: number;
}
export declare function simulateRoutedRun(outcome: EvalOutcome, taskClass: TaskClass, policy: RoutingPolicy, options?: {
    model?: Partial<RoutingEffectModel>;
    seed?: number;
}): RoutedRunMetrics;
export interface RoutingComparison {
    championPassRate: number;
    routedPassRate: number;
    championTokens: number;
    routedTokens: number;
    complexRoutedPassRate: number;
    complexChampionPassRate: number;
    passDelta: number;
    tokenSavingRatio: number;
    promoteRouted: boolean;
    reasons: string[];
}
/**
 * The cost/quality gate. The routed policy is promoted ONLY when it saves a
 * meaningful fraction of tokens AND does not regress the complex split beyond
 * tolerance. Tasteless "multi-model is better" is explicitly not a default.
 */
export declare function evaluateRouting(champion: RoutedRunMetrics[], routed: RoutedRunMetrics[], opts?: {
    minTokenSavingRatio?: number;
    maxComplexPassDrop?: number;
}): RoutingComparison;
export declare function renderRoutingComparison(cmp: RoutingComparison): string;
//# sourceMappingURL=model-routing.d.ts.map