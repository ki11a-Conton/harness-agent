export type InvariantId = "INV-001" | "INV-002" | "INV-003" | "INV-004" | "INV-005" | "INV-006" | "INV-007" | "INV-008" | "INV-009" | "INV-010";
export declare const ALL_INVARIANTS: readonly InvariantId[];
export interface Violation {
    /** Human-readable pointer to the record that violated the invariant. */
    at: string;
    detail: string;
}
export interface InvariantResult {
    invariant: InvariantId;
    label: string;
    ok: boolean;
    violations: Violation[];
}
/** Closed set of terminal run states; a run in any of these is done. */
export type TerminalState = "verified_complete" | "failed" | "cancelled" | "security_denied";
export declare const TERMINAL_STATES: readonly TerminalState[];
export declare function isTerminalState(state: string): boolean;
export interface StateSnapshot {
    at: string;
    state: string;
}
/**
 * Given an ordered state timeline (oldest → newest) for one run/session, the
 * invariant holds iff no snapshot AFTER the first terminal snapshot differs
 * from it (i.e. a terminal state never transitions to another state).
 */
export declare function invTerminalStateCannotTransition(timeline: StateSnapshot[]): InvariantResult;
export type CapabilityDimension = "tool" | "filesystem" | "network" | "process";
export declare const CAPABILITY_DIMENSIONS: readonly CapabilityDimension[];
export interface CapabilityClaim {
    /** Upper bound conferred by parent/host. */
    conferred: Partial<Record<CapabilityDimension, readonly string[]>>;
    /** What the child claims for itself; effectively an insist-at-least-this. */
    declared: Partial<Record<CapabilityDimension, readonly string[]>>;
}
/**
 * The invariant holds iff for every dimension the child declared, every item it
 * declared is available to the parent (i.e. the child insists on nothing the
 * parent lacks). This is the no-escalation core of the capability boundary.
 */
export declare function invChildCapabilityIsConferredBound(claim: CapabilityClaim): InvariantResult;
export interface ToolCallRecord {
    toolId: string;
    /** A tool whose side effect is irreversible/dangerous on repeated execution. */
    unsafe: boolean;
    /** Whether this occurrence was an automatic retry (vs manual/user-driven). */
    autoRetry: boolean;
    retryAttempt: number;
}
/**
 * The invariant holds iff no unsafe tool is ever re-invoked by an automatic
 * retry. Manual/user-driven re-execution is allowed (and audited), but the
 * harness must never auto-retry a tool marked unsafe.
 */
export declare function invUnsafeToolNeverAutoRetried(calls: ToolCallRecord[]): InvariantResult;
export interface VerificationClaim {
    caseId: string;
    /** Reported outcome of the verification gate. */
    passed: boolean;
    /** Independent checks the gate actually ran (empty ⇒ no evidence). */
    checks: {
        id: string;
        passed: boolean;
    }[];
    /** Discrete evidence artifacts produced by the verifier. */
    evidence: {
        id: string;
    }[];
}
/**
 * The invariant holds iff a reported pass is backed by at least one passed
 * check and some evidence; claiming completion on no data — or on a fully
 * failed check set — is treated as fabrication.
 */
export declare function invVerificationCannotBeFabricated(claims: VerificationClaim[]): InvariantResult;
export interface ContextAccess {
    /** Context the child is explicitly allowed to read (cwd, env keys, files,
     *  memory keys, etc.) by the parent. */
    granted: readonly string[];
    /** Keys the child actually read during the run. */
    observed: {
        key: string;
        at: string;
    }[];
    /** Regular expression/prefix pattern marking parent-internal secrets. */
    internalPrefix?: string;
}
/**
 * The invariant holds iff the child never observes anything it was not granted
 * — and in particular never observes parent-internal keys. Gaps are flagged.
 */
export declare function invChildContextIsolation(access: ContextAccess): InvariantResult;
export interface ScoringRecord {
    caseId: string;
    /** Whether this case is a holdout (withheld until activation). */
    holdout: boolean;
    /** Whether the judge instance has been activated for this case. */
    activated: boolean;
    /** Whether the judge scored this case. */
    scored: boolean;
}
/**
 * The invariant holds iff no holdout case is ever scored by a judge that has
 * not been activated for it — the judge must not see/score holdout answers
 * before activation, else the benchmark leaks into the pipeline.
 */
export declare function invHoldoutJudgeSecrecy(records: ScoringRecord[]): InvariantResult;
export interface MemoryWrite {
    contentId: string;
    /** Content was classified unsafe (secret / injection / tracking / ...). */
    unsafe: boolean;
    /** Whether the write was actually persisted to memory. */
    persisted: boolean;
    /** Whether the write was rejected at the gate. */
    rejected: boolean;
}
/**
 * The invariant holds iff unsafe content is never persisted. A write may be
 * rejected (good) but never both persisted and unsafe.
 */
export declare function invMemoryUnsafeContentCannotPersist(writes: MemoryWrite[]): InvariantResult;
export interface NetworkDecision {
    actionId: string;
    /** Network gate verdict for this action. */
    allowed: boolean;
    /** Whether the action actually executed (e.g. made the HTTP call). */
    executed: boolean;
}
/**
 * The invariant holds iff a denied network action never executes. Deny must be
 * fail-closed: `allowed=false ⇒ executed=false`.
 */
export declare function invNetworkDeniedCannotExecute(decisions: NetworkDecision[]): InvariantResult;
export interface DelegationRecord {
    delegateId: string;
    depth: number;
    maxDepth: number;
    /** Cumulative delegation count under this parent, for fan-out bounding. */
    count: number;
    maxCount: number;
    /** Whether the child's effective capability is a subset of the delegator's. */
    capabilityNarrowed: boolean;
}
/**
 * The invariant holds iff every delegation is within its depth bound, within
 * its fan-out count bound, and does not widen capability (subset/intersection).
 */
export declare function invDelegationBounded(records: DelegationRecord[]): InvariantResult;
export interface SideEffectRecord {
    effectId: string;
    /** Side effect is irreversible/high-impact if repeated. */
    unsafe: boolean;
    /** Whether it has already been recorded as completed. */
    completed: boolean;
}
export interface ReplayExecution {
    effectId: string;
    /** Whether this replay run executed (or re-executed) the side effect. */
    executed: boolean;
}
/**
 * The invariant holds iff a replay never re-executes a side effect that is
 * already recorded as completed AND unsafe — such an effect must be replayed
 * as a no-op, not duplicated.
 */
export declare function invReplayNoDuplicateUnsafeSideEffect(known: SideEffectRecord[], replay: ReplayExecution[]): InvariantResult;
export interface InvariantRun {
    stateTimeline?: StateSnapshot[];
    capability?: CapabilityClaim;
    toolCalls?: ToolCallRecord[];
    verificationClaims?: VerificationClaim[];
    childContext?: ContextAccess;
    scoring?: ScoringRecord[];
    memoryWrites?: MemoryWrite[];
    networkDecisions?: NetworkDecision[];
    delegations?: DelegationRecord[];
    sideEffects?: {
        known: SideEffectRecord[];
        replay: ReplayExecution[];
    };
}
export declare function checkInvariants(run: InvariantRun): InvariantResult[];
export declare function allPass(results: InvariantResult[]): boolean;
export declare function violated(results: InvariantResult[]): InvariantResult[];
/** Compact one-line-per-invariant rendering for gate summaries. */
export declare function renderInvariants(results: InvariantResult[]): string;
//# sourceMappingURL=formal-invariants.d.ts.map