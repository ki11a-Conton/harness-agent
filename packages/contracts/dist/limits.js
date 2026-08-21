export const DEFAULT_DELEGATION_LIMITS = {
    maxDepth: 2,
    maxChildren: 3,
    maxConcurrent: 3,
    timeoutMs: 10 * 60 * 1000,
};
/** P3-3: resolve the child-count caps from delegation limits. `total` always
 *  has a concrete value (maxChildrenTotal, else the deprecated maxChildren
 *  alias, else 0 = no cap); `active` is undefined when no active cap was set.
 */
export function resolveChildLimits(limits) {
    const total = limits.maxChildrenTotal ?? limits.maxChildren;
    return { total: total ?? 0, active: limits.maxActiveChildren };
}
/** Default share of the tree tool budget held back for the root agent (its
 *  own execution, completion and verification gate). */
export const TREE_BUDGET_HEADROOM_RATIO = 0.2;
export const DEFAULT_SCHEDULER_LIMITS = {
    maxGlobalAgents: 8,
    maxAgentsPerRoot: 4,
    maxDepth: 3,
    maxDurationMs: 10 * 60 * 1000,
};
//# sourceMappingURL=limits.js.map