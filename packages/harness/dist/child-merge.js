// P3-5: parent merge becomes a PHYSICAL merge — the child's workspace patch
// is applied to the parent root under conflict detection, and the metadata
// merge (mergeChildCompletion) is reconciled with the physical result so
// both stay consistent: applied paths land in filesChanged/artifactRefs,
// physical conflicts surface in the report, and skipped entries are recorded
// (never silently dropped).
import { mergeChildCompletion } from "@ar/agents";
/** Apply a child's completion to the parent: physical patch first, metadata
 *  merge second, then reconciliation (conflicts/skips surfaced in both).
 *  A failed/cancelled child without a patch is a metadata-only merge. */
export async function applyChildResult(parentRoot, parent, result, manager) {
    const empty = { applied: [], conflicts: [], skipped: [] };
    const physical = result.workspacePatch !== undefined && result.workspacePatch.entries.length > 0
        ? await manager.apply(parentRoot, result.workspacePatch)
        : empty;
    const metadata = mergeChildCompletion(parent, result);
    // Reconciliation: the physical result is authoritative for the workspace.
    for (const conflict of physical.conflicts) {
        if (!metadata.conflicts.some((c) => c.path === conflict.path)) {
            metadata.conflicts.push({ path: conflict.path, detail: conflict.detail });
        }
    }
    for (const path of physical.applied) {
        if (!parent.filesChanged.includes(path))
            parent.filesChanged.push(path);
        if (!parent.artifactRefs.includes(path))
            parent.artifactRefs.push(path);
        if (!metadata.mergedPaths.includes(path))
            metadata.mergedPaths.push(path);
    }
    for (const skipped of physical.skipped) {
        metadata.skipped.push({
            reason: "stale",
            detail: `${skipped.path}: ${skipped.detail}`,
        });
    }
    return { physical, metadata };
}
//# sourceMappingURL=child-merge.js.map