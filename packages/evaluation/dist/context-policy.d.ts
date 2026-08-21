import type { RunMetrics } from "@ar/observability";
/**
 * P3-11 — Context Policy Learning.
 *
 * A mechanism-CANDIDATE experiment (no main-runtime refactor). A context policy
 * tunes three knobs (plan.md P3-11):
 *
 *   compaction threshold   when (in tokens) to compact / how much to keep
 *   retrieval top-k        how many memory items to pull back
 *   recent-message tail    how many recent messages to keep verbatim
 *
 * The policy is picked automatically by the benchmark: each candidate policy is
 * scored on the SAME eval split, cost-adjusted, and only the policy that beats
 * the champion is promoted. A hard safety invariant: a policy must not drop
 * critical context — an aggressive compaction / too-small top-k / near-empty
 * recent tail that causes a context-overflow or a critical-context drop is
 * REJECTED regardless of apparent speed/cost gains.
 */
export interface ContextPolicy {
    name: string;
    /** Compact when accumulated context exceeds this (tokens). */
    compactionThresholdTokens: number;
    /** Number of memory items retrieved. */
    retrievalTopK: number;
    /** Number of recent messages kept verbatim. */
    recentTailMessages: number;
}
export interface PolicyAssessment {
    name: string;
    costScore: number;
    passRate: number;
    totalTokens: number;
    /** Turns that overflowed or dropped critical context under this policy. */
    criticalDrops: number;
}
export interface ContextPolicyDecision {
    promotedName: string | null;
    keepChampion: boolean;
    reasons: string[];
}
/** Enforce the no-critical-context-drop invariant. Aggregate per-policy runs and
 *  pick the best cost-adjusted policy that beats the champion without dropping
 *  critical context. */
export declare function chooseBestContextPolicy(champion: PolicyAssessment, candidates: PolicyAssessment[], opts?: {
    minCostLift?: number;
    maxCriticalDrops?: number;
}): ContextPolicyDecision;
/** Score one context-policy run from raw metrics + whether it dropped context. */
export declare function runPolicyEffects(metricsByKey: {
    tokens: number;
    droppedContext: boolean;
}[], passed: boolean[]): {
    passed: boolean;
    tokens: number;
    droppedContext: boolean;
}[];
/** Adapt a RunMetrics into the compact per-run shape used for policy scoring. */
export declare function fromRunMetrics(m: RunMetrics, droppedContext: boolean): {
    passed: boolean;
    tokens: number;
    droppedContext: boolean;
};
export declare function renderContextDecision(assessments: PolicyAssessment[], decision: ContextPolicyDecision): string;
//# sourceMappingURL=context-policy.d.ts.map