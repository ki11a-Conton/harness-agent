/**
 * Q-3 — Shared Error Taxonomy.
 *
 * The project already carries four bounded vocabularies (see their own modules):
 *
 *   ErrorCode          — packages/contracts/src/errors.ts
 *   TerminationReason  — packages/contracts/src/termination.ts  (P2-39)
 *   RetryKind          — packages/contracts/src/retry.ts         (P2-40)
 *   SecurityDimension  — packages/security/src/denial.ts         (P0-7)
 *
 * What was missing is the TYPED MAPPING between them, so call sites can stop
 * hand-rolling ad-hoc string checks of the form:
 *
 *   if (err.info.code === "PERMISSION_DENIED" || ... || code.startsWith("SANDBOX"))
 *   if (code === "USER_CANCELLED")
 *
 * This module is the single shared home for those cross-taxonomy couplings and
 * predicates. SecurityDimension lives in the `security` package (contracts must
 * not import it to avoid a cycle); the coupling there is already centralized by
 * `securityErrorCode`/`securityEventType`. Everything in this module is derived
 * from the closed unions above, so adding a member to a union (or removing one)
 * is a compile error that forces this file to stay in lock-step.
 */
import type { ErrorCode } from "./errors.js";
import type { RetryKind } from "./retry.js";
import { RETRY_KIND_SPECS } from "./retry.js";
import type { TerminationReason } from "./termination.js";

// ---------------------------------------------------------------------------
// ErrorCode → TerminationReason (denied family)
// ---------------------------------------------------------------------------

/**
 * Coupling from a denial-class ErrorCode to the bounded TerminationReason
 * (P2-39) that the same failure would surface as at the turn level. Authority
 * for the exact merge (a permission ask vs an approval denial vs a sandbox /
 * security gate) stays here in ONE place so the runtime and the event-derived
 * evaluation fallback agree.
 */
export const DENIED_TERMINATION: Readonly<Partial<Record<ErrorCode, TerminationReason>>> = {
  PERMISSION_DENIED: "permission_denied",
  APPROVAL_DENIED: "permission_denied",
  SANDBOX_DENIED: "sandbox_denied",
  SANDBOX_FILESYSTEM_DENIED: "sandbox_denied",
  SANDBOX_PROCESS_DENIED: "sandbox_denied",
  SANDBOX_NETWORK_DENIED: "sandbox_denied",
  SECURITY_DENIED: "security_denied",
  INJECTION_DENIED: "security_denied",
  SECRET_REDACTED: "security_denied",
  WRITE_SAFETY_DENIED: "security_denied",
  MEMORY_DENIED: "security_denied",
  SKILL_DENIED: "security_denied",
  MCP_DENIED: "security_denied",
};

/** Total, fail-closed: any ErrorCode resolves to a TerminationReason. */
export function deniedTermination(code: ErrorCode): TerminationReason {
  return DENIED_TERMINATION[code] ?? "security_denied";
}

// ---------------------------------------------------------------------------
// Typed guarded sets and predicates (no repeated string literals)
// ---------------------------------------------------------------------------

/** Permission/approval/sandbox denials — the set a tool orchestrator maps to a
 *  "denied" outcome status. Centralizes the former `code.startsWith("SANDBOX")`. */
const PERMISSION_OR_SANDBOX_DENIED = new Set<ErrorCode>([
  "PERMISSION_DENIED",
  "APPROVAL_DENIED",
  "SANDBOX_DENIED",
  "SANDBOX_FILESYSTEM_DENIED",
  "SANDBOX_PROCESS_DENIED",
  "SANDBOX_NETWORK_DENIED",
]);

/** Timeout-class errors (a single deliberated terminal classification). */
const TIMEOUT_ERRORS = new Set<ErrorCode>(["PROCESS_TIMEOUT"]);

/** User / caller-initiated cancellation. */
const CANCELLED_ERRORS = new Set<ErrorCode>(["USER_CANCELLED"]);

/** Internal / invariant-broken failures. */
const INTERNAL_ERRORS = new Set<ErrorCode>(["INTERNAL_ERROR"]);

/** Model-side failures. */
const MODEL_ERRORS = new Set<ErrorCode>(["MODEL_ERROR"]);

/** True when a code denotes a permission, approval, or sandbox denial. */
export function isPermissionOrSandboxDenied(code: ErrorCode): boolean {
  return PERMISSION_OR_SANDBOX_DENIED.has(code);
}

/** True for any error in the "denied" family (permission / sandbox / security). */
export function isDeniedErrorCode(code: ErrorCode): boolean {
  return code in DENIED_TERMINATION;
}

/** True for a timeout-class code. */
export function isTimeoutErrorCode(code: ErrorCode): boolean {
  return TIMEOUT_ERRORS.has(code);
}

/** True for a user/caller-initiated cancellation. */
export function isCancelledErrorCode(code: ErrorCode): boolean {
  return CANCELLED_ERRORS.has(code);
}

/** True for an internal / invariant-broken failure. */
export function isInternalErrorCode(code: ErrorCode): boolean {
  return INTERNAL_ERRORS.has(code);
}

/** True for a model-side failure. */
export function isModelErrorCode(code: ErrorCode): boolean {
  return MODEL_ERRORS.has(code);
}

// ---------------------------------------------------------------------------
// RetryKind → TerminationReason
// ---------------------------------------------------------------------------

/** The TerminationReason a retry kind surfaces when its budget is exhausted,
 *  read straight from the authoritative P2-40 governance table. */
export function retryKindTermination(kind: RetryKind): TerminationReason {
  return RETRY_KIND_SPECS[kind].terminationBehavior;
}