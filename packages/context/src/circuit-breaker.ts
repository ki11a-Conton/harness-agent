import type { CompactionStageReport } from "./compaction.js";

/**
 * P17-8 compaction circuit breaker + observability.
 *
 * A compaction is EFFECTIVE when it measurably reduced the token footprint
 * (afterTokens < beforeTokens). A run of consecutive INEFFECTIVE compactions
 * (or a compact failure) arms the breaker; once OPEN, the runtime must stop
 * auto-compacting (and surface it as a degraded event) instead of looping —
 * the acceptance criterion is "no compact loop, no permanently lost pending
 * work". Metrics (before/after tokens, latency, fallback count) are recorded
 * for the benchmark.
 */

export type BreakerState = "closed" | "armed" | "open";

export interface CompactionMetrics {
  totalCompactions: number;
  effectiveCompactions: number;
  ineffectiveCompactions: number;
  /** Times the LLM summary / reactive fallback stage ran. */
  fallbackCount: number;
  /** Sum of token deltas across all recorded compactions (negative = saved). */
  netTokenDelta: number;
  /** Total latency across all recorded compactions, ms. */
  totalLatencyMs: number;
  /** Latest compaction outcome details (for the benchmark row). */
  last?: {
    beforeTokens: number;
    afterTokens: number;
    latencyMs: number;
    fallbackUsed: boolean;
  };
}

export interface CompactionCircuitBreakerOptions {
  /** Consecutive ineffective compactions before the breaker opens. Default 3. */
  maxConsecutiveIneffective?: number;
}

/** P17-8: per-run compaction guard. Stateless across runs (a fresh breaker
 *  per turn) unless the host deliberately shares one. */
export class CompactionCircuitBreaker {
  private consecutiveIneffective = 0;
  private _state: BreakerState = "closed";
  private readonly maxIneffective: number;
  readonly metrics: CompactionMetrics = {
    totalCompactions: 0,
    effectiveCompactions: 0,
    ineffectiveCompactions: 0,
    fallbackCount: 0,
    netTokenDelta: 0,
    totalLatencyMs: 0,
  };

  constructor(opts: CompactionCircuitBreakerOptions = {}) {
    this.maxIneffective = opts.maxConsecutiveIneffective ?? 3;
  }

  get state(): BreakerState {
    return this._state;
  }

  /** P17-8: is auto-compaction currently allowed? False when the breaker is
   *  OPEN — the runtime must not keep compacting ineffectively. */
  get canCompact(): boolean {
    return this._state !== "open";
  }

  /** Record one compaction outcome (stage reports + wall latency). Returns
   *  the post-record breaker state. */
  record(reports: readonly CompactionStageReport[], latencyMs: number): BreakerState {
    const before = reports[0]?.beforeTokens ?? 0;
    const after = reports[reports.length - 1]?.afterTokens ?? 0;
    const effective = after < before;
    const fallbackUsed = reports.some((r) => r.stage === "summary" || r.stage === "reactive");

    this.metrics.totalCompactions += 1;
    this.metrics.netTokenDelta += after - before;
    this.metrics.totalLatencyMs += latencyMs;
    if (fallbackUsed) this.metrics.fallbackCount += 1;
    this.metrics.last = { beforeTokens: before, afterTokens: after, latencyMs, fallbackUsed };

    if (effective) {
      this.metrics.effectiveCompactions += 1;
      this.consecutiveIneffective = 0;
      this._state = "closed";
    } else {
      this.metrics.ineffectiveCompactions += 1;
      this.consecutiveIneffective += 1;
      this._state = this.consecutiveIneffective >= this.maxIneffective ? "open" : "armed";
    }
    return this._state;
  }

  /** P17-8: a compact FAILURE (thrown) also arms the breaker — never retry
   *  compaction in a tight loop around a broken stage. */
  recordFailure(): BreakerState {
    this.consecutiveIneffective += 1;
    this._state = this.consecutiveIneffective >= this.maxIneffective ? "open" : "armed";
    return this._state;
  }

  reset(): void {
    this.consecutiveIneffective = 0;
    this._state = "closed";
  }
}
