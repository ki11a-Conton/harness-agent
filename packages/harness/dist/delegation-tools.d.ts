import type { ToolDefinition } from "@ar/contracts";
import type { DelegationResult, Delegator, ParallelDelegator } from "@ar/agents";
export interface DelegationToolDeps {
    /** Lazy accessors: the delegator is constructed AFTER the runtime (which
     *  needs the full registry specs), so the tools resolve it at execute time.
     *  Throws when delegation is not wired (never silently no-ops). */
    delegator: () => Delegator;
    parallelDelegator: () => ParallelDelegator;
    /** Read-only tool names every child is restricted to (P3-1 hard policy). */
    readonlyToolNames: readonly string[];
    /** Cap on one batch (plan.md P3-7: max tasks). */
    maxBatchSize?: number;
    /** P3-6: write-capable worker agent id (resolved lazily). Present only
     *  when the harness exposes delegate_worker. */
    workerAgentId?: () => string;
    /** P3-6: workspace manager used to apply the worker's isolated patch
     *  (P3-5 physical merge). Required for delegate_worker. */
    workspaceManager?: () => import("@ar/agents").ChildWorkspaceManager;
}
/** P3-8: render a child completion for the parent model — structured,
 *  semi-trusted data (the pipeline labels tool output as semi-trusted; the
 *  model must never treat it as authoritative). */
export declare function renderDelegationResult(result: DelegationResult): string;
/** P3-1/P3-7: the production delegation tools. */
export declare function createDelegationTools(deps: DelegationToolDeps): ToolDefinition[];
//# sourceMappingURL=delegation-tools.d.ts.map