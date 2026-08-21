import type { RunMetrics } from "@ar/observability";
/**
 * P3-13 — Recovery Policy Learning.
 *
 * A mechanism-CANDIDATE experiment (no main-runtime refactor). A recovery
 * policy tunes (plan.md P3-13):
 *
 *   retry count     how many retries are allowed per failed attempt
 *   stall threshold how long before a stall is diagnosed
 *   compact timing  when compaction runs relative to recovery
 *
 * Two hard rules:
 *
 *   1. NO BRUTE-FORCE — a recovery policy must NOT lift success by throwing more
 *      retries at everything. Retry growth is penalised by the cost gate.
 *   2. COST GATE MUST PARTICIPATE — promotion is decided on the cost-adjusted
 *      score (quality gained per retry/time spent), never on raw pass rate.
 *
 * A policy that cranks retries to lift pass but collapses the cost score is
 * rejected. The challenger is a deterministic effect model over outcomes.
 */
export interface RecoveryPolicy {
    name: string;
    maxRetries: number;
    stallThresholdMs: number;
    compactOnRecovery: boolean;
}
export interface RecoveryOutcome {
    policyName: string;
    /** Pass rate (how often a stuck case eventually passes). */
    passRate: number;
    totalRetries: number;
    totalTokens: number;
    /** Cost-adjusted score in [0,100] — retry/token inflation drags it down. */
    costScore: number;
}
export interface RecoveryDecision {
    promotedName: string | null;
    keepChampion: boolean;
    reasons: string[];
}
export interface RecoveryGateOptions {
    minCostLift?: number;
    maxRetryMultiplier?: number;
    tokenBudget?: number;
}
/** Deterministic cost-adjusted score: pass-rate quality minus retry/token drag.
 *  A policy that brute-forces success with retries scores low. */
export declare function recoveryCostScore(passRate: number, retries: number, tokens: number): number;
/** Choose the best recovery policy. The cost gate is mandatory: only a policy
 *  that beats the champion's cost-adjusted score (quality per retry/token) is
 *  promoted; a retry-inflating policy is rejected even at a higher pass rate. */
export declare function chooseBestRecoveryPolicy(champion: RecoveryOutcome, candidates: RecoveryOutcome[], opts?: RecoveryGateOptions): RecoveryDecision;
/** Adapt raw per-run metrics into a recovery outcome for one policy. */
export declare function fromRecoveryRuns(policyName: string, runs: {
    metrics: RunMetrics;
}[], resolve: (r: {
    metrics: RunMetrics;
}) => {
    passed: boolean;
}): RecoveryOutcome;
export declare function renderRecoveryDecision(outcomes: RecoveryOutcome[], decision: RecoveryDecision): string;
//# sourceMappingURL=recovery-policy.d.ts.map