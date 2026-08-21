import { NEVER_COMPACT_SOURCES } from "@ar/contracts";
function isNeverEvict(block) {
    return block.trust === "trusted" || NEVER_COMPACT_SOURCES.has(block.source);
}
function reserveSum(budget) {
    return budget.reserved.system + budget.reserved.task + budget.reserved.output;
}
/**
 * Deterministic budget planner (CTX-002).
 *
 * Admission rules, in order:
 * 1. Never-evict blocks (source "system"/"user" via NEVER_COMPACT_SOURCES, or
 *    trust === "trusted") are always selected, first, in input order. They are
 *    never evicted for exceeding the budget — evicting them would be a security
 *    policy violation, so the ceiling yields to them (see overflow below).
 * 2. Ordinary blocks are stable-sorted by priority descending (ties keep input
 *    order) and admitted while the running total fits the spendable headroom.
 * 3. `budget.dynamic` is ignored: the spendable headroom is computed as
 *    maxTokens - (reserved.system + reserved.task + reserved.output). The
 *    reserved amounts are held back and never consumed by the planner.
 *
 * Overflow semantics: if the never-evict blocks alone exceed maxTokens, they
 * are still all kept and `report.used` truthfully reports a value above
 * maxTokens (hence `report.available` goes negative). No ordinary block is
 * admitted in that case; compaction (CTX-003) or the caller must resolve the
 * overflow. This is the direct consequence of "no security policy eviction".
 */
export class BudgetPlannerImpl {
    plan(blocks, budget) {
        const spendable = Math.max(0, budget.maxTokens - reserveSum(budget));
        const neverEvict = [];
        const ordinary = [];
        for (const block of blocks) {
            (isNeverEvict(block) ? neverEvict : ordinary).push(block);
        }
        const selected = [...neverEvict];
        let used = selected.reduce((sum, b) => sum + b.tokens, 0);
        const ranked = ordinary
            .map((block, index) => ({ block, index }))
            .sort((a, b) => b.block.priority - a.block.priority || a.index - b.index);
        const dropped = [];
        for (const { block } of ranked) {
            if (used + block.tokens > spendable) {
                dropped.push(block);
                continue;
            }
            selected.push(block);
            used += block.tokens;
        }
        return {
            selected,
            dropped,
            report: {
                used,
                available: budget.maxTokens - used,
                dropped: dropped.length,
                compressed: 0,
            },
        };
    }
}
//# sourceMappingURL=budget.js.map