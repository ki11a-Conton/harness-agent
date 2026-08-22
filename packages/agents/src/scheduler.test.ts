import { describe, expect, it } from "vitest";
import type {
  AgentDefinition,
  AgentEvent,
  DelegationLimits,
  EventStore,
  Message,
  Session,
  SessionId,
  SessionStore,
  ToolCallRequest,
  ToolExecutionContext,
  ToolOrchestrator,
  ToolResult,
  Turn,
  TurnId,
  Verifier,
} from "@ar/contracts";
import { newAgentId, newSessionId } from "@ar/contracts";
import { ScriptedModelProvider } from "@ar/model";
import type { Script } from "@ar/model";
import { AgentRuntime } from "@ar/core";
import { AgentExecutionScheduler } from "./scheduler.js";
import { Delegator } from "./delegator.js";

// ---- in-memory fakes -------------------------------------------------------

class MemorySessionStore implements SessionStore {
  sessions = new Map<string, Session>();
  turns = new Map<string, Turn>();
  messages: Message[] = [];
  snapshots = new Map<string, Record<string, unknown>>();

  async createSession(session: Session): Promise<void> {
    this.sessions.set(session.id, session);
  }
  async getSession(id: SessionId): Promise<Session | undefined> {
    return this.sessions.get(id);
  }
  async updateSession(session: Session): Promise<void> {
    this.sessions.set(session.id, session);
  }
  async listSessions(opts?: { parentId?: SessionId; status?: Session["status"] }): Promise<Session[]> {
    let all = [...this.sessions.values()];
    if (opts?.parentId !== undefined) all = all.filter((s) => s.parentId === opts.parentId);
    if (opts?.status !== undefined) all = all.filter((s) => s.status === opts.status);
    return all;
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
  async saveStateSnapshot(sessionId: SessionId, snapshot: Record<string, unknown>): Promise<void> {
    this.snapshots.set(sessionId, snapshot);
  }
  async loadStateSnapshot(sessionId: SessionId): Promise<Record<string, unknown> | undefined> {
    return this.snapshots.get(sessionId);
  }
}

class MemoryEventStore implements EventStore {
  events: AgentEvent[] = [];
  private seq = 0;
  async nextSequence(): Promise<number> {
    return this.seq + 1;
  }
  async append(event: AgentEvent): Promise<AgentEvent> {
    const stored = { ...event, sequence: ++this.seq };
    this.events.push(stored);
    return stored;
  }
  async list(sessionId: SessionId, opts?: { afterSequence?: number; limit?: number }): Promise<AgentEvent[]> {
    let list = this.events.filter((e) => e.sessionId === sessionId);
    if (opts?.afterSequence !== undefined) list = list.filter((e) => e.sequence > opts.afterSequence!);
    if (opts?.limit !== undefined) list = list.slice(0, opts.limit);
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
  calls: Array<{ request: ToolCallRequest }> = [];
  constructor(private readonly result: ToolResult = { status: "success", output: "fake-ok" }) {}
  async execute(request: ToolCallRequest, _context: ToolExecutionContext): Promise<ToolResult> {
    this.calls.push({ request });
    return this.result;
  }
}

const PARENT: AgentDefinition = {
  id: newAgentId(),
  name: "parent",
  description: "parent test agent",
  mode: "primary",
  model: { providerId: "scripted", modelId: "scripted-model" },
  systemPrompt: "parent prompt",
  tools: {},
  permissions: { rules: [] },
  skills: {},
  limits: {},
};

const SUBAGENT: AgentDefinition = {
  id: newAgentId(),
  name: "sub",
  description: "subagent test agent",
  mode: "subagent",
  model: { providerId: "scripted", modelId: "scripted-model" },
  systemPrompt: "sub prompt",
  tools: {},
  permissions: { rules: [] },
  skills: {},
  limits: {},
};

function makeHarness(opts?: {
  scripts?: Script[];
  limits?: Partial<DelegationLimits>;
  schedulerLimits?: Partial<import("@ar/contracts").SchedulerLimits>;
  scheduler?: AgentExecutionScheduler;
  now?: () => number;
  verifier?: Verifier;
}) {
  const store = new MemorySessionStore();
  const events = new MemoryEventStore();
  const now = opts?.now ?? Date.now;
  const provider = new ScriptedModelProvider(opts?.scripts ?? [ScriptedModelProvider.text("child done")]);
  const runtime = new AgentRuntime({
    store,
    events,
    modelProvider: provider,
    orchestrator: new FakeOrchestrator(),
    agents: [PARENT, SUBAGENT],
    now,
    ...(opts?.verifier !== undefined
      ? { task: { id: "t", goal: "g", verification: [] }, verifier: opts.verifier }
      : {}),
  });
  // The scheduler MUST share the harness store (it resolves root+depth from it).
  const scheduler =
    opts?.scheduler ??
    (opts?.schedulerLimits !== undefined
      ? new AgentExecutionScheduler({ store, limits: opts.schedulerLimits })
      : undefined);
  const delegator = new Delegator({
    runtime,
    store,
    events,
    agentId: SUBAGENT.id,
    limits: opts?.limits,
    now,
    ...(scheduler !== undefined ? { scheduler } : {}),
  });
  return { store, events, runtime, delegator, provider, scheduler };
}

async function sessionIn(store: SessionStore, parentId?: SessionId): Promise<Session> {
  const session: Session = {
    id: `session_${Math.random().toString(36).slice(2)}` as never,
    ...(parentId !== undefined ? { parentId } : {}),
    agentId: PARENT.id,
    model: PARENT.model,
    cwd: "C:\\work",
    status: "active",
    createdAt: 0,
    updatedAt: 0,
  };
  await store.createSession(session);
  return session;
}

async function makeTree(store: SessionStore, depth: number): Promise<Session[]> {
  const levels: Session[] = [];
  for (let i = 0; i < depth; i += 1) {
    levels.push(await sessionIn(store, levels[i - 1]?.id));
  }
  return levels;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---- scheduler unit tests ----------------------------------------------------

describe("AgentExecutionScheduler (P1-6) — unit", () => {
  it("queues beyond maxGlobalAgents and starts FIFO on release (fairness)", async () => {
    const store = new MemorySessionStore();
    const [root] = await makeTree(store, 1) as unknown as [Session];
    const scheduler = new AgentExecutionScheduler({ store, limits: { maxGlobalAgents: 1, maxAgentsPerRoot: 1 } });

    const a = scheduler.acquire({ parentSessionId: root.id, agentId: SUBAGENT.id }, new AbortController().signal);
    const entered = [await a];
    // second request must queue
    const bPromise = scheduler.acquire({ parentSessionId: root.id, agentId: SUBAGENT.id }, new AbortController().signal);
    await new Promise((r) => setTimeout(r, 1)); // let acquire() reach the queue
    expect(scheduler.snapshot().find((e) => e.state === "queued")).toBeDefined();

    entered[0]!.release();
    const b = await bPromise;
    entered.push(b);
    expect(entered[0]!.entry.startedAt!).toBeLessThanOrEqual(entered[1]!.entry.startedAt!);
    b.release();
    expect(entered[1]!.entry.state).toBe("done");
  });

  it("maxAgentsPerRoot limits a subtree while other roots keep running (sibling isolation)", async () => {
    const store = new MemorySessionStore();
    const [r1] = await makeTree(store, 1) as unknown as [Session];
    const [r2] = await makeTree(store, 1) as unknown as [Session];
    const scheduler = new AgentExecutionScheduler({ store, limits: { maxGlobalAgents: 4, maxAgentsPerRoot: 1 } });

    const a = await scheduler.acquire({ parentSessionId: r1.id, agentId: SUBAGENT.id }, new AbortController().signal);
    const c = await scheduler.acquire({ parentSessionId: r2.id, agentId: SUBAGENT.id }, new AbortController().signal);
    // same root as A is queued; root2 runs immediately
    const b = scheduler.acquire({ parentSessionId: r1.id, agentId: SUBAGENT.id }, new AbortController().signal);
    await delay(5);
    expect(a.signal.aborted).toBe(false);
    expect(c.signal.aborted).toBe(false);
    expect(scheduler.snapshot().filter((e) => e.state === "queued").length).toBe(1);

    a.release();
    const bToken = await b;
    bToken.release();
    c.release();
  });

  it("rejects beyond maxDepth (defense against exponential fan-out)", async () => {
    const store = new MemorySessionStore();
    const levels = await makeTree(store, 3); // depth 0,1,2
    const scheduler = new AgentExecutionScheduler({ store, limits: { maxDepth: 2 } });

    // A child of the depth-2 session would sit at depth 3 > maxDepth.
    await expect(
      scheduler.acquire({ parentSessionId: levels[2]!.id, agentId: SUBAGENT.id }, new AbortController().signal),
    ).rejects.toMatchObject({ info: expect.objectContaining({ code: "RESOURCE_LIMIT" }) });
  });

  it("a queued request cancelled by its caller never starts (no session created)", async () => {
    const store = new MemorySessionStore();
    const [root] = await makeTree(store, 1) as unknown as [Session];
    const scheduler = new AgentExecutionScheduler({ store, limits: { maxGlobalAgents: 1 } });

    const a = await scheduler.acquire({ parentSessionId: root.id, agentId: SUBAGENT.id }, new AbortController().signal);
    const acB = new AbortController();
    const b = scheduler.acquire({ parentSessionId: root.id, agentId: SUBAGENT.id }, acB.signal);
    await delay(1);
    acB.abort();
    await expect(b).rejects.toMatchObject({
      info: expect.objectContaining({ code: "USER_CANCELLED" }),
    });
    expect(scheduler.snapshot().filter((e) => e.state === "queued")).toHaveLength(0);
    a.release();
  });

  it("cancelSubtree aborts queued and running entries under that root", async () => {
    const store = new MemorySessionStore();
    const [root] = await makeTree(store, 1) as unknown as [Session];
    const scheduler = new AgentExecutionScheduler({ store, limits: { maxGlobalAgents: 1 } });

    const a = await scheduler.acquire({ parentSessionId: root.id, agentId: SUBAGENT.id }, new AbortController().signal);
    const b = scheduler.acquire({ parentSessionId: root.id, agentId: SUBAGENT.id }, new AbortController().signal);
    await new Promise((r) => setTimeout(r, 1)); // let B queue before the subtree cancel

    scheduler.cancelSubtree(root.id);
    expect(a.signal.aborted).toBe(true);
    await expect(b).rejects.toMatchObject({
      info: expect.objectContaining({ code: "USER_CANCELLED" }),
    });
  });

  it("cancelSubtree honours sibling roots (one subtree only)", async () => {
    const store = new MemorySessionStore();
    const [r1] = await makeTree(store, 1) as unknown as [Session];
    const [r2] = await makeTree(store, 1) as unknown as [Session];
    const scheduler = new AgentExecutionScheduler({ store, limits: { maxGlobalAgents: 2 } });

    const a = await scheduler.acquire({ parentSessionId: r1.id, agentId: SUBAGENT.id }, new AbortController().signal);
    const c = await scheduler.acquire({ parentSessionId: r2.id, agentId: SUBAGENT.id }, new AbortController().signal);

    scheduler.cancelSubtree(r1.id);
    expect(a.signal.aborted).toBe(true);
    expect(c.signal.aborted).toBe(false);
    c.release();
  });

  it("wall-clock budget cancels a running agent (maxDurationMs)", async () => {
    const store = new MemorySessionStore();
    const [root] = await makeTree(store, 1) as unknown as [Session];
    const scheduler = new AgentExecutionScheduler({ store, limits: { maxDurationMs: 10 } });

    const token = await scheduler.acquire({ parentSessionId: root.id, agentId: SUBAGENT.id }, new AbortController().signal);
    await delay(30);
    expect(token.signal.aborted).toBe(true);
    token.release();
  });
});

// ---- delegator integration ---------------------------------------------------

describe("AgentExecutionScheduler (P1-6) — delegator integration", () => {
  it("children run through the scheduler slot: queued beyond the global cap still complete in order", async () => {
    const h = makeHarness({
      scripts: Array.from({ length: 3 }, () => ScriptedModelProvider.text("child done")),
      schedulerLimits: { maxGlobalAgents: 1, maxAgentsPerRoot: 1 },
    });
    const parent = await h.runtime.createSession({ agent: PARENT, cwd: "C:\\work" });

    const results = await Promise.all([
      h.delegator.delegate({ parentSessionId: parent.id, goal: "g1" }, new AbortController().signal),
      h.delegator.delegate({ parentSessionId: parent.id, goal: "g2" }, new AbortController().signal),
      h.delegator.delegate({ parentSessionId: parent.id, goal: "g3" }, new AbortController().signal),
    ]);

    expect(results.map((r) => r.status)).toEqual(["success", "success", "success"]);
    expect(results.map((r) => r.childSessionId)).toHaveLength(3);
    const children = await h.store.listSessions({ parentId: parent.id });
    expect(children).toHaveLength(3);
  });

  it("cancelSubtree surfaces as a structured cancelled delegation for the child", async () => {
    const slowScript: Script = {
      [Symbol.asyncIterator]() {
        const events = ScriptedModelProvider.text("still working");
        const state = { i: 0 };
        return {
          async next() {
            if (state.i >= events.length) return { done: true, value: undefined as never };
            if (state.i === 0) {
              await new Promise((r) => setTimeout(r, 30));
            }
            state.i += 1;
            return { done: false, value: events[state.i - 1]! };
          },
        };
      },
    };
    const h = makeHarness({
      scripts: [slowScript],
      schedulerLimits: { maxGlobalAgents: 1 },
    });
    const parent = await h.runtime.createSession({ agent: PARENT, cwd: "C:\\work" });

    const pending = h.delegator.delegate({ parentSessionId: parent.id, goal: "g" }, new AbortController().signal);
    // Wait until the scheduler actually shows the child running before
    // cancelling the subtree (the acquire/start window is async).
    for (let i = 0; i < 50 && h.scheduler!.snapshot().filter((e) => e.state === "running").length === 0; i += 1) {
      await delay(2);
    }
    h.scheduler!.cancelSubtree(parent.id);

    const result = await pending;
    expect(result.status).toBe("cancelled");
  });
});
describe("AgentExecutionScheduler tree budgeting (P1-7)", () => {
  it("pre-reserves an allocation and refunds the unused part on release", async () => {
    const store = new MemorySessionStore();
    const [root] = await makeTree(store, 1) as unknown as [Session];
    const scheduler = new AgentExecutionScheduler({ store });
    const budget: any = { maxToolCalls: 10 }; // headroom 20% -> pool 8
    scheduler.setRootBudget(root.id, budget);

    expect(scheduler.treeBudgetRemaining(root.id)).toEqual({ allocated: 10, remaining: 8 });

    // A reserves 5; the pool drops to 3.
    const a = await scheduler.acquire({ parentSessionId: root.id, agentId: SUBAGENT.id, toolBudget: 5 }, new AbortController().signal);
    expect(scheduler.treeBudgetRemaining(root.id)!.remaining).toBe(3);

    // A only spent 2: release refunds the other 3.
    a.release(2);
    expect(scheduler.treeBudgetRemaining(root.id)!.remaining).toBe(6);
  });

  it("child cannot spend outside its allocation: exhausted tree tool budget rejects (RESOURCE_LIMIT)", async () => {
    const store = new MemorySessionStore();
    const [root] = await makeTree(store, 1) as unknown as [Session];
    const scheduler = new AgentExecutionScheduler({ store });
    scheduler.setRootBudget(root.id, { maxToolCalls: 5 }); // pool 4

    const a = await scheduler.acquire({ parentSessionId: root.id, agentId: SUBAGENT.id, toolBudget: 4 }, new AbortController().signal);
    await expect(
      scheduler.acquire({ parentSessionId: root.id, agentId: SUBAGENT.id, toolBudget: 2 }, new AbortController().signal),
    ).rejects.toMatchObject({
      info: expect.objectContaining({ code: "RESOURCE_LIMIT", message: expect.stringContaining("tree tool-call budget exhausted") }),
    });

    // The second request never started: only A consumed a slot.
    expect(scheduler.snapshot().filter((e) => e.state === "running")).toHaveLength(1);
    a.release(1);
  });

  it("tree wall-clock budget cancels the whole subtree (maxDurationMs minus root headroom)", async () => {
    const store = new MemorySessionStore();
    const [root] = await makeTree(store, 1) as unknown as [Session];
    const scheduler = new AgentExecutionScheduler({ store });
    scheduler.setRootBudget(root.id, { maxDurationMs: 20 }); // child budget 16ms

    const token = await scheduler.acquire({ parentSessionId: root.id, agentId: SUBAGENT.id }, new AbortController().signal);
    await delay(35);
    expect(token.signal.aborted).toBe(true);
    token.release(0);
  });

  it("headroom is reserved for the root: children draw from the pool, not the whole budget", async () => {
    const store = new MemorySessionStore();
    const [root] = await makeTree(store, 1) as unknown as [Session];
    const scheduler = new AgentExecutionScheduler({ store });
    scheduler.setRootBudget(root.id, { maxToolCalls: 100 }); // pool 80, headroom 20

    // 20 children allocating exactly the pool leaves nothing for a 21st.
    for (let i = 0; i < 20; i += 1) {
      await scheduler.acquire({ parentSessionId: root.id, agentId: SUBAGENT.id, toolBudget: 4 }, new AbortController().signal).then((t) => t.release(4));
    }
    expect(scheduler.treeBudgetRemaining(root.id)!.remaining).toBe(0);
    await expect(
      scheduler.acquire({ parentSessionId: root.id, agentId: SUBAGENT.id, toolBudget: 1 }, new AbortController().signal),
    ).rejects.toMatchObject({ info: expect.objectContaining({ code: "RESOURCE_LIMIT" }) });
  });

  it("P0-11: token budget pre-reserves allocation and blocks exhaustion", async () => {
    const store = new MemorySessionStore();
    const [root] = await makeTree(store, 1) as unknown as [Session];
    const scheduler = new AgentExecutionScheduler({ store });
    scheduler.setRootBudget(root.id, { maxTokens: 1000 }); // pool 800, headroom 200

    expect(scheduler.tokenBudgetRemaining(root.id)!.remaining).toBe(800);

    const a = await scheduler.acquire({ parentSessionId: root.id, agentId: SUBAGENT.id, tokenBudget: 300 }, new AbortController().signal);
    expect(scheduler.tokenBudgetRemaining(root.id)!.remaining).toBe(500);

    // Token budget exhaustion rejects.
    await expect(
      scheduler.acquire({ parentSessionId: root.id, agentId: SUBAGENT.id, tokenBudget: 800 }, new AbortController().signal),
    ).rejects.toMatchObject({
      info: expect.objectContaining({ code: "RESOURCE_LIMIT", message: expect.stringContaining("tree token budget exhausted") }),
    });
    a.release(0);
  });

  it("P0-11: reportUsage accumulates token usage into the tree budget", async () => {
    const store = new MemorySessionStore();
    const [root] = await makeTree(store, 1) as unknown as [Session];
    const scheduler = new AgentExecutionScheduler({ store });
    scheduler.setRootBudget(root.id, { maxTokens: 1000 });

    // Simulate model calls reporting token usage.
    scheduler.reportUsage(root.id, { inputTokens: 100, outputTokens: 50, source: "measured" });
    expect(scheduler.tokenBudgetRemaining(root.id)!.remaining).toBe(650); // 800 - 150

    scheduler.reportUsage(root.id, { inputTokens: 200, outputTokens: 25, source: "measured" });
    expect(scheduler.tokenBudgetRemaining(root.id)!.remaining).toBe(425); // 650 - 225

    const a = await scheduler.acquire({ parentSessionId: root.id, agentId: SUBAGENT.id, tokenBudget: 200 }, new AbortController().signal);
    expect(scheduler.tokenBudgetRemaining(root.id)!.remaining).toBe(225); // 425 - 200
    a.release(0);
  });

  it("P0-11: token budget undefined allows unlimited usage", async () => {
    const store = new MemorySessionStore();
    const [root] = await makeTree(store, 1) as unknown as [Session];
    const scheduler = new AgentExecutionScheduler({ store });
    // No token budget set — all acquire/reportUsage calls succeed.
    expect(scheduler.tokenBudgetRemaining(root.id)).toBeUndefined();
    for (let i = 0; i < 100; i += 1) {
      scheduler.reportUsage(root.id, { inputTokens: 1000, outputTokens: 1000, source: "measured" });
      const a = await scheduler.acquire({ parentSessionId: root.id, agentId: SUBAGENT.id, tokenBudget: 1000 }, new AbortController().signal);
      a.release(0);
    }
  });

  it("delegation reports real tool usage into the tree budget", async () => {
    const h = makeHarness({
      scripts: [
        ScriptedModelProvider.toolCall("echo", { text: "x" }),
        ScriptedModelProvider.text("done"),
      ],
      schedulerLimits: {},
    });
    const parent = await h.runtime.createSession({ agent: PARENT, cwd: "C:\\work" });
    h.scheduler!.setRootBudget(parent.id, { maxToolCalls: 10 }); // pool 8

    expect(h.scheduler!.treeBudgetRemaining(parent.id)!.remaining).toBe(8);
    const result = await h.delegator.delegate(
      { parentSessionId: parent.id, goal: "g" },
      new AbortController().signal,
    );

    expect(result.status).toBe("success");
    // One tool call executed and was reported into the tree pool.
    expect(h.scheduler!.treeBudgetRemaining(parent.id)!.remaining).toBe(7);
  });
});
describe("P3-10: session-scoped usage reporting", () => {
  it("bindSession routes runtime-side usage to the tree root", async () => {
    const store = new MemorySessionStore();
    const [root] = await makeTree(store, 1) as unknown as [Session];
    const scheduler = new AgentExecutionScheduler({ store });
    scheduler.setRootBudget(root.id, { maxTokens: 1000 });

    // A child session reports usage — without a binding nothing is counted.
    const child = { id: "child-1" as SessionId };
    scheduler.reportUsageBySession(child.id, { inputTokens: 100, outputTokens: 50, source: "measured" });
    expect(scheduler.tokenBudgetRemaining(root.id)!.remaining).toBe(800);

    // After binding, the same usage reaches the root tree account.
    scheduler.bindSession(child.id, root.id);
    scheduler.reportUsageBySession(child.id, { inputTokens: 100, outputTokens: 50, source: "measured" });
    expect(scheduler.tokenBudgetRemaining(root.id)!.remaining).toBe(650);

    // Unbinding stops attribution (the child finished).
    scheduler.unbindSession(child.id);
    scheduler.reportUsageBySession(child.id, { inputTokens: 100, outputTokens: 50, source: "measured" });
    expect(scheduler.tokenBudgetRemaining(root.id)!.remaining).toBe(650);
  });
});

describe("P15-3: scheduler queue bound", () => {
  it("rejects a request past maxQueued with RESOURCE_LIMIT instead of unbounded queueing", async () => {
    const store = new MemorySessionStore();
    const scheduler = new AgentExecutionScheduler({ store, limits: { maxGlobalAgents: 1, maxQueued: 2 } });
    const parentId = newSessionId();
    await store.createSession({
      id: parentId,
      agentId: newAgentId(),
      model: { providerId: "p", modelId: "m" },
      cwd: "/w",
      status: "active",
      createdAt: 1,
      updatedAt: 1,
    });
    const parent = (await store.getSession(parentId))!;

    // First acquire starts (uses the single global slot).
    const ac1 = new AbortController();
    const p1 = scheduler.acquire({ parentSessionId: parent.id, agentId: parent.agentId }, ac1.signal);
    // Wait for it to start (queued → active).
    await new Promise((r) => setTimeout(r, 20));

    // Two more queue up (maxQueued 2).
    const ac2 = new AbortController();
    const p2 = scheduler.acquire({ parentSessionId: parent.id, agentId: parent.agentId }, ac2.signal);
    const ac3 = new AbortController();
    const p3 = scheduler.acquire({ parentSessionId: parent.id, agentId: parent.agentId }, ac3.signal);
    await new Promise((r) => setTimeout(r, 20));
    expect(scheduler.snapshot().filter((e) => e.state === "queued")).toHaveLength(2);

    // The 4th request must REJECT (queue full), not queue without bound.
    const ac4 = new AbortController();
    await expect(
      scheduler.acquire({ parentSessionId: parent.id, agentId: parent.agentId }, ac4.signal),
    ).rejects.toMatchObject({ info: { code: "RESOURCE_LIMIT" } });

    // cleanup: cancel all pending
    ac1.abort(); ac2.abort(); ac3.abort();
    await Promise.allSettled([p1, p2, p3]);
  });
});
