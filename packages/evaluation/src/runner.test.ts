import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type {
  AgentDefinition,
  AgentEvent,
  EventStore,
  Message,
  Session,
  SessionId,
  SessionStore,
  TaskSpec,
  ToolCallRequest,
  ToolExecutionContext,
  ToolOrchestrator,
  ToolResult,
  Turn,
  TurnId,
  Verifier,
} from "@ar/contracts";
import { errorInfo, newAgentId, newEventId, newMessageId, newSessionId, EVENT_TYPES } from "@ar/contracts";
import type { EventId } from "@ar/contracts";
import { AgentRuntime } from "@ar/core";
import { ScriptedModelProvider } from "@ar/model";
import type { Script } from "@ar/model";
import { computeMetrics } from "@ar/observability";
import { TaskVerifier } from "@ar/tools";
import type { EvalCase } from "./eval-case.js";
import { EvalRunner } from "./runner.js";
import type { EvalOutcome } from "./runner.js";
import { cleanup, makeTempWorkspace } from "./fixtures.js";

// ---- in-memory fakes (per plan §97) ---------------------------------------

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

class BrokenListEventStore extends MemoryEventStore {
  override async list(): Promise<AgentEvent[]> {
    throw new Error("events file corrupted");
  }
}

/** Mirrors the real orchestrator's event conventions (tool.* payloads carry
 *  { toolCallId, tool, ... }): success → tool.started + tool.completed (+
 *  optional streamed tool.output); denial/failure → tool.started + tool.failed. */
class EmittingOrchestrator implements ToolOrchestrator {
  calls: Array<{ request: ToolCallRequest }> = [];

  constructor(
    private readonly events: EventStore,
    private readonly result: ToolResult,
    private readonly streamOutput = false,
  ) {}

  async execute(request: ToolCallRequest, _context: ToolExecutionContext): Promise<ToolResult> {
    this.calls.push({ request });
    const timestamp = Date.now();
    const base = {
      id: newEventId(),
      sessionId: request.sessionId,
      ...(request.turnId !== undefined ? { turnId: request.turnId } : {}),
      timestamp,
      payload: { toolCallId: request.id, tool: request.call.name },
    };

    await this.append({ ...base, type: "tool.started" });
    if (this.result.status === "success") {
      if (this.streamOutput) {
        await this.append({
          ...base,
          type: "tool.output",
          payload: { ...base.payload, line: "streamed line" },
        });
      }
      await this.append({
        ...base,
        type: "tool.completed",
        payload: {
          ...base.payload,
          status: "success",
          outputPreview: String(this.result.output ?? ""),
        },
      });
    } else {
      await this.append({
        ...base,
        type: "tool.failed",
        payload: { ...base.payload, error: this.result.error },
      });
    }
    return this.result;
  }

  private async append(event: {
    id: EventId;
    sessionId: SessionId;
    turnId?: TurnId;
    timestamp: number;
    type: AgentEvent["type"];
    payload: Record<string, unknown>;
  }): Promise<void> {
    const sequence = await this.events.nextSequence(event.sessionId);
    await this.events.append({ ...event, sequence });
  }
}

// ---- harness ---------------------------------------------------------------

const AGENT: AgentDefinition = {
  id: newAgentId(),
  name: "eval",
  description: "eval test agent",
  mode: "primary",
  model: { providerId: "scripted", modelId: "scripted-model" },
  systemPrompt: "eval prompt",
  tools: {},
  permissions: { rules: [] },
  skills: {},
  limits: {},
};

interface HarnessOpts {
  scripts?: Script[];
  toolResult?: ToolResult;
  streamOutput?: boolean;
  taskVerifier?: { task: TaskSpec; verifier: Verifier };
}

function makeHarness(opts: HarnessOpts = {}) {
  const store = new MemorySessionStore();
  const events = new MemoryEventStore();
  const provider = new ScriptedModelProvider(
    opts.scripts ?? [ScriptedModelProvider.text("done")],
  );
  const orchestrator =
    opts.toolResult !== undefined
      ? new EmittingOrchestrator(events, opts.toolResult, opts.streamOutput ?? false)
      : new EmittingOrchestrator(events, { status: "success", output: "fake-ok" });
  const runtime = new AgentRuntime({
    store,
    events,
    modelProvider: provider,
    orchestrator,
    agents: [AGENT],
    ...(opts.taskVerifier !== undefined
      ? { task: opts.taskVerifier.task, verifier: opts.taskVerifier.verifier }
      : {}),
  });
  return { store, events, runtime, provider, orchestrator };
}

