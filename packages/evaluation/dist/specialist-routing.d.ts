import type { EvalCase } from "./eval-case.js";
import type { EvalOutcome } from "./runner.js";
import { type CostModelOptions } from "./cost-model.js";
/**
 * P3-3 — Specialist Routing Experiment.
 *
 * A mechanism-CANDIDATE experiment (no main-runtime refactor). The hypothesis:
 * routing a task to a per-type specialist prompt (coding / debugging / research
 * / docs / data) - by a deterministic classifier reading only structural cues -
 * lifts the pass rate on well-matched tasks, at the price of a routing-decision
 * pass (extra tokens + latency) on every task and a mis-routing risk on fuzzy
 * tasks. When classification confidence is low, the router MUST fall back to
 * the generalist (never force a specialist into a mismatched task).
 *
 * The promotion gate (plan.md P3: "先 benchmark 验证 specialist prompt 是否比统一
 * agent 好" + "如果只是增加 token/latency，不推广") only promotes when the
 * specialist challenger lifts correctly-routed task pass rate beyond tolerance,
 * does not regress generalist/uncertain tasks, and the cost-model delta is
 * positive. As with P3-1/P3-2, the challenger is a deterministic, seeded effect
 * model composed over the measured Worker outcome - nothing is fabricated.
 */
/** The five routing lanes from plan.md P3-3. */
export type TaskType = "coding" | "debugging" | "research" | "docs" | "data" | "generalist";
/**
 * Routing policy variant.
 *
 * NOTE: renamed from `RoutingPolicy` → `SpecialistRoutingPolicy` so the package
 * barrel does not collide with model-routing's `RoutingPolicy`. Consumers of
 * the specialist experiment use this name.
 */
export type SpecialistRoutingPolicy = "generalist" | "specialist_router";
/** A routing lane definition: name + structural cues. */
export interface Specialist {
    type: Exclude<TaskType, "generalist">;
    /** Keyword cues found in the task title / request text. */
    keywords: string[];
    /** Substrings of changed file paths that signal the lane (e.g. `.md` → docs). */
    pathHints: string[];
}
/** Deterministic classifier output for one task. */
export interface RoutingDecision {
    caseId: string;
    type: TaskType;
    confidence: number;
    cues: number;
    usesSpecialist: boolean;
}
export declare const ROUTING_THRESHOLD = 0.5;
/** A specialist lane needs this many cue hits before it may be chosen at all.
 *  A single keyword is too thin to trust and must fall back to the generalist. */
export declare const MIN_CUES_TO_ROUTE = 2;
/** Default specialist lanes (plan.md). Cues are structural, never model wording. */
export declare const DEFAULT_SPECIALISTS: Specialist[];
/**
 * Deterministic specialist classification. For each lane we count cue hits
 * across its keywords + path hints. A lane is routed ONLY when it is a *clear*
 * winner: it has at least `MIN_CUES_TO_ROUTE` hits and strictly beats every
 * other lane (a tie collapses to the generalist). Confidence is the winner's
 * margin over the runner-up, so it never penalizes a lane just for having many
 * cues the task happens not to hit.
 */
export declare function classifyTaskType(caseDef: Pick<EvalCase, "id"> & {
    task?: string;
    fixture?: Record<string, string>;
}, specialists?: Specialist[], threshold?: number): RoutingDecision;
/** Specialist routing effect model - tunable experiment hypothesis. */
export interface RouterEffectModel {
    /** Extra tokens the routing decision burns per routed case. */
    routingTokensPerCase: number;
    /** Extra wall-clock (ms) the routing decision adds per case. */
    routingLatencyMsPerCase: number;
    /** Pass-rate lift fraction when a task is routed to the right specialist. */
    specialistPassGain: number;
    /** Pass-rate loss fraction when a task is mis-routed to the wrong specialist. */
    mismatchPassPenalty: number;
    /** Only route when confident (never force a specialist on fuzzy tasks). */
    fallbackOnLowConfidence: boolean;
}
export declare const DEFAULT_ROUTER_MODEL: RouterEffectModel;
export interface SpecialistRunMetrics {
    caseId: string;
    policy: SpecialistRoutingPolicy;
    routed: boolean;
    routedCorrect: boolean;
    routedWrong: boolean;
    passed: boolean;
    tokens: number;
    durationMs: number;
}
export interface SpecialistAggregate {
    policy: SpecialistRoutingPolicy;
    passRate: number;
    routedCount: number;
    correctlyRouted: number;
    misRouted: number;
    totalTokens: number;
    totalDurationMs: number;
    costScore: number;
}
export interface SpecialistComparison {
    baseline: SpecialistAggregate;
    challenger: SpecialistAggregate;
    cases: SpecialistRunMetrics[];
    passDelta: number;
    routedRatio: number;
    mismatchRatio: number;
    tokenDeltaRatio: number;
    latencyDeltaRatio: number;
    costScoreDelta: number;
    decision: RoutingDecisionSummary;
}
export type RoutingDecisionCode = "promote" | "no_gain" | "mismatch_regression" | "cost_negative";
export interface RoutingDecisionSummary {
    promote: boolean;
    code: RoutingDecisionCode;
    reason: string;
    minimumPassGain: number;
    maxMismatchRatio: number;
}
export interface RunRoutingExperimentOptions {
    specialists?: Specialist[];
    model?: Partial<RouterEffectModel>;
    cost?: CostModelOptions;
    seed?: number;
    truth?: (caseDef: EvalCase) => TaskType | undefined;
    gate?: {
        minimumPassGain?: number;
        maxMismatchRatio?: number;
        maxRoutedTokens?: number;
    };
}
/**
 * Simulate a routing-policy run for one case. The generalist is the identity
 * champion. The specialist_router adds the routing pass; when routed to the
 * *correct* specialist it stochastically lifts pass, when mis-routed it
 * stochastically drops pass, and low-confidence tasks fall back to the
 * generalist behavior. Seeded for reproducibility.
 *
 * Correctness is decided against `truthLane` when the caller supplies it (a
 * judge/known-answer truth layer that never feeds the router's own decision);
 * when omitted, a documented confidence heuristic is used instead.
 */
export declare function simulateSpecialistRun(outcome: EvalOutcome, decision: RoutingDecision, policy: SpecialistRoutingPolicy, options?: {
    model?: Partial<RouterEffectModel>;
    seed?: number;
    truthLane?: TaskType;
}): SpecialistRunMetrics;
export declare function aggregateSpecialist(runs: SpecialistRunMetrics[], policy: SpecialistRoutingPolicy, cost?: CostModelOptions): SpecialistAggregate;
interface RoutingGateInput {
    passDelta: number;
    mismatchRatio: number;
    costScoreDelta: number;
    asked: boolean;
    gate?: {
        minimumPassGain?: number;
        maxMismatchRatio?: number;
    };
}
export declare function decideRoutingPromotion(input: RoutingGateInput): RoutingDecisionSummary;
/** Run the Specialist Routing experiment end-to-end. */
export declare function runRoutingExperiment(cases: EvalCase[], runWorker: (caseDef: EvalCase) => Promise<EvalOutcome>, options?: RunRoutingExperimentOptions): Promise<SpecialistComparison>;
export declare function renderSpecialistComparison(cmp: SpecialistComparison): string;
export {};
//# sourceMappingURL=specialist-routing.d.ts.map