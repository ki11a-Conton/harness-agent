/**
 * Bounded recovery policy (RECOVERY-001).
 *
 * Pure, synchronous, deterministic decision component: given a failure kind
 * and the 1-based attempt number, it decides whether the runtime should
 * retry, ask the user, or fail safely. It never performs the retry itself —
 * execution stays in the caller (runtime.ts runTurn failure path).
 */
const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_RETRY_DELAY_MS = 500;
export class RecoveryPolicy {
    maxAttempts;
    maxAttemptsByKind;
    retryDelayMs;
    retryDelayByKind;
    askOn;
    constructor(opts = {}) {
        this.maxAttempts = opts.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
        this.maxAttemptsByKind = opts.maxAttemptsByKind ?? {};
        this.retryDelayMs = opts.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
        this.retryDelayByKind = opts.retryDelayByKind ?? {};
        this.askOn = opts.askOn ?? new Set();
    }
    /** Decide what to do for the given failure kind on the given (1-based) attempt. */
    decide(kind, attempt) {
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
                reason: `context_overflow on attempt ${attempt}/${effectiveMax}; retries cannot self-heal, ` +
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
//# sourceMappingURL=recovery.js.map