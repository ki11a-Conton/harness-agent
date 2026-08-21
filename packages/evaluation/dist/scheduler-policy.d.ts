/**
 * P3-12 — Scheduler Policy Learning.
 *
 * A mechanism-CANDIDATE experiment (no main-runtime refactor). A scheduler
 * policy tunes (plan.md P3-12):
 *
 *   maxConcurrent          how many children run at once
 *   childBudgetAllocation  how the token/effort budget is split among children
 *   queueFairness          whether pending children are served fairly
 *
 * A policy may be promoted ONLY after the STRESS suite proves it stable: the
 * adversarial/stress split must not regress (no new security violations, no
 * raised false-complete, bounded latency/tokens). A policy that improves
 * throughput but destabilises the stress suite is rejected.
 *
 * The challenger is a deterministic, seeded effect model over measured
 * outcomes — nothing is fabricated.
 */
export interface SchedulerPolicy {
    name: string;
    maxConcurrent: number;
    childBudgetAllocation: "equal" | "priority" | "greedy";
    queueFairness: boolean;
}
/** Outcome of running a policy over the stress suite. */
export interface ScheduleStressResult {
    policyName: string;
    /** Pass rate on the stress split. */
    stressPassRate: number;
    securityViolations: number;
    falseCompletes: number;
    p95LatencyMs: number;
    totalTokens: number;
}
export interface SchedulerDecision {
    promotedName: string | null;
    keepChampion: boolean;
    reasons: string[];
}
export interface SchedulerGateOptions {
    maxSecurityViolations?: number;
    maxFalseCompletes?: number;
    p95LatencyMsBudget?: number;
    tokenBudget?: number;
    minimumStressLift?: number;
}
/** Pre-promotion stress gate: a policy must keep the stress suite stable. A
 *  policy that spikes security violations / false-completes / latency / tokens
 *  is never promoted, even if its nominal pass rate looks good. */
export declare function stressStable(r: ScheduleStressResult, budgets?: SchedulerGateOptions): {
    stable: boolean;
    reasons: string[];
};
/** Choose the best scheduler policy: it must clear the stress-stability gate
 *  AND beat the champion's stress pass rate by the minimum lift. No instability
 *  → no promotion, regardless of throughput. */
export declare function chooseBestSchedulerPolicy(champion: ScheduleStressResult, candidates: ScheduleStressResult[], budgets?: SchedulerGateOptions): SchedulerDecision;
export declare function renderSchedulerDecision(results: ScheduleStressResult[], decision: SchedulerDecision): string;
//# sourceMappingURL=scheduler-policy.d.ts.map