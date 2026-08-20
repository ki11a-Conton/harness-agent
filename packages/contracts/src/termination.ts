/**
 * P2-39 — bounded termination-reason taxonomy (V2). The runtime reports turn
 * termination using ONLY these members; no free-form strings (a previous
 * "limit:<kind>" proliferation is collapsed here). Downstream consumers
 * (evaluation attribution/fallback, delegation, scorecard, observability) key
 * off this closed set, so adding a reason is a deliberate, reviewed change.
 *
 * Completion / verification:
 *   verified_complete    — finished AND passed the verification gate.
 *   model_stopped        — model emitted a terminal stop without a gate pass.
 *   verification_failed  — verification gate exhausted its allowed retries.
 *
 * Failure origin:
 *   model_error          — the model call itself failed / ended unfinished.
 *   provider_error       — upstream provider / transport-level error.
 *   tool_error           — a tool call failed in a way that terminated the turn.
 *   sandbox_denied       — a sandbox gate denied the work (process/file/network).
 *   permission_denied    — a permission policy denied the work.
 *   security_denied      — a security gate denied the work (injection/secret/...).
 *
 * Budget limits:
 *   context_limit        — token budget (maxTokens) exhausted.
 *   tool_limit           — tool-call budget exhausted (maxToolCalls / repeated).
 *   time_limit           — wall-clock budget (maxDurationMs) exhausted.
 *   agent_limit          — agent execution budget (maxIterationsPerTurn) exhausted.
 *
 * Other:
 *   cancelled            — user/provider cancelled the turn.
 *   resume_ambiguous     — recovery could not disambiguate; closed fail-safe.
 */
export type TerminationReason =
  | "verified_complete"
  | "model_stopped"
  | "verification_failed"
  | "model_error"
  | "provider_error"
  | "tool_error"
  | "sandbox_denied"
  | "permission_denied"
  | "security_denied"
  | "context_limit"
  | "tool_limit"
  | "time_limit"
  | "agent_limit"
  | "cancelled"
  | "resume_ambiguous";

/** Exhaustive list of the bounded taxonomy, for runtime validation of
 *  externally-supplied reasons (e.g. benchmark case data). `satisfies`
 *  keeps this in lock-step with the union: adding a reason to the union
 *  without adding it here is a compile error. */
export const TERMINATION_REASONS = [
  "verified_complete",
  "model_stopped",
  "verification_failed",
  "model_error",
  "provider_error",
  "tool_error",
  "sandbox_denied",
  "permission_denied",
  "security_denied",
  "context_limit",
  "tool_limit",
  "time_limit",
  "agent_limit",
  "cancelled",
  "resume_ambiguous",
] as const satisfies readonly TerminationReason[];

export function isTerminationReason(value: unknown): value is TerminationReason {
  return typeof value === "string" && (TERMINATION_REASONS as readonly string[]).includes(value);
}

/**
 * P2-39 — stable mapping from a `run.limit_reached` limit identifier to the
 * bounded TerminationReason used as the turn's terminal reason. Kept in ONE
 * place so the runtime (which knows the actual terminal reason) and the
 * event-derived evaluation fallback (which only sees the limit event) agree.
 */
export const LIMIT_TERMINATION_REASON: Readonly<Record<string, TerminationReason>> = {
  maxTokens: "context_limit",
  maxDurationMs: "time_limit",
  maxToolCalls: "tool_limit",
  maxRepeatedToolCalls: "tool_limit",
  maxIterationsPerTurn: "agent_limit",
  maxVerificationFailures: "verification_failed",
  maxRetries: "model_error",
};
/**
 * P8-3 — false-complete grading. Metrics MUST distinguish these even when the
 * termination-reason enum stays coarse:
 *
 *   verified_complete    — finished AND the verification gate passed fully.
 *   verified_partial     — finished, gate ran, only some steps passed.
 *   verification_failed  — the gate itself exhausted its retries / failed.
 *   unverified_complete  — the model just stopped; no gate, no evidence.
 *
 * "I'm done" is NOT success — unverified_complete is the honest grade for a
 * bare model_stopped with no verification evidence.
 */
export type FalseCompleteGrade =
  | "unverified_complete"
  | "verification_failed"
  | "verified_partial"
  | "verified_complete";

export interface CompletionEvidence {
  /** Steps that passed the verification gate. */
  passedSteps: number;
  /** Total steps the gate ran. */
  totalSteps: number;
}

export function gradeCompletion(
  reason: TerminationReason,
  evidence?: CompletionEvidence,
): FalseCompleteGrade {
  switch (reason) {
    case "verified_complete":
      return "verified_complete";
    case "verification_failed":
      return "verification_failed";
    case "model_stopped":
      if (evidence !== undefined && evidence.totalSteps > 0) {
        return evidence.passedSteps >= evidence.totalSteps
          ? "verified_complete"
          : "verified_partial";
      }
      return "unverified_complete";
    default:
      // failure/cancelled/limit reasons are not "complete" at all.
      return "unverified_complete";
  }
}