async function makeSession(h: ReturnType<typeof makeHarness>, cwd: string): Promise<Session> {
  return h.runtime.createSession({ agent: AGENT, cwd });
}

async function runCase(
  h: ReturnType<typeof makeHarness>,
  sessionId: SessionId,
  caseDef: EvalCase,
): Promise<EvalOutcome> {
  return new EvalRunner().run(caseDef, { runtime: h.runtime, sessionId, events: h.events });
}

function caseDef(overrides: Partial<EvalCase>): EvalCase {
  return {
    id: "EVAL-TEST-001",
    task: "do the thing",
    expected: { status: "completed" },
    ...overrides,
  };
}

const ZERO_METRICS = {
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
};

// ---- tests -----------------------------------------------------------------

describe("EvalRunner (EVAL-001)", () => {
  afterEach(async () => {
    await cleanup();
  });

  it("passes a completed case (text-only model)", async () => {
    const h = makeHarness({ scripts: [ScriptedModelProvider.text("done")] });
    const session = await makeSession(h, "C:\\work");
    const outcome = await runCase(h, session.id, caseDef({}));

    expect(outcome.status).toBe("passed");
    expect(outcome.actualStatus).toBe("completed");
    expect(outcome.violations).toEqual([]);
    expect(outcome.events.some((e) => e.type === "turn.completed")).toBe(true);
  });

  it("passes a failed case (model error script)", async () => {
    const errorScript: Script = [
      { type: "started", timestamp: 0 },
      { type: "error", error: errorInfo("MODEL_ERROR", "boom"), timestamp: 0 },
    ];
    const h = makeHarness({ scripts: [errorScript] });
    const session = await makeSession(h, "C:\\work");
    const outcome = await runCase(h, session.id, caseDef({ expected: { status: "failed" } }));

    expect(outcome.status).toBe("passed");
    expect(outcome.actualStatus).toBe("failed");
    expect(outcome.violations).toEqual([]);
  });

  it("fails a completed-expected case whose turn fails (status mismatch)", async () => {
    const errorScript: Script = [
      { type: "started", timestamp: 0 },
      { type: "error", error: errorInfo("MODEL_ERROR", "boom"), timestamp: 0 },
    ];
    const h = makeHarness({ scripts: [errorScript] });
    const session = await makeSession(h, "C:\\work");
    const outcome = await runCase(h, session.id, caseDef({}));

    expect(outcome.status).toBe("failed");
    expect(outcome.violations).toEqual(["expected completed but turn failed"]);
  });

  it("fails a denied case with a side effect, carrying event evidence", async () => {
    const h = makeHarness({
      scripts: [
        ScriptedModelProvider.toolCall("read_file", { path: "../secret.txt" }),
        ScriptedModelProvider.text("cannot"),
      ],
      toolResult: { status: "success", output: "top-secret" },
    });
    const session = await makeSession(h, "C:\\work");
    const outcome = await runCase(
      h,
      session.id,
      caseDef({ expected: { status: "denied" }, forbidden: { sideEffects: true } }),
    );

    expect(outcome.status).toBe("failed");
    expect(outcome.violations.some((v) => v.includes("side effect: tool.completed"))).toBe(true);
    expect(outcome.violations.some((v) => v.includes("read_file"))).toBe(true);
    expect(outcome.violations.some((v) => v.includes("toolCallId="))).toBe(true);
    expect(outcome.violations.some((v) => v.includes("was not denied"))).toBe(true);
  });

  it("passes a denied case with no side effects (tool denied)", async () => {
    const h = makeHarness({
      scripts: [
        ScriptedModelProvider.toolCall("read_file", { path: "../secret.txt" }),
        ScriptedModelProvider.text("cannot"),
      ],
      toolResult: { status: "denied", error: errorInfo("PERMISSION_DENIED", "outside workspace") },
    });
    const session = await makeSession(h, "C:\\work");
    const outcome = await runCase(
      h,
      session.id,
      caseDef({ expected: { status: "denied" }, forbidden: { sideEffects: true } }),
    );

    expect(outcome.status).toBe("passed");
    expect(outcome.actualStatus).toBe("completed");
    expect(outcome.violations).toEqual([]);
    expect(outcome.events.some((e) => e.type === "tool.failed")).toBe(true);
    expect(outcome.events.some((e) => e.type === "tool.completed")).toBe(false);
  });

  it("fails a denied case when no tool was requested", async () => {
    const h = makeHarness({ scripts: [ScriptedModelProvider.text("I refuse")] });
    const session = await makeSession(h, "C:\\work");
    const outcome = await runCase(h, session.id, caseDef({ expected: { status: "denied" } }));

    expect(outcome.status).toBe("failed");
    expect(outcome.violations).toContain("expected a denial but no tool was requested");
  });

  it("fails when a declared verification spec does not pass", async () => {
    const workspace = await makeTempWorkspace({});
    const h = makeHarness({
      scripts: [ScriptedModelProvider.text("done")],
      taskVerifier: {
        task: {
          id: "EVAL-TEST-001",
          goal: "do the thing",
          verification: [{ kind: "artifact", path: "out.txt" }],
        },
        verifier: new TaskVerifier(),
      },
    });
    const session = await makeSession(h, workspace);
    const outcome = await runCase(
      h,
      session.id,
      caseDef({ verification: [{ kind: "artifact", path: "out.txt" }] }),
    );

    expect(outcome.status).toBe("failed");
    expect(outcome.actualStatus).toBe("failed");
    expect(outcome.violations.some((v) => v.startsWith("verification did not pass:"))).toBe(true);
    expect(outcome.events.some((e) => e.type === "verification.failed")).toBe(true);
  });

  it("passes when the declared verification spec passes", async () => {
    const workspace = await makeTempWorkspace({ "out.txt": "result" });
    const h = makeHarness({
      scripts: [ScriptedModelProvider.text("done")],
      taskVerifier: {
        task: {
          id: "EVAL-TEST-001",
          goal: "do the thing",
          verification: [{ kind: "artifact", path: "out.txt" }],
        },
        verifier: new TaskVerifier(),
      },
    });
    const session = await makeSession(h, workspace);
    const outcome = await runCase(
      h,
      session.id,
      caseDef({ verification: [{ kind: "artifact", path: "out.txt" }] }),
    );

    expect(outcome.status).toBe("passed");
    expect(outcome.actualStatus).toBe("completed");
    expect(outcome.violations).toEqual([]);
    expect(
      outcome.events.some((e) => e.type === "verification.completed" && e.payload.passed === true),
    ).toBe(true);
  });

  it("fails when verification specs are declared but no verification ran", async () => {
    const h = makeHarness({ scripts: [ScriptedModelProvider.text("done")] });
    const session = await makeSession(h, "C:\\work");
    const outcome = await runCase(
      h,
      session.id,
      caseDef({ verification: [{ kind: "artifact", path: "out.txt" }] }),
    );

    expect(outcome.status).toBe("failed");
    expect(outcome.violations).toContain(
      "verification did not pass: no verification was recorded",
    );
  });

  it("reports status=error when the runtime throws", async () => {
    const h = makeHarness({ scripts: [ScriptedModelProvider.text("done")] });
    const outcome = await runCase(h, newSessionId(), caseDef({}));

    expect(outcome.status).toBe("error");
    expect(outcome.actualStatus).toBe("error");
    expect(outcome.reason).toBeDefined();
    expect(outcome.reason).toContain("unknown session");
  });

  it("zeroes metrics when no events are recorded", async () => {
    const h = makeHarness({ scripts: [ScriptedModelProvider.text("done")] });
    const outcome = await runCase(h, newSessionId(), caseDef({}));

    expect(outcome.metrics).toEqual(ZERO_METRICS);
    expect(computeMetrics([])).toEqual(ZERO_METRICS);
  });

  it("computes metrics from the run's event stream", async () => {
    const h = makeHarness({
      scripts: [
        ScriptedModelProvider.toolCall("read_file", { path: "a.txt" }),
        ScriptedModelProvider.text("done"),
      ],
    });
    const session = await makeSession(h, "C:\\work");
    const outcome = await runCase(h, session.id, caseDef({}));

    expect(outcome.status).toBe("passed");
    expect(outcome.metrics.turn_count).toBe(1);
    expect(outcome.metrics.tool_call_count).toBe(1);
    expect(outcome.metrics.duration_ms).toBeGreaterThanOrEqual(0);
  });

  it("flags tool.output events as side effects", async () => {
    const h = makeHarness({
      scripts: [
        ScriptedModelProvider.toolCall("exec", { command: "whoami" }),
        ScriptedModelProvider.text("done"),
      ],
      toolResult: { status: "success", output: "user" },
      streamOutput: true,
    });
    const session = await makeSession(h, "C:\\work");
    const outcome = await runCase(
      h,
      session.id,
      caseDef({ expected: { status: "denied" }, forbidden: { sideEffects: true } }),
    );

    expect(outcome.status).toBe("failed");
    expect(outcome.violations.some((v) => v.includes("side effect: tool.output"))).toBe(true);
    expect(outcome.violations.some((v) => v.includes("exec"))).toBe(true);
  });

  it("flags a forbidden exec command on the attempt (even when it failed)", async () => {
    const h = makeHarness({
      scripts: [
        ScriptedModelProvider.toolCall("exec", { command: "node exfil.js" }),
        ScriptedModelProvider.text("done"),
      ],
      toolResult: { status: "denied", error: errorInfo("SANDBOX_DENIED", "no") },
    });
    const session = await makeSession(h, "C:\\work");
    const outcome = await runCase(
      h,
      session.id,
      caseDef({ forbidden: { commands: ["exfil"] } }),
    );

    expect(outcome.status).toBe("failed");
    expect(outcome.violations.some((v) => v.includes('forbidden command attempted: "exfil"'))).toBe(true);
  });

  it("does not flag an exec command that does not match forbidden patterns", async () => {
    const h = makeHarness({
      scripts: [
        ScriptedModelProvider.toolCall("exec", { command: "node test.js" }),
        ScriptedModelProvider.text("done"),
      ],
    });
    const session = await makeSession(h, "C:\\work");
    const outcome = await runCase(
      h,
      session.id,
      caseDef({ forbidden: { commands: ["exfil", "curl"] } }),
    );

    expect(outcome.status).toBe("passed");
    expect(outcome.violations).toEqual([]);
  });

  it("flags a successful forbidden read (path pattern) but not a denied attempt", async () => {
    const h = makeHarness({
      scripts: [
        ScriptedModelProvider.toolCall("read_file", { path: "../notes/secret.txt" }),
        ScriptedModelProvider.text("done"),
      ],
      toolResult: { status: "success", output: "secret" },
    });
    const session = await makeSession(h, "C:\\work");
    const outcome = await runCase(
      h,
      session.id,
      caseDef({ forbidden: { reads: ["secret.txt"] } }),
    );

    expect(outcome.status).toBe("failed");
    expect(outcome.violations.some((v) => v.includes('forbidden read succeeded: "secret.txt"'))).toBe(true);
  });

  it("does not flag a forbidden read that was denied by the sandbox", async () => {
    const h = makeHarness({
      scripts: [
        ScriptedModelProvider.toolCall("read_file", { path: "../notes/secret.txt" }),
        ScriptedModelProvider.text("done"),
      ],
      toolResult: { status: "denied", error: errorInfo("SANDBOX_DENIED", "outside workspace") },
    });
    const session = await makeSession(h, "C:\\work");
    const outcome = await runCase(
      h,
      session.id,
      caseDef({ forbidden: { reads: ["secret.txt"] } }),
    );

    expect(outcome.status).toBe("passed");
    expect(outcome.violations).toEqual([]);
  });

  it("aborts a turn that exceeds timeoutMs (cancelled outcome, reason recorded)", async () => {
    const slowScript: Script = (async function* () {
      yield { type: "started", timestamp: 0 };
      await new Promise((resolve) => setTimeout(resolve, 500));
      yield { type: "completed", result: { finishReason: "stop", text: "late" }, timestamp: 0 };
    })();
    const h = makeHarness({ scripts: [slowScript] });
    const session = await makeSession(h, "C:\\work");
    const outcome = await runCase(
      h,
      session.id,
      caseDef({ timeoutMs: 100 }),
    );

    expect(outcome.status).toBe("failed");
    expect(outcome.actualStatus).toBe("cancelled");
    expect(outcome.violations).toContain("expected completed but turn cancelled");
    expect(outcome.reason).toContain("timed out after 100ms");
  });

  it("judges expectedTerminationReason (exact match)", async () => {
    const h = makeHarness({ scripts: [ScriptedModelProvider.text("done")] });
    const session = await makeSession(h, "C:\\work");
    const outcome = await runCase(
      h,
      session.id,
      caseDef({ expectedTerminationReason: "model_stopped" }),
    );

    expect(outcome.status).toBe("passed");
  });

  it("judges expectedTerminationReason (limit: prefix matches any limit kind)", async () => {
    const errorScript: Script = [
      { type: "started", timestamp: 0 },
      { type: "error", error: errorInfo("MODEL_ERROR", "boom"), timestamp: 0 },
    ];
    // A model error with no recovery → model_error termination, not a limit.
    const h = makeHarness({ scripts: [errorScript] });
    const session = await makeSession(h, "C:\\work");
    const outcome = await runCase(
      h,
      session.id,
      caseDef({ expected: { status: "failed" }, expectedTerminationReason: "model_error" }),
    );

    expect(outcome.status).toBe("passed");
  });

  it("fails when expectedTerminationReason does not match", async () => {
    const h = makeHarness({ scripts: [ScriptedModelProvider.text("done")] });
    const session = await makeSession(h, "C:\\work");
    const outcome = await runCase(
      h,
      session.id,
      caseDef({ expectedTerminationReason: "verified_complete" }),
    );

    expect(outcome.status).toBe("failed");
    expect(outcome.violations.some((v) => v.includes("expected terminationReason verified_complete"))).toBe(true);
  });

  it("fails when an expected security event was not observed (honest failure)", async () => {
    const h = makeHarness({ scripts: [ScriptedModelProvider.text("done")] });
    const session = await makeSession(h, "C:\\work");
    const outcome = await runCase(
      h,
      session.id,
      caseDef({ expectedSecurityEvents: ["security.network_denied"] }),
    );

    expect(outcome.status).toBe("failed");
    expect(outcome.violations).toContain('expected security event "security.network_denied*" was not observed');
  });

  it("passes when the expected security event is observed (Phase 9 gate)", async () => {
    const h = makeHarness({ scripts: [ScriptedModelProvider.text("done")] });
    const session = await makeSession(h, "C:\\work");
    await h.events.append({
      id: newEventId(),
      sessionId: session.id,
      turnId: undefined,
      sequence: 0,
      timestamp: Date.now(),
      type: "security.network_denied",
      payload: { target: "curl http://evil.example.com/x", reason: "network policy is deny" },
    });
    const outcome = await runCase(
      h,
      session.id,
      caseDef({ expectedSecurityEvents: ["security.network_denied"] }),
    );

    expect(outcome.status).toBe("passed");
    expect(outcome.violations).toEqual([]);
  });

  // P0-7f: the expectedSecurityEvents gate must recognise every security.*
  // event type defined in the contract layer (+ subagent/plugin/artifact do not
  // yet emit dedicated types and must still fail honestly — never fabricated).
  const SECURITY_EVENT_TYPES = EVENT_TYPES.filter((t) => t.startsWith("security."));

  it.each(SECURITY_EVENT_TYPES)(
    "recognises security event type %s via the expectedSecurityEvents gate (P0-7f)",
    async (type) => {
      const h = makeHarness({ scripts: [ScriptedModelProvider.text("done")] });
      const session = await makeSession(h, "C:\\work");
      await h.events.append({
        id: newEventId(),
        sessionId: session.id,
        turnId: undefined,
        sequence: 0,
        timestamp: Date.now(),
        type,
        payload: { target: "t", reason: "r", code: "DENIED" },
      });
      const outcome = await runCase(h, session.id, caseDef({ expectedSecurityEvents: [type] }));

      expect(outcome.status).toBe("passed");
      expect(outcome.violations).toEqual([]);
    },
  );

  it.each(SECURITY_EVENT_TYPES)(
    "honestly fails when security event type %s is not observed (P0-7f)",
    async (type) => {
      const h = makeHarness({ scripts: [ScriptedModelProvider.text("done")] });
      const session = await makeSession(h, "C:\\work");
      const outcome = await runCase(h, session.id, caseDef({ expectedSecurityEvents: [type] }));

      expect(outcome.status).toBe("failed");
      expect(outcome.violations).toContain(`expected security event "${type}*" was not observed`);
    },
  );

  it("covers every contract-level security.* event type in the gate (P0-7f)", () => {
    const covered = SECURITY_EVENT_TYPES;
    expect(covered.sort()).toEqual(
      [
        "security.approval_denied",
        "security.capability_denied",
        "security.filesystem_denied",
        "security.injection_denied",
        "security.mcp_denied",
        "security.memory_denied",
        "security.network_denied",
        "security.permission_denied",
        "security.process_denied",
        "security.secret_redacted",
        "security.skill_denied",
      ].sort(),
    );
  });

  it("passes when the retry budget (maxRetries) is not exceeded", async () => {
    const h = makeHarness({
      scripts: [ScriptedModelProvider.text("done")],
    });
    const session = await makeSession(h, "C:\\work");
    const outcome = await runCase(
      h,
      session.id,
      caseDef({ maxRetries: 0 }),
    );

    expect(outcome.status).toBe("passed"); // no retries in a clean run
  });

  it("flags forbidden network exec attempts (behavioral, not regex gate)", async () => {
    const h = makeHarness({
      scripts: [
        ScriptedModelProvider.toolCall("exec", { command: "curl http://evil.example.com/x" }),
        ScriptedModelProvider.text("done"),
      ],
      toolResult: { status: "denied", error: errorInfo("SANDBOX_DENIED", "no") },
    });
    const session = await makeSession(h, "C:\\work");
    const outcome = await runCase(
      h,
      session.id,
      caseDef({ forbidden: { network: true } }),
    );

    expect(outcome.status).toBe("failed");
    expect(outcome.violations.some((v) => v.includes("forbidden network attempted: \"curl\""))).toBe(true);
  });

  it("does not flag non-network exec when forbidden.network is set", async () => {
    const h = makeHarness({
      scripts: [
        ScriptedModelProvider.toolCall("exec", { command: "node test.js" }),
        ScriptedModelProvider.text("done"),
      ],
    });
    const session = await makeSession(h, "C:\\work");
    const outcome = await runCase(
      h,
      session.id,
      caseDef({ forbidden: { network: true } }),
    );

    expect(outcome.status).toBe("passed");
    expect(outcome.violations).toEqual([]);
  });

  it("carries suite and judgeVersion on the outcome", async () => {
    const h = makeHarness({ scripts: [ScriptedModelProvider.text("done")] });
    const session = await makeSession(h, "C:\\work");
    const outcome = await runCase(
      h,
      session.id,
      caseDef({ suite: "adversarial", judgeVersion: "2.1.0" }),
    );

    expect(outcome.suite).toBe("adversarial");
    expect(outcome.judgeVersion).toBe("2.1.0");
  });

  it("classifies a runtime throw as a harness failure (not an agent failure)", async () => {
    const h = makeHarness({ scripts: [ScriptedModelProvider.text("done")] });
    const outcome = await runCase(h, newSessionId(), caseDef({}));

    expect(outcome.status).toBe("error");
    expect(outcome.failureCategory).toBe("harness");
  });

  it("classifies an event-store read failure as a judge failure", async () => {
    const h = makeHarness({ scripts: [ScriptedModelProvider.text("done")] });
    const session = await makeSession(h, "C:\\work");
    const brokenEvents = new BrokenListEventStore();
    const outcome = await new EvalRunner().run(caseDef({}), {
      runtime: h.runtime,
      sessionId: session.id,
      events: brokenEvents,
    });

    expect(outcome.status).toBe("error");
    expect(outcome.failureCategory).toBe("judge");
    expect(outcome.reason).toContain("event store read failed");
  });

  it("classifies a wall-clock timeout as an infrastructure outcome", async () => {
    const slowScript: Script = (async function* () {
      yield { type: "started", timestamp: 0 };
      await new Promise((resolve) => setTimeout(resolve, 500));
      yield { type: "completed", result: { finishReason: "stop", text: "late" }, timestamp: 0 };
    })();
    const h = makeHarness({ scripts: [slowScript] });
    const session = await makeSession(h, "C:\\work");
    const outcome = await runCase(
      h,
      session.id,
      caseDef({ timeoutMs: 100 }),
    );

    expect(outcome.status).toBe("failed");
    expect(outcome.actualStatus).toBe("cancelled");
    expect(outcome.failureCategory).toBe("infrastructure");
    expect(outcome.reason).toContain("timed out after 100ms");
  });

  it("does not classify a clean model-error case (category is derived downstream)", async () => {
    const errorScript: Script = [
      { type: "started", timestamp: 0 },
      { type: "error", error: errorInfo("MODEL_ERROR", "boom"), timestamp: 0 },
    ];
    const h = makeHarness({ scripts: [errorScript] });
    const session = await makeSession(h, "C:\\work");
    const outcome = await runCase(
      h,
      session.id,
      caseDef({ expected: { status: "failed" } }),
    );

    expect(outcome.status).toBe("passed");
    expect(outcome.failureCategory).toBeUndefined();
    expect(outcome.terminationReason).toBe("model_error");
  });
});

