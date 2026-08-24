import { describe, expect, it } from "vitest";
import type {
  AgentDefinition,
  AgentEvent,
  AgentId,
  EventStore,
  Message,
  ModelEvent,
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
import { errorInfo, newAgentId, newMessageId } from "@ar/contracts";
import { ScriptedModelProvider } from "@ar/model";
import type { Script } from "@ar/model";
import { AgentRuntime } from "@ar/core";
import { ParallelDelegator } from "./parallel-delegator.js";
import { AgentExecutionScheduler } from "./scheduler.js";
import type { DelegationResult } from "./delegation.js";

// ---- in-memory fakes (same pattern as delegator.test.ts) -------------------

class MemorySessionStore implements SessionStore {
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

  async saveStateSnapshot(): Promise<void> {}

  async loadStateSnapshot(): Promise<Record<string, unknown> | undefined> {
    return undefined;
  }
}

class MemoryEventStore implements EventStore {
  events: AgentEvent[] = [];
  private seq = 0;

  async nextSequence(): Promise<number> {
    return this.seq + 1;
  }

  async appendNew(event: Omit<AgentEvent, "sequence">): Promise<AgentEvent> {
    return this.append({ ...event, sequence: -1 });
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

    async executeBound(request: import("@ar/contracts").BoundToolCallRequest, ctx: import("@ar/contracts").ToolExecutionContext): Promise<import("@ar/contracts").ToolResult> {
    return this.execute(request, ctx);
  }

async execute(request: ToolCallRequest, _context: ToolExecutionContext): Promise<ToolResult> {
    this.calls.push({ request });
    return this.result;
  }
}

// ---- harness ---------------------------------------------------------------

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
  limits?: Partial<import("@ar/contracts").DelegationLimits>;
  orchestrator?: FakeOrchestrator;
  agents?: AgentDefinition[];
  now?: () => number;
  verifier?: Verifier;
  schedulerLimits?: Partial<import("@ar/contracts").SchedulerLimits>;
}) {
  const store = new MemorySessionStore();
  const events = new MemoryEventStore();
  const now = opts?.now ?? Date.now;
  const provider = new ScriptedModelProvider(opts?.scripts ?? [ScriptedModelProvider.text("child done")]);
  const orchestrator = opts?.orchestrator ?? new FakeOrchestrator();
  const agents = opts?.agents ?? [PARENT, SUBAGENT];
  const runtime = new AgentRuntime({
      toolRegistry: localTestToolCatalog(),
      permissiveToolResolution: true,
    store,
    events,
    modelProvider: provider,
    orchestrator,
    agents,
    now,
    ...(opts?.verifier !== undefined
      ? { task: { id: "t", goal: "g", verification: [] }, verifier: opts.verifier }
      : {}),
  });
  const scheduler =
    opts?.schedulerLimits !== undefined
      ? new AgentExecutionScheduler({ store, limits: opts.schedulerLimits })
      : undefined;
  const delegator = new ParallelDelegator({
    runtime,
    store,
    events,
    agentId: SUBAGENT.id,
    limits: opts?.limits,
    now,
    ...(scheduler !== undefined ? { scheduler } : {}),
  });
  return { store, events, runtime, delegator, orchestrator, provider };
}

async function createParent(
  harness: ReturnType<typeof makeHarness>,
  texts: string[] = [],
): Promise<Session> {
  const { runtime, store } = harness;
  const parent = await runtime.createSession({ agent: PARENT, cwd: "C:\\work" });
  for (const text of texts) {
    await store.appendMessage({
      id: newMessageId(),
      sessionId: parent.id,
      role: "user",
      content: text,
      createdAt: 1,
    });
  }
  return parent;
}

function requests(parentId: SessionId, count: number, prefix = "g") {
  return Array.from({ length: count }, (_, i) => ({ parentSessionId: parentId, goal: `${prefix}${i}` }));
}

// ---- slow model with an active-count tracker ---------------------------------

interface ActiveTracker {
  active: number;
  peak: number;
  /** Script names in completion order (when supplied). */
  finished?: string[];
}

