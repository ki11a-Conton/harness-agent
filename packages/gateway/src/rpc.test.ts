import { describe, expect, it } from "vitest";
import type {
  AgentDefinition,
  AgentEvent,
  ApprovalDecision,
  ApprovalRequest,
  EventStore,
  Message,
  ModelEvent,
  ModelProvider,
  Session,
  SessionId,
  SessionStore,
  Skill,
  ToolCallRequest,
  ToolExecutionContext,
  ToolOrchestrator,
  ToolResult,
  ToolSpec,
  Turn,
  TurnId,
} from "@ar/contracts";
import { AgentError, newAgentId, newApprovalId, newSkillId } from "@ar/contracts";
import type { TurnOutcome } from "@ar/core";
import { AgentRuntime, DefaultLoadedSessionManager } from "@ar/core";
import { ScriptedModelProvider } from "@ar/model";
import { SessionService } from "@ar/session";
import { InMemoryApprovalStore } from "@ar/security";
import type { AgentSummary } from "./rpc.js";
import { RpcMethodRegistry, createRuntimeRpc, rpcErrorBody } from "./rpc.js";
import { InMemoryTransport } from "./transport.js";

const AGENT: AgentDefinition = {
  id: newAgentId(),
  name: "rpc-agent",
  description: "gateway test agent",
  mode: "primary",
  model: { providerId: "scripted", modelId: "scripted-model" },
  systemPrompt: "you are a gateway test agent",
  tools: {},
  permissions: { rules: [] },
  skills: {},
  limits: {},
};

const TOOL_SPEC: ToolSpec = {
  name: "read_file",
  description: "reads a file",
  inputSchema: {},
};

const SKILL_SPEC: Skill = {
  id: newSkillId(),
  path: "skills/echo",
  manifest: { name: "echo", description: "echo skill", version: "1.0.0" },
  status: "discovered",
  discoveredAt: 0,
};

/** In-memory SessionStore (mirrors the core test fake; not exported). */
class MemSessionStore implements SessionStore {
  sessions = new Map<string, Session>();
  turns = new Map<string, Turn>();
  messages: Message[] = [];

  async createSession(session: Session): Promise<void> {
    this.sessions.set(session.id, session);
  }
  async getSession(id: SessionId): Promise<Session | undefined> {
    return this.sessions.get(id);
  }
  async updateSession(session: Session): Promise<void> {
    this.sessions.set(session.id, session);
  }
  async listSessions(): Promise<Session[]> {
    return [...this.sessions.values()];
  }
  async createTurn(turn: Turn): Promise<void> {
    this.turns.set(turn.id, turn);
  }
  async getTurn(id: TurnId): Promise<Turn | undefined> {
    return this.turns.get(id);
  }
  async updateTurn(turn: Turn): Promise<void> {
    this.turns.set(turn.id, turn);
  }
  async listTurns(sessionId: SessionId): Promise<Turn[]> {
    return [...this.turns.values()].filter((t) => t.sessionId === sessionId);
  }
  async appendMessage(message: Message): Promise<void> {
    this.messages.push(message);
  }
  async listMessages(sessionId: SessionId): Promise<Message[]> {
    return this.messages.filter((m) => m.sessionId === sessionId);
  }
  async listMessagesByTurn(sessionId: SessionId, turnId: TurnId): Promise<Message[]> {
    return this.messages.filter((m) => m.sessionId === sessionId && m.turnId === turnId);
  }
  async saveStateSnapshot(_sessionId: SessionId, _snapshot: Record<string, unknown>): Promise<void> {}
  async loadStateSnapshot(): Promise<Record<string, unknown> | undefined> {
    return undefined;
  }
}

/** In-memory EventStore (mirrors the core test fake; not exported). */
class MemEventStore implements EventStore {
  events: AgentEvent[] = [];
  private seq = 0;

  async nextSequence(_sessionId: SessionId): Promise<number> {
    return this.seq + 1;
  }
  async appendNew(event: Omit<AgentEvent, "sequence">): Promise<AgentEvent> {
    return this.append({ ...event, sequence: -1 });
  }

