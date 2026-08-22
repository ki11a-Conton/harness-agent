import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type {
  AgentEvent,
  EventStore,
  EventType,
  Message,
  Session,
  SessionId,
  SessionStore,
  SessionStatus,
  TaskSpec,
  Turn,
  TurnId,
  VerificationContext,
  VerificationResult,
  Verifier,
} from "@ar/contracts";
import {
  newAgentId,
  newEventId,
  newSessionId,
  newTurnId,
} from "@ar/contracts";
import { computeMetrics, type RunMetrics } from "./metrics.js";
import {
  EPISODE_FILES,
  exportEpisode,
  type EpisodePackage,
} from "./trace-exporter.js";

// ---- in-memory fakes (mirror @ar/contracts interfaces) ---------------------

class InMemoryEventStore implements EventStore {
  readonly stored: AgentEvent[] = [];

  async appendNew(event: Omit<AgentEvent, "sequence">): Promise<AgentEvent> {
    return this.append({ ...event, sequence: -1 });
  }

  async append(event: AgentEvent): Promise<AgentEvent> {
    if (this.stored.some((e) => e.id === event.id)) {
      throw new Error(`duplicate event id: ${event.id}`);
    }
    const previous = this.stored[this.stored.length - 1];
    const next: AgentEvent = {
      ...event,
      sequence: previous === undefined ? 0 : previous.sequence + 1,
    };
    this.stored.push(next);
    return next;
  }

  async list(
    sessionId: SessionId,
    opts: { afterSequence?: number; limit?: number } = {},
  ): Promise<AgentEvent[]> {
    const after = opts.afterSequence ?? -1;
    const filtered = this.stored.filter(
      (e) => e.sessionId === sessionId && e.sequence > after,
    );
    return opts.limit === undefined ? filtered : filtered.slice(0, opts.limit);
  }

  async *stream(
    sessionId: SessionId,
    opts: { afterSequence?: number } = {},
  ): AsyncIterable<AgentEvent> {
    for (const event of await this.list(sessionId, opts)) yield event;
  }

  async nextSequence(sessionId: SessionId): Promise<number> {
    const events = await this.list(sessionId);
    const last = events[events.length - 1];
    return last === undefined ? 0 : last.sequence + 1;
  }
}

class InMemorySessionStore implements SessionStore {
  private readonly sessions = new Map<string, Session>();
  private readonly turns = new Map<string, Turn>();
  private readonly messages: Message[] = [];

  async createSession(session: Session): Promise<void> {
    this.sessions.set(session.id, session);
  }

  async getSession(id: SessionId): Promise<Session | undefined> {
    return this.sessions.get(id);
  }

  async updateSession(session: Session): Promise<void> {
    this.sessions.set(session.id, session);
  }

  async listSessions(
    opts: { parentId?: SessionId; status?: SessionStatus } = {},
  ): Promise<Session[]> {
    return [...this.sessions.values()].filter(
      (s) =>
        (opts.parentId === undefined || s.parentId === opts.parentId) &&
        (opts.status === undefined || s.status === opts.status),
    );
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
    return (await this.listMessages(sessionId)).filter((m) => m.turnId === turnId);
  }

  async saveStateSnapshot(): Promise<void> {
    // unused by the exporter
  }

  async loadStateSnapshot(): Promise<Record<string, unknown> | undefined> {
    return undefined;
  }
}

// ---- fixtures ---------------------------------------------------------------

let tempDir: string | undefined;

afterEach(async () => {
  if (tempDir !== undefined) {
    await rm(tempDir, { recursive: true, force: true });
    tempDir = undefined;
  }
});

async function freshOutputDir(): Promise<string> {
  tempDir = await mkdtemp(join(tmpdir(), "trace-"));
  return tempDir;
}

