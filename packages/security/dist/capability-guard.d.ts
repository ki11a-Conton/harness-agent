import type { CapabilitySets, CapabilityViolation, DeclaredCapability, SandboxPolicy } from "@ar/contracts";
/**
 * P2-45 — capability escalation guard, bound to the real policy types.
 *
 * A child/plugin/MCP/hook presents a `DeclaredCapability` (from its own config
 * or instruction text). The guard verifies it is only a NARROWING of the upper
 * bound the host granted (`GrantedCapability` = a SandboxPolicy + tool
 * allowlist) and, when it is, returns the narrowed SandboxPolicy + tool
 * allowlist that the subordinate may run with. Any attempt to widen — extra
 * tool, wider filesystem root, new network host, or new process command — is an
 * escalation and throws {@link CapabilityEscalationError} (fail closed).
 *
 * P14-1: filesystem narrowing shares ONE canonicalisation semantic with
 * SandboxManager.  Both conferred roots and declared filesystem items are
 * canonicalised with {@link canonicalizePath} (realpath of the deepest
 * existing ancestor + lexically resolved tail) BEFORE the pure containment
 * comparison, so `/work/../etc`, `C:\work\..\Windows`, symlink/junction
 * escapes, and siblings can never masquerade as "inside" a conferred root.
 *
 * Escalations are never auto-granted here; only an explicit host/user approval
 * upstream may raise `grant.policy`, and that raise is recomputed against the
 * new bound on the next compose.
 */
export declare class CapabilityEscalationError extends Error {
    readonly violations: readonly CapabilityViolation[];
    constructor(violations: readonly CapabilityViolation[]);
}
export interface GrantedCapability {
    /** The upper bound the host confers on this subordinate. */
    policy: SandboxPolicy;
    /** Tool ids the host allows the subordinate to call. */
    toolAllowlist: readonly string[];
}
export interface NarrowedCapability {
    policy: SandboxPolicy;
    toolAllowlist: readonly string[];
    /** Capability dimensions the subordinate narrowed, for audit. */
    narrowed: readonly string[];
}
/** Options for {@link composeChildCapability}. */
export interface ComposeChildCapabilityOptions {
    /** Working directory used to canonicalise relative filesystem paths. */
    cwd?: string;
}
/** Project a granted SandboxPolicy + tool allowlist into capability sets. */
export declare function capabilitySetsFromGrant(grant: GrantedCapability): CapabilitySets;
/**
 * Verify a subordinate's declared capability only narrows the granted bound.
 * Returns a narrowed SandboxPolicy + tool allowlist on success; throws
 * `CapabilityEscalationError` (fail closed) on any escalation.
 *
 * Filesystem containment (P14-1): conferred roots AND declared items are
 * canonicalised with the same function SandboxManager uses before the pure
 * containment comparison — one canonicalisation semantic across the guard and
 * the sandbox.
 */
export declare function composeChildCapability(grant: GrantedCapability, declared: DeclaredCapability, opts?: ComposeChildCapabilityOptions): NarrowedCapability;
//# sourceMappingURL=capability-guard.d.ts.map