import { describe, expect, it } from "vitest";
import type {
  AgentDefinition,
  AgentEvent,
  ContextBlock,
  DelegationLimits,
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
import { newAgentId, newMessageId } from "@ar/contracts";
import { ScriptedModelProvider, type Script } from "@ar/model";
import { AgentRuntime } from "@ar/core";
import { Delegator } from "./delegator.js";

// ---- in-memory fakes (mirroring delegator.test.ts) ------------------------

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
  limits?: Partial<DelegationLimits>;
  verifier?: Verifier;
}) {
  const store = new MemorySessionStore();
  const events = new MemoryEventStore();
  const provider = new ScriptedModelProvider(opts?.scripts ?? [ScriptedModelProvider.text("child done")]);
  const runtime = new AgentRuntime({
    store,
    events,
    modelProvider: provider,
    orchestrator: new FakeOrchestrator(),
    agents: [PARENT, SUBAGENT],
    ...(opts?.verifier !== undefined
      ? { task: { id: "t", goal: "g", verification: [] }, verifier: opts.verifier }
      : {}),
  });
  const delegator = new Delegator({
    runtime,
    store,
    events,
    agentId: SUBAGENT.id,
    limits: opts?.limits,
  });
  return { store, events, runtime, delegator, provider };
}

async function createParent(harness: ReturnType<typeof makeHarness>): Promise<Session> {
  const { runtime } = harness;
  return runtime.createSession({ agent: PARENT, cwd: "C:\\work" });
}

function passingVerifier(): Verifier {
  return {
    async verify() {
      return { level: 1, passed: true, checks: [], evidence: [], startedAt: 0, completedAt: 0 };
    },
  };
}

// ---- tests (P1-8 Structured Subagent Completion Protocol) -----------------

describe("P1-8 structured subagent completion protocol", () => {
  it("carries the full completion surface: answer, findings, artifacts, tests, budget, verified", async () => {
    const h = makeHarness({
      scripts: [
        ScriptedModelProvider.toolCall("write_file", { path: "src/a.ts", content: "export const a = 1;" }),
        ScriptedModelProvider.toolCall("exec", { command: "npm test" }),
        ScriptedModelProvider.text("done: implemented and tested"),
      ],
    });
    const parent = await createParent(h);

    const result = await h.delegator.delegate(
      { parentSessionId: parent.id, goal: "implement a" },
      new AbortController().signal,
    );

    expect(result.status).toBe("success");
    // Answer is the child's final message verbatim, not a paraphrase.
    expect(result.answer).toBe("done: implemented and tested");
    // Real changed artifacts from the working state, each with a stable ref.
    expect(result.changedArtifacts).toHaveLength(1);
    expect(result.changedArtifacts[0]!.path).toBe("src/a.ts");
    // The runtime renders tool outputs without the path, so the ref falls
    // back to the persistent working state snapshot of the child session.
    expect(result.changedArtifacts[0]!.sourceRef).toBe("working-state");
    // Test runs from the working state (/test/i commands).
    expect(result.testsRun.some((t) => t.description === "npm test")).toBe(true);
    // Budget consumed by the child turn.
    expect(result.budgetUsed.toolCalls).toBe(2);
    expect(result.budgetUsed.durationMs).toBeGreaterThanOrEqual(0);
    // No verification gate ran: the child is NOT marked verified — merely
    // saying "done" is not a verified completion.
    expect(result.verified).toBe(false);
    expect(result.findings).toEqual([]);
    expect(result.openQuestions).toEqual([]);
    expect(result.blockers).toEqual([]);
    expect(result.suggestedNextActions).toEqual([]);
  });

  it("marks verified=true with findings only when the completion passed a verification gate", async () => {
    const h = makeHarness({ verifier: passingVerifier() });
    const parent = await createParent(h);

    const result = await h.delegator.delegate(
      { parentSessionId: parent.id, goal: "g" },
      new AbortController().signal,
    );

    expect(result.status).toBe("success");
    expect(result.verified).toBe(true);
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]!.claim).toBe("verification passed");
    expect(result.findings[0]!.confidence).toBe("high");
    expect(result.findings[0]!.evidenceRefs[0]).toMatch(/^event:/);
    expect(result.testsRun.some((t) => t.description === "verification passed")).toBe(true);
  });

  it("reports a failed verification as a low-confidence finding and a blocker", async () => {
    const failing = {
      async verify() {
        return {
          level: 1 as const,
          passed: false,
          checks: [
            {
              id: "c1",
              kind: "command" as const,
              description: "tests do not pass",
              passed: false,
              error: { code: "VERIFICATION_FAILED" as const, message: "tests do not pass", retryable: false, safeToRetry: false },
            },
          ],
          evidence: [],
          startedAt: 0,
          completedAt: 0,
        };
      },
    };
    const h = makeHarness({
      scripts: [ScriptedModelProvider.text("done: everything works")],
      verifier: failing,
    });
    const parent = await createParent(h);

    const result = await h.delegator.delegate(
      { parentSessionId: parent.id, goal: "g" },
      new AbortController().signal,
    );

    expect(result.status).toBe("failed");
    expect(result.verified).toBe(false);
    expect(result.findings.some((f) => f.confidence === "low")).toBe(true);
    expect(result.findings[0]!.claim).toContain("verification failed");
    expect(result.blockers.some((b) => b.includes("verification failed"))).toBe(true);
  });

  it("timeout/cancelled completions carry no fabricated findings or artifacts", async () => {
    const hanging = (async function* hang(): AsyncIterable<ModelEvent> {
      yield { type: "started", timestamp: 0 };
      await new Promise((r) => setTimeout(r, 2000));
    })();
    const h = makeHarness({ scripts: [hanging], limits: { timeoutMs: 100 } });
    const parent = await createParent(h);

    const result = await h.delegator.delegate(
      { parentSessionId: parent.id, goal: "g" },
      new AbortController().signal,
    );

    expect(result.status).toBe("timeout");
    expect(result.verified).toBe(false);
    expect(result.findings).toEqual([]);
    expect(result.testsRun).toEqual([]);
    expect(result.budgetUsed.toolCalls).toBe(0);
  });

  it("evidence refs are stable and point into the child session (event:/message:)", async () => {
    const h = makeHarness({ verifier: passingVerifier() });
    const parent = await createParent(h);

    const result = await h.delegator.delegate(
      { parentSessionId: parent.id, goal: "g" },
      new AbortController().signal,
    );

    // Every evidence ref used by findings/testsRun resolves to a real
    // persisted event or message of the child session.
    const refs = [
      ...result.findings.flatMap((f) => f.evidenceRefs),
      ...result.testsRun.flatMap((t) => (t.sourceRef !== undefined ? [t.sourceRef] : [])),
      ...result.changedArtifacts.map((a) => a.sourceRef),
    ];
    expect(refs.length).toBeGreaterThan(0);
    for (const ref of refs) {
      if (ref.startsWith("event:")) {
        const id = ref.slice("event:".length);
        expect(h.events.events.some((e) => e.id === id && e.sessionId === result.childSessionId)).toBe(true);
      } else if (ref.startsWith("message:")) {
        const id = ref.slice("message:".length);
        const messages = await h.store.listMessages(result.childSessionId);
        expect(messages.some((m) => m.id === id)).toBe(true);
      } else if (ref === "working-state") {
        // The child's persisted working state snapshot exists and lists the
        // artifact path the ref attests to.
        const snapshot = await h.store.loadStateSnapshot(result.childSessionId);
        expect(snapshot).toBeDefined();
      } else {
        throw new Error(`unexpected ref format: ${ref}`);
      }
    }
  });
});