import type { TerminationReason, VerificationSpec } from "@ar/contracts";

/**
 * Forbidden actions judged from the event trail (plan.md benchmark spec:
 * prompt injection / path traversal / exfiltration cases must be checkable
 * from events, never from model wording).
 */
export interface ForbiddenActions {
  /** Any completed/output tool call counts as a side effect (denial cases). */
  sideEffects?: boolean;
  /**
   * exec commands whose text contains any of these substrings are a violation
   * when the model *attempts* them (tool.requested), even if the sandbox
   * denied the execution — the attempt itself is the failure mode.
   */
  commands?: string[];
  /**
   * read/search requests whose resolved path argument contains any of these
   * substrings are a violation only when the read *succeeded* (tool.completed
   * with status success) — an unauthorized successful read is the failure.
   */
  reads?: string[];
  /**
   * Behavioral network policy (benchmark hardening): when true, any exec
   * command that looks like a network operation (curl/wget/ssh/git remote/
   * package manager/exfiltration patterns — see NETWORK_EXEC_PATTERNS in
   * runner.ts) is a violation on *attempt* (tool.requested), matching the
   * `commands` semantics. This is behavior-level judging from the event
   * trail, never a shell regex gate on the runtime.
   */
  network?: boolean;
}

/** Benchmark suite selector (Phase 6.5 benchmark hardening). */
export type EvalSuite = "regression" | "holdout" | "adversarial" | "stress";

/**
 * Eval case (AGENT_ARCHITECTURE_PLAN v2.0 §73, extended by the benchmark
 * plan.md and Phase 6.5 hardening). `workspace.fixture` is a dataset label
 * (e.g. "path-traversal") resolved by the harness into a real workspace (see
 * fixtures.ts); the runner itself only needs the session to exist.
 */
export interface EvalCase {
  id: string;
  task: string;
  workspace?: { fixture: string };
  expected: { status: "completed" | "failed" | "denied" };
  forbidden?: ForbiddenActions;
  verification?: VerificationSpec[];
  /** Wall-clock cap for the whole turn; expiry aborts the turn (cancelled). */
  timeoutMs?: number;
  /** Which benchmark suite the case belongs to (default "regression"). */
  suite?: EvalSuite;
  /** Free-form classification tags (e.g. "injection", "long-context"). */
  tags?: string[];
  /**
   * Optional expected structured termination reason, drawn from the bounded
   * P2-39 TerminationReason taxonomy (e.g. "verified_complete" |
   * "model_stopped" | "model_error" | "tool_limit" | "cancelled"). Exact
   * match only — there is no "limit:" prefix wildcard anymore.
   */
  expectedTerminationReason?: TerminationReason;
  /**
   * Security events the case expects to observe (Phase 9 security boundary).
   * Each entry is an event-type prefix: the turn must record at least one
   * event whose type starts with it (e.g. "security.network_denied").
   */
  expectedSecurityEvents?: string[];
  /** Budget on total retries across all retry kinds (retry taxonomy sum). */
  maxRetries?: number;
  /**
   * Runtime-level wall-clock budget (agent.limits.maxDurationMs, checked
   * inside the agent loop). Distinct from `timeoutMs` which aborts the turn
   * from outside. When both are set the tighter one wins in practice.
   */
  maxDurationMs?: number;
  /**
   * Whether large tool outputs may be spilled to artifact files
   * (toolOutputBudget.artifactDir). false → inline truncation only.
   * Default true.
   */
  allowArtifacts?: boolean;
  /** Judge logic version; used to surface "Judge Changed" in comparisons. */
  judgeVersion?: string;
}
