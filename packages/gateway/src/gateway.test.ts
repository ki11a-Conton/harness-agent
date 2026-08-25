import { afterEach, describe, expect, it } from "vitest";
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
import { eventSinkFromStore, newAgentId, newApprovalId, newEventId } from "@ar/contracts";
import { AgentRuntime, DefaultLoadedSessionManager } from "@ar/core";
import { ScriptedModelProvider } from "@ar/model";
import { SessionService } from "@ar/session";
import { InMemoryApprovalStore } from "@ar/security";
import { FakeChannel } from "./fakes/fake-channel.js";
import { Gateway } from "./gateway.js";
import { createRuntimeRpc } from "./rpc.js";
import type { RpcMethodRegistry } from "./rpc.js";

const AGENT: AgentDefinition = {
  id: newAgentId(),
  name: "gateway-agent",
  description: "gateway test agent",
  mode: "primary",
  model: { providerId: "scripted", modelId: "scripted-model" },
  systemPrompt: "you are a gateway test agent",
  tools: {},
  permissions: { rules: [] },
  skills: {},
  limits: {},
};

/** In-memory SessionStore (mirrors the rpc.test fake). */
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

/** In-memory EventStore (mirrors the rpc.test fake). */
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

/** Model that parks inside generate() until its AbortSignal fires. */
class BlockingProvider implements ModelProvider {
  readonly id = "blocking";
  private releaseBlocked?: () => void;
  readonly blocked: Promise<void> = new Promise((resolve) => {
    this.releaseBlocked = resolve;
  });
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
  approvalStore: InMemoryApprovalStore;
  runtime: AgentRuntime;
  rpc: RpcMethodRegistry;
  gateway: Gateway;
  channels: FakeChannel[];
  provider: ModelProvider;
  clock: { t: number };
}

function makeGateway(
  opts: {
    provider?: ModelProvider;
    channels?: FakeChannel[];
    route?: (from: string) => SessionId | undefined;
    sessionDefaults?: { agentId: typeof AGENT.id; cwd: string } | undefined;
    pollDelayMs?: number;
  } = {},
): Harness {
  const store = new MemSessionStore();
  const events = new MemEventStore();
  const orch = new FakeOrchestrator();
  const clock = { t: 1_000 };
  const provider = opts.provider ?? new ScriptedModelProvider([
    ScriptedModelProvider.text("ok"),
    ScriptedModelProvider.text("ok"),
    ScriptedModelProvider.text("ok"),
    ScriptedModelProvider.text("ok"),
  ]);
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
  const approvalStore = new InMemoryApprovalStore(() => clock.t);
  const sessions = new DefaultLoadedSessionManager({ runtime, store, emit: eventSinkFromStore(events) });
  const rpc = createRuntimeRpc(runtime, { sessionService, sessions, approvalStore, events });
  const channels = opts.channels ?? [new FakeChannel("ch-a")];
  const gateway = new Gateway({
    rpc,
    channels,
    sessionService,
    approvalStore,
    events,
    route: opts.route,
    sessionDefaults:
      "sessionDefaults" in opts
        ? opts.sessionDefaults
        : { agentId: AGENT.id, cwd: "C:\\work" },
    pollDelayMs: opts.pollDelayMs ?? 5,
  });
  return { store, events, approvalStore, runtime, rpc, gateway, channels, provider, clock };
}

// ---------------------------------------------------------------------------
// P29 — App Server protocol adapter tests (thin wire layer over the same
// runtime deps as the Gateway).
// ---------------------------------------------------------------------------
import { AppServer } from "./app-server.js";

