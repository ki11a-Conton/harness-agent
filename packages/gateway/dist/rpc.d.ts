import type { AgentDefinition, AgentId, ApprovalStore, ErrorCode, EventStore, Skill, ToolSpec } from "@ar/contracts";
import { AgentError } from "@ar/contracts";
import type { AgentRuntime, TurnOutcome } from "@ar/core";
import type { SessionService } from "@ar/session";
/** Caller-supplied context attached to a single invoke (transport agnostic). */
export interface RpcContext {
    /** Caller abort signal; wired into long-running methods (plan §156). */
    signal?: AbortSignal;
}
export type RpcHandler = (params: Record<string, unknown>, ctx: RpcContext) => Promise<unknown>;
/** Transport-agnostic JSON-RPC-style method registry (plan §84). */
export declare class RpcMethodRegistry {
    private readonly handlers;
    register(name: string, handler: RpcHandler): this;
    has(name: string): boolean;
    listMethods(): string[];
    invoke(name: string, params?: Record<string, unknown>, ctx?: RpcContext): Promise<unknown>;
}
/**
 * Normalize any thrown value into a structured AgentError. The structured
 * surface (info) carries code + message only — never a stack trace.
 */
export declare function toRpcError(err: unknown): AgentError;
/** Serializable error body for transports: { code, message } — no stack. */
export declare function rpcErrorBody(err: unknown): {
    code: ErrorCode;
    message: string;
};
/** Safe projection of an agent exposed over the wire (plan §161). */
export interface AgentSummary {
    id: AgentId;
    name: string;
    description: string;
    mode: AgentDefinition["mode"];
}
export type ActiveTurnStatus = TurnOutcome["status"] | "not_running";
export interface RuntimeRpcDeps {
    sessionService: SessionService;
    /** §161 approval binding: one-shot, session-scoped decisions. */
    approvalStore: ApprovalStore;
    events: EventStore;
    /** Host-wired agent listing; absent provider makes `agent.list` an error. */
    listAgents?: () => AgentDefinition[];
    /** Host-wired tool listing; absent provider makes `tool.list` an error. */
    listTools?: () => ToolSpec[];
    /** Host-wired skill listing; absent provider makes `skill.list` an error. */
    listSkills?: () => Skill[];
}
/**
 * Bind the §84 method surface to an AgentRuntime. All side effects stay in
 * the runtime (which routes through ToolOrchestrator / PermissionEngine /
 * SandboxManager); this layer only adapts calls and normalizes errors.
 */
export declare function createRuntimeRpc(runtime: AgentRuntime, deps: RuntimeRpcDeps): RpcMethodRegistry;
//# sourceMappingURL=rpc.d.ts.map