  async append(event: AgentEvent): Promise<AgentEvent> {
    const seq = ++this.seq;
    const stored = { ...event, sequence: seq };
    this.events.push(stored);
    return stored;
  }
  async list(
    sessionId: SessionId,
    opts?: { afterSequence?: number; limit?: number },
  ): Promise<AgentEvent[]> {
    let list = this.events.filter((e) => e.sessionId === sessionId);
    if (opts?.afterSequence !== undefined) {
      list = list.filter((e) => e.sequence > opts.afterSequence!);
    }
    if (opts?.limit !== undefined) {
      list = list.slice(0, opts.limit);
    }
    return list;
  }
  async *stream(sessionId: SessionId, opts?: { afterSequence?: number }): AsyncIterable<AgentEvent> {
    for (const e of this.events) {
      if (e.sessionId !== sessionId) continue;
      if (opts?.afterSequence !== undefined && e.sequence <= opts.afterSequence) continue;
      yield e;
    }
  }
}

class FakeOrchestrator implements ToolOrchestrator {
  calls: ToolCallRequest[] = [];
    async executeBound(request: import("@ar/contracts").BoundToolCallRequest, ctx: import("@ar/contracts").ToolExecutionContext): Promise<import("@ar/contracts").ToolResult> {
    return this.execute(request, ctx);
  }

async execute(request: ToolCallRequest, _context: ToolExecutionContext): Promise<ToolResult> {
    this.calls.push(request);
    return { status: "success", output: "ok" };
  }
}

/**
 * Model that blocks mid-turn until its AbortSignal fires, then finishes.
 * An optional second script answers the second generate() call so one
 * runtime can host a blocked run and a completing run concurrently.
 * `blocked` resolves once the first generate() call is parked awaiting
 * abort — tests use it to remove ordering races.
 */
class BlockingProvider implements ModelProvider {
  readonly id = "blocking";
  private calls = 0;
  private releaseBlocked?: () => void;
  readonly blocked: Promise<void> = new Promise((resolve) => {
    this.releaseBlocked = resolve;
  });
  constructor(private readonly secondScript?: ModelEvent[]) {}
  listModels() {
    return Promise.resolve([]);
  }
  createClient() {
    const self = this;
    return {
      async *generate(
        _request: unknown,
        signal: AbortSignal,
      ): AsyncGenerator<ModelEvent, void, void> {
        self.calls += 1;
        if (self.calls > 1 && self.secondScript !== undefined) {
          yield* self.secondScript;
          return;
        }
        yield { type: "started", timestamp: 0 };
        yield { type: "text_delta", text: "thinking", timestamp: 0 };
        self.releaseBlocked?.();
        await new Promise<void>((resolve) => {
          if (signal.aborted) resolve();
          else signal.addEventListener("abort", () => resolve(), { once: true });
        });
        yield {
          type: "completed",
          result: { finishReason: "stop", text: "done" },
          timestamp: 0,
        };
      },
    };
  }
}

function makeRpc(opts: { provider?: ModelProvider; clock?: { t: number } } = {}) {
  const store = new MemSessionStore();
  const events = new MemEventStore();
  const orch = new FakeOrchestrator();
  const provider = opts.provider ?? new ScriptedModelProvider([ScriptedModelProvider.text("ok")]);
  const runtime = new AgentRuntime({
      toolRegistry: localTestToolCatalog(),
      permissiveToolResolution: true,
    store,
    events,
    modelProvider: provider,
    orchestrator: orch,
    agents: [AGENT],
  });
  const sessionService = new SessionService({ store });
  const approvalStore = new InMemoryApprovalStore(
    opts.clock === undefined ? undefined : () => opts.clock!.t,
  );
  const sessions = new DefaultLoadedSessionManager({ runtime, store });
  const registry = createRuntimeRpc(runtime, {
    sessionService,
    sessions,
    approvalStore,
    events,
    listAgents: () => [AGENT],
    listTools: () => [TOOL_SPEC],
    listSkills: () => [SKILL_SPEC],
  });
  return { store, events, orch, runtime, sessionService, approvalStore, sessions, registry };
}

