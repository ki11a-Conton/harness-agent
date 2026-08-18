/**
 * Bounded recovery policy (RECOVERY-001).
 *
 * Pure, synchronous, deterministic decision component: given a failure kind
 * and the 1-based attempt number, it decides whether the runtime should
 * retry, ask the user, or fail safely. It never performs the retry itself —
 * execution stays in the caller (runtime.ts runTurn failure path).
 */

export type FailureKind = "tool_failure" | "test_failure" | "timeout" | "context_overflow" | "model_error";

export type RecoveryAction = "retry" | "ask" | "fail_safe";

export interface RecoveryDecision {
  action: RecoveryAction;
  kind: FailureKind;
  /** 1-based: this is the Nth attempt (including the current one). */
  attempt: number;
  /** Effective per-kind attempt cap (kind override or global default). */
  maxAttempts: number;
  /** Human-readable rationale for the action. */
  reason: string;
  /** Present only when action === "retry". */
  retryDelayMs?: number;
}

export interface RecoveryPolicyOptions {
  /** Global default attempt cap. Default 3. */
  maxAttempts?: number;
  /** Per-kind attempt cap overrides. Default {} (no overrides). */
  maxAttemptsByKind?: Partial<Record<FailureKind, number>>;
  /** Global retry delay. Default 500. */
  retryDelayMs?: number;
  /** Per-kind retry delay overrides. Default {} (no overrides). */
  retryDelayByKind?: Partial<Record<FailureKind, number>>;
  /**
   * Kinds that must ask the user once attempts are exhausted.
   * Default: empty set (only context_overflow asks by default).
   */
  askOn?: ReadonlySet<FailureKind>;
}

const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_RETRY_DELAY_MS = 500;

export class RecoveryPolicy {
  private readonly maxAttempts: number;
  private readonly maxAttemptsByKind: Partial<Record<FailureKind, number>>;
  private readonly retryDelayMs: number;
  private readonly retryDelayByKind: Partial<Record<FailureKind, number>>;
  private readonly askOn: ReadonlySet<FailureKind>;

  constructor(opts: RecoveryPolicyOptions = {}) {
    this.maxAttempts = opts.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
    this.maxAttemptsByKind = opts.maxAttemptsByKind ?? {};
    this.retryDelayMs = opts.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
    this.retryDelayByKind = opts.retryDelayByKind ?? {};
    this.askOn = opts.askOn ?? new Set();
  }

  /** Decide what to do for the given failure kind on the given (1-based) attempt. */
  decide(kind: FailureKind, attempt: number): RecoveryDecision {
    if (!Number.isInteger(attempt) || attempt <= 0) {
      throw new TypeError(`attempt must be a positive integer, got ${attempt}`);
    }

    const effectiveMax = this.maxAttemptsByKind[kind] ?? this.maxAttempts;

    if (attempt < effectiveMax) {
      const remaining = effectiveMax - attempt;
      return {
        action: "retry",
        kind,
        attempt,
        maxAttempts: effectiveMax,
        reason: `${kind} on attempt ${attempt}/${effectiveMax}; ${remaining} attempt(s) remaining, retrying`,
        retryDelayMs: this.retryDelayByKind[kind] ?? this.retryDelayMs,
      };
    }

    if (kind === "context_overflow") {
      return {
        action: "ask",
        kind,
        attempt,
        maxAttempts: effectiveMax,
        reason:
          `context_overflow on attempt ${attempt}/${effectiveMax}; retries cannot self-heal, ` +
          `ask the user to compact the context or decide next steps`,
      };
    }

    if (this.askOn.has(kind)) {
      return {
        action: "ask",
        kind,
        attempt,
        maxAttempts: effectiveMax,
        reason: `${kind} on attempt ${attempt}/${effectiveMax}; attempts exhausted and asking is configured for this kind`,
      };
    }

    return {
      action: "fail_safe",
      kind,
      attempt,
      maxAttempts: effectiveMax,
      reason: `${kind} on attempt ${attempt}/${effectiveMax}; attempts exhausted, failing safely`,
    };
  }
}