describe("P29 AppServer (wire adapter)", () => {
  function makeAppServer() {
    const h = makeGateway();
    const sessionService = new SessionService({ store: h.store });
    const server = new AppServer({
      runtime: h.runtime,
      sessions: new DefaultLoadedSessionManager({ runtime: h.runtime, store: h.store }),
      sessionService,
      approvalStore: h.approvalStore,
      events: h.events,
      listAgents: () => [AGENT],
      ingressCapacity: 2,
    });
    return { server, store: h.store };
  }

  it("requires initialize before mutating methods", async () => {
    const { server } = makeAppServer();
    const res = await server.invoke("thread/start", { agentName: "x", cwd: "/tmp" });
    expect(res.error?.code).toBe("NOT_INITIALIZED");
    expect(res.error?.retryable).toBe(false);
  });

  it("initialize returns protocol version + server info + capabilities", async () => {
    const { server } = makeAppServer();
    const res = await server.invoke("initialize", {
      clientInfo: { name: "cli", version: "1.0.0" },
      capabilities: { streamingItems: true },
    });
    expect(res.result).toMatchObject({
      protocolVersion: "1",
      serverInfo: { name: "harness-app-server" },
      capabilities: { streamingItems: true, approvalForms: false },
    });
  });

  it("rejects repeated initialize with ALREADY_INITIALIZED", async () => {
    const { server } = makeAppServer();
    await server.invoke("initialize", { clientInfo: { name: "cli", version: "1" } });
    const res = await server.invoke("initialize", { clientInfo: { name: "cli", version: "1" } });
    expect(res.error?.code).toBe("ALREADY_INITIALIZED");
  });

  it("thread/start creates a session via the runtime", async () => {
    const { server, store } = makeAppServer();
    await server.invoke("initialize", { clientInfo: { name: "cli", version: "1" } });
    const res = await server.invoke("thread/start", { agentName: AGENT.name, cwd: "C:\\work" });
    expect(res.error).toBeUndefined();
    const sessions = await store.listSessions();
    expect(sessions.length).toBe(1);
    expect(sessions[0]?.agentId).toBe(AGENT.id);
  });

  it("bounded ingress capacity=2: third concurrent call rejects fast with SERVER_OVERLOADED", async () => {
    const { server } = makeAppServer();
    await server.invoke("initialize", { clientInfo: { name: "cli", version: "1" } });
    const q = (
      server as unknown as {
        ingress: { submit: (w: () => Promise<unknown>) => Promise<unknown>; pendingCount: number };
      }
    ).ingress;
    let release1!: () => void;
    const g1 = new Promise<void>((r) => {
      release1 = r;
    });
    const slow1 = q.submit(async () => {
      await g1;
      return "slow1";
    });
    const slow2 = q.submit(async () => "slow2");
    const rejected = q.submit(async () => "slow3").catch((e) => e as Error);
    expect(((await rejected) as Error).message).toContain("saturated");
    release1();
    expect(await slow1).toBe("slow1");
    expect(await slow2).toBe("slow2");
    expect(q.pendingCount).toBe(0);
  });

  it("idempotency key replays the result instead of re-running", async () => {
    const { server, store } = makeAppServer();
    await server.invoke("initialize", { clientInfo: { name: "cli", version: "1" } });
    const params = { agentName: AGENT.name, cwd: "C:\\work", idempotencyKey: "k-thread-1" };
    const first = await server.invoke("thread/start", params);
    const before = (await store.listSessions()).length;
    const second = await server.invoke("thread/start", params);
    expect(second.result).toEqual(first.result);
    expect((await store.listSessions()).length).toBe(before);
  });

  it("unknown method fails closed", async () => {
    const { server } = makeAppServer();
    await server.invoke("initialize", { clientInfo: { name: "cli", version: "1" } });
    const res = await server.invoke("nope/nowhere", {});
    expect(res.error?.code).toBe("INTERNAL_ERROR");
    expect(res.error?.retryable).toBe(false);
  });
});

const gateways: Gateway[] = [];

afterEach(async () => {
  for (const g of gateways.splice(0)) {
    await g.stop();
  }
});

/** Scan the channel send queue from `startIndex` until a text matches. */
async function waitForMessage(
  channel: FakeChannel,
  predicate: (text: string) => boolean,
  startIndex = 0,
  timeoutMs = 3_000,
): Promise<{ text: string; nextIndex: number }> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const texts = channel.sentTexts();
    for (let i = Math.max(0, startIndex); i < texts.length; i += 1) {
      const text = texts[i]!;
      if (predicate(text)) return { text, nextIndex: i + 1 };
    }
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error(
    `timed out waiting for a channel message on ${channel.id}; queue: ${JSON.stringify(channel.sentTexts())}`,
  );
}