async function createSession(registry: RpcMethodRegistry, cwd = "C:\\work"): Promise<Session> {
  return (await registry.invoke("session.create", { agentId: AGENT.id, cwd })) as Session;
}

async function sendTurn(registry: RpcMethodRegistry, sessionId: SessionId, text = "do it") {
  return (await registry.invoke("session.send", { sessionId, text })) as { turnId: string };
}

async function rejectError(promise: Promise<unknown>): Promise<AgentError> {
  try {
    await promise;
  } catch (err) {
    return err as AgentError;
  }
  throw new Error("expected the promise to reject");
}

describe("RpcMethodRegistry", () => {
  it("exposes the full §84 method surface", () => {
    const { registry } = makeRpc();
    expect(registry.listMethods().sort()).toEqual([
      "agent.list",
      "session.approve",
      "session.cancel",
      "session.create",
      "session.followup",
      "session.interrupt",
      "session.resume",
      "session.run",
      "session.send",
      "session.status",
      "session.steer",
      "session.subscribe",
      "skill.list",
      "tool.list",
      "trace.get",
    ]);
  });

  it("rejects unknown methods with METHOD_NOT_FOUND semantics (no stack leak)", async () => {
    const err = await rejectError(new RpcMethodRegistry().invoke("no.such"));
    expect(err.info.code).toBe("INTERNAL_ERROR");
    expect(err.info.message).toBe("unknown rpc method: no.such");
    expect(err.info.cause).toEqual({ jsonrpcCode: -32601 });
    expect("stack" in err.info).toBe(false);
    expect(rpcErrorBody(err)).toEqual({ code: "INTERNAL_ERROR", message: "unknown rpc method: no.such" });
  });

  it("rejects duplicate registrations", () => {
    const r = new RpcMethodRegistry().register("a", async () => 1);
    expect(() => r.register("a", async () => 2)).toThrow(/already registered/);
  });

  it("normalizes a raw handler error to a structured error without a stack", async () => {
    const r = new RpcMethodRegistry().register("boom", async () => {
      throw new Error("kaboom");
    });
    const err = await rejectError(r.invoke("boom", {}));
    expect(err.info.code).toBe("INTERNAL_ERROR");
    expect(err.info.message).toBe("kaboom");
    expect("stack" in err.info).toBe(false);
    expect(rpcErrorBody(err)).toEqual({ code: "INTERNAL_ERROR", message: "kaboom" });
  });
});

