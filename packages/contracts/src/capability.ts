/**
 * P2-45 — Capability Escalation Defense.
 *
 * A child agent, plugin, MCP server, or hook must never be able to enlarge its
 * own effective capability — tool allowlist, filesystem root, network access,
 * or process policy — through text or config that it itself supplies. The only
 * way capability changes legally is DOWNWARD: the conferring parent/host grants
 * an upper bound, and a subordinate may at most NARROW it (intersection), never
 * widen it. Widening is an escalation attempt and is rejected fail-closed.
 *
 * This module is the pure boundary: it computes the effective (intersected)
 * capability from an upper bound (`conferred`) and what the subordinate claims
 * for itself (`declared`), and reports every dimension that tried to exceed the
 * bound. It performs no I/O, no policy lookup, and no privileged trust decision
 * — so a host or security layer can apply identical logic to every trust
 * boundary (child / plugin / MCP / hook) and rely on it deterministically.
 *
 * Escalations are only override-able by an explicit user/host approval; nothing
 * in this module ever widens on its own.
 */
export type CapabilityDimension = "tool" | "filesystem" | "network" | "process";

export const CAPABILITY_DIMENSIONS = [
  "tool",
  "filesystem",
  "network",
  "process",
] as const satisfies readonly CapabilityDimension[];

/** The 4 effective-capability surfaces named by the plan. */
export type CapabilitySets = Record<CapabilityDimension, readonly string[]>;

export const EMPTY_CAPABILITY_SETS: CapabilitySets = {
  tool: [],
  filesystem: [],
  network: [],
  process: [],
};

/** What a subordinate claims for itself; absent dimension ⇒ inherit conferred. */
export type DeclaredCapability = Partial<Record<CapabilityDimension, readonly string[]>>;

export type ViolationKind =
  | "tool_escalation"
  | "filesystem_escalation"
  | "network_escalation"
  | "process_escalation";

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

const VIOLATION_KIND_BY_DIMENSION: Record<CapabilityDimension, ViolationKind> = {
  tool: "tool_escalation",
  filesystem: "filesystem_escalation",
  network: "network_escalation",
  process: "process_escalation",
};

function containsItem(dim: CapabilityDimension, bound: readonly string[], needle: string): boolean {
  if (bound.includes("*")) return true; // upper bound is "full" for this dimension
  if (dim === "filesystem") {
    // A declared path narrows a conferred root iff it is equal to it or lives
    // strictly inside it (boundary-aware: `/home/u/work/docs` ⊂ `/home/u/work`,
    // but `/home/u/workx` is NOT — a sibling with a shared prefix is out of scope).
    return bound.some((root) => {
      if (needle === root) return true;
      return needle.startsWith(root.endsWith("/") ? root : root + "/");
    });
  }
  return bound.includes(needle);
}

function withinBound(dim: CapabilityDimension, bound: readonly string[], items: readonly string[]): boolean {
  return items.every((item) => containsItem(dim, bound, item));
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
 * The returned `allowed` is false iff there is at least one violation; the
 * caller MUST fail closed and grant only `effective`.
 */
export function composeCapabilities(
  conferred: CapabilitySets,
  declared: DeclaredCapability,
): CapabilityVerdict {
  const effective: CapabilitySets = {
    tool: [...conferred.tool],
    filesystem: [...conferred.filesystem],
    network: [...conferred.network],
    process: [...conferred.process],
  };
  const violations: CapabilityViolation[] = [];
  const narrowed: CapabilityDimension[] = [];

  for (const dim of CAPABILITY_DIMENSIONS) {
    const declaredItems = declared[dim];
    if (declaredItems === undefined) continue; // inherit the conferred bound unchanged
    narrowed.push(dim);
    if (!withinBound(dim, conferred[dim], declaredItems)) {
      violations.push({
        kind: VIOLATION_KIND_BY_DIMENSION[dim],
        declared: [...declaredItems],
        conferred: [...conferred[dim]],
      });
    }
    effective[dim] = declaredItems.filter((item) => containsItem(dim, conferred[dim], item));
  }

  return { allowed: violations.length === 0, effective, violations, narrowed };
}