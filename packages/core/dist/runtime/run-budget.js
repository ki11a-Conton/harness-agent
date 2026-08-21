/**
 * P0-10: unified run-budget tracker. Centralises all the ad-hoc limit checks
 * that were scattered across the runtime and replaces them with a single
 * check-on-trigger contract. The tracker is created per run (turn) and
 * reports the first breach; subsequent calls are no-ops so the first breach
 * is never masked by a second check.
 */
export class RunBudgetTracker {
    startedAt;
    limits;
    now;
    breached = false;
    usedTurns = 0;
    usedToolCalls = 0;
    outputChars = 0;
    retries = 0;
    subagentsSpawned = 0;
    inputTokens = 0;
    outputTokens = 0;
    estimatedCostUsd = 0;
    constructor(limits, now) {
        this.limits = limits;
        this.now = now;
        this.startedAt = now();
    }
    // ── trigger-point methods ───────────────────────────────────────────────
    /** Returns a LimitBreach when maxTurns restricts. */
    onTurnStart() {
        this.usedTurns += 1;
        return this.alarm("maxTurns", this.usedTurns, this.limits.maxTurns);
    }
    /** Returns a LimitBreach when maxToolCalls restricts. */
    onToolCall() {
        this.usedToolCalls += 1;
        return this.alarm("maxToolCalls", this.usedToolCalls, this.limits.maxToolCalls);
    }
    /** Returns a LimitBreach when maxDurationMs restricts. */
    onDurationCheck() {
        const elapsed = this.now() - this.startedAt;
        return this.alarm("maxDurationMs", elapsed, this.limits.maxDurationMs);
    }
    /** Returns a LimitBreach when maxOutputChars restricts. */
    onOutput(chars) {
        this.outputChars += chars;
        return this.alarm("maxOutputChars", this.outputChars, this.limits.maxOutputChars);
    }
    /** Returns a LimitBreach when maxRetries restricts. */
    onRetry() {
        this.retries += 1;
        return this.alarm("maxRetries", this.retries, this.limits.maxRetries);
    }
    /** Returns a LimitBreach when maxSubagents restricts. */
    onSubagentSpawn() {
        this.subagentsSpawned += 1;
        return this.alarm("maxSubagents", this.subagentsSpawned, this.limits.maxSubagents);
    }
    /** Returns a LimitBreach when maxEstimatedCostUsd restricts.
     *  Call after model.completed with the new usage delta. */
    onModelUsage(inputTokens, outputTokens, costUsd) {
        this.inputTokens += inputTokens;
        this.outputTokens += outputTokens;
        this.estimatedCostUsd += costUsd;
        return this.alarm("maxEstimatedCostUsd", this.estimatedCostUsd, this.limits.maxEstimatedCostUsd);
    }
    // ── snapshot ────────────────────────────────────────────────────────────
    snapshot() {
        return {
            runId: "",
            limits: { ...this.limits },
            usedTurns: this.usedTurns,
            usedToolCalls: this.usedToolCalls,
            startedAt: this.startedAt,
            durationMs: this.now() - this.startedAt,
            outputChars: this.outputChars,
            retries: this.retries,
            subagentsSpawned: this.subagentsSpawned,
            estimatedCostUsd: this.estimatedCostUsd,
        };
    }
    // ── private ─────────────────────────────────────────────────────────────
    alarm(key, used, allowed) {
        if (this.breached)
            return undefined;
        if (allowed === undefined)
            return undefined;
        if (used <= allowed)
            return undefined;
        this.breached = true;
        return { limit: key, used, allowed };
    }
}
/** Checks whether the current limit breach is a "hard" limit (termination). */
export function isHardLimit(breach) {
    return breach.limit !== "maxEstimatedCostUsd" && breach.limit !== "maxTurns";
}
void isHardLimit;
//# sourceMappingURL=run-budget.js.map