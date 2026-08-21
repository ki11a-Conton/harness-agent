import type { ApprovalStore, AskUserStore, CheckpointStore, SessionStore } from "@ar/contracts";
/**
 * P12-3: `agent recover list` — startup recovery scan. Reports unfinished
 * sessions, pending approvals/asks, orphan child sessions and unfinished
 * checkpoints. NEVER executes side effects; recovery is the human's call.
 */
export interface RecoveryScan {
    unfinishedSessions: Array<{
        sessionId: string;
        status: string;
        updatedAt: number;
        parentId?: string;
    }>;
    pendingApprovals: Array<{
        approvalId: string;
        sessionId?: string;
        action: string;
        createdAt?: number;
    }>;
    pendingAsks: Array<{
        askId: string;
        sessionId: string;
        question: string;
        createdAt: number;
    }>;
    orphanChildren: Array<{
        sessionId: string;
        parentId: string;
    }>;
    unfinishedCheckpoints: number;
}
export declare function recoverListCmd(deps: {
    store: SessionStore;
    approvalStore?: ApprovalStore;
    askUserStore?: AskUserStore;
    checkpointStore?: CheckpointStore;
}): Promise<{
    exitCode: number;
    lines: string[];
    scan: RecoveryScan;
}>;
//# sourceMappingURL=recover-command.d.ts.map