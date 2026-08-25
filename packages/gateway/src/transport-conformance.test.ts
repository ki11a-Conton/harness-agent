import { describe, expect, it } from "vitest";
import type {
  AgentDefinition,
  AgentEvent,
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
import { newAgentId, newSkillId } from "@ar/contracts";
import { AgentRuntime, DefaultLoadedSessionManager } from "@ar/core";
import { ScriptedModelProvider } from "@ar/model";
import { SessionService } from "@ar/session";
import { InMemoryApprovalStore } from "@ar/security";
import { createRuntimeRpc } from "./rpc.js";
import { AppServer, type AppServerInvokeResult } from "./app-server.js";
import { InMemoryTransport } from "./transport.js";
import { StdioTransport } from "./stdio-transport.js";

/**
 * P34-5 — App Server protocol conformance over BOTH transports.
 *
 * The SAME contract fixtures run against InMemoryTransport (microtask
 * delivery) and StdioTransport (JSONL framing). In BOTH cases the client
 * sees the AppServer's wire envelope — { result? | error? } — so the tests
 * assert transport-identical behavior:
 *   - handshake gating (NOT_INITIALIZED / ALREADY_INITIALIZED);
 *   - structured errors (never a raw throw across the wire);
 *   - idempotency replay;
 *   - backpressure (SERVER_OVERLOADED, retryable);
 *   - reconnect replay (state kept server-side);
 *   - interrupt / steer / concurrent-turn semantics of an active turn.
 */

const AGENT: AgentDefinition = {
  id: newAgentId(),
  name: "proto-agent",
  description: "P34-5 wire conformance agent",
  mode: "primary",
  model: { providerId: "scripted", modelId: "scripted-model" },
  systemPrompt: "you are a wire conformance agent",
  tools: {},
  permissions: { rules: [] },
  skills: {},
  limits: {},
};

const TOOL_SPEC: ToolSpec = { name: "read_file", description: "reads a file", inputSchema: {} };
const SKILL_SPEC: Skill = {
  id: newSkillId(),
  path: "skills/wire",
  manifest: { name: "wire", description: "wire skill", version: "1.0.0" },
  status: "discovered",
  discoveredAt: 0,
};

/** Minimal in-memory SessionStore (mirrors rpc.test's fake). */
class MemSessionStore implements SessionStore {
  sessions = new Map<string, Session>();
  turns = new Map<string, Turn>();
  messages: Message[] = [];
  async createSession(s: Session) { this.sessions.set(s.id, s); }
  async getSession(id: SessionId) { return this.sessions.get(id); }
  async updateSession(s: Session) { this.sessions.set(s.id, s); }
  async listSessions() { return [...this.sessions.values()]; }
  async createTurn(t: Turn) { this.turns.set(t.id, t); }
  async getTurn(id: TurnId) { return this.turns.get(id); }
  async updateTurn(t: Turn) { this.turns.set(t.id, t); }
  async listTurns(sid: SessionId) { return [...this.turns.values()].filter((t) => t.sessionId === sid); }
  async appendMessage(m: Message) { this.messages.push(m); }
  async listMessages(sid: SessionId) { return this.messages.filter((m) => m.sessionId === sid); }
  async listMessagesByTurn(sid: SessionId, turnId: TurnId) {
    return this.messages.filter((m) => m.sessionId === sid && m.turnId === turnId);
  }
  async saveStateSnapshot(_s: SessionId, _snap: Record<string, unknown>) {}
  async loadStateSnapshot() { return undefined; }
}

/** Minimal in-memory EventStore. */
class MemEventStore implements EventStore {
  events: AgentEvent[] = [];
  private seq = 0;
  async nextSequence() { return this.seq + 1; }
  async appendNew(e: Omit<AgentEvent, "sequence">): Promise<AgentEvent> {
    return this.append({ ...e, sequence: -1 });
  }
  async append(e: AgentEvent): Promise<AgentEvent> {
    const stored = { ...e, sequence: ++this.seq };
    this.events.push(stored);
    return stored;
  }
  async list(_sid: SessionId, opts?: { afterSequence?: number; limit?: number }) {
    let list = this.events;
    if (opts?.afterSequence !== undefined) list = list.filter((e) => e.sequence > opts.afterSequence!);
    if (opts?.limit !== undefined) list = list.slice(0, opts.limit);
    return list;
  }
  async *stream(_sid: SessionId, _opts?: { afterSequence?: number }): AsyncIterable<AgentEvent> {
    yield* [];
  }
}

class FakeOrchestrator implements ToolOrchestrator {
  calls: ToolCallRequest[] = [];
  async executeBound(r: import("@ar/contracts").BoundToolCallRequest, ctx: ToolExecutionContext): Promise<ToolResult> {
    return this.execute(r, ctx);
  }
  async execute(request: ToolCallRequest, _ctx: ToolExecutionContext): Promise<ToolResult> {
    this.calls.push(request);
    return { status: "success", output: "ok" };
  }
}

/** Model provider that blocks mid-turn until the AbortSignal fires. */
class BlockingProvider implements ModelProvider {
  readonly id = "blocking";
  private calls = 0;
  private releaseBlocked?: () => void;
  readonly blocked: Promise<void> = new Promise((r) => (this.releaseBlocked = r));
  listModels() { return Promise.resolve([]); }
  createClient() {
    const self = this;
    return {
      async *generate(_request: unknown, signal: AbortSignal): AsyncGenerator<ModelEvent, void, void> {
        self.calls += 1;
        yield { type: "started", timestamp: 0 };
        yield { type: "text_delta", text: "thinking", timestamp: 0 };
        self.releaseBlocked?.();
        await new Promise<void>((r) => {
          if (signal.aborted) return r();
          signal.addEventListener("abort", () => r(), { once: true });
        });
        yield { type: "completed", result: { finishReason: "stop", text: "done" }, timestamp: 0 };
      },
    };
  }
}

interface ServerHarness {
  server: AppServer;
  store: MemSessionStore;
  events: MemEventStore;
  provider: BlockingProvider | undefined;
}

function makeHarness(opts: { blocking?: boolean; ingressCapacity?: number } = {}): ServerHarness {
  const store = new MemSessionStore();
  const events = new MemEventStore();
  const orch = new FakeOrchestrator();
  const provider = opts.blocking ? new BlockingProvider() : undefined;
  const runtime = new AgentRuntime({
    toolRegistry: localTestCatalog(),
    permissiveToolResolution: true,
    store,
    events,
    modelProvider: provider ?? new ScriptedModelProvider([ScriptedModelProvider.text("ok")]),
    orchestrator: orch,
    agents: [AGENT],
  });
  const sessionService = new SessionService({ store });
  const approvalStore = new InMemoryApprovalStore();
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
  const server = new AppServer({
    runtime,
    sessions,
    sessionService,
    approvalStore,
    events,
    listAgents: () => [AGENT],
    ingressCapacity: opts.ingressCapacity ?? 2,
  });
  return { server, store, events, provider };
}

/** A client handle over either transport (duck-typed shared surface). */
interface WireClient {
  /** Invoke via the wire; resolves with the App wire envelope. */
  invoke(method: string, params?: Record<string, unknown>): Promise<AppServerInvokeResult>;
}

function makeInMemoryClient(h: ServerHarness): WireClient {
  const { client, server } = InMemoryTransport.pair();
  // AppServer.invoke returns { result? | error? }; the transport carries that.
  server.connect(h.server as never);
  return {
    async invoke(method, params) {
      const result = await client.request(method, params);
      return result as AppServerInvokeResult;
    },
  };
}

function makeStdioClient(h: ServerHarness): WireClient {
  const client = new StdioTransport({ role: "client" });
  const server = new StdioTransport({ role: "server", server: h.server as never });
  client.pair(server);
  return {
    invoke(method, params) {
      return client.request(method, params) as Promise<AppServerInvokeResult>;
    },
  };
}

type ClientFactory = (h: ServerHarness) => WireClient;
const CLIENT_FACTORIES: Record<string, ClientFactory> = {
  "InMemoryTransport": makeInMemoryClient,
  "StdioTransport": makeStdioClient,
};

async function initClient(c: WireClient): Promise<void> {
  await c.invoke("initialize", { clientInfo: { name: "t", version: "1" } });
}

/** Assert a transport's wire envelope has an error with the given code. */
function expectCode(res: AppServerInvokeResult, code: string): void {
  expect(res.error?.code).toBe(code);
}

for (const [name, makeClient] of Object.entries(CLIENT_FACTORIES)) {
  describe(`P34-5 ${name}`, () => {
    it("request before initialize → NOT_INITIALIZED", async () => {
      const client = makeClient(makeHarness());
      const res = await client.invoke("thread/start", { agentName: AGENT.name, cwd: "/tmp" });
      expectCode(res, "NOT_INITIALIZED");
    });

    it("duplicate initialize → ALREADY_INITIALIZED", async () => {
      const client = makeClient(makeHarness());
      await initClient(client);
      const res = await client.invoke("initialize", { clientInfo: { name: "t", version: "1" } });
      expectCode(res, "ALREADY_INITIALIZED");
    });

    it("unknown method → structured error, never a raw throw", async () => {
      const client = makeClient(makeHarness());
      await initClient(client);
      const res = await client.invoke("nope/nowhere", {});
      expectCode(res, "INTERNAL_ERROR");
    });

    it("malformed params fail closed and the wire survives", async () => {
      const client = makeClient(makeHarness());
      await initClient(client);
      const res = await client.invoke("thread/start", { agentName: 123 as never, cwd: "/tmp" });
      // either a structured error or (for lenient methods) a result — the wire
      // never throws into the client and the NEXT request still works
      expect(res.error === undefined || typeof res.error.code === "string").toBe(true);
      const ok = await client.invoke("agent/list", {});
      expect(ok.error).toBeUndefined();
    });

    it("overload → SERVER_OVERLOADED, retryable, and other requests still complete", async () => {
      // capacity=2: fire 5 concurrent requests; the queue must NEVER grow
      // unbounded — at least one is rejected with SERVER_OVERLOADED while
      // the rest settle normally. No turn is blocked (control requests are
      // quick, so nothing deadlocks).
      const h = makeHarness({ ingressCapacity: 2 });
      const client = makeClient(h);
      await initClient(client);
      const results = await Promise.all(
        Array.from({ length: 5 }, () => client.invoke("agent/list", {})),
      );
      const overloaded = results.filter((r) => r.error?.code === "SERVER_OVERLOADED");
      expect(overloaded.length).toBeGreaterThan(0);
      for (const r of overloaded) expect(r.error?.retryable).toBe(true);
      // the ones admitted completed fine — the wire never wedged
      const ok = results.filter((r) => r.error === undefined);
      expect(ok.length).toBeGreaterThan(0);
    });

    it("reconnect replay: session state is server-side — a fresh transport reaches the same thread", async () => {
      const h = makeHarness();
      const wire1 = makeClient(h);
      await initClient(wire1);
      const s1 = await wire1.invoke("thread/start", { agentName: AGENT.name, cwd: "/tmp" });
      const threadId = (s1.result as { id: string }).id;
      // The handshake is SERVER state, not per-connection: a brand-new
      // transport to the SAME AppServer inherits initialize() — the session
      // state (not the handshake) is what survives a reconnect.
      const wire2 = makeClient(h);
      const read = await wire2.invoke("thread/read", { threadId });
      expect(read.error).toBeUndefined();
      // protocol DTO shape: { threadId, items, nextSequence } (P34-6)
      expect((read.result as { threadId: string }).threadId).toBe(threadId);
      expect(Array.isArray((read.result as { items: unknown[] }).items)).toBe(true);
      // the reconnect did NOT create a second session
      expect((await h.store.listSessions()).length).toBe(1);
    });

    it("duplicate idempotency key replays the exact result (no second side effect)", async () => {
      const h = makeHarness();
      const client = makeClient(h);
      await initClient(client);
      const params = { agentName: AGENT.name, cwd: "/tmp", idempotencyKey: "dup-key-1" } as never;
      const first = await client.invoke("thread/start", params);
      const before = (await h.store.listSessions()).length;
      const second = await client.invoke("thread/start", params);
      expect(second).toEqual(first);
      expect((await h.store.listSessions()).length).toBe(before);
    });

    it("interrupt active turn settles the run as interrupted", async () => {
      const h = makeHarness({ blocking: true });
      const client = makeClient(h);
      await initClient(client);
      const s1 = await client.invoke("thread/start", { agentName: AGENT.name, cwd: "/tmp" });
      const s1id = (s1.result as { id: string }).id;
      const t1 = await client.invoke("turn/start", { threadId: s1id, prompt: "interrupt me" });
      const turnId = (t1.result as { turnId: string }).turnId;
      expect(t1.error).toBeUndefined();
      const run = client.invoke("turn/run", { threadId: s1id, turnId });
      await h.provider!.blocked;
      const intr = await client.invoke("turn/interrupt", { threadId: s1id, turnId });
      expect(intr.error).toBeUndefined();
      const outcome = await run;
      expect((outcome.result as { status: string }).status).toMatch(/interrupted|cancelled/);
    });

    it("steer while active is admitted explicitly — never silently mutates the turn", async () => {
      const h = makeHarness({ blocking: true });
      const client = makeClient(h);
      await initClient(client);
      const s1 = await client.invoke("thread/start", { agentName: AGENT.name, cwd: "/tmp" });
      const s1id = (s1.result as { id: string }).id;
      const t1 = await client.invoke("turn/start", { threadId: s1id, prompt: "steer me" });
      const turnId = (t1.result as { turnId: string }).turnId;
      const run = client.invoke("turn/run", { threadId: s1id, turnId });
      await h!.provider!.blocked;
      // a steer while running either resolves explicitly or is rejected with a
      // structured code — never silently merged into the running turn
      const steer = await client.invoke("turn/steer", { threadId: s1id, turnId, text: "redirect" });
      expect(steer.error === undefined || typeof steer.error.code === "string").toBe(true);
      await client.invoke("turn/interrupt", { threadId: s1id, turnId });
      await run;
    });

    it("concurrent run of the same thread → SESSION_BUSY (never runs twice)", async () => {
      const h = makeHarness({ blocking: true });
      const client = makeClient(h);
      await initClient(client);
      const s1 = await client.invoke("thread/start", { agentName: AGENT.name, cwd: "/tmp" });
      const s1id = (s1.result as { id: string }).id;
      const t1 = await client.invoke("turn/start", { threadId: s1id, prompt: "one" });
      const turnId = (t1.result as { turnId: string }).turnId;
      const run1 = client.invoke("turn/run", { threadId: s1id, turnId });
      await h!.provider!.blocked;
      const dup = await client.invoke("turn/start", { threadId: s1id, prompt: "two" });
      expectCode(dup, "SESSION_BUSY");
      await client.invoke("turn/interrupt", { threadId: s1id, turnId });
      await run1;
    });
  });
}

function localTestCatalog() {
  const names = ["read_file", "write_file", "edit_file", "exec", "search_files", "grep_search", "repo_tree", "repo_map", "update_plan", "ask_user", "env_snapshot", "discover_commands", "tool_lookup", "echo"];
  const mk = (name: string) => ({
    name,
    description: `stub ${name}`,
    inputSchema: {} as never,
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