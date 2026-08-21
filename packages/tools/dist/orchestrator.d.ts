import type { ApprovalResolver, EventSink, PermissionEngine, SessionId, ToolCallRequest, ToolExecutionContext, ToolResult } from "@ar/contracts";
import type { ToolRegistry } from "./registry.js";
export interface OrchestratorDeps {
    registry: ToolRegistry;
    permission?: PermissionEngine;
    approval?: ApprovalResolver;
    approvalExpiresMs?: number;
    workspaceRoot?: string;
    events?: EventSink;
    now?: () => number;
    /** P3-6: per-session extra sandbox roots (e.g. a child's isolated
     *  workspace). Returned roots are admitted as allowed filesystem roots for
     *  that session's tool calls, in addition to workspaceRoot. */
    sandboxExtraRoots?: (sessionId: SessionId) => readonly string[];
}
/**
 * ToolOrchestrator per AGENT_ARCHITECTURE_PLAN §14 (INV-001, INV-002).
 * The 12-step pipeline is mandatory — no step may be silently skipped:
 *
 *   resolve → validate → normalize → risk → permission → approval
 *   → sandbox → execute → timeout/output limits → evidence → events → normalize
 */
export declare class ToolOrchestrator {
    private readonly registry;
    private readonly permission;
    private readonly approval?;
    private readonly approvalExpiresMs;
    private readonly workspaceRoot?;
    private readonly events?;
    private readonly now;
    private readonly sandboxExtraRoots?;
    constructor(deps: OrchestratorDeps);
    execute(request: ToolCallRequest, context: ToolExecutionContext): Promise<ToolResult>;
    private classify;
    private effectivePolicy;
    private requestApproval;
    private evaluateSandbox;
    private emitSecurityDenial;
    private runBounded;
    private applyOutputLimit;
    private buildEvidence;
    private normalize;
    private preview;
    private fail;
    private failPermission;
    private failSandbox;
    private emit;
    private str;
}
//# sourceMappingURL=orchestrator.d.ts.map