describe("createRuntimeRpc session lifecycle", () => {
  it("session.create → session.send → session.run completes the full chain", async () => {
    const { registry, store, events } = makeRpc();

    const session = await createSession(registry);
    expect(session.agentId).toBe(AGENT.id);
    expect(session.cwd).toBe("C:\\work");
    expect(session.status).toBe("active");
    expect(await store.getSession(session.id)).toBeDefined();

    const { turnId } = await sendTurn(registry, session.id);
    const turn = await store.getTurn(turnId as TurnId);
    expect(turn?.status).toBe("running");

    const outcome = (await registry.invoke("session.run", {
      sessionId: session.id,
      turnId,
    })) as TurnOutcome;
    expect(outcome.status).toBe("completed");
    expect(outcome.turn.status).toBe("completed");
    expect(outcome.toolCalls).toBe(0);

    const types = (await events.list(session.id)).map((e) => e.type);
    expect(types).toEqual(["session.created", "turn.started", "model.started", "tools.selected", "model.completed", "turn.completed"]);
  });

  it("session.create rejects an unknown agent", async () => {
    const { registry } = makeRpc();
    const err = await rejectError(
      registry.invoke("session.create", { agentId: "agent_unknown", cwd: "C:\\work" }),
    );
    expect(err.info.code).toBe("INTERNAL_ERROR");
    expect(err.info.message).toContain("unknown agent");
  });

  it("session.cancel aborts a blocked turn and settles with cancelled", async () => {
    const { registry, store, events } = makeRpc({ provider: new BlockingProvider() });
    const session = await createSession(registry);
    const { turnId } = await sendTurn(registry, session.id);

    const runPromise = registry.invoke("session.run", { sessionId: session.id, turnId });
    const cancel = (await registry.invoke("session.cancel", {
      sessionId: session.id,
      turnId,
    })) as { status: string };
    expect(cancel.status).toBe("cancelled");

    const outcome = (await runPromise) as TurnOutcome;
    expect(outcome.status).toBe("cancelled");
    expect((await store.getTurn(turnId as TurnId))?.status).toBe("cancelled");
    expect((await events.list(session.id)).map((e) => e.type)).toContain("turn.cancelled");
  });

  it("session.cancel of a non-running turn reports not_running", async () => {
    const { registry } = makeRpc();
    const session = await createSession(registry);
    const { turnId } = await sendTurn(registry, session.id);
    const result = (await registry.invoke("session.cancel", {
      sessionId: session.id,
      turnId,
    })) as { status: string };
    expect(result.status).toBe("not_running");
  });

  it("session.steer admits a steering prompt without touching the transcript", async () => {
    const { registry } = makeRpc();
    const session = await createSession(registry);
    const res = (await registry.invoke("session.steer", {
      sessionId: session.id,
      text: "redirect me",
    })) as { admitted: string };
    expect(res.admitted).toBe("steer");
  });

  it("session.followup queues a follow-up turn and surfaces it in session.status", async () => {
    const { registry } = makeRpc();
    const session = await createSession(registry);
    const res = (await registry.invoke("session.followup", {
      sessionId: session.id,
      text: "later",
    })) as { admitted: string };
    expect(res.admitted).toBe("followup");
    const status = (await registry.invoke("session.status", {
      sessionId: session.id,
    })) as { queuedFollowups: number; loaded: boolean };
    expect(status.loaded).toBe(true);
    expect(status.queuedFollowups).toBe(1);
  });

  it("session.interrupt reports not_running when no turn is active", async () => {
    const { registry } = makeRpc();
    const session = await createSession(registry);
    const res = (await registry.invoke("session.interrupt", {
      sessionId: session.id,
    })) as { interrupted: boolean; status: string };
    expect(res.interrupted).toBe(false);
    expect(res.status).toBe("not_running");
  });

  it("session.send is refused with SESSION_BUSY while a turn is active (P25-3)", async () => {
    const { registry } = makeRpc({ provider: new BlockingProvider() });
    const session = await createSession(registry);
    const { turnId } = await sendTurn(registry, session.id);
    const runA = registry.invoke("session.run", { sessionId: session.id, turnId });
    const err = await rejectError(
      registry.invoke("session.send", { sessionId: session.id, text: "second" }),
    );
    expect(err.info.code).toBe("SESSION_BUSY");
    // cleanup: cancel the running turn so the test settles.
    await registry.invoke("session.cancel", { sessionId: session.id, turnId });
    await runA;
  });

  it("session.run rejects a concurrent duplicate run of the same turn", async () => {
    const { registry } = makeRpc({ provider: new BlockingProvider() });
    const session = await createSession(registry);
    const { turnId } = await sendTurn(registry, session.id);
    const first = registry.invoke("session.run", { sessionId: session.id, turnId });
    const err = await rejectError(
      registry.invoke("session.run", { sessionId: session.id, turnId }),
    );
    expect(err.info.code).toBe("SESSION_BUSY");
    expect(err.info.message).toContain("already has an active turn");
    const cancel = (await registry.invoke("session.cancel", {
      sessionId: session.id,
      turnId,
    })) as { status: string };
    expect(cancel.status).toBe("cancelled");
    const outcome = (await first) as TurnOutcome;
    expect(outcome.status).toBe("cancelled");
  });

  it("session.resume returns the session; unknown session rejects structured", async () => {
    const { registry } = makeRpc();
    const session = await createSession(registry);
    const resumed = (await registry.invoke("session.resume", {
      sessionId: session.id,
    })) as Session;
    expect(resumed.id).toBe(session.id);

    const err = await rejectError(registry.invoke("session.resume", { sessionId: "session_nope" }));
    expect(err.info.code).toBe("INTERNAL_ERROR");
    expect(err.info.message).toContain("session_nope");
  });
});

