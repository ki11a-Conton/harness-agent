import type { SessionId } from "@ar/contracts";
import type { ApplyPatchOptions, ApplyPatchResult, ChildWorkspaceHandle, ChildWorkspaceManager, WorkspacePatch } from "@ar/agents";
export interface DefaultChildWorkspaceManagerDeps {
    /** Scratch root for isolated copies (default system temp). */
    scratchRoot?: string;
    now?: () => number;
    /** Max bytes of a file admitted into a patch (default 256 KiB). */
    maxPatchBytes?: number;
}
export declare class DefaultChildWorkspaceManager implements ChildWorkspaceManager {
    private readonly scratchRoot;
    private readonly now;
    private readonly maxPatchBytes;
    constructor(deps?: DefaultChildWorkspaceManagerDeps);
    create(input: {
        parentRoot: string;
        childSessionId: SessionId;
        writable: boolean;
    }): Promise<ChildWorkspaceHandle>;
    apply(parentRoot: string, patch: WorkspacePatch, opts?: ApplyPatchOptions): Promise<ApplyPatchResult>;
    /** Copy the parent tree into the child root, skipping the ignored
     *  directories; records baseline hashes for diff/conflict detection.
     *  `parentRoot` anchors the global relative path of every copied file. */
    private copyTree;
    /** An isolated-copy handle: diffs against the baseline and cleans up. */
    private IsolatedCopyHandle;
}
/** Resolve a relative path inside root, rejecting any traversal. */
export declare function safeJoin(root: string, rel: string): string | undefined;
//# sourceMappingURL=workspace-manager.d.ts.map