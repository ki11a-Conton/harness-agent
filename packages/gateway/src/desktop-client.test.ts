import { describe, expect, it } from "vitest";
import type {
  AgentDefinition,
  AgentEvent,
  ApprovalRequest,
  EventStore,
  Message,
  ModelEvent,
  ModelProvider,
  Session,
  SessionId,
  SessionStore,
  ToolCallRequest,
  ToolExecutionContext,
  ToolOrchestrator,
  ToolResult,
  Turn,
  TurnId,
} from "@ar/contracts";
import { AgentError, newAgentId, newApprovalId } from "@ar/contracts";
import { AgentRuntime, DefaultLoadedSessionManager } from "@ar/core";
import { ScriptedModelProvider } from "@ar/model";
import { SessionService } from "@ar/session";
import { InMemoryApprovalStore } from "@ar/security";
import { DesktopClient } from "./desktop-client.js";
import type { DesktopClientOptions } from "./desktop-client.js";
import { createRuntimeRpc } from "./rpc.js";
import { InMemoryTransport } from "./transport.js";

const AGENT: AgentDefinition = {
  id: newAgentId(),
  name: "desktop-agent",
  description: "desktop test agent",
  mode: "primary",
  model: { providerId: "scripted", modelId: "scripted-model" },
  systemPrompt: "you are a desktop test agent",
  tools: {},
  permissions: { rules: [] },
  skills: {},
  limits: {},
};

const AGENT_2: AgentDefinition = {
  ...AGENT,
  id: newAgentId(),
  name: "desktop-agent-2",
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

interface Harness {
  store: MemSessionStore;
  events: MemEventStore;
  orch: FakeOrchestrator;
  runtime: AgentRuntime;
  approvalStore: InMemoryApprovalStore;
  registry: ReturnType<typeof createRuntimeRpc>;
  transport: InMemoryTransport;
  server: InMemoryTransport;
  client: DesktopClient;
}

function makeClient(
  opts: { provider?: ModelProvider; clock?: { t: number }; pollDelayMs?: number } = {},
): Harness {
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
    agents: [AGENT, AGENT_2],
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
  });
  const { client: transport, server } = InMemoryTransport.pair();
  server.connect(registry);
  const client = new DesktopClient({
    transport,
    sessionDefaults: { agentId: AGENT.id, cwd: "C:\\work" },
    approvalStore,
    pollDelayMs: opts.pollDelayMs ?? 5,
  });
  return { store, events, orch, runtime, approvalStore, registry, transport, server, client };
}

function approvalRequest(clock: { t: number }): ApprovalRequest {
  return {
    id: newApprovalId(),
    sessionId: "session_desktop_approval" as SessionId,
    agentId: AGENT.id,
    action: "tool.execute",
    target: "rm -rf /tmp/x",
    reason: "test approval",
    createdAt: clock.t,
    expiresAt: clock.t + 5_000,
  };
}

async function rejectError(promise: Promise<unknown>): Promise<AgentError> {
  try {
    await promise;
  } catch (err) {
    return err as AgentError;
  }
  throw new Error("expected the promise to reject");
}

