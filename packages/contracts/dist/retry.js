/** Exhaustive list of retry kinds; `satisfies` keeps it in lock-step with the
 *  union — adding a kind to the union without adding it here is a compile error. */
export const RETRY_KINDS = [
    "provider",
    "model",
    "tool",
    "verification",
    "compaction",
    "stallRecovery",
    "reconciliation",
    "mcpReconnect",
];
/**
 * P2-40 — the retry-kind governance table. Values describe the CURRENT runtime
 * behavior; changing one is a behavior change, not just a comment.
 */
export const RETRY_KIND_SPECS = {
    provider: {
        kind: "provider",
        maxAttempts: 3,
        backoffMs: 200,
        // The request was not yet a call the agent observed; retrying a transport
        // failure is always safe (no observable side effect was delivered).
        safePredicate: "always",
        terminationBehavior: "provider_error",
    },
    model: {
        kind: "model",
        maxAttempts: 3,
        backoffMs: 500,
        // The model call may have produced part of a tool batch; the runtime only
        // retries when the prior attempt yielded no committed tool effects.
        safePredicate: "idempotent",
        terminationBehavior: "model_error",
    },
    tool: {
        kind: "tool",
        maxAttempts: 3,
        backoffMs: 500,
        // Only recoverable (idempotent/read-only) tools are auto-retried; unknown or
        // non-idempotent effects flow to the model instead (plan.md Phase 3.6).
        safePredicate: "idempotent",
        terminationBehavior: "tool_limit",
    },
    verification: {
        kind: "verification",
        maxAttempts: 2,
        backoffMs: null,
        // The verification gate is read-only; re-running it is always safe.
        safePredicate: "always",
        terminationBehavior: "verification_failed",
    },
    compaction: {
        kind: "compaction",
        maxAttempts: 2,
        backoffMs: null,
        // Compaction collapses history; re-compacting is idempotent.
        safePredicate: "idempotent",
        terminationBehavior: "context_limit",
    },
    stallRecovery: {
        kind: "stallRecovery",
        maxAttempts: 1,
        backoffMs: null,
        // Only once per streak — a bounded observation is injected and the streak is
        // reset; the turn is only terminated on a LATER streak (maxRepeatedToolCalls).
        safePredicate: "always",
        terminationBehavior: "tool_limit",
    },
    reconciliation: {
        kind: "reconciliation",
        maxAttempts: 0,
        backoffMs: null,
        // Never auto-redone. A started-but-unconfirmed tool's outcome is unknown; the
        // runtime surfaces it to the model to reconcile, and the executor confirms the
        // effect manually (cancel never rolls back). 0 attempts by design.
        safePredicate: "never",
        terminationBehavior: "resume_ambiguous",
    },
    mcpReconnect: {
        kind: "mcpReconnect",
        maxAttempts: 3,
        backoffMs: 100,
        // A disconnected MCP client is re-handshaken (initialize) before the call;
        // the transport has no committed agent-visible effect until tools/call answers.
        safePredicate: "always",
        terminationBehavior: "provider_error",
    },
};
export function isRetryKind(value) {
    return typeof value === "string" && RETRY_KINDS.includes(value);
}
//# sourceMappingURL=retry.js.map