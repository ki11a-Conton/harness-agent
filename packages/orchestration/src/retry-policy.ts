/**
 * P33-7 — Retry policy.
 *
 * Transient failures retry with exponential backoff + jitter. Uses an
 * injected monotonic clock (`now`) so tests never wait. A state change
 * (item terminal/inactive/blocked) cancels any pending retry — reconcile
 * simply no longer sees the item as retry-eligible.
 *
 * No retry storm after restart: counts are derived purely from the observed
 * attempt plus the injected clock, so a restart that re-observes the same
 * failure state re-derives the same backoff window (no memory of in-flight
 * attempts is needed; the scheduler re-schedules from attempt 0 on a fresh
 * process).
 */

export interface RetryConfig {
  /** Delay for the first retry (ms). */
  readonly baseDelayMs: number;
  /** Multiplier per attempt (default 2). */
  readonly factor?: number;
  /** Hard ceiling on any single delay (ms). */
  readonly maxDelayMs: number;
  /** Max attempts before retries are abandoned (default 5). */
  readonly maxAttempts?: number;
  /** Random jitter fraction applied to the computed delay (default 0.2 → ±20%). */
  readonly jitterRatio?: number;
}

export const DEFAULT_RETRY: RetryConfig = {
  baseDelayMs: 1_000,
  factor: 2,
  maxDelayMs: 60_000,
  maxAttempts: 5,
  jitterRatio: 0.2,
};

export interface RetryState {
  /** Attempt number this state represents (1-based after the first failure). */
  readonly attempt: number;
  /** Absolute time when the retry becomes due. POSITIVE_INFINITY = abandoned. */
  readonly nextAttemptAt: number;
}

/** Pure: compute the (jittered) delay for the given 0-based attempt index. */
export function computeRetryDelay(config: RetryConfig, attemptIndex: number, now: number, rand = Math.random): number {
  const factor = config.factor ?? 2;
  const jitterRatio = config.jitterRatio ?? 0.2;
  const base = config.baseDelayMs * Math.pow(factor, attemptIndex);
  const capped = Math.min(base, config.maxDelayMs);
  const jitter = (rand() * 2 - 1) * jitterRatio * capped;
  return Math.max(0, Math.round(capped + jitter));
}

/** Next scheduled retry for an item that just failed with `attempt` previous failures. */
export function scheduleRetry(config: RetryConfig, attempt: number, now: number, rand = Math.random): RetryState {
  const maxAttempts = config.maxAttempts ?? 5;
  if (attempt >= maxAttempts) {
    return { attempt, nextAttemptAt: Number.POSITIVE_INFINITY };
  }
  return {
    attempt: attempt + 1,
    nextAttemptAt: now + computeRetryDelay(config, attempt, now, rand),
  };
}

/** True when a scheduled retry's time has arrived. */
export function retryDue(state: { nextAttemptAt: number }, now: number): boolean {
  return state.nextAttemptAt !== Number.POSITIVE_INFINITY && state.nextAttemptAt <= now;
}

/** Injected-monotonic-clock retry scheduler for testable orchestration. */
export class RetryScheduler {
  private readonly config: RetryConfig;
  private readonly now: () => number;

  constructor(config: RetryConfig, now: () => number) {
    this.config = config;
    this.now = now;
  }

  /** Next retry state after a failure with the given prior attempt count. */
  next(attempt: number): RetryState {
    return scheduleRetry(this.config, attempt, this.now());
  }

  /** True when the item's scheduled retry is due now. */
  due(entry: { nextAttemptAt: number }): boolean {
    return retryDue(entry, this.now());
  }

  get maxAttempts(): number {
    return this.config.maxAttempts ?? 5;
  }
}