async function waitFor(
  predicate: () => Promise<boolean>,
  timeoutMs = 3_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error("timed out in waitFor");
}

async function appendEvent(events: MemEventStore, event: Omit<AgentEvent, "sequence">): Promise<void> {
  await events.append({ sequence: 0, ...event });
}

describe("Gateway routing", () => {
  it("routes a channel message into a fresh session and replies with the run result", async () => {
    const h = makeGateway();
    gateways.push(h.gateway);
    await h.gateway.start();
    await h.channels[0]!.deliver("hello agent");

    const reply = await waitForMessage(h.channels[0]!, (t) => t.startsWith("[run]"));
    expect(reply.text).toMatch(/^\[run\] completed turn:/);
    expect(h.channels[0]!.sent[0]!.recipient).toBe("user-1");

    const sessions = await h.store.listSessions();
    expect(sessions).toHaveLength(1);
    const turns = await h.store.listTurns(sessions[0]!.id);
    expect(turns).toHaveLength(1);
    expect(turns[0]!.input.text).toBe("hello agent");
    expect((await h.events.list(sessions[0]!.id)).map((e) => e.type)).toContain("turn.completed");

    // Same sender reuses the session instead of creating a second one.
    await h.channels[0]!.deliver("second message");
    await waitForMessage(h.channels[0]!, (t) => t.startsWith("[run]"), reply.nextIndex);
    expect(await h.store.listSessions()).toHaveLength(1);
    expect(await h.store.listTurns(sessions[0]!.id)).toHaveLength(2);
  });

  it("reuses an existing session when route maps the sender, and falls back to creation on a stale route", async () => {
    let routed: SessionId | undefined;
    const h = makeGateway({
      route: () => routed,
      sessionDefaults: { agentId: AGENT.id, cwd: "C:\\work" },
    });
    gateways.push(h.gateway);
    const existing = (await h.rpc.invoke("session.create", {
      agentId: AGENT.id,
      cwd: "C:\\work",
    })) as Session;
    routed = existing.id;

    await h.gateway.start();
    await h.channels[0]!.deliver("do it");
    const reply = await waitForMessage(h.channels[0]!, (t) => t.startsWith("[run]"));
    expect(reply.text).toMatch(/completed/);
    // No second session: the routed one received the turn.
    expect(await h.store.listSessions()).toHaveLength(1);
    expect(await h.store.listTurns(existing.id)).toHaveLength(1);

    // A stale route id fails session validation → a fresh session is created
    // (checked for a new sender; the bound user keeps its own session).
    routed = "session_gone" as SessionId;
    await h.channels[0]!.deliver("more", "second-user");
    await waitForMessage(h.channels[0]!, (t) => t.startsWith("[run]"), reply.nextIndex);
    const sessions = await h.store.listSessions();
    expect(sessions).toHaveLength(2);
    expect(sessions[1]!.id).not.toBe(existing.id);
  });

  it("replies with an error when no session can be created (no route, no defaults)", async () => {
    const h = makeGateway({ sessionDefaults: undefined });
    gateways.push(h.gateway);
    await h.gateway.start();
    await h.channels[0]!.deliver("hello");
    const reply = await waitForMessage(h.channels[0]!, (t) => t.startsWith("[error]"));
    expect(reply.text).toContain("no default agent");
    expect(await h.store.listSessions()).toHaveLength(0);
  });

  it("P25-3/P25-5: a message while a turn is running is queued as a follow-up, never injected", async () => {
    const h = makeGateway({ provider: new BlockingProvider() });
    gateways.push(h.gateway);
    await h.gateway.start();

    await h.channels[0]!.deliver("first message");
    const sessions = await h.store.listSessions();
    const sid = sessions[0]!.id;
    // Wait until the first turn is actually active (actor owns the run).
    await waitFor(async () => {
      const st = (await h.rpc.invoke("session.status", { sessionId: sid })) as { activeTurn?: unknown };
      return st.activeTurn !== undefined;
    });

    // Second message while the first turn runs: explicitly queued.
    await h.channels[0]!.deliver("second message");
    const queued = await waitForMessage(h.channels[0]!, (t) => t.startsWith("[queued]"));
    expect(queued.text).toContain("follow-up");

    // The second message is NOT injected into the running turn.
    expect((await h.store.listMessages(sid)).some((m) => m.content === "second message")).toBe(false);

    // Interrupting turn 1 drains the queued follow-up into a NEW turn.
    await h.rpc.invoke("session.interrupt", { sessionId: sid });
    await waitForMessage(h.channels[0]!, (t) => t.startsWith("[run]"));
    await waitFor(async () =>
      (await h.store.listMessages(sid)).some((m) => m.content === "second message"),
    );
    expect(await h.store.listTurns(sid)).toHaveLength(2);
  });
});