function makeSession(sid: SessionId, status: SessionStatus = "completed"): Session {
  return {
    id: sid,
    agentId: newAgentId(),
    model: { providerId: "test", modelId: "fake" },
    cwd: process.cwd(),
    status,
    createdAt: 1000,
    updatedAt: 9000,
  };
}

/** Event builder with a controllable timestamp sequence (100ms apart). */
function makeEventBuilder(sessionId: SessionId) {
  let clock = 1000;
  return (
    type: EventType,
    payload: Record<string, unknown> = {},
    turnId?: Turn["id"],
  ): AgentEvent => {
    const event: AgentEvent = {
      id: newEventId(),
      sessionId,
      sequence: 0,
      timestamp: clock,
      type,
      payload,
    };
    if (turnId !== undefined) event.turnId = turnId;
    clock += 100;
    return event;
  };
}

async function readJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, "utf8")) as unknown;
}

async function readLines(path: string): Promise<string[]> {
  const content = await readFile(path, "utf8");
  if (content.length === 0) return [];
  return content.split("\n").filter((line) => line.length > 0);
}

async function readJsonLines(path: string): Promise<Record<string, unknown>[]> {
  return (await readLines(path)).map((line) => JSON.parse(line) as Record<string, unknown>);
}

// ---- tests ------------------------------------------------------------------