function slowScript(name: string, delayMs: number, tracker?: ActiveTracker): AsyncIterable<ModelEvent> {
  return (async function* () {
    tracker!.active += 1;
    tracker!.peak = Math.max(tracker!.peak, tracker!.active);
    try {
      yield { type: "started", timestamp: 0 };
      await new Promise((r) => setTimeout(r, delayMs));
      yield { type: "text_delta", text: name, timestamp: 0 };
      await new Promise((r) => setTimeout(r, delayMs));
      yield { type: "completed", result: { finishReason: "stop", text: name }, timestamp: 0 };
      tracker!.finished?.push(name);
    } finally {
      tracker!.active -= 1;
    }
  })();
}

function hangScript(): AsyncIterable<ModelEvent> {
  return (async function* hang() {
    yield { type: "started", timestamp: 0 };
    await new Promise((r) => setTimeout(r, 1000));
  })();
}

// ---- tests -----------------------------------------------------------------

describe("ParallelDelegator (SUBAGENT-002)", () => {
  it("runs all children successfully with peak concurrency bounded by maxConcurrent", async () => {
    const tracker: ActiveTracker = { active: 0, peak: 0 };
    const h = makeHarness({
      scripts: [slowScript("a", 60, tracker), slowScript("b", 60, tracker), slowScript("c", 60, tracker)],
      limits: { maxConcurrent: 2 },
    });
    const parent = await createParent(h);

    const results = await h.delegator.delegateAll(requests(parent.id, 3), new AbortController().signal);

    expect(results.map((r) => r.status)).toEqual(["success", "success", "success"]);
    expect(tracker.peak).toBeLessThanOrEqual(2);
    expect(tracker.peak).toBe(2); // genuinely ran in parallel, not serialized
    expect(tracker.active).toBe(0);
  });

  it("returns results in request order regardless of completion order", async () => {
    const finished: string[] = [];
    const tracker: ActiveTracker = { active: 0, peak: 0, finished };
    const h = makeHarness({
      scripts: [
        slowScript("fast child", 10, tracker),
        slowScript("slow child", 80, tracker),
        slowScript("medium child", 30, tracker),
      ],
    });
    const parent = await createParent(h);
    const goals = ["goal-A", "goal-B", "goal-C"];

    const results = await h.delegator.delegateAll(
      goals.map((goal) => ({ parentSessionId: parent.id, goal })),
      new AbortController().signal,
    );

    expect(results).toHaveLength(3);
    for (let i = 0; i < results.length; i++) {
      const messages = await h.store.listMessages(results[i]!.childSessionId);
      const goalText = messages.find((m) => m.content.startsWith("goal-"))?.content;
      expect(goalText).toBe(goals[i]);
    }
    // The slowest script always finishes last (160ms vs ~1ms), so completion
    // order is never the request order — the array is still in request order.
    expect(finished).toHaveLength(3);
    expect(finished[2]).toBe("slow child");
  });

  it("isolates failures: one failed child does not affect the others", async () => {
    const h = makeHarness({
      scripts: [
        ScriptedModelProvider.text("ok-a"),
        [{ type: "error", error: errorInfo("MODEL_ERROR", "boom"), timestamp: 0 }],
        ScriptedModelProvider.text("ok-c"),
      ],
    });
    const parent = await createParent(h);

    const results = await h.delegator.delegateAll(requests(parent.id, 3), new AbortController().signal);

    expect(results.map((r) => r.status)).toEqual(["success", "failed", "success"]);
    expect(results[1]!.error).toBe("boom");
    expect(results[1]!.summary).toContain("boom");
  });

  it("propagates an abort to every running child", async () => {
    const h = makeHarness({ scripts: [hangScript(), hangScript(), hangScript()] });
    const parent = await createParent(h);
    const ac = new AbortController();

    const pending = h.delegator.delegateAll(requests(parent.id, 3), ac.signal);
    const cancel = setTimeout(() => ac.abort(), 60);
    const results = await pending;
    clearTimeout(cancel);

    expect(results.map((r) => r.status)).toEqual(["cancelled", "cancelled", "cancelled"]);
  });

  it("returns cancelled for every child when the signal is already aborted", async () => {
    const h = makeHarness();
    const parent = await createParent(h);
    const ac = new AbortController();
    ac.abort();

    const results = await h.delegator.delegateAll(requests(parent.id, 3), ac.signal);

    expect(results.map((r) => r.status)).toEqual(["cancelled", "cancelled", "cancelled"]);
  });

  it("P1-10: cancels one child without cancelling siblings (per-child signal)", async () => {
    const hanging = (async function* hang(): AsyncIterable<ModelEvent> {
      yield { type: "started", timestamp: 0 };
      await new Promise((r) => setTimeout(r, 500));
    })();
    const h = makeHarness({
      scripts: [hanging, ScriptedModelProvider.text("done")],
    });
    const parent = await createParent(h);
    const batch = new AbortController();
    const childA = new AbortController();

    const pending = h.delegator.delegateAll(requests(parent.id, 2), batch.signal, {
      childSignals: [childA.signal],
    });
    // Let child A start (and hang) before cancelling exactly it.
    await new Promise((r) => setTimeout(r, 50));
    childA.abort();
    const results = await pending;

    expect(results[0]!.status).toBe("cancelled");
    // The sibling was never touched by child A's cancellation.
    expect(results[1]!.status).toBe("success");
    expect(results[1]!.answer).toBe("done");
  });

  it("P1-10: a child cancelled while queued resolves as cancelled instead of rejecting the batch", async () => {
    const hanging = (async function* hang(): AsyncIterable<ModelEvent> {
      yield { type: "started", timestamp: 0 };
      await new Promise((r) => setTimeout(r, 500));
    })();
    const h = makeHarness({
      scripts: [hanging, ScriptedModelProvider.text("done")],
      schedulerLimits: { maxGlobalAgents: 1, maxAgentsPerRoot: 1, maxDepth: 3, maxDurationMs: 0 },
    });
    const parent = await createParent(h);
    const ac = new AbortController();

    const pending = h.delegator.delegateAll(requests(parent.id, 2), ac.signal);
    // Child 0 starts (and hangs) under the only scheduler slot; child 1 queues.
    await new Promise((r) => setTimeout(r, 50));
    ac.abort();
    const results = await pending;

    expect(results.map((r) => r.status)).toEqual(["cancelled", "cancelled"]);
  });

  it("runs sequentially when maxConcurrent=1", async () => {
    const tracker: ActiveTracker = { active: 0, peak: 0 };
    const h = makeHarness({
      scripts: [slowScript("a", 40, tracker), slowScript("b", 40, tracker), slowScript("c", 40, tracker)],
      limits: { maxConcurrent: 1 },
    });
    const parent = await createParent(h);

    const results = await h.delegator.delegateAll(requests(parent.id, 3), new AbortController().signal);

    expect(results.every((r) => r.status === "success")).toBe(true);
    expect(tracker.peak).toBe(1);
  });

  it("rejects maxConcurrent=0 before starting anything", async () => {
    const h = makeHarness({ limits: { maxConcurrent: 0 } });
    const parent = await createParent(h);

    await expect(
      h.delegator.delegateAll(requests(parent.id, 1), new AbortController().signal),
    ).rejects.toMatchObject({ info: { code: "RESOURCE_LIMIT" } });
    expect(await h.store.listSessions({ parentId: parent.id })).toHaveLength(0);
  });

  it("rejects the whole batch when maxChildren=0 without creating any child", async () => {
    const h = makeHarness({ limits: { maxChildren: 0 } });
    const parent = await createParent(h);

    await expect(
      h.delegator.delegateAll(requests(parent.id, 3), new AbortController().signal),
    ).rejects.toMatchObject({ info: { code: "RESOURCE_LIMIT" } });
    expect(await h.store.listSessions({ parentId: parent.id })).toHaveLength(0);
  });

  it("pre-flights the batch size: 3 requests with maxChildren=2 create nothing", async () => {
    const h = makeHarness({ limits: { maxChildren: 2 } });
    const parent = await createParent(h);

    await expect(
      h.delegator.delegateAll(requests(parent.id, 3), new AbortController().signal),
    ).rejects.toMatchObject({ info: { code: "RESOURCE_LIMIT" } });
    expect(await h.store.listSessions({ parentId: parent.id })).toHaveLength(0);
  });

  it("counts existing children in the pre-flight", async () => {
    const h = makeHarness({ limits: { maxChildren: 1 } });
    const parent = await createParent(h);
    await h.runtime.createSession({ agent: SUBAGENT, cwd: parent.cwd, parentId: parent.id });

    await expect(
      h.delegator.delegateAll(requests(parent.id, 1), new AbortController().signal),
    ).rejects.toMatchObject({ info: { code: "RESOURCE_LIMIT" } });
  });

  it("rejects the whole batch when maxDepth=0 without creating any child", async () => {
    const h = makeHarness({ limits: { maxDepth: 0 } });
    const parent = await createParent(h);

    await expect(
      h.delegator.delegateAll(requests(parent.id, 1), new AbortController().signal),
    ).rejects.toMatchObject({ info: { code: "RESOURCE_LIMIT" } });
    expect(await h.store.listSessions({ parentId: parent.id })).toHaveLength(0);
  });

  it("rejects when a request references an unknown parent session", async () => {
    const h = makeHarness();

    await expect(
      h.delegator.delegateAll(
        [{ parentSessionId: "session_does-not-exist" as SessionId, goal: "g" }],
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ info: { code: "INTERNAL_ERROR" } });
  });

  it("rejects when a request references an unknown agent", async () => {
    const h = makeHarness();
    const parent = await createParent(h);

    await expect(
      h.delegator.delegateAll(
        [{ parentSessionId: parent.id, goal: "g", agentId: "agent_nope" as AgentId }],
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ info: { code: "INTERNAL_ERROR" } });
  });

  it("honours per-request limits during pre-flight", async () => {
    const h = makeHarness();
    const parent = await createParent(h);

    await expect(
      h.delegator.delegateAll(
        [
          { parentSessionId: parent.id, goal: "g0" },
          { parentSessionId: parent.id, goal: "g1", limits: { maxChildren: 0 } },
        ],
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ info: { code: "RESOURCE_LIMIT" } });
    expect(await h.store.listSessions({ parentId: parent.id })).toHaveLength(0);
  });

  it("P14-3: a writable request without a workspace manager rejects the whole batch before any child starts", async () => {
    const h = makeHarness(); // no workspaceManager — the production-invalid config
    const parent = await createParent(h);

    await expect(
      h.delegator.delegateAll(
        [
          { parentSessionId: parent.id, goal: "write", writable: true },
          { parentSessionId: parent.id, goal: "read" },
        ],
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ info: { code: "SECURITY_DENIED" } });

    // No child session was created for any batch member (no partial start).
    expect(await h.store.listSessions({ parentId: parent.id })).toEqual([]);
    expect(h.orchestrator.calls).toEqual([]);
  });

  it("creates one child per request, all under the parent", async () => {
    const h = makeHarness();
    const parent = await createParent(h);

    const results = await h.delegator.delegateAll(requests(parent.id, 3), new AbortController().signal);

    const children = await h.store.listSessions({ parentId: parent.id });
    expect(children).toHaveLength(3);
    expect(children.every((c) => c.parentId === parent.id)).toBe(true);
    expect(children.every((c) => c.agentId === SUBAGENT.id)).toBe(true);
    expect(new Set(children.map((c) => c.id)).size).toBe(3);
    expect(new Set(results.map((r) => r.childSessionId)).size).toBe(3);
  });

  it("emits subagent.started and subagent.completed per child on the parent stream", async () => {
    const h = makeHarness({
      scripts: [ScriptedModelProvider.text("a"), ScriptedModelProvider.text("b"), ScriptedModelProvider.text("c")],
    });
    const parent = await createParent(h);

    await h.delegator.delegateAll(requests(parent.id, 3), new AbortController().signal);

    const events = h.events.events.filter(
      (e) => e.sessionId === parent.id && e.type.startsWith("subagent."),
    );
    expect(events.filter((e) => e.type === "subagent.started")).toHaveLength(3);
    const completed = events.filter((e) => e.type === "subagent.completed");
    expect(completed).toHaveLength(3);
    expect(completed.every((e) => e.payload.status === "success")).toBe(true);
  });

  it("returns an empty array for an empty request list", async () => {
    const h = makeHarness();

    const results = await h.delegator.delegateAll([], new AbortController().signal);

    expect(results).toEqual([]);
  });

  it("uses the injectable clock for durationMs", async () => {
    const clock = { t: 1000 };
    const h = makeHarness({ now: () => clock.t });
    const parent = await createParent(h);

    const results = await h.delegator.delegateAll(requests(parent.id, 1), new AbortController().signal);

    expect(results[0]!.durationMs).toBe(0);
  });
});

/** P23-4 local inert catalog — agents tests drive tools through a
 *  FakeOrchestrator; the frozen step router must resolve their names. */
function localTestToolCatalog() {
  const names = ["read_file", "write_file", "edit_file", "exec", "search_files", "grep_search", "repo_tree", "repo_map", "update_plan", "ask_user", "env_snapshot", "discover_commands", "tool_lookup", "run_test", "echo"];
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