describe("Gateway approvals", () => {
  function pendingApproval(clock: { t: number }, sessionId: SessionId): ApprovalRequest {
    return {
      id: newApprovalId(),
      sessionId,
      agentId: AGENT.id,
      action: "exec",
      target: "rm -rf /tmp/x",
      reason: "risky command",
      createdAt: clock.t,
      expiresAt: clock.t + 60_000,
    };
  }

  it("resolves approve:<id>:allow through session.approve and records human.approval", async () => {
    const h = makeGateway();
    gateways.push(h.gateway);
    await h.gateway.start();
    const sessionId = "session_approval" as SessionId;
    const request = pendingApproval(h.clock, sessionId);
    h.approvalStore.create(request);

    await h.channels[0]!.deliver(`approve:${request.id}:allow`);
    const reply = await waitForMessage(h.channels[0]!, (t) => t.startsWith("[approve]"));
    expect(reply.text).toBe(`[approve] ${request.id} allow`);

    const human = (await h.events.list(sessionId)).find((e) => e.type === "human.approval");
    expect(human?.payload).toMatchObject({
      approvalId: request.id,
      value: "allow",
      decidedBy: "ch-a:user-1",
    });
  });

  it("resolves approve:<id>:deny through session.approve", async () => {
    const h = makeGateway();
    gateways.push(h.gateway);
    await h.gateway.start();
    const request = pendingApproval(h.clock, "session_approval" as SessionId);
    h.approvalStore.create(request);

    await h.channels[0]!.deliver(`approve:${request.id}:deny`);
    const reply = await waitForMessage(h.channels[0]!, (t) => t.startsWith("[approve]"));
    expect(reply.text).toBe(`[approve] ${request.id} deny`);
  });

  it("replies with an error message for an unknown approval id", async () => {
    const h = makeGateway();
    gateways.push(h.gateway);
    await h.gateway.start();
    await h.channels[0]!.deliver("approve:approval_nope:allow");
    const reply = await waitForMessage(h.channels[0]!, (t) => t.startsWith("[approve]"));
    expect(reply.text).toContain("unknown or already-resolved approval: approval_nope");
  });
});