describe("exportEpisode (TRACE-001, §77)", () => {
  it("exports the complete 10-file §77 package layout", async () => {
    const sid = newSessionId();
    const events = new InMemoryEventStore();
    const sessions = new InMemorySessionStore();
    await sessions.createSession(makeSession(sid));
    const mk = makeEventBuilder(sid);
    await events.append(mk("turn.started", { turnId: newTurnId() }));
    await events.append(mk("turn.completed", { turnId: newTurnId(), status: "completed" }));

    const output = await freshOutputDir();
    const pkg = await exportEpisode({
      events,
      sessions,
      outputDir: output,
    });

    expect(pkg.files).toEqual(EPISODE_FILES);
    expect(pkg.sessionId).toBe(sid);
    for (const file of EPISODE_FILES) {
      await expect(readFile(join(output, file), "utf8")).resolves.toBeDefined();
    }
  });

  it("events.jsonl holds one parseable line per event in sequence order", async () => {
    const sid = newSessionId();
    const events = new InMemoryEventStore();
    const sessions = new InMemorySessionStore();
    await sessions.createSession(makeSession(sid));
    const mk = makeEventBuilder(sid);
    const turnId = newTurnId();
    for (let i = 0; i < 5; i += 1) {
      await events.append(mk("model.delta", { kind: "text" }, turnId));
    }

    const output = await freshOutputDir();
    await exportEpisode({ events, sessions, outputDir: output });

    const lines = await readJsonLines(join(output, "events.jsonl"));
    expect(lines).toHaveLength(5);
    for (let i = 0; i < lines.length; i += 1) {
      expect(lines[i]).toMatchObject({ type: "model.delta", sequence: i });
    }
  });

  it("metrics.json counts turns and tool calls", async () => {
    const sid = newSessionId();
    const events = new InMemoryEventStore();
    const sessions = new InMemorySessionStore();
    await sessions.createSession(makeSession(sid));
    const mk = makeEventBuilder(sid);
    const turnId = newTurnId();
    await events.append(mk("turn.started", {}, turnId));
    await events.append(mk("tool.requested", { toolCallId: "toolcall_1", name: "read" }, turnId));
    await events.append(mk("tool.requested", { toolCallId: "toolcall_2", name: "edit" }, turnId));
    await events.append(mk("tool.requested", { toolCallId: "toolcall_3", name: "read" }, turnId));
    await events.append(mk("turn.started", {}, newTurnId()));
    await events.append(mk("turn.started", {}, newTurnId()));

    const output = await freshOutputDir();
    await exportEpisode({ events, sessions, outputDir: output });

    const metrics = (await readJson(join(output, "metrics.json"))) as RunMetrics;
    expect(metrics.turn_count).toBe(3);
    expect(metrics.tool_call_count).toBe(3);
  });

  it("sums input/output/context tokens from model.completed usage payloads", async () => {
    const sid = newSessionId();
    const events = new InMemoryEventStore();
    const sessions = new InMemorySessionStore();
    await sessions.createSession(makeSession(sid));
    const mk = makeEventBuilder(sid);
    // P0-9: usage is reported on the terminal model.completed event ONLY
    // (model.started/usage snapshots are folded into it by the runtime) —
    // summing model.started too would double-count the same tokens.
    await events.append(mk("model.completed", { finishReason: "stop", usage: { inputTokens: 40, outputTokens: 10, contextTokens: 600 } }));
    await events.append(mk("model.completed", { finishReason: "tool_calls", usage: { inputTokens: 100, outputTokens: 50, contextTokens: 500 } }));

    const output = await freshOutputDir();
    await exportEpisode({ events, sessions, outputDir: output });

    const metrics = (await readJson(join(output, "metrics.json"))) as RunMetrics;
    expect(metrics.tokens_input).toBe(140);
    expect(metrics.tokens_output).toBe(60);
    expect(metrics.context_tokens).toBe(1100);
  });

  it("counts compactions, verification failures, human interventions and duration", async () => {
    const sid = newSessionId();
    const events = new InMemoryEventStore();
    const sessions = new InMemorySessionStore();
    await sessions.createSession(makeSession(sid));
    const mk = makeEventBuilder(sid);
    await events.append(mk("turn.started"));
    await events.append(mk("context.compacted", { compressed: 100 }));
    await events.append(mk("context.compacted", { compressed: 200 }));
    await events.append(mk("verification.failed", { error: { code: "VERIFICATION_FAILED" } }));
    await events.append(mk("verification.completed", { passed: false }));
    await events.append(mk("human.approval", { approvalId: "approval_1" }));
    await events.append(mk("human.correction", { text: "use npm" }));
    await events.append(mk("turn.completed"));

    const output = await freshOutputDir();
    await exportEpisode({ events, sessions, outputDir: output });

    const metrics = (await readJson(join(output, "metrics.json"))) as RunMetrics;
    expect(metrics.compaction_count).toBe(2);
    expect(metrics.verification_failures).toBe(2);
    expect(metrics.human_interventions).toBe(2);
    expect(metrics.duration_ms).toBe(700);
  });

  it("counts retries via maxRetries limit events and retried tool failures", async () => {
    const sid = newSessionId();
    const events = new InMemoryEventStore();
    const sessions = new InMemorySessionStore();
    await sessions.createSession(makeSession(sid));
    const mk = makeEventBuilder(sid);
    await events.append(mk("tool.failed", { toolCallId: "toolcall_1", error: { code: "PROCESS_ERROR" }, retried: true }));
    await events.append(mk("tool.failed", { toolCallId: "toolcall_1", error: { code: "PROCESS_ERROR" }, retried: true }));
    await events.append(mk("run.limit_reached", { limit: "maxRetries", used: 2 }));
    await events.append(mk("tool.failed", { toolCallId: "toolcall_2", error: { code: "PROCESS_ERROR" } }));
    await events.append(mk("run.limit_reached", { limit: "maxTurns", used: 5 }));

    const output = await freshOutputDir();
    await exportEpisode({ events, sessions, outputDir: output });

    const metrics = (await readJson(join(output, "metrics.json"))) as RunMetrics;
    expect(metrics.retry_count).toBe(3);
  });

  it("estimates cost from default rates and honors explicit recorded cost", async () => {
    const sid = newSessionId();
    const events = new InMemoryEventStore();
    const sessions = new InMemorySessionStore();
    await sessions.createSession(makeSession(sid));
    const mk = makeEventBuilder(sid);
    await events.append(mk("model.completed", { finishReason: "stop", usage: { inputTokens: 1000, outputTokens: 500 } }));

    const output = await freshOutputDir();
    await exportEpisode({ events, sessions, outputDir: output });
    const estimated = (await readJson(join(output, "metrics.json"))) as RunMetrics;
    expect(estimated.estimated_cost).toBeCloseTo(0.002 + 0.004, 6);

    const explicitEvents = new InMemoryEventStore();
    await explicitEvents.append(mk("model.completed", { finishReason: "stop", usage: { inputTokens: 1000, outputTokens: 500, cost: 0.25 } }));
    const output2 = await freshOutputDir();
    await exportEpisode({ events: explicitEvents, sessions, outputDir: output2 });
    const explicit = (await readJson(join(output2, "metrics.json"))) as RunMetrics;
    expect(explicit.estimated_cost).toBe(0.25);
  });

  it("tool-calls.jsonl contains only requested/completed/failed entries with correlation keys", async () => {
    const sid = newSessionId();
    const events = new InMemoryEventStore();
    const sessions = new InMemorySessionStore();
    await sessions.createSession(makeSession(sid));
    const mk = makeEventBuilder(sid);
    await events.append(mk("turn.started"));
    await events.append(mk("tool.requested", { toolCallId: "toolcall_1", name: "read", args: { path: "a.ts" } }));
    await events.append(mk("tool.permission_requested", { toolCallId: "toolcall_1", tool: "read" }));
    await events.append(mk("tool.completed", { toolCallId: "toolcall_1", tool: "read", status: "success", durationMs: 5, evidence: [] }));
    await events.append(mk("tool.failed", { toolCallId: "toolcall_2", tool: "edit", error: { code: "PERMISSION_DENIED" } }));
    await events.append(mk("model.delta", { kind: "text" }));

    const output = await freshOutputDir();
    await exportEpisode({ events, sessions, outputDir: output });

    const lines = await readJsonLines(join(output, "tool-calls.jsonl"));
    expect(lines).toHaveLength(3);
    for (const line of lines) {
      expect(["tool.requested", "tool.completed", "tool.failed"]).toContain(line.type);
      expect(line.toolCallId).toBeDefined();
      expect(line.tool).toBeDefined();
    }
    expect(lines[0]).toMatchObject({ type: "tool.requested", toolCallId: "toolcall_1", tool: "read", args: { path: "a.ts" } });
    expect(lines[2]).toMatchObject({ type: "tool.failed", toolCallId: "toolcall_2", error: { code: "PERMISSION_DENIED" } });
  });

  it("permissions.jsonl contains only permission and human events", async () => {
    const sid = newSessionId();
    const events = new InMemoryEventStore();
    const sessions = new InMemorySessionStore();
    await sessions.createSession(makeSession(sid));
    const mk = makeEventBuilder(sid);
    await events.append(mk("tool.requested", { toolCallId: "toolcall_1", name: "edit" }));
    await events.append(mk("tool.permission_requested", { toolCallId: "toolcall_1", tool: "edit", approvalId: "approval_1" }));
    await events.append(mk("tool.permission_resolved", { toolCallId: "toolcall_1", tool: "edit", effect: "allow", approvalId: "approval_1" }));
    await events.append(mk("human.message", { text: "continue" }));
    await events.append(mk("tool.completed", { toolCallId: "toolcall_1", tool: "edit", status: "success" }));

    const output = await freshOutputDir();
    await exportEpisode({ events, sessions, outputDir: output });

    const lines = await readJsonLines(join(output, "permissions.jsonl"));
    expect(lines).toHaveLength(3);
    for (const line of lines) {
      expect(
        ["tool.permission_requested", "tool.permission_resolved", "human.message", "human.approval", "human.correction", "human.cancel", "human.override"],
      ).toContain(line.type);
    }
    expect(lines[1]).toMatchObject({ type: "tool.permission_resolved", effect: "allow", approvalId: "approval_1" });
  });

  it("summary.json carries sessionId, status, artifact list and metrics", async () => {
    const sid = newSessionId();
    const events = new InMemoryEventStore();
    const sessions = new InMemorySessionStore();
    await sessions.createSession(makeSession(sid, "failed"));
    const mk = makeEventBuilder(sid);
    await events.append(mk("tool.requested", { toolCallId: "toolcall_1", name: "edit" }));
    await events.append(mk("tool.completed", {
      toolCallId: "toolcall_1",
      tool: "edit",
      status: "success",
      evidence: [
        { type: "file", source: "src/a.ts", description: "edited", timestamp: 1000 },
        { type: "file", source: "src/b.ts", description: "edited", timestamp: 1000 },
      ],
    }));

    const output = await freshOutputDir();
    const pkg = await exportEpisode({ events, sessions, outputDir: output });

    const summary = (await readJson(join(output, "summary.json"))) as {
      sessionId: string;
      status: string;
      artifacts: string[];
      metrics: RunMetrics;
      files: string[];
    };
    expect(summary.sessionId).toBe(sid);
    expect(summary.status).toBe("failed");
    expect(summary.artifacts).toEqual(["src/a.ts", "src/b.ts"]);
    expect(summary.metrics.tool_call_count).toBe(1);
    expect(summary.files).toEqual(EPISODE_FILES);
    expect(pkg.summary.sessionId).toBe(sid);
    expect(pkg.summary.artifacts).toEqual(["src/a.ts", "src/b.ts"]);
  });

  it("exports an empty package for an empty event stream without throwing", async () => {
    const sid = newSessionId();
    const events = new InMemoryEventStore();
    const sessions = new InMemorySessionStore();
    await sessions.createSession(makeSession(sid));

    const output = await freshOutputDir();
    const pkg = await exportEpisode({ events, sessions, outputDir: output });

    expect(pkg.events).toEqual([]);
    expect(pkg.files).toEqual(EPISODE_FILES);
    expect(pkg.metrics).toEqual({
      turn_count: 0,
      tool_call_count: 0,
      tokens_input: 0,
      tokens_output: 0,
      context_tokens: 0,
      compaction_count: 0,
      duration_ms: 0,
      retry_count: 0,
      verification_failures: 0,
      human_interventions: 0,
      estimated_cost: 0,
      usage_unknown: 0,
      cache_tokens_read: 0,
      cache_tokens_created: 0,
      model_call_count: 0,
    });
    expect(await readFile(join(output, "events.jsonl"), "utf8")).toBe("");
    expect(await readJsonLines(join(output, "tool-calls.jsonl"))).toEqual([]);
    expect(await readJsonLines(join(output, "permissions.jsonl"))).toEqual([]);
    const verification = (await readJson(join(output, "verification.json"))) as { source: string };
    expect(verification.source).toBe("none");
    const context = (await readJson(join(output, "context.json"))) as { builds: unknown[]; compactions: unknown[] };
    expect(context.builds).toEqual([]);
    expect(context.compactions).toEqual([]);
  });

  it("task.json mirrors the provided TaskSpec", async () => {
    const sid = newSessionId();
    const events = new InMemoryEventStore();
    const sessions = new InMemorySessionStore();
    await sessions.createSession(makeSession(sid));
    const task: TaskSpec = {
      id: "T-1",
      goal: "do the thing",
      constraints: ["no deps"],
      verification: [{ kind: "command", command: "pnpm test" }],
    };

    const output = await freshOutputDir();
    await exportEpisode({ events, sessions, task, outputDir: output });

    expect(await readJson(join(output, "task.json"))).toEqual(task);
  });

  it("embeds the verifier result and passes changedPaths/cwd to it", async () => {
    const sid = newSessionId();
    const events = new InMemoryEventStore();
    const sessions = new InMemorySessionStore();
    const session = makeSession(sid);
    await sessions.createSession(session);
    const mk = makeEventBuilder(sid);
    await events.append(mk("tool.completed", {
      toolCallId: "toolcall_1",
      tool: "edit",
      status: "success",
      evidence: [{ type: "file", source: "src/a.ts", description: "edited", timestamp: 1000 }],
    }));

    let seenContext: VerificationContext | undefined;
    const verifier: Verifier = {
      async verify(_task: TaskSpec, context: VerificationContext): Promise<VerificationResult> {
        seenContext = context;
        return {
          level: 2,
          passed: true,
          checks: [{ id: "c1", kind: "artifact", description: "a.ts changed", passed: true }],
          evidence: [],
          startedAt: 1000,
          completedAt: 1005,
        };
      },
    };
    const task: TaskSpec = { id: "T-1", goal: "do the thing" };

    const output = await freshOutputDir();
    await exportEpisode({ events, sessions, task, verifier, outputDir: output });

    expect(seenContext?.sessionId).toBe(sid);
    expect(seenContext?.cwd).toBe(session.cwd);
    expect(seenContext?.changedPaths).toEqual(["src/a.ts"]);
    const verification = (await readJson(join(output, "verification.json"))) as {
      source: string;
      passed: boolean;
      checks: unknown[];
    };
    expect(verification.source).toBe("verifier");
    expect(verification.passed).toBe(true);
    expect(verification.checks).toHaveLength(1);
  });

  it("artifacts.json collects file evidence from tool.completed events", async () => {
    const sid = newSessionId();
    const events = new InMemoryEventStore();
    const sessions = new InMemorySessionStore();
    await sessions.createSession(makeSession(sid));
    const mk = makeEventBuilder(sid);
    await events.append(mk("tool.completed", {
      toolCallId: "toolcall_1",
      tool: "edit",
      status: "success",
      evidence: [
        { type: "file", source: "src/a.ts", description: "edited", timestamp: 1000 },
        { type: "diff", source: "src/a.ts", description: "diff", timestamp: 1000 },
      ],
      artifacts: ["tests/x.test.ts"],
    }));

    const output = await freshOutputDir();
    await exportEpisode({ events, sessions, outputDir: output });

    const doc = (await readJson(join(output, "artifacts.json"))) as {
      artifacts: { path: string; kind?: string }[];
    };
    expect(doc.artifacts).toEqual([
      { path: "src/a.ts", kind: "file", description: "edited", at: 1000 },
      { path: "tests/x.test.ts", at: 1000 },
    ]);
  });

  it("session.json round-trips the stored session", async () => {
    const sid = newSessionId();
    const events = new InMemoryEventStore();
    const sessions = new InMemorySessionStore();
    const session = makeSession(sid);
    await sessions.createSession(session);

    const output = await freshOutputDir();
    await exportEpisode({ events, sessions, outputDir: output });

    expect(await readJson(join(output, "session.json"))).toEqual(session);
  });
});

