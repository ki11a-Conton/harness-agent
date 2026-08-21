import type { WorkingState } from "@ar/contracts";
import type { ApplyPatchResult, ChildWorkspaceManager, DelegationResult, MergeReport } from "@ar/agents";
export interface ChildMergeResult {
    /** Physical filesystem merge outcome. */
    physical: ApplyPatchResult;
    /** Metadata merge report, reconciled with the physical outcome. */
    metadata: MergeReport;
}
/** Apply a child's completion to the parent: physical patch first, metadata
 *  merge second, then reconciliation (conflicts/skips surfaced in both).
 *  A failed/cancelled child without a patch is a metadata-only merge. */
export declare function applyChildResult(parentRoot: string, parent: WorkingState, result: DelegationResult, manager: ChildWorkspaceManager): Promise<ChildMergeResult>;
//# sourceMappingURL=child-merge.d.ts.map