describe("Gateway event push", () => {
  /** Bind a session to the channel user so the poller has a recipient. */
  async function bindSession(h: Harness): Promise<{ nextIndex: number; session: Session }> {
    await h.channels[0]!.deliver("start work");
    const reply = await waitForMessage(h.channels[0]!, (t) => t.startsWith("[run]"));
    const session = (await h.store.listSessions())[0]!;
    return { nextIndex: reply.nextIndex, session };
  }

  it("pushes approval.created to the channel with full action/target/reason/session fields", async () => {
    const h = makeGateway({ pollDelayMs: 2 });
    gateways.push(h.gateway);
    await h.gateway.start();
    const { nextIndex, session } = await bindSession(h);

    const request: ApprovalRequest = {
      id: newApprovalId(),
      sessionId: session.id,
      agentId: AGENT.id,
      action: "exec",
      target: "rm -rf /tmp/x",
      reason: "risky command",
      policyRule: "rule-1",
      createdAt: h.clock.t,
      expiresAt: h.clock.t + 60_000,
    };
    h.approvalStore.create(request);
    await appendEvent(h.events, {
      id: newEventId(),
      sessionId: session.id,
      timestamp: Date.now(),
      type: "approval.created",
      payload: {
        approvalId: request.id,
        target: request.target,
        reason: request.reason,
        expiresAt: request.expiresAt,
      },
    });

    const pushed = await waitForMessage(
      h.channels[0]!,
      (t) => t.includes("action: exec"),
      nextIndex,
    );
    expect(pushed.text).toContain("action: exec");
    expect(pushed.text).toContain("target: rm -rf /tmp/x");
    expect(pushed.text).toContain("reason: risky command");
    expect(pushed.text).toContain(session.id);
    expect(pushed.text).toContain(`agent: ${AGENT.id}`);
    expect(pushed.text).toContain("policy: rule-1");
    expect(pushed.text).toContain("expires: 61000");
    expect(pushed.text).toContain(`approve:${request.id}:allow`);
    expect(pushed.text).toContain(`approve:${request.id}:deny`);
  });

  it("pushes tool.permission_requested events to the channel", async () => {
    const h = makeGateway({ pollDelayMs: 2 });
    gateways.push(h.gateway);
    await h.gateway.start();
    const { nextIndex, session } = await bindSession(h);

    await appendEvent(h.events, {
      id: newEventId(),
      sessionId: session.id,
      timestamp: Date.now(),
      type: "tool.permission_requested",
      payload: { toolCallId: "toolcall_1", tool: "read_file", approvalId: "approval_1" },
    });

    const pushed = await waitForMessage(
      h.channels[0]!,
      (t) => t.startsWith("[permission]"),
      nextIndex,
    );
    expect(pushed.text).toContain("read_file");
    expect(pushed.text).toContain("approval_1");
  });

  it("pushes run.limit_reached events and ignores non-forwarded event types", async () => {
    const h = makeGateway({ pollDelayMs: 2 });
    gateways.push(h.gateway);
    await h.gateway.start();
    const { nextIndex, session } = await bindSession(h);

    await appendEvent(h.events, {
      id: newEventId(),
      sessionId: session.id,
      timestamp: Date.now(),
      type: "run.limit_reached",
      payload: { limit: "maxTokens", used: 4_000 },
    });
    const pushed = await waitForMessage(
      h.channels[0]!,
      (t) => t.startsWith("[limit]"),
      nextIndex,
    );
    expect(pushed.text).toContain("maxTokens");
    expect(pushed.text).toContain("4000");

    const countAfterLimit = h.channels[0]!.sent.length;
    await appendEvent(h.events, {
      id: newEventId(),
      sessionId: session.id,
      timestamp: Date.now(),
      type: "turn.started",
      payload: { turnId: "turn_x" },
    });
    await new Promise((r) => setTimeout(r, 40));
    expect(h.channels[0]!.sent.length).toBe(countAfterLimit);
  });

  it("falls back to event payload fields when the pending approval is already gone", async () => {
    const h = makeGateway({ pollDelayMs: 2 });
    gateways.push(h.gateway);
    await h.gateway.start();
    const { nextIndex, session } = await bindSession(h);

    await appendEvent(h.events, {
      id: newEventId(),
      sessionId: session.id,
      timestamp: Date.now(),
      type: "approval.created",
      payload: {
        approvalId: "approval_resolved",
        target: "npm test",
        reason: "payload-only reason",
        expiresAt: 99,
      },
    });
    const pushed = await waitForMessage(
      h.channels[0]!,
      (t) => t.includes("approval_resolved"),
      nextIndex,
    );
    expect(pushed.text).toContain("action: unknown");
    expect(pushed.text).toContain("target: npm test");
    expect(pushed.text).toContain("reason: payload-only reason");
  });
});

