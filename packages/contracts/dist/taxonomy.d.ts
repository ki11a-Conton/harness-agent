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
import type { TerminationReason } from "./termination.js";
/**
 * Coupling from a denial-class ErrorCode to the bounded TerminationReason
 * (P2-39) that the same failure would surface as at the turn level. Authority
 * for the exact merge (a permission ask vs an approval denial vs a sandbox /
 * security gate) stays here in ONE place so the runtime and the event-derived
 * evaluation fallback agree.
 */
export declare const DENIED_TERMINATION: Readonly<Partial<Record<ErrorCode, TerminationReason>>>;
/** Total, fail-closed: any ErrorCode resolves to a TerminationReason. */
export declare function deniedTermination(code: ErrorCode): TerminationReason;
/** True when a code denotes a permission, approval, or sandbox denial. */
export declare function isPermissionOrSandboxDenied(code: ErrorCode): boolean;
/** True for any error in the "denied" family (permission / sandbox / security). */
export declare function isDeniedErrorCode(code: ErrorCode): boolean;
/** True for a timeout-class code. */
export declare function isTimeoutErrorCode(code: ErrorCode): boolean;
/** True for a user/caller-initiated cancellation. */
export declare function isCancelledErrorCode(code: ErrorCode): boolean;
/** True for an internal / invariant-broken failure. */
export declare function isInternalErrorCode(code: ErrorCode): boolean;
/** True for a model-side failure. */
export declare function isModelErrorCode(code: ErrorCode): boolean;
/** The TerminationReason a retry kind surfaces when its budget is exhausted,
 *  read straight from the authoritative P2-40 governance table. */
export declare function retryKindTermination(kind: RetryKind): TerminationReason;
//# sourceMappingURL=taxonomy.d.ts.map