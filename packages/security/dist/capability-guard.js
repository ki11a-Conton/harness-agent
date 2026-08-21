import { composeCapabilities } from "@ar/contracts";
import { canonicalizePath } from "./canonical-path.js";
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
export class CapabilityEscalationError extends Error {
    violations;
    constructor(violations) {
        super(`capability escalation denied: ${violations.map((v) => v.kind).join(", ")}`);
        this.name = "CapabilityEscalationError";
        this.violations = violations;
    }
}
/** Project a granted SandboxPolicy + tool allowlist into capability sets. */
export function capabilitySetsFromGrant(grant) {
    return {
        tool: [...grant.toolAllowlist],
        filesystem: grant.policy.filesystem.mode === "full"
            ? ["*"]
            : [...(grant.policy.filesystem.allowedPaths ?? [])],
        network: grant.policy.network.mode === "full"
            ? ["*"]
            : [...(grant.policy.network.hosts ?? [])],
        process: [...(grant.policy.process.allowedCommands ?? [])],
    };
}
/** Canonicalise every filesystem entry in a capability set (`*` passes
 *  through unchanged).  Shares the sandbox's exact canonicalisation. */
function canonicalizeFilesystem(items, cwd) {
    return items.map((p) => (p === "*" ? p : canonicalizePath(p, { cwd })));
}
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
export function composeChildCapability(grant, declared, opts) {
    const cwd = opts?.cwd ?? process.cwd();
    const conferred = capabilitySetsFromGrant(grant);
    const caseInsensitive = grant.policy.filesystem.caseInsensitive === true;
    const conferredCanonical = {
        ...conferred,
        filesystem: canonicalizeFilesystem(conferred.filesystem, cwd),
    };
    const declaredCanonical = {
        ...declared,
        ...(declared.filesystem !== undefined
            ? { filesystem: canonicalizeFilesystem(declared.filesystem, cwd) }
            : {}),
    };
    const verdict = composeCapabilities(conferredCanonical, declaredCanonical, {
        caseInsensitive,
    });
    if (!verdict.allowed) {
        throw new CapabilityEscalationError(verdict.violations);
    }
    return {
        policy: {
            filesystem: {
                mode: verdict.effective.filesystem.includes("*") ? "full" : "workspace-write",
                ...(verdict.effective.filesystem.includes("*")
                    ? {}
                    : { allowedPaths: [...verdict.effective.filesystem] }),
                ...(grant.policy.filesystem.caseInsensitive !== undefined
                    ? { caseInsensitive: grant.policy.filesystem.caseInsensitive }
                    : {}),
            },
            network: {
                mode: verdict.effective.network.includes("*") ? "full" : "allowlist",
                ...(verdict.effective.network.includes("*")
                    ? {}
                    : { hosts: [...verdict.effective.network] }),
            },
            process: {
                ...grant.policy.process,
                allowedCommands: [...verdict.effective.process],
            },
        },
        toolAllowlist: [...verdict.effective.tool],
        narrowed: [...verdict.narrowed],
    };
}
//# sourceMappingURL=capability-guard.js.map