describe("Gateway cancellation", () => {
  it("treats a cancel message as human.cancel and aborts the running turn", async () => {
    const provider = new BlockingProvider();
    const h = makeGateway({ provider });
    gateways.push(h.gateway);
    await h.gateway.start();

    await h.channels[0]!.deliver("block me");
    await provider.blocked;

    await h.channels[0]!.deliver("cancel");
    // The cancel settles both the abort reply and the original run reply.
    const texts = h.channels[0]!.sentTexts();
    expect(texts).toContain("[cancel] cancelled");
    expect(texts.some((t) => t.startsWith("[run] cancelled"))).toBe(true);

    const session = (await h.store.listSessions())[0]!;
    const turn = (await h.store.listTurns(session.id))[0]!;
    expect(turn.status).toBe("cancelled");
    const human = (await h.events.list(session.id)).find((e) => e.type === "human.cancel");
    expect(human?.payload).toMatchObject({ text: "cancel", turnId: turn.id });
  });

  it("reports not_running when the sender has no active turn", async () => {
    const h = makeGateway();
    gateways.push(h.gateway);
    await h.gateway.start();
    await h.channels[0]!.deliver("hello agent");
    await waitForMessage(h.channels[0]!, (t) => t.startsWith("[run]"));
    await h.channels[0]!.deliver("cancel");
    const reply = await waitForMessage(h.channels[0]!, (t) => t.startsWith("[cancel]"));
    expect(reply.text).toBe("[cancel] not_running");
  });
});

describe("Gateway lifecycle and isolation", () => {
  it("connects channels on start and disconnects them on stop", async () => {
    const ch = new FakeChannel("life");
    const h = makeGateway({ channels: [ch] });
    gateways.push(h.gateway);
    await h.gateway.start();
    expect(ch.connected).toBe(true);
    expect(ch.connectCount).toBe(1);

    await expect(h.gateway.start()).rejects.toThrow(/already started/);

    await h.gateway.stop();
    expect(ch.connected).toBe(false);
    expect(ch.disconnectCount).toBe(1);

    await h.gateway.stop(); // idempotent
    expect(ch.disconnectCount).toBe(1);

    // Messages after stop are ignored (no handler effect, no replies).
    await ch.deliver("hello");
    expect(ch.sent).toHaveLength(0);
  });

  it("keeps channels isolated: separate sessions, replies and approvals per channel", async () => {
    const chA = new FakeChannel("ch-a");
    const chB = new FakeChannel("ch-b");
    const h = makeGateway({ channels: [chA, chB] });
    gateways.push(h.gateway);
    await h.gateway.start();

    await chA.deliver("hello", "alice");
    await chB.deliver("hello", "bob");
    const replyA = await waitForMessage(chA, (t) => t.startsWith("[run]"));
    const replyB = await waitForMessage(chB, (t) => t.startsWith("[run]"));
    expect(replyA.text).toMatch(/completed/);
    expect(replyB.text).toMatch(/completed/);
    expect(chA.sent.map((s) => s.recipient)).toEqual(["alice"]);
    expect(chB.sent.map((s) => s.recipient)).toEqual(["bob"]);
    const sessions = await h.store.listSessions();
    expect(sessions).toHaveLength(2);

    // An approval resolved on channel A never reaches channel B.
    const request: ApprovalRequest = {
      id: newApprovalId(),
      sessionId: sessions[0]!.id,
      agentId: AGENT.id,
      action: "exec",
      target: "rm -rf /tmp/x",
      reason: "risky command",
      createdAt: h.clock.t,
      expiresAt: h.clock.t + 60_000,
    };
    h.approvalStore.create(request);
    await chA.deliver(`approve:${request.id}:allow`);
    await waitForMessage(chA, (t) => t.startsWith("[approve]"), replyA.nextIndex);
    await new Promise((r) => setTimeout(r, 30));
    expect(chB.sentTexts().filter((t) => t.startsWith("[approve]"))).toHaveLength(0);
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
