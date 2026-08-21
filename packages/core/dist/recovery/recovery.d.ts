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
export declare class RecoveryPolicy {
    private readonly maxAttempts;
    private readonly maxAttemptsByKind;
    private readonly retryDelayMs;
    private readonly retryDelayByKind;
    private readonly askOn;
    constructor(opts?: RecoveryPolicyOptions);
    /** Decide what to do for the given failure kind on the given (1-based) attempt. */
    decide(kind: FailureKind, attempt: number): RecoveryDecision;
}
//# sourceMappingURL=recovery.d.ts.map