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
export type RetryKind =
  | "provider"
  | "model"
  | "tool"
  | "verification"
  | "compaction"
  | "stallRecovery"
  | "reconciliation"
  | "mcpReconnect";

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
] as const satisfies readonly RetryKind[];

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
export const RETRY_KIND_SPECS: Readonly<Record<RetryKind, RetryKindSpec>> = {
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

export function isRetryKind(value: unknown): value is RetryKind {
  return typeof value === "string" && (RETRY_KINDS as readonly string[]).includes(value);
}