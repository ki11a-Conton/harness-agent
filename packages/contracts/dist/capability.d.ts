export type CapabilityDimension = "tool" | "filesystem" | "network" | "process";
export declare const CAPABILITY_DIMENSIONS: readonly ["tool", "filesystem", "network", "process"];
/** The 4 effective-capability surfaces named by the plan. */
export type CapabilitySets = Record<CapabilityDimension, readonly string[]>;
export declare const EMPTY_CAPABILITY_SETS: CapabilitySets;
/** What a subordinate claims for itself; absent dimension ⇒ inherit conferred. */
export type DeclaredCapability = Partial<Record<CapabilityDimension, readonly string[]>>;
export type ViolationKind = "tool_escalation" | "filesystem_escalation" | "network_escalation" | "process_escalation";
export interface CapabilityViolation {
    kind: ViolationKind;
    /** The items the subordinate declared but was not conferred. */
    declared: readonly string[];
    /** The upper bound the conferring parent/host granted. */
    conferred: readonly string[];
}
export interface CapabilityVerdict {
    /** True when every declared item was within the conferred bound. */
    allowed: boolean;
    /** Effective capability = declared ∩ conferred (monotonic downward). */
    effective: CapabilitySets;
    /** Every dimension that attempted to widen beyond its bound. */
    violations: CapabilityViolation[];
    /** Dimensions the subordinate explicitly narrowed (changed), for audit. */
    narrowed: CapabilityDimension[];
}
/** Optional compose-time policy: case-insensitive filesystem folding
 *  (mirrors `FilesystemPolicy.caseInsensitive` for path comparisons). */
export interface ComposeCapabilitiesOptions {
    caseInsensitive?: boolean;
}
/**
 * Compute the effective capability for a subordinate.
 *
 * Semantics:
 *   - A dimension the subordinate does NOT declare is inherited from `conferred`
 *     unchanged — it can never be widened by omission.
 *   - A dimension the subordinate DOES declare is intersected with `conferred`.
 *     Any item it declares that is not in `conferred` is an escalation violation.
 *   - A `*` entry in `conferred` means "anything in this dimension" (upper bound
 *     is full); a subordinate may still narrow it but its own `*` claim is only
 *     valid if `conferred` also contains `*`.
 *
 * P14-1: filesystem items must be canonicalised by the CALLER before being
 * passed here (the capability guard realpath-resolves declared and conferred
 * paths).  Containment is decided by the shared pure {@link isPathWithin}.
 *
 * The returned `allowed` is false iff there is at least one violation; the
 * caller MUST fail closed and grant only `effective`.
 */
export declare function composeCapabilities(conferred: CapabilitySets, declared: DeclaredCapability, opts?: ComposeCapabilitiesOptions): CapabilityVerdict;
//# sourceMappingURL=capability.d.ts.map