describe("computeMetrics (TRACE-001, §78)", () => {
  it("is deterministic on a synthetic stream and matches expectations", async () => {
    const sid = newSessionId();
    const mk = makeEventBuilder(sid);
    const events = [
      mk("turn.started"),
      // P0-9: usage rides on model.completed (usage on model.started was the
      // old optional reading; the runtime now folds snapshots into completed).
      mk("model.completed", { finishReason: "stop", usage: { inputTokens: 10, outputTokens: 5, contextTokens: 100 } }),
      mk("tool.requested", { toolCallId: "toolcall_1", name: "read" }),
      mk("context.compacted", { compressed: 50 }),
      mk("verification.completed", { passed: true }),
    ];
    const first = computeMetrics(events);
    const second = computeMetrics(events);
    expect(second).toEqual(first);
    expect(first.turn_count).toBe(1);
    expect(first.tool_call_count).toBe(1);
    expect(first.tokens_input).toBe(10);
    expect(first.tokens_output).toBe(5);
    expect(first.context_tokens).toBe(100);
    expect(first.compaction_count).toBe(1);
    expect(first.duration_ms).toBe(400);
    expect(first.verification_failures).toBe(0);
    expect(first.human_interventions).toBe(0);
    expect(first.retry_count).toBe(0);
  });

  it("counts context.built tokens into context_tokens", () => {
    const sid = newSessionId();
    const mk = makeEventBuilder(sid);
    const events = [
      mk("context.built", { tokens: 300 }),
      mk("context.built", { tokens: 150 }),
    ];
    const metrics = computeMetrics(events);
    expect(metrics.context_tokens).toBe(450);
  });

  it("P0-9 acceptance: exactly reports the single-call usage without double counting", () => {
    const sid = newSessionId();
    const mk = makeEventBuilder(sid);
    // The runtime folds provider usage snapshots into model.completed; the
    // terminal event alone is what metrics sums — a usage that also appeared
    // on model.started must not be added twice.
    const events = [
      mk("model.started", { callId: "modelcall_1", usage: { inputTokens: 100, outputTokens: 50 } }),
      mk("model.completed", {
        callId: "modelcall_1",
        finishReason: "stop",
        usage: { inputTokens: 100, outputTokens: 50, estimatedCostUsd: 0.0012 },
      }),
    ];
    const metrics = computeMetrics(events);
    expect(metrics.tokens_input).toBe(100);
    expect(metrics.tokens_output).toBe(50);
    expect(metrics.estimated_cost).toBeCloseTo(0.0012, 6);
  });

  it("P0-9 acceptance: multi-call usage sums per call, never double counts", () => {
    const sid = newSessionId();
    const mk = makeEventBuilder(sid);
    const events = [
      mk("model.completed", { callId: "modelcall_1", finishReason: "stop", usage: { inputTokens: 100, outputTokens: 50, estimatedCostUsd: 0.001 } }),
      // A duplicate/mislaid usage on a model.started must NOT add again.
      mk("model.started", { callId: "modelcall_2", usage: { inputTokens: 200, outputTokens: 25 } }),
      mk("model.completed", { callId: "modelcall_2", finishReason: "stop", usage: { inputTokens: 200, outputTokens: 25, estimatedCostUsd: 0.002 } }),
    ];
    const metrics = computeMetrics(events);
    // 100+200 and 50+25 exactly; the model.started usage is ignored.
    expect(metrics.tokens_input).toBe(300);
    expect(metrics.tokens_output).toBe(75);
    expect(metrics.estimated_cost).toBeCloseTo(0.003, 6);
  });

  it("requires exactly one session in the store", async () => {
    const events = new InMemoryEventStore();
    const sessions = new InMemorySessionStore();
    const output = await freshOutputDir();

    await expect(
      exportEpisode({ events, sessions, outputDir: output }),
    ).rejects.toThrow(/no session/);

    await sessions.createSession(makeSession(newSessionId()));
    await sessions.createSession(makeSession(newSessionId()));
    await expect(
      exportEpisode({ events, sessions, outputDir: output }),
    ).rejects.toThrow(/exactly one session/);
  });

  it("returns the exported episode package with events and metrics", async () => {
    const sid = newSessionId();
    const events = new InMemoryEventStore();
    const sessions = new InMemorySessionStore();
    await sessions.createSession(makeSession(sid));
    const mk = makeEventBuilder(sid);
    await events.append(mk("turn.started"));

    const output = await freshOutputDir();
    const pkg: EpisodePackage = await exportEpisode({ events, sessions, outputDir: output });

    expect(pkg.outputDir).toBe(output);
    expect(pkg.events).toHaveLength(1);
    expect(pkg.metrics.turn_count).toBe(1);
    expect(pkg.summary.status).toBe("completed");
  });
});
