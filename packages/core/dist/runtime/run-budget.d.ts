import type { LimitBreach, RunBudget, RunLimits } from "@ar/contracts";
/**
 * P0-10: unified run-budget tracker. Centralises all the ad-hoc limit checks
 * that were scattered across the runtime and replaces them with a single
 * check-on-trigger contract. The tracker is created per run (turn) and
 * reports the first breach; subsequent calls are no-ops so the first breach
 * is never masked by a second check.
 */
export declare class RunBudgetTracker {
    private readonly startedAt;
    private readonly limits;
    private readonly now;
    private breached;
    private usedTurns;
    private usedToolCalls;
    private outputChars;
    private retries;
    private subagentsSpawned;
    private inputTokens;
    private outputTokens;
    private estimatedCostUsd;
    constructor(limits: RunLimits, now: () => number);
    /** Returns a LimitBreach when maxTurns restricts. */
    onTurnStart(): LimitBreach | undefined;
    /** Returns a LimitBreach when maxToolCalls restricts. */
    onToolCall(): LimitBreach | undefined;
    /** Returns a LimitBreach when maxDurationMs restricts. */
    onDurationCheck(): LimitBreach | undefined;
    /** Returns a LimitBreach when maxOutputChars restricts. */
    onOutput(chars: number): LimitBreach | undefined;
    /** Returns a LimitBreach when maxRetries restricts. */
    onRetry(): LimitBreach | undefined;
    /** Returns a LimitBreach when maxSubagents restricts. */
    onSubagentSpawn(): LimitBreach | undefined;
    /** Returns a LimitBreach when maxEstimatedCostUsd restricts.
     *  Call after model.completed with the new usage delta. */
    onModelUsage(inputTokens: number, outputTokens: number, costUsd: number): LimitBreach | undefined;
    snapshot(): RunBudget;
    private alarm;
}
/** Checks whether the current limit breach is a "hard" limit (termination). */
export declare function isHardLimit(breach: LimitBreach): boolean;
//# sourceMappingURL=run-budget.d.ts.map