/**
 * P29 — App Server Protocol v1 adapter.
 *
 * The App Server is a THIN wire adapter that sits on top of the existing
 * Gateway RPC surface. It does NOT reimplement the runtime: every mutating
 * wire method funnels into the same `RpcMethodRegistry` the internal clients
 * use, so the Runtime stays the single owner of session/turn state (P25).
 *
 * Wire responsibilities implemented here (from `@ar/protocol`):
 *   - P29-2  initialize handshake (NOT_INITIALIZED / ALREADY_INITIALIZED);
 *   - P29-4  thread↔session naming (Thread = Session per P29-3);
 *   - P29-7  bounded ingress (third concurrent request → SERVER_OVERLOADED,
 *            retryable — never unbounded memory);
 *   - P29-9  request idempotency for mutating methods.
 */
import type {
  AgentDefinition,
  ApprovalStore,
  EventStore,
  SessionId,
  Skill,
  ToolSpec,
} from "@ar/contracts";
import { AgentError, errorInfo } from "@ar/contracts";
import { ProtocolError, InitializeGate, BoundedQueue, IdempotencyTable, ProtocolEventMapper } from "@ar/protocol";
import type { AgentRuntime, LoadedSessionManager } from "@ar/core";
import type { SessionService } from "@ar/session";
import { createRuntimeRpc, type RpcMethodRegistry } from "./rpc.js";

export interface AppServerOptions {
  runtime: AgentRuntime;
  sessions: LoadedSessionManager;
  sessionService: SessionService;
  approvalStore: ApprovalStore;
  events: EventStore;
  listAgents?: () => AgentDefinition[];
  listTools?: () => ToolSpec[];
  listSkills?: () => Skill[];
  /** Bounded ingress concurrency (P29-7). Default 2. */
  ingressCapacity?: number;
  /** Server identity reported on initialize. */
  serverInfo?: { name: string; version: string };
}

export interface AppServerInvokeResult {
  result?: unknown;
  error?: {
    code: string;
    message: string;
    retryable: boolean;
    data?: unknown;
  };
}

/**
 * The App Server: an RPC boundary exposing the P29 wire protocol, backed by
 * the Gateway RPC registry. Handles handshake, backpressure, and idempotency;
 * delegates every method to the runtime registry.
 */
export class AppServer {
  readonly initialize: InitializeGate;
  private readonly ingress: BoundedQueue<unknown>;
  private readonly idempotency = new IdempotencyTable();
  private readonly rpc: RpcMethodRegistry;
  private readonly serverInfo: { name: string; version: string };
  private readonly listAgentsRef?: AppServerOptions["listAgents"];
  private readonly eventsRef: EventStore;
  private readonly mapper = new ProtocolEventMapper();

  constructor(opts: AppServerOptions) {
    const capacity = opts.ingressCapacity ?? 2;
    this.ingress = new BoundedQueue<unknown>({ capacity });
    this.serverInfo = opts.serverInfo ?? { name: "harness-app-server", version: "0.1.0" };
    this.initialize = new InitializeGate();
    this.listAgentsRef = opts.listAgents;
    this.eventsRef = opts.events;
    this.rpc = createRuntimeRpc(opts.runtime, {
      sessionService: opts.sessionService,
      sessions: opts.sessions,
      approvalStore: opts.approvalStore,
      events: opts.events,
      listAgents: opts.listAgents,
      listTools: opts.listTools,
      listSkills: opts.listSkills,
    });
  }

  /**
   * P29-1 method surface. Returns the result or a normalized error.
   * Mutating methods require initialize (P29-2).
   */
  async invoke(method: string, params: Record<string, unknown>): Promise<AppServerInvokeResult> {
    try {
      if (method === "initialize") {
        const clientInfo =
          typeof params.clientInfo === "object" && params.clientInfo !== null
            ? (params.clientInfo as { name: string; version: string })
            : { name: "unknown", version: "0" };
        const result = this.initialize.initialize(
          {
            clientInfo,
            capabilities:
              typeof params.capabilities === "object" && params.capabilities !== null
                ? (params.capabilities as { streamingItems?: boolean; approvalForms?: boolean })
                : undefined,
          },
          this.serverInfo,
        );
        return { result };
      }

      // Every other method requires the handshake.
      this.initialize.requireInitialized();

      // Idempotent keys replay the previous result instead of re-running.
      const explicitKey =
        typeof params.idempotencyKey === "string" ? params.idempotencyKey : undefined;
      if (explicitKey !== undefined) {
        const prior = this.idempotency.lookup(explicitKey);
        if (prior !== undefined) return { result: prior };
      }

      // `thread/read` is a PROTOCOL-level read (P29-8 replay): it must return
      // the DTO shape { threadId, items, nextSequence } the SDK depends on,
      // NOT the runtime status object. Handled BEFORE generic mapping so the
      // wire contract and the runtime RPC surface stay decoupled.
      if (method === "thread/read") {
        const result = await this.readThread(
          params as { threadId?: string; afterSequence?: number; limit?: number },
        );
        if (explicitKey !== undefined) this.idempotency.record(explicitKey, result);
        return { result };
      }

      const wireMethod = this.mapMethod(method);
      const adapted = this.adaptParams(method, params);
      const result = await this.ingress.submit(() => this.rpc.invoke(wireMethod, adapted));
      if (explicitKey !== undefined) this.idempotency.record(explicitKey, result);
      return { result };
    } catch (err) {
      if (err instanceof ProtocolError) {
        return { error: { ...err.info } };
      }
      // Runtime throws typed AgentError (SESSION_BUSY, NOT_FOUND, …). A client
      // MUST be able to tell a busy/not-found apart from an internal fault, so
      // carry the canonical code/retryable through the wire instead of burying
      // it under INTERNAL_ERROR (P34-5 structured-error conformance).
      if (err instanceof AgentError) {
        return { error: { ...err.info } };
      }
      const message = err instanceof Error ? err.message : String(err);
      return {
        error: {
          code: "INTERNAL_ERROR",
          message,
          retryable: false,
        },
      };
    }
  }

