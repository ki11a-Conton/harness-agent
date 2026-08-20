import type { LimitBreach, RunBudget, RunLimits } from "@ar/contracts";

/**
 * P0-10: unified run-budget tracker. Centralises all the ad-hoc limit checks
 * that were scattered across the runtime and replaces them with a single
 * check-on-trigger contract. The tracker is created per run (turn) and
 * reports the first breach; subsequent calls are no-ops so the first breach
 * is never masked by a second check.
 */
export class RunBudgetTracker {
  private readonly startedAt: number;
  private readonly limits: RunLimits;
  private readonly now: () => number;
  private breached = false;
  private usedTurns = 0;
  private usedToolCalls = 0;
  private outputChars = 0;
  private retries = 0;
  private subagentsSpawned = 0;
  private inputTokens = 0;
  private outputTokens = 0;
  private estimatedCostUsd = 0;

  constructor(limits: RunLimits, now: () => number) {
    this.limits = limits;
    this.now = now;
    this.startedAt = now();
  }

  // ── trigger-point methods ───────────────────────────────────────────────

  /** Returns a LimitBreach when maxTurns restricts. */
  onTurnStart(): LimitBreach | undefined {
    this.usedTurns += 1;
    return this.alarm("maxTurns", this.usedTurns, this.limits.maxTurns);
  }

  /** Returns a LimitBreach when maxToolCalls restricts. */
  onToolCall(): LimitBreach | undefined {
    this.usedToolCalls += 1;
    return this.alarm("maxToolCalls", this.usedToolCalls, this.limits.maxToolCalls);
  }

  /** Returns a LimitBreach when maxDurationMs restricts. */
  onDurationCheck(): LimitBreach | undefined {
    const elapsed = this.now() - this.startedAt;
    return this.alarm("maxDurationMs", elapsed, this.limits.maxDurationMs);
  }

  /** Returns a LimitBreach when maxOutputChars restricts. */
  onOutput(chars: number): LimitBreach | undefined {
    this.outputChars += chars;
    return this.alarm("maxOutputChars", this.outputChars, this.limits.maxOutputChars);
  }

  /** Returns a LimitBreach when maxRetries restricts. */
  onRetry(): LimitBreach | undefined {
    this.retries += 1;
    return this.alarm("maxRetries", this.retries, this.limits.maxRetries);
  }

  /** Returns a LimitBreach when maxSubagents restricts. */
  onSubagentSpawn(): LimitBreach | undefined {
    this.subagentsSpawned += 1;
    return this.alarm("maxSubagents", this.subagentsSpawned, this.limits.maxSubagents);
  }

  /** Returns a LimitBreach when maxEstimatedCostUsd restricts.
   *  Call after model.completed with the new usage delta. */
  onModelUsage(inputTokens: number, outputTokens: number, costUsd: number): LimitBreach | undefined {
    this.inputTokens += inputTokens;
    this.outputTokens += outputTokens;
    this.estimatedCostUsd += costUsd;
    return this.alarm("maxEstimatedCostUsd", this.estimatedCostUsd, this.limits.maxEstimatedCostUsd);
  }

  // ── snapshot ────────────────────────────────────────────────────────────

  snapshot(): RunBudget {
    return {
      runId: "" as never,
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

  private alarm<K extends keyof RunLimits>(
    key: K,
    used: number,
    allowed: number | undefined,
  ): LimitBreach | undefined {
    if (this.breached) return undefined;
    if (allowed === undefined) return undefined;
    if (used <= allowed) return undefined;
    this.breached = true;
    return { limit: key, used, allowed };
  }
}

/** Checks whether the current limit breach is a "hard" limit (termination). */
export function isHardLimit(breach: LimitBreach): boolean {
  return breach.limit !== "maxEstimatedCostUsd" && breach.limit !== "maxTurns";
}

void isHardLimit;