describe("createRuntimeRpc approval (plan §161)", () => {
  function makeApproval() {
    const clock = { t: 1_000 };
    const h = makeRpc({ clock });
    const request: ApprovalRequest = {
      id: newApprovalId(),
      sessionId: "session_approval_test" as SessionId,
      agentId: AGENT.id,
      action: "tool.execute",
      target: "rm -rf /tmp/x",
      reason: "test approval",
      createdAt: clock.t,
      expiresAt: clock.t + 5_000,
    };
    return { ...h, clock, request };
  }

  it("session.approve allow records the decision and decidedBy", async () => {
    const { registry, approvalStore, clock, request } = makeApproval();
    approvalStore.create(request);
    clock.t = 2_000;
    const decision = (await registry.invoke("session.approve", {
      approvalId: request.id,
      value: "allow",
      decidedBy: "test-user",
    })) as ApprovalDecision;
    expect(decision.value).toBe("allow");
    expect(decision.decidedBy).toBe("test-user");
  });

  it("session.approve deny resolves deny", async () => {
    const { registry, approvalStore, request } = makeApproval();
    approvalStore.create(request);
    const decision = (await registry.invoke("session.approve", {
      approvalId: request.id,
      value: "deny",
    })) as ApprovalDecision;
    expect(decision.value).toBe("deny");
  });

  it("session.approve past expiresAt resolves expired even for allow", async () => {
    const { registry, approvalStore, clock, request } = makeApproval();
    approvalStore.create(request);
    clock.t = 10_000;
    const decision = (await registry.invoke("session.approve", {
      approvalId: request.id,
      value: "allow",
    })) as ApprovalDecision;
    expect(decision.value).toBe("expired");
  });

  it("session.approve of an unknown approval rejects structured", async () => {
    const { registry } = makeApproval();
    const err = await rejectError(
      registry.invoke("session.approve", { approvalId: newApprovalId(), value: "allow" }),
    );
    expect(err.info.code).toBe("INTERNAL_ERROR");
    expect(err.info.message).toContain("unknown or already-resolved");
  });

  it("session.approve rejects an invalid value", async () => {
    const { registry } = makeApproval();
    const err = await rejectError(
      registry.invoke("session.approve", {
        approvalId: newApprovalId(),
        value: "maybe",
      }),
    );
    expect(err.info.code).toBe("INTERNAL_ERROR");
    expect(err.info.message).toContain("allow or deny");
  });
});

describe("createRuntimeRpc listings, trace, subscribe", () => {
  it("agent.list / tool.list / skill.list return host data", async () => {
    const { registry } = makeRpc();
    const agents = (await registry.invoke("agent.list")) as AgentSummary[];
    expect(agents.map((a) => a.id)).toEqual([AGENT.id]);
    expect(agents[0]!.name).toBe("rpc-agent");
    expect("systemPrompt" in agents[0]!).toBe(false);

    const tools = (await registry.invoke("tool.list")) as ToolSpec[];
    expect(tools.map((t) => t.name)).toEqual(["read_file"]);

    const skills = (await registry.invoke("skill.list")) as Skill[];
    expect(skills.map((s) => s.manifest.name)).toEqual(["echo"]);
  });

  it("tool.list without a host provider rejects structured", async () => {
    const h = makeRpc();
    const bare = createRuntimeRpc(h.runtime, {
      sessionService: h.sessionService,
      sessions: h.sessions,
      approvalStore: h.approvalStore,
      events: h.events,
    });
    const err = await rejectError(bare.invoke("tool.list"));
    expect(err.info.code).toBe("INTERNAL_ERROR");
    expect(err.info.message).toContain("not configured");
  });

  it("trace.get returns the session event log", async () => {
    const { registry } = makeRpc();
    const session = await createSession(registry);
    await sendTurn(registry, session.id);
    const trace = (await registry.invoke("trace.get", { sessionId: session.id })) as AgentEvent[];
    expect(trace.map((e) => e.type)).toEqual(["session.created", "turn.started"]);
  });

  it("session.subscribe returns a snapshot filtered by afterSequence", async () => {
    const { registry } = makeRpc();
    const session = await createSession(registry);
    await sendTurn(registry, session.id);
    const snapshot = (await registry.invoke("session.subscribe", {
      sessionId: session.id,
      afterSequence: 1,
    })) as AgentEvent[];
    expect(snapshot.map((e) => e.type)).toEqual(["turn.started"]);
    const all = (await registry.invoke("session.subscribe", {
      sessionId: session.id,
    })) as AgentEvent[];
    expect(all.length).toBe(2);
  });
});