  /** P29-4 — wire method names (thread/turn) → internal RPC names. */
  private mapMethod(method: string): string {
    switch (method) {
      case "thread/start":
      case "thread/resume":
      case "thread/fork":
        return "session.create";
      // `thread/read` is handled at the protocol layer (readThread) — it does
      // NOT route to the runtime status RPC (removed in P34-6).
      case "thread/list":
        return "agent.list";
      case "thread/loaded/list":
        return "agent.list";
      case "turn/start":
        return "session.send";
      case "turn/run":
        return "session.run";
      case "turn/interrupt":
        return "session.interrupt";
      case "turn/cancel":
        return "session.cancel";
      case "turn/steer":
        return "session.steer";
      case "approval/respond":
        return "session.approve";
      case "ask/respond":
        return "session.followup";
      case "agent/list":
        return "agent.list";
      case "tool/list":
        return "tool.list";
      case "skill/list":
        return "skill.list";
      case "trace/read":
        return "trace.get";
      default:
        throw new Error(`unknown method: ${method}`);
    }
  }

  /** P29-3 — map wire-level external naming to internal RPC param shapes. */
  private adaptParams(method: string, params: Record<string, unknown>): Record<string, unknown> {
    const threadId = typeof params.threadId === "string" ? params.threadId : undefined;
    switch (method) {
      case "thread/start":
      case "thread/fork": {
        // The wire speaks in agent NAMES; the runtime speaks agent IDs.
        const agentName = typeof params.agentName === "string" ? params.agentName : undefined;
        const resolved = agentName !== undefined ? this.agentIdForName(agentName) : undefined;
        return {
          agentId: resolved ?? params.agentName,
          cwd: typeof params.cwd === "string" ? params.cwd : ".",
        };
      }
      case "turn/start": {
        // wire "threadId" ↔ runtime "sessionId"; wire "prompt" ↔ runtime "text"
        return {
          sessionId: threadId,
          text: typeof params.prompt === "string" ? params.prompt : undefined,
        };
      }
      case "turn/run":
      case "turn/cancel":
        return {
          sessionId: threadId,
          turnId: params.turnId,
        };
      case "turn/interrupt":
        return { sessionId: threadId };
      case "turn/steer":
        return {
          sessionId: threadId,
          text: typeof params.text === "string" ? params.text : undefined,
        };
      case "thread/read":
        return {
          sessionId: threadId,
          ...(params.afterSequence !== undefined ? { afterSequence: params.afterSequence } : {}),
          ...(params.limit !== undefined ? { limit: params.limit } : {}),
        };
      default:
        return params;
    }
  }

  /** P29-8 — protocol read of a thread's visible items. Replays the event
   *  store through ProtocolEventMapper into the DTO shape the SDK consumes:
   *  { threadId, items, nextSequence }. */
  private async readThread(params: {
    threadId?: string;
    afterSequence?: number;
    limit?: number;
  }): Promise<unknown> {
    const threadId = typeof params.threadId === "string" ? params.threadId : undefined;
    if (threadId === undefined || threadId.length === 0) {
      throw new AgentError(errorInfo("INTERNAL_ERROR", "threadId is required"));
    }
    const events = await this.eventsRef.list(threadId as never, {
      ...(params.afterSequence !== undefined ? { afterSequence: params.afterSequence } : {}),
    });
    let items = events
      .map((e) => this.mapper.mapSafe(e, threadId))
      .filter((e): e is NonNullable<typeof e> => e !== null && e.type === "item/completed" && e.item !== undefined)
      .map((e) => (e as { item: import("@ar/protocol").ThreadItem }).item);
    if (params.limit !== undefined) items = items.slice(0, params.limit);
    const nextSequence =
      items.length > 0 ? (items[items.length - 1]!.sequence as number) + 1 : 0;
    return {
      threadId,
      items,
      nextSequence,
    };
  }

  private agentIdForName(name: string): string | undefined {
    const agents = this.listAgentsRef?.() ?? [];
    for (const agent of agents) {
      if (agent.name === name || agent.id === name) return agent.id;
    }
    return undefined;
  }
}

export type { RpcMethodRegistry, SessionId };
export type AppResult = AppServerInvokeResult;