async function waitFor(check: () => boolean, timeoutMs = 2_000): Promise<void> {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor timed out");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe("DesktopClient session lifecycle (§85)", () => {
  it("createSession forwards through RPC and returns { sessionId }", async () => {
    const { client, store } = makeClient();
    const { sessionId } = await client.createSession();
    const session = await store.getSession(sessionId as SessionId);
    expect(session?.agentId).toBe(AGENT.id);
    expect(session?.cwd).toBe("C:\\work");
    expect(session?.status).toBe("active");
  });

  it("createSession falls back to sessionDefaults; explicit args override them", async () => {
    const { client, store } = makeClient();
    const { sessionId: defaultId } = await client.createSession();
    const stored = await store.getSession(defaultId as SessionId);
    expect(stored?.agentId).toBe(AGENT.id);
    expect(stored?.cwd).toBe("C:\\work");

    const { sessionId: overrideId } = await client.createSession(AGENT_2.id, "C:\\other");
    const overridden = await store.getSession(overrideId as SessionId);
    expect(overridden?.agentId).toBe(AGENT_2.id);
    expect(overridden?.cwd).toBe("C:\\other");
  });

  it("createSession without defaults and without args rejects structured", async () => {
    const { transport } = makeClient();
    const bare = new DesktopClient({ transport });
    const err = await rejectError(bare.createSession());
    expect(err.info.code).toBe("INTERNAL_ERROR");
    expect(err.info.message).toContain("required");
  });

  it("send starts a turn and returns its id", async () => {
    const { client, store } = makeClient();
    const { sessionId } = await client.createSession();
    const { turnId } = await client.send(sessionId, "do the thing");
    const turn = await store.getTurn(turnId as TurnId);
    expect(turn?.sessionId).toBe(sessionId);
    expect(turn?.status).toBe("running");
  });

  it("send for an unknown session rejects structured", async () => {
    const { client } = makeClient();
    const err = await rejectError(client.send("session_nope", "hi"));
    expect(err.info.code).toBe("INTERNAL_ERROR");
    expect(err.info.message).toContain("session_nope");
  });

  it("run reports the outcome and delivers turn.started → tool.requested → turn.completed via onEvent", async () => {
    const script = [
      ScriptedModelProvider.toolCall("read_file", { path: "a.txt" }),
      ScriptedModelProvider.text("done: read a.txt"),
    ];
    const { client, orch } = makeClient({ provider: new ScriptedModelProvider(script) });
    const { sessionId } = await client.createSession();
    const { turnId } = await client.send(sessionId, "read the file");
    const seen: AgentEvent[] = [];
    const outcome = await client.run(sessionId, turnId, (e) => seen.push(e));

    expect(outcome).toEqual({ status: "completed", toolCalls: 1, iterations: 1 });
    expect(orch.calls.map((c) => c.call.name)).toEqual(["read_file"]);
    const types = seen.map((e) => e.type);
    expect(types).toContain("turn.started");
    expect(types).toContain("tool.requested");
    expect(types).toContain("turn.completed");
    expect(types.indexOf("turn.started")).toBeLessThan(types.indexOf("tool.requested"));
    expect(types.indexOf("tool.requested")).toBeLessThan(types.indexOf("turn.completed"));
    expect(seen.every((e) => e.sessionId === sessionId)).toBe(true);
  });

  it("run without onEvent still returns the outcome", async () => {
    const { client } = makeClient();
    const { sessionId } = await client.createSession();
    const { turnId } = await client.send(sessionId, "hello");
    const outcome = await client.run(sessionId, turnId);
    expect(outcome).toEqual({ status: "completed", toolCalls: 0, iterations: 0 });
  });

  it("cancel aborts a blocked run, reports cancelled, and delivers turn.cancelled", async () => {
    const provider = new BlockingProvider();
    const { client } = makeClient({ provider });
    const { sessionId } = await client.createSession();
    const { turnId } = await client.send(sessionId, "block me");
    const seen: AgentEvent[] = [];
    const runPromise = client.run(sessionId, turnId, (e) => seen.push(e));
    await provider.blocked;

    const cancel = await client.cancel(sessionId, turnId);
    expect(cancel.status).toBe("cancelled");

    const outcome = await runPromise;
    expect(outcome.status).toBe("cancelled");
    expect(seen.map((e) => e.type)).toContain("turn.cancelled");
  });

  it("resume returns the session", async () => {
    const { client } = makeClient();
    const { sessionId } = await client.createSession();
    const { session } = await client.resume(sessionId);
    expect((session as Session).id).toBe(sessionId);
    expect((session as Session).agentId).toBe(AGENT.id);
  });
});