describe("concurrency and transport", () => {
  it("concurrent runs on one runtime: cancelling one leaves the other intact", async () => {
    const provider = new BlockingProvider(ScriptedModelProvider.text("fine"));
    const { registry, events } = makeRpc({ provider });
    const sessionA = await createSession(registry);
    const sessionB = await createSession(registry);
    const turnA = await sendTurn(registry, sessionA.id, "block me");
    const turnB = await sendTurn(registry, sessionB.id, "finish me");

    const runA = registry.invoke("session.run", { sessionId: sessionA.id, turnId: turnA.turnId });
    await provider.blocked;
    const runB = registry.invoke("session.run", { sessionId: sessionB.id, turnId: turnB.turnId });

    const cancelA = (await registry.invoke("session.cancel", {
      sessionId: sessionA.id,
      turnId: turnA.turnId,
    })) as { status: string };
    expect(cancelA.status).toBe("cancelled");

    const [outcomeA, outcomeB] = (await Promise.all([runA, runB])) as [TurnOutcome, TurnOutcome];
    expect(outcomeA.status).toBe("cancelled");
    expect(outcomeB.status).toBe("completed");
    expect((await events.list(sessionA.id)).map((e) => e.type)).toContain("turn.cancelled");
    expect((await events.list(sessionB.id)).map((e) => e.type)).toContain("turn.completed");
  });

  it("transport round-trips requests and propagates structured errors", async () => {
    const { registry } = makeRpc();
    const { client, server } = InMemoryTransport.pair();
    server.connect(registry);

    const session = (await client.request("session.create", {
      agentId: AGENT.id,
      cwd: "C:\\work",
    })) as Session;
    expect(session.agentId).toBe(AGENT.id);

    const err = await rejectError(
      client.request("session.create", { agentId: "agent_unknown", cwd: "C:\\work" }),
    );
    expect(err.info.code).toBe("INTERNAL_ERROR");
    expect(err.info.message).toContain("unknown agent");
  });

  it("transport propagates the caller AbortSignal into session.run", async () => {
    const { registry } = makeRpc({ provider: new BlockingProvider() });
    const { client, server } = InMemoryTransport.pair();
    server.connect(registry);

    const session = (await client.request("session.create", {
      agentId: AGENT.id,
      cwd: "C:\\work",
    })) as Session;
    const { turnId } = (await client.request("session.send", {
      sessionId: session.id,
      text: "go",
    })) as { turnId: string };

    const controller = new AbortController();
    const runPromise = client.request(
      "session.run",
      { sessionId: session.id, turnId },
      { signal: controller.signal },
    );
    await Promise.resolve();
    controller.abort();

    const outcome = (await runPromise) as TurnOutcome;
    expect(outcome.status).toBe("cancelled");
  });
});

/** P23-4 local inert catalog for gateway/web tests (FakeOrchestrator). */
function localTestToolCatalog() {
  const names = ["read_file", "write_file", "edit_file", "exec", "search_files", "grep_search", "repo_tree", "repo_map", "update_plan", "ask_user", "env_snapshot", "discover_commands", "tool_lookup", "echo"];
  const mk = (name: string) => ({
    name,
    description: `stub ${name}`,
    inputSchema: ({} as never),
    risk: "readonly" as const,
    metadata: { name, version: "1.0.0", sideEffect: false, network: false, filesystem: false, process: false, interactive: false },
    execute: async () => ({ status: "success" as const, output: "" }),
  });
  return {
    get: (name: string) => (names.includes(name) ? mk(name) : undefined),
    list: () => names.map(mk),
    specs: () => names.map((name) => ({ name, description: `stub ${name}`, inputSchema: {} as never })),
  };
}
