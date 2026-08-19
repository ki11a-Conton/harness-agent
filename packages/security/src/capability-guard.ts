import type {
  CapabilitySets,
  CapabilityViolation,
  DeclaredCapability,
  SandboxPolicy,
} from "@ar/contracts";
import { composeCapabilities } from "@ar/contracts";

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
 * Escalations are never auto-granted here; only an explicit host/user approval
 * upstream may raise `grant.policy`, and that raise is recomputed against the
 * new bound on the next compose.
 */
export class CapabilityEscalationError extends Error {
  readonly violations: readonly CapabilityViolation[];
  constructor(violations: readonly CapabilityViolation[]) {
    super(
      `capability escalation denied: ${violations.map((v) => v.kind).join(", ")}`,
    );
    this.name = "CapabilityEscalationError";
    this.violations = violations;
  }
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

/** Project a granted SandboxPolicy + tool allowlist into capability sets. */
export function capabilitySetsFromGrant(grant: GrantedCapability): CapabilitySets {
  return {
    tool: [...grant.toolAllowlist],
    filesystem:
      grant.policy.filesystem.mode === "full"
        ? ["*"]
        : [...(grant.policy.filesystem.allowedPaths ?? [])],
    network:
      grant.policy.network.mode === "full"
        ? ["*"]
        : [...(grant.policy.network.hosts ?? [])],
    process: [...(grant.policy.process.allowedCommands ?? [])],
  };
}

/**
 * Verify a subordinate's declared capability only narrows the granted bound.
 * Returns a narrowed SandboxPolicy + tool allowlist on success; throws
 * `CapabilityEscalationError` (fail closed) on any escalation.
 */
export function composeChildCapability(
  grant: GrantedCapability,
  declared: DeclaredCapability,
): NarrowedCapability {
  const conferred = capabilitySetsFromGrant(grant);
  const verdict = composeCapabilities(conferred, declared);
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