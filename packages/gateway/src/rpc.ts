import type {
  AgentDefinition,
  AgentEvent,
  AgentId,
  ApprovalId,
  ApprovalStore,
  ErrorCode,
  EventStore,
  SessionId,
  Skill,
  ToolSpec,
  TurnId,
} from "@ar/contracts";
import { AgentError, errorInfo } from "@ar/contracts";
import type { AgentRuntime, TurnOutcome } from "@ar/core";
import type { SessionService } from "@ar/session";

/** Caller-supplied context attached to a single invoke (transport agnostic). */
export interface RpcContext {
  /** Caller abort signal; wired into long-running methods (plan §156). */
  signal?: AbortSignal;
}

export type RpcHandler = (
  params: Record<string, unknown>,
  ctx: RpcContext,
) => Promise<unknown>;

/** JSON-RPC 2.0 error code for "method not found", carried in the error cause. */
const JSONRPC_METHOD_NOT_FOUND = -32601;

/** Transport-agnostic JSON-RPC-style method registry (plan §84). */
export class RpcMethodRegistry {
  private readonly handlers = new Map<string, RpcHandler>();

  register(name: string, handler: RpcHandler): this {
    if (this.handlers.has(name)) {
      throw new Error(`rpc method already registered: ${name}`);
    }
    this.handlers.set(name, handler);
    return this;
  }

  has(name: string): boolean {
    return this.handlers.has(name);
  }

  listMethods(): string[] {
    return [...this.handlers.keys()];
  }

  async invoke(
    name: string,
    params?: Record<string, unknown>,
    ctx?: RpcContext,
  ): Promise<unknown> {
    const handler = this.handlers.get(name);
    if (handler === undefined) {
      throw new AgentError(
        errorInfo("INTERNAL_ERROR", `unknown rpc method: ${name}`, {
          cause: { jsonrpcCode: JSONRPC_METHOD_NOT_FOUND },
        }),
      );
    }
    try {
      return await handler(params ?? {}, ctx ?? {});
    } catch (err) {
      throw toRpcError(err);
    }
  }
}

/**
 * Normalize any thrown value into a structured AgentError. The structured
 * surface (info) carries code + message only — never a stack trace.
 */
export function toRpcError(err: unknown): AgentError {
  if (err instanceof AgentError) return err;
  const message = err instanceof Error ? err.message : String(err);
  return new AgentError(errorInfo("INTERNAL_ERROR", message));
}

/** Serializable error body for transports: { code, message } — no stack. */
export function rpcErrorBody(err: unknown): { code: ErrorCode; message: string } {
  const info = err instanceof AgentError ? err.info : errorInfo("INTERNAL_ERROR", String(err));
  return { code: info.code, message: info.message };
}

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

interface ActiveRun {
  controller: AbortController;
  promise: Promise<TurnOutcome>;
}

function requireParam(name: string, value: unknown): string {
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
export function createRuntimeRpc(
  runtime: AgentRuntime,
  deps: RuntimeRpcDeps,
): RpcMethodRegistry {
  /** In-flight turns keyed by `${sessionId}:${turnId}` for session.cancel. */
  const activeRuns = new Map<string, ActiveRun>();

  const key = (sessionId: SessionId, turnId: TurnId) => `${sessionId}:${turnId}`;

  return new RpcMethodRegistry()
    .register("session.create", async (params) => {
      const { agentId, cwd } = params as { agentId: AgentId; cwd: string };
      const agentIdValue = requireParam("agentId", agentId) as AgentId;
      const agent = runtime.getAgent(agentIdValue);
      if (agent === undefined) {
        throw new AgentError(errorInfo("INTERNAL_ERROR", `unknown agent: ${agentIdValue}`));
      }
      return runtime.createSession({ agent, cwd: requireParam("cwd", cwd) });
    })
    .register("session.send", async (params) => {
      const { sessionId, text } = params as { sessionId: SessionId; text: string };
      const turn = await runtime.startTurn(
        requireParam("sessionId", sessionId) as SessionId,
        requireParam("text", text),
      );
      return { turnId: turn.id };
    })
    .register("session.run", async (params, ctx) => {
      const { sessionId, turnId } = params as { sessionId: SessionId; turnId: TurnId };
      const session = requireParam("sessionId", sessionId) as SessionId;
      const turn = requireParam("turnId", turnId) as TurnId;
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
        } else {
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
      const { sessionId, turnId } = params as { sessionId: SessionId; turnId: TurnId };
      const session = requireParam("sessionId", sessionId) as SessionId;
      const turn = requireParam("turnId", turnId) as TurnId;
      const run = activeRuns.get(key(session, turn));
      if (run === undefined) {
        return { sessionId: session, turnId: turn, status: "not_running" as const };
      }
      run.controller.abort();
      const outcome = await run.promise;
      return { sessionId: session, turnId: turn, status: outcome.status };
    })
    .register("session.resume", async (params) => {
      const { sessionId } = params as { sessionId: SessionId };
      return deps.sessionService.resume(requireParam("sessionId", sessionId) as SessionId);
    })
    .register("session.approve", async (params) => {
      const { approvalId, value, decidedBy } = params as {
        approvalId: ApprovalId;
        value: "allow" | "deny";
        decidedBy?: string;
      };
      const id = requireParam("approvalId", approvalId) as ApprovalId;
      if (value !== "allow" && value !== "deny") {
        throw new AgentError(errorInfo("INTERNAL_ERROR", "session.approve value must be allow or deny"));
      }
      try {
        return deps.approvalStore.resolve(
          id,
          value,
          decidedBy === undefined ? undefined : requireParam("decidedBy", decidedBy),
        );
      } catch (err) {
        throw toRpcError(err);
      }
    })
    .register("session.subscribe", async (params) => {
      const { sessionId, afterSequence } = params as {
        sessionId: SessionId;
        afterSequence?: number;
      };
      const session = requireParam("sessionId", sessionId) as SessionId;
      const events: AgentEvent[] = await deps.events.list(session, {
        ...(afterSequence !== undefined ? { afterSequence } : {}),
      });
      return events;
    })
    .register("agent.list", async () => {
      if (deps.listAgents === undefined) {
        throw new AgentError(
          errorInfo("INTERNAL_ERROR", "agent.list is not configured (host did not wire listAgents)"),
        );
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
        throw new AgentError(
          errorInfo("INTERNAL_ERROR", "tool.list is not configured (host did not wire listTools)"),
        );
      }
      return deps.listTools();
    })
    .register("skill.list", async () => {
      if (deps.listSkills === undefined) {
        throw new AgentError(
          errorInfo("INTERNAL_ERROR", "skill.list is not configured (host did not wire listSkills)"),
        );
      }
      return deps.listSkills();
    })
    .register("trace.get", async (params) => {
      const { sessionId } = params as { sessionId: SessionId };
      return deps.events.list(requireParam("sessionId", sessionId) as SessionId);
    });
}