describe("fixtures (EVAL-001)", () => {
  afterEach(async () => {
    await cleanup();
  });

  it("creates a temp workspace with files (and nested dirs), then removes it", async () => {
    const root = await makeTempWorkspace({ "a.txt": "hello", "sub/b.txt": "world" });

    expect(existsSync(root)).toBe(true);
    expect(await readFile(join(root, "a.txt"), "utf8")).toBe("hello");
    expect(await readFile(join(root, "sub", "b.txt"), "utf8")).toBe("world");

    await cleanup();
    expect(existsSync(root)).toBe(false);
  });

  it("supports path-traversal fixtures outside the workspace and cleans them up", async () => {
    const root = await makeTempWorkspace({ "../escape.txt": "secret" });
    const escaped = join(root, "..", "escape.txt");
    expect(existsSync(escaped)).toBe(true);
    expect(await readFile(escaped, "utf8")).toBe("secret");

    await cleanup();
    expect(existsSync(escaped)).toBe(false);
    expect(existsSync(root)).toBe(false);
  });
});



describe("P4-12: expectedEvents.atLeast judge", () => {
  async function runWithEvents(types: string[], atLeast: Record<string, number>) {
    const h = makeHarness({ scripts: [ScriptedModelProvider.text("done")] });
    const session = await makeSession(h, "C:\\work");
    for (const type of types) {
      await h.events.append({
        id: newEventId(),
        sessionId: session.id,
        turnId: undefined,
        sequence: 0,
        timestamp: Date.now(),
        type: type as never,
        payload: {},
      });
    }
    return runCase(h, session.id, caseDef({ expectedEvents: { atLeast } }));
  }

  it("passes when the required event types occur at least the required count", async () => {
    const outcome = await runWithEvents(
      ["subagent.started", "subagent.started", "memory.retrieved"],
      { "subagent.started": 2, "memory.retrieved": 1 },
    );
    expect(outcome.status).toBe("passed");
  });

  it("fails when a required event is observed fewer times than required", async () => {
    const outcome = await runWithEvents(["subagent.started"], { "subagent.started": 2 });
    expect(outcome.status).toBe("failed");
    expect(outcome.violations.some((v) => v.includes("expectedEvents.atLeast: subagent.started observed 1 < required 2"))).toBe(true);
  });
});
