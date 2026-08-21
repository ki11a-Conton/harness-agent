import type { TerminationReason } from "./termination.js";
/**
 * P2-40 — retry taxonomy V2. Distinguishes every retry the runtime can express
 * (each derived from observable events — never from model wording) and pins,
 * for each kind, the four governance dimensions the plan requires:
 *
 *   max attempts        hard per-streak/per-turn cap on re-attempts.
 *   backoff             base delay between attempts (ms); null = no deliberate backoff.
 *   safe predicate      when a re-execution is SAFE (no double side effects).
 *   termination behavior the bounded TerminationReason (P2-39) reported when the
 *                       budget is exhausted.
 *
 * This is the authoritative definition. The evaluation `RetryTaxonomy` counter,
 * the runtime's recovery/stall/reconcile branches and the MCP auto-reconnect all
 * key off this closed set — adding a retry kind is a deliberate, reviewed change
 * to the union + array + spec here.
 */
export type RetryKind = "provider" | "model" | "tool" | "verification" | "compaction" | "stallRecovery" | "reconciliation" | "mcpReconnect";
/** Exhaustive list of retry kinds; `satisfies` keeps it in lock-step with the
 *  union — adding a kind to the union without adding it here is a compile error. */
export declare const RETRY_KINDS: readonly ["provider", "model", "tool", "verification", "compaction", "stallRecovery", "reconciliation", "mcpReconnect"];
/** Whether re-attempting a kind can be done without risking double work. */
export type RetrySafePredicate = "idempotent" | "always" | "never";
export interface RetryKindSpec {
    kind: RetryKind;
    /** Hard cap on re-attempts per streak/turn. 0 = the kind is never retried. */
    maxAttempts: number;
    /** Base backoff between attempts (ms); null = no deliberate backoff. */
    backoffMs: number | null;
    /**
     * - always     : safe to re-run on any failure (pure/read-only/structural).
     * - idempotent : safe only when the operation is provably idempotent.
     * - never      : never auto-requeue (double side-effect / unknown-outcome risk);
     *                surfaces a reconciliation / termination instead.
     */
    safePredicate: RetrySafePredicate;
    /** Bounded TerminationReason (P2-39) emitted when the budget is exhausted. */
    terminationBehavior: TerminationReason;
}
/**
 * P2-40 — the retry-kind governance table. Values describe the CURRENT runtime
 * behavior; changing one is a behavior change, not just a comment.
 */
export declare const RETRY_KIND_SPECS: Readonly<Record<RetryKind, RetryKindSpec>>;
export declare function isRetryKind(value: unknown): value is RetryKind;
//# sourceMappingURL=retry.d.ts.map