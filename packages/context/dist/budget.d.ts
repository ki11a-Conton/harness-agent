import type { BudgetPlan, BudgetPlanner, ContextBlock, ContextBudget } from "@ar/contracts";
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
export declare class BudgetPlannerImpl implements BudgetPlanner {
    plan(blocks: ContextBlock[], budget: ContextBudget): BudgetPlan;
}
//# sourceMappingURL=budget.d.ts.map