describe("DesktopClient approvals (§162)", () => {
  it("approve allow resolves { value: 'allow' } and clears the pending list", async () => {
    const clock = { t: 1_000 };
    const { client, approvalStore } = makeClient({ clock });
    const request = approvalRequest(clock);
    approvalStore.create(request);

    const decision = await client.approve(request.id, true, "desktop-user");
    expect(decision).toEqual({ value: "allow" });
    expect(approvalStore.listPending()).toEqual([]);
  });

  it("approve deny resolves { value: 'deny' }", async () => {
    const clock = { t: 1_000 };
    const { client, approvalStore } = makeClient({ clock });
    const request = approvalRequest(clock);
    approvalStore.create(request);

    const decision = await client.approve(request.id, false);
    expect(decision).toEqual({ value: "deny" });
  });

  it("approve of an unknown approval rejects structured", async () => {
    const clock = { t: 1_000 };
    const { client } = makeClient({ clock });
    const err = await rejectError(client.approve(newApprovalId(), true));
    expect(err.info.code).toBe("INTERNAL_ERROR");
    expect(err.info.message).toContain("unknown or already-resolved");
  });

  it("listPendingApprovals returns pending requests and is one-shot after resolution", async () => {
    const clock = { t: 1_000 };
    const { client, approvalStore } = makeClient({ clock });
    const request = approvalRequest(clock);
    approvalStore.create(request);

    const pending = await client.listPendingApprovals();
    expect(pending.map((r) => (r as ApprovalRequest).id)).toEqual([request.id]);
    expect((pending[0] as ApprovalRequest).action).toBe("tool.execute");
    expect((pending[0] as ApprovalRequest).reason).toBe("test approval");

    await client.approve(request.id, true);
    expect(await client.listPendingApprovals()).toEqual([]);
  });

  it("listPendingApprovals without an injected store rejects structured", async () => {
    const { transport } = makeClient();
    const bare = new DesktopClient({ transport });
    const err = await rejectError(bare.listPendingApprovals());
    expect(err.info.code).toBe("INTERNAL_ERROR");
    expect(err.info.message).toContain("approvalStore");
  });
});

describe("DesktopClient event display (§85)", () => {
  it("subscribe delivers session events to the callback and resolves on abort", async () => {
    const { client } = makeClient();
    const { sessionId } = await client.createSession();
    const seen: AgentEvent[] = [];
    const controller = new AbortController();
    const subscription = client.subscribe(sessionId, 0, (e) => seen.push(e), controller.signal);

    const { turnId } = await client.send(sessionId, "hello");
    await client.run(sessionId, turnId);
    await waitFor(() => seen.some((e) => e.type === "turn.completed"));

    controller.abort();
    await subscription;

    const types = seen.map((e) => e.type);
    expect(types).toContain("session.created");
    expect(types).toContain("turn.started");
    expect(types).toContain("turn.completed");
    expect(types.indexOf("turn.started")).toBeLessThan(types.indexOf("turn.completed"));
    expect(seen.every((e) => e.sessionId === sessionId)).toBe(true);
  });
});

describe("DesktopClient boundaries", () => {
  it("type-level §85 guard: options reject runtime internals; the client exposes no runtime state", () => {
    const h = makeClient();
    // @ts-expect-error — §85: the desktop client's only runtime-facing
    // dependency is the transport; runtime/registry/stores must not fit
    const opts: DesktopClientOptions = { transport: h.transport, runtime: h.runtime };
    expect(opts.transport).toBe(h.transport);

    const instance = new DesktopClient({
      transport: h.transport,
      sessionDefaults: { agentId: AGENT.id, cwd: "C:\\work" },
    });
    const keys = Object.keys(instance as unknown as Record<string, unknown>);
    for (const forbidden of ["runtime", "registry", "sessionStore", "eventStore"]) {
      expect(keys).not.toContain(forbidden);
    }
  });

  it("multi-session: runs and subscriptions are isolated per session", async () => {
    // One script per run: ScriptedModelProvider consumes one per generate() call.
    const { client } = makeClient({
      provider: new ScriptedModelProvider([
        ScriptedModelProvider.text("b done"),
        ScriptedModelProvider.text("a done"),
      ]),
    });
    const a = await client.createSession();
    const b = await client.createSession();

    const seenA: AgentEvent[] = [];
    const controller = new AbortController();
    // afterSequence=1 skips session A's own creation event.
    const subscription = client.subscribe(a.sessionId, 1, (e) => seenA.push(e), controller.signal);

    const turnB = await client.send(b.sessionId, "b turn");
    await client.run(b.sessionId, turnB.turnId);
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(seenA).toEqual([]);

    const turnA = await client.send(a.sessionId, "a turn");
    const outcomeA = await client.run(a.sessionId, turnA.turnId);
    expect(outcomeA.status).toBe("completed");
    await waitFor(() => seenA.some((e) => e.type === "turn.completed"));
    expect(seenA.every((e) => e.sessionId === a.sessionId)).toBe(true);
    expect(seenA.some((e) => e.sessionId === b.sessionId)).toBe(false);

    controller.abort();
    await subscription;
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
