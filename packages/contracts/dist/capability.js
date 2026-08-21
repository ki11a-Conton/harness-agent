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
 * Filesystem semantics (P14-1): containment is decided by the shared pure
 * primitive {@link isPathWithin} — boundary-aware and case-policy-aware — on
 * inputs that the CALLER has already canonicalised (separator-normalised,
 * absolute, realpath/lexically-resolved).  A textual prefix like
 * `/work/../etc` or `C:\work\..\Windows` is NOT "inside `/work`" once
 * canonicalised; a sibling like `/home/u/workx` is never inside `/home/u/work`.
 * The capability guard and SandboxManager therefore share one containment
 * semantic instead of one doing string compares and the other doing realpath.
 *
 * Escalations are only override-able by an explicit user/host approval; nothing
 * in this module ever widens on its own.
 */
import { isPathWithin } from "./path-containment.js";
export const CAPABILITY_DIMENSIONS = [
    "tool",
    "filesystem",
    "network",
    "process",
];
export const EMPTY_CAPABILITY_SETS = {
    tool: [],
    filesystem: [],
    network: [],
    process: [],
};
const VIOLATION_KIND_BY_DIMENSION = {
    tool: "tool_escalation",
    filesystem: "filesystem_escalation",
    network: "network_escalation",
    process: "process_escalation",
};
function containsItem(dim, bound, needle, caseInsensitive) {
    if (bound.includes("*"))
        return true; // upper bound is "full" for this dimension
    if (dim === "filesystem") {
        // P14-1: shared pure boundary-aware containment on canonical inputs.
        // `needle` and `root` must already be canonicalised by the caller (the
        // capability guard resolves realpath; the pure module resolves `.`/`..`).
        // A sibling (`/home/u/workx` vs `/home/u/work`) is never inside; a
        // traversal (`/work/../etc` after resolution → `/etc`) is never inside.
        return bound.some((root) => {
            if (root === "*")
                return true;
            return isPathWithin(needle, root, caseInsensitive);
        });
    }
    return bound.includes(needle);
}
function withinBound(dim, bound, items, caseInsensitive) {
    return items.every((item) => containsItem(dim, bound, item, caseInsensitive));
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
export function composeCapabilities(conferred, declared, opts) {
    const caseInsensitive = opts?.caseInsensitive === true;
    const effective = {
        tool: [...conferred.tool],
        filesystem: [...conferred.filesystem],
        network: [...conferred.network],
        process: [...conferred.process],
    };
    const violations = [];
    const narrowed = [];
    for (const dim of CAPABILITY_DIMENSIONS) {
        const declaredItems = declared[dim];
        if (declaredItems === undefined)
            continue; // inherit the conferred bound unchanged
        narrowed.push(dim);
        if (!withinBound(dim, conferred[dim], declaredItems, caseInsensitive)) {
            violations.push({
                kind: VIOLATION_KIND_BY_DIMENSION[dim],
                declared: [...declaredItems],
                conferred: [...conferred[dim]],
            });
        }
        effective[dim] = declaredItems.filter((item) => containsItem(dim, conferred[dim], item, caseInsensitive));
    }
    return { allowed: violations.length === 0, effective, violations, narrowed };
}
//# sourceMappingURL=capability.js.map