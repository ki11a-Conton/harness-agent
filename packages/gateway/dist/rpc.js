import { AgentError, errorInfo } from "@ar/contracts";
/** JSON-RPC 2.0 error code for "method not found", carried in the error cause. */
const JSONRPC_METHOD_NOT_FOUND = -32601;
/** Transport-agnostic JSON-RPC-style method registry (plan §84). */
export class RpcMethodRegistry {
    handlers = new Map();
    register(name, handler) {
        if (this.handlers.has(name)) {
            throw new Error(`rpc method already registered: ${name}`);
        }
        this.handlers.set(name, handler);
        return this;
    }
    has(name) {
        return this.handlers.has(name);
    }
    listMethods() {
        return [...this.handlers.keys()];
    }
    async invoke(name, params, ctx) {
        const handler = this.handlers.get(name);
        if (handler === undefined) {
            throw new AgentError(errorInfo("INTERNAL_ERROR", `unknown rpc method: ${name}`, {
                cause: { jsonrpcCode: JSONRPC_METHOD_NOT_FOUND },
            }));
        }
        try {
            return await handler(params ?? {}, ctx ?? {});
        }
        catch (err) {
            throw toRpcError(err);
        }
    }
}
/**
 * Normalize any thrown value into a structured AgentError. The structured
 * surface (info) carries code + message only — never a stack trace.
 */
export function toRpcError(err) {
    if (err instanceof AgentError)
        return err;
    const message = err instanceof Error ? err.message : String(err);
    return new AgentError(errorInfo("INTERNAL_ERROR", message));
}
/** Serializable error body for transports: { code, message } — no stack. */
export function rpcErrorBody(err) {
    const info = err instanceof AgentError ? err.info : errorInfo("INTERNAL_ERROR", String(err));
    return { code: info.code, message: info.message };
}
function requireParam(name, value) {
    if (typeof value !== "string" || value.length === 0) {
        throw new AgentError(errorInfo("INTERNAL_ERROR", `${name} is required`));
    }
    return value;
}
/**
 * Bind the §84 method surface to an AgentRuntime. All side effects stay in
 * the runtime (which routes through ToolOrchestrator / PermissionEngine /
 * SandboxManager); this layer only adapts calls and normalizes errors.
 */
export function createRuntimeRpc(runtime, deps) {
    /** In-flight turns keyed by `${sessionId}:${turnId}` for session.cancel. */
    const activeRuns = new Map();
    const key = (sessionId, turnId) => `${sessionId}:${turnId}`;
    return new RpcMethodRegistry()
        .register("session.create", async (params) => {
        const { agentId, cwd } = params;
        const agentIdValue = requireParam("agentId", agentId);
        const agent = runtime.getAgent(agentIdValue);
        if (agent === undefined) {
            throw new AgentError(errorInfo("INTERNAL_ERROR", `unknown agent: ${agentIdValue}`));
        }
        return runtime.createSession({ agent, cwd: requireParam("cwd", cwd) });
    })
        .register("session.send", async (params) => {
        const { sessionId, text } = params;
        const turn = await runtime.startTurn(requireParam("sessionId", sessionId), requireParam("text", text));
        return { turnId: turn.id };
    })
        .register("session.run", async (params, ctx) => {
        const { sessionId, turnId } = params;
        const session = requireParam("sessionId", sessionId);
        const turn = requireParam("turnId", turnId);
        const k = key(session, turn);
        if (activeRuns.has(k)) {
            throw new AgentError(errorInfo("INTERNAL_ERROR", `turn already running: ${turn}`));
        }
        const controller = new AbortController();
        const callerSignal = ctx.signal;
        if (callerSignal !== undefined) {
            const link = () => controller.abort();
            if (callerSignal.aborted) {
                controller.abort();
            }
            else {
                callerSignal.addEventListener("abort", link, { once: true });
            }
            const promise = runtime.runTurn(session, turn, controller.signal).finally(() => {
                activeRuns.delete(k);
                callerSignal.removeEventListener("abort", link);
            });
            activeRuns.set(k, { controller, promise });
            return promise;
        }
        const promise = runtime.runTurn(session, turn, controller.signal).finally(() => {
            activeRuns.delete(k);
        });
        activeRuns.set(k, { controller, promise });
        return promise;
    })
        .register("session.cancel", async (params) => {
        const { sessionId, turnId } = params;
        const session = requireParam("sessionId", sessionId);
        const turn = requireParam("turnId", turnId);
        const run = activeRuns.get(key(session, turn));
        if (run === undefined) {
            return { sessionId: session, turnId: turn, status: "not_running" };
        }
        run.controller.abort();
        const outcome = await run.promise;
        return { sessionId: session, turnId: turn, status: outcome.status };
    })
        .register("session.resume", async (params) => {
        const { sessionId } = params;
        return deps.sessionService.resume(requireParam("sessionId", sessionId));
    })
        .register("session.approve", async (params) => {
        const { approvalId, value, decidedBy } = params;
        const id = requireParam("approvalId", approvalId);
        if (value !== "allow" && value !== "deny") {
            throw new AgentError(errorInfo("INTERNAL_ERROR", "session.approve value must be allow or deny"));
        }
        try {
            return deps.approvalStore.resolve(id, value, decidedBy === undefined ? undefined : requireParam("decidedBy", decidedBy));
        }
        catch (err) {
            throw toRpcError(err);
        }
    })
        .register("session.subscribe", async (params) => {
        const { sessionId, afterSequence } = params;
        const session = requireParam("sessionId", sessionId);
        const events = await deps.events.list(session, {
            ...(afterSequence !== undefined ? { afterSequence } : {}),
        });
        return events;
    })
        .register("agent.list", async () => {
        if (deps.listAgents === undefined) {
            throw new AgentError(errorInfo("INTERNAL_ERROR", "agent.list is not configured (host did not wire listAgents)"));
        }
        return deps.listAgents().map((a) => ({
            id: a.id,
            name: a.name,
            description: a.description,
            mode: a.mode,
        }));
    })
        .register("tool.list", async () => {
        if (deps.listTools === undefined) {
            throw new AgentError(errorInfo("INTERNAL_ERROR", "tool.list is not configured (host did not wire listTools)"));
        }
        return deps.listTools();
    })
        .register("skill.list", async () => {
        if (deps.listSkills === undefined) {
            throw new AgentError(errorInfo("INTERNAL_ERROR", "skill.list is not configured (host did not wire listSkills)"));
        }
        return deps.listSkills();
    })
        .register("trace.get", async (params) => {
        const { sessionId } = params;
        return deps.events.list(requireParam("sessionId", sessionId));
    });
}
//# sourceMappingURL=rpc.js.map