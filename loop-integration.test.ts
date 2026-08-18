import { describe, expect, it } from "vitest";
import type {
  AgentDefinition,
  ContextBudget,
  InstructionDiscoveryOptions,
  ModelEvent,
  TaskSpec,
  ToolCallRequest,
  ToolExecutionContext,
  ToolResult,
  Verifier,
  VerificationContext,
  VerificationResult,
} from "@ar/contracts";
import { errorInfo, newAgentId } from "@ar/contracts";
import { ScriptedModelProvider } from "@ar/model";
import { ContextPipeline } from "@ar/context";
import { AgentRuntime } from "./runtime.js";
import { MemoryEventStore, MemorySessionStore } from "../test/fakes.js";
import { FakeOrchestrator } from "../test/fake-orchestrator.js";
import { RecoveryPolicy } from "../recovery/recovery.js";

const AGENT: AgentDefinition = {
  id: newAgentId(),
  name: "loop-agent",
  description: "loop integration",
  mode: "primary",
  model: { providerId: "scripted", modelId: "scripted-model" },
  systemPrompt: "you are a loop test agent",
  tools: {},
  permissions: { rules: [] },
  skills: {},
  limits: {},
};

const FAKE_TASK: TaskSpec = {
  id: "loop-task",
  goal: "make a small change and verify with tests",
  constraints: ["touch only README"],
  verification: [
    { kind: "command", command: "tests pass", description: "required test must pass" },
  ],
};

const BIG_BUDGET: ContextBudget = {
  maxTokens: 1_000_000,
  reserved: { system: 0, task: 0, output: 0 },
  dynamic: 0,
};

const TINY_BUDGET: ContextBudget = {
  maxTokens: 500,
  reserved: { system: 0, task: 0, output: 0 },
  dynamic: 0,
};

/** Deterministic InstructionDiscovery double returning scripted docs. */
class ScriptedDiscovery {
  constructor(public readonly docs: { path: string; scope: "root" | "nested" | "cwd"; content: string }[]) {}
  readonly seenCwd: string[] = [];
  async discover(cwd: string, _opts?: InstructionDiscoveryOptions) {
    this.seenCwd.push(cwd);
    return this.docs.map((d) => ({
      path: d.path,
      scope: d.scope,
      sizeBytes: Buffer.byteLength(d.content, "utf8"),
      content: d.content,
      truncated: false,
      detectedAt: 0,
    }));
  }
}

function listVerifier(verdict: "passed" | "failed"): Verifier {
  return {
    async verify(_task: TaskSpec, _context: VerificationContext): Promise<VerificationResult> {
      const now = Date.now();
      const failed = verdict !== "passed";
      return {
        level: 3,
        passed: !failed,
        checks: [
          {
            id: "check-0",
            kind: "command",
            description: "required test must pass",
            passed: !failed,
            ...(failed ? { error: errorInfo("VERIFICATION_FAILED", "exit 1") } : {}),
          },
        ],
        evidence: [],
        startedAt: now,
        completedAt: now,
      };
    },
  };
}

function makeLoop(
  script: ModelEvent[][],
  overrides: {
    recovery?: RecoveryPolicy;
    task?: TaskSpec;
    verifier?: Verifier;
    pipeline?: ContextPipeline;
    budget?: ContextBudget;
    maxToolCalls?: number;
    maxIterationsPerTurn?: number;
    maxVerificationFailures?: number;
    toolCapabilityOf?: (name: string) => { retry: "safe" | "unknown" | "none"; concurrencySafe: boolean };
    orchResult?: { status: "success" | "failed"; output?: string; error?: ReturnType<typeof errorInfo> };
    changedPaths?: () => readonly string[];
  } = {},
) {
  const store = new MemorySessionStore();
  const events = new MemoryEventStore();
  const orch = new FakeOrchestrator(
    overrides.orchResult ?? { status: "success", output: "ok" },
  );
  const provider = new ScriptedModelProvider(script);
  const runtime = new AgentRuntime({
    store,
    events,
    modelProvider: provider,
    orchestrator: orch,
    agents: [
      { ...AGENT, limits: { maxToolCalls: overrides.maxToolCalls } },
    ],
    maxIterationsPerTurn: overrides.maxIterationsPerTurn,
    maxVerificationFailures: overrides.maxVerificationFailures,
    recovery: overrides.recovery,
    task: overrides.task,
    verifier: overrides.verifier,
    toolCapabilityOf: overrides.toolCapabilityOf,
    ...(overrides.changedPaths !== undefined ? { changedPathsProvider: overrides.changedPaths } : {}),
    ...(overrides.pipeline !== undefined
      ? { context: { pipeline: overrides.pipeline, budget: overrides.budget ?? BIG_BUDGET } }
      : {}),
  });
  return { store, events, orch, runtime };
}

async function runLoop(runtime: AgentRuntime, store: MemorySessionStore, text = "please do the task") {
  const session = await runtime.createSession({ agent: AGENT, cwd: "C:\\work" });
  const turn = await runtime.startTurn(session.id, text);
  const outcome = await runtime.runTurn(session.id, turn.id, new AbortController().signal);
  return { session, turn, outcome };
}

describe("LOOP-001 full agent loop (integration)", () => {
  it("acceptance: read README → change → run test → report, all through the orchestrator", async () => {
    const script: ModelEvent[][] = [
      ScriptedModelProvider.toolCall("read_file", { path: "README.md" }),
      ScriptedModelProvider.toolCall("edit_file", { path: "README.md", change: "typo" }),
      ScriptedModelProvider.toolCall("run_test", { command: "pnpm test" }),
      ScriptedModelProvider.text("done: fixed the typo, tests pass"),
    ];
    const { runtime, store, events, orch } = makeLoop(script, {
      task: FAKE_TASK,
      verifier: listVerifier("passed"),
    });

    const { outcome } = await runLoop(runtime, store);

    expect(outcome.status).toBe("completed");
    expect(orch.calls.map((c) => c.request.call.name)).toEqual([
      "read_file",
      "edit_file",
      "run_test",
    ]);
    expect(outcome.toolCalls).toBe(3);
    expect(outcome.iterations).toBe(3);

    const sessionId = (await store.listSessions())[0]!.id;
    expect((await events.list(sessionId)).map((e) => e.type)).toContain("verification.completed");

    const messages = await store.listMessages(sessionId);
    expect(messages[messages.length - 1]!.content).toContain("done: fixed the typo");
  });

  it("loops across iterations when the model keeps calling tools", async () => {
    const script: ModelEvent[][] = [
      ScriptedModelProvider.toolCall("run_test", { command: "first" }),
      ScriptedModelProvider.toolCall("run_test", { command: "second" }),
      ScriptedModelProvider.text("both passed"),
    ];
    const { runtime, store, orch } = makeLoop(script, {
      task: FAKE_TASK,
      verifier: listVerifier("passed"),
    });
    const { outcome } = await runLoop(runtime, store);
    expect(outcome.status).toBe("completed");
    expect(orch.calls.length).toBe(2);
    expect(outcome.toolCalls).toBe(2);
    expect(outcome.iterations).toBe(2);
  });

  it("VERIFY-001: blocks completion when the required test fails (bounded attempts)", async () => {
    const script: ModelEvent[][] = [
      ScriptedModelProvider.text("task done, tests pass"),
      ScriptedModelProvider.text("task done, tests pass"),
      ScriptedModelProvider.text("task done, tests pass"),
    ];
    const { runtime, store, events } = makeLoop(script, {
      task: FAKE_TASK,
      verifier: listVerifier("failed"),
      maxVerificationFailures: 3,
    });
    const { outcome } = await runLoop(runtime, store);

    expect(outcome.status).toBe("failed");
    expect(outcome.error?.code).toBe("VERIFICATION_FAILED");
    const sessionId = (await store.listSessions())[0]!.id;
    const stored = await events.list(sessionId);
    expect(stored.map((e) => e.type)).toContain("verification.failed");
    const limit = stored.find((e) => e.type === "run.limit_reached");
    expect(limit?.payload.limit).toBe("maxVerificationFailures");
  });

  it("VERIFY-001 (plan.md Phase 4): a failed gate injects an observation and the loop continues; a later pass completes", async () => {
    class FlakyVerifier implements Verifier {
      failuresLeft = 1;
      async verify(_task: TaskSpec, _context: VerificationContext): Promise<VerificationResult> {
        const now = Date.now();
        const failed = this.failuresLeft > 0;
        this.failuresLeft -= 1;
        return {
          level: 3,
          passed: !failed,
          checks: [
            {
              id: "check-0",
              kind: "command",
              description: "required test must pass",
              passed: !failed,
              ...(failed ? { error: errorInfo("VERIFICATION_FAILED", "exit 1") } : {}),
            },
          ],
          evidence: [],
          startedAt: now,
          completedAt: now,
        };
      }
    }
    const script: ModelEvent[][] = [
      ScriptedModelProvider.text("done"),
      ScriptedModelProvider.text("fixed it now"),
    ];
    const { runtime, store, events } = makeLoop(script, {
      task: FAKE_TASK,
      verifier: new FlakyVerifier(),
    });
    const { outcome } = await runLoop(runtime, store);

    expect(outcome.status).toBe("completed");
    expect(outcome.terminationReason).toBe("verified_complete");
    const sessionId = (await store.listSessions())[0]!.id;
    const messages = await store.listMessages(sessionId);
    const observation = messages.find((m) => m.role === "system" && m.content.includes("[verification failed"));
    expect(observation).toBeDefined();
    const stored = await events.list(sessionId);
    expect(stored.filter((e) => e.type === "verification.failed")).toHaveLength(1);
    expect(stored.filter((e) => e.type === "verification.completed")).toHaveLength(1);
  });

  it("RECOVERY (plan.md Phase 4): retries a model error up to the policy budget, then completes", async () => {
    const errorScript: ModelEvent[] = [
      { type: "started", timestamp: 0 },
      { type: "error", error: errorInfo("MODEL_ERROR", "transient 500"), timestamp: 0 },
    ];
    const script: ModelEvent[][] = [errorScript, ScriptedModelProvider.text("recovered")];
    const { runtime, store, events } = makeLoop(script, {
      recovery: new RecoveryPolicy({ retryDelayMs: 0 }),
    });
    const { outcome } = await runLoop(runtime, store);

    expect(outcome.status).toBe("completed");
    expect(outcome.terminationReason).toBe("model_stopped");
    const sessionId = (await store.listSessions())[0]!.id;
    const stored = await events.list(sessionId);
    const retry = stored.find((e) => e.type === "model.retry");
    expect(retry?.payload.attempt).toBe(1);
    expect(stored.filter((e) => e.type === "model.failed")).toHaveLength(0);
  });

  it("RECOVERY (plan.md Phase 4): exhausts model-error retries, then fails with a limit event", async () => {
    const errorScript: ModelEvent[] = [
      { type: "started", timestamp: 0 },
      { type: "error", error: errorInfo("MODEL_ERROR", "down"), timestamp: 0 },
    ];
    const script: ModelEvent[][] = [errorScript, errorScript, errorScript];
    const { runtime, store, events } = makeLoop(script, {
      recovery: new RecoveryPolicy({ retryDelayMs: 0 }),
    });
    const { outcome } = await runLoop(runtime, store);

    expect(outcome.status).toBe("failed");
    expect(outcome.error?.code).toBe("MODEL_ERROR");
    expect(outcome.terminationReason).toBe("model_error");
    const sessionId = (await store.listSessions())[0]!.id;
    const stored = await events.list(sessionId);
    expect(stored.filter((e) => e.type === "model.retry")).toHaveLength(2);
    const limit = stored.find((e) => e.type === "run.limit_reached");
    expect(limit?.payload.limit).toBe("maxRetries");
  });

  it("RECOVERY-001: retries a failed SAFE tool call up to the policy bound, then fails safely", async () => {
    const script: ModelEvent[][] = [
      ScriptedModelProvider.toolCall("flaky", {}),
      ScriptedModelProvider.text("final answer"),
    ];
    const failing: ToolResult = {
      status: "failed",
      error: errorInfo("PROCESS_ERROR", "boom"),
    };

    // failed once then success: retry heals → turn completes
    let fails = 0;
    class FlakyOrchestrator extends FakeOrchestrator {
      override async execute(
        request: ToolCallRequest,
        context: ToolExecutionContext,
      ): Promise<ToolResult> {
        if (fails < 1) {
          fails += 1;
          return failing;
        }
        return super.execute(request, context);
      }
    }
    const orch = new FlakyOrchestrator({ status: "success", output: "recovered" });

    const store = new MemorySessionStore();
    const events = new MemoryEventStore();
    const runtime = new AgentRuntime({
      store,
      events,
      modelProvider: new ScriptedModelProvider(script),
      orchestrator: orch,
      agents: [{ ...AGENT, limits: {} }],
      recovery: new RecoveryPolicy({ maxAttempts: 3, retryDelayMs: 0 }),
      // read-only idempotent tools are auto-retried (plan.md Phase 3.6)
      toolCapabilityOf: () => ({ retry: "safe", concurrencySafe: false }),
    });

    const { outcome } = await runLoop(runtime, store);
    expect(outcome.status).toBe("completed");
    expect(orch.calls.length).toBe(2);
  });

  it("RECOVERY-001: does NOT auto-retry a failed tool with unknown/non-idempotent effects", async () => {
    const script: ModelEvent[][] = [
      ScriptedModelProvider.toolCall("write_file", {}),
      ScriptedModelProvider.text("final answer"),
    ];
    const failing: ToolResult = {
      status: "failed",
      error: errorInfo("PROCESS_ERROR", "boom"),
    };
    let calls = 0;
    class FailingOnce extends FakeOrchestrator {
      override async execute(
        request: ToolCallRequest,
        context: ToolExecutionContext,
      ): Promise<ToolResult> {
        calls += 1;
        return failing;
      }
    }
    const orch = new FailingOnce({ status: "success", output: "n/a" });

    const store = new MemorySessionStore();
    const events = new MemoryEventStore();
    const runtime = new AgentRuntime({
      store,
      events,
      modelProvider: new ScriptedModelProvider(script),
      orchestrator: orch,
      agents: [{ ...AGENT, limits: {} }],
      recovery: new RecoveryPolicy({ maxAttempts: 5, retryDelayMs: 0 }),
      // default capability resolver: unknown → never blind-retry
    });

    const { outcome } = await runLoop(runtime, store);
    expect(outcome.status).toBe("completed"); // the model saw the failure and finished
    expect(calls).toBe(1); // exactly ONE execution — no hidden re-execution
  });

  it("CTX pipeline: discovery runs with the session cwd and instructions feed the model", async () => {
    const discovery = new ScriptedDiscovery([
      { path: "C:\\repo\\AGENTS.md", scope: "root", content: "# root rules" },
      { path: "C:\\repo\\sub\\AGENTS.md", scope: "nested", content: "# nested rules" },
    ]);
    const pipeline = new ContextPipeline({ discovery: discovery as never });
    const { runtime, store } = makeLoop(
      [
        ScriptedModelProvider.text("ok"),
      ],
      { pipeline, budget: BIG_BUDGET },
    );

    const session = await runtime.createSession({ agent: AGENT, cwd: "C:\\repo\\sub" });
    const turn = await runtime.startTurn(session.id, "go");
    const outcome = await runtime.runTurn(session.id, turn.id, new AbortController().signal);

    expect(outcome.status).toBe("completed");
    expect(discovery.seenCwd).toEqual(["C:\\repo\\sub"]);
  });

  it("P1-20: tool.completed and model.completed carry latency fields", async () => {
    const { runtime, store, events } = makeLoop(
      [ScriptedModelProvider.toolCall("read_file", { path: "README.md" }), ScriptedModelProvider.text("ok")],
      {},
    );

    const { session, outcome } = await runLoop(runtime, store);
    expect(outcome.status).toBe("completed");

    const all = await events.list(session.id);
    const toolDone = all.find((e) => e.type === "tool.completed");
    expect(toolDone).toBeDefined();
    expect(toolDone!.payload).toMatchObject({ tool: "read_file" });
    expect(toolDone!.payload.durationMs).toBeGreaterThanOrEqual(0);
    expect(typeof toolDone!.payload.toolCallId).toBe("string");

    const modelDone = all.find((e) => e.type === "model.completed" && e.payload.finishReason === "stop");
    expect(modelDone).toBeDefined();
    expect(modelDone!.payload.durationMs).toBeGreaterThanOrEqual(0);
    expect(modelDone!.payload.timeToFirstTokenMs).toBeGreaterThanOrEqual(0);
  });

  it("P1-17: each discovered instruction is observable with scope and truncation", async () => {
    const discovery = new ScriptedDiscovery([
      { path: "C:\\repo\\AGENTS.md", scope: "root", content: "# root rules" },
      { path: "C:\\repo\\sub\\AGENTS.md", scope: "nested", content: "# nested rules" },
    ]);
    const pipeline = new ContextPipeline({ discovery: discovery as never });
    const { runtime, store, events } = makeLoop(
      [ScriptedModelProvider.text("ok")],
      { pipeline, budget: BIG_BUDGET },
    );

    const session = await runtime.createSession({ agent: AGENT, cwd: "C:\\repo\\sub" });
    const turn = await runtime.startTurn(session.id, "go");
    const outcome = await runtime.runTurn(session.id, turn.id, new AbortController().signal);

    expect(outcome.status).toBe("completed");
    const all = await events.list(session.id);
    const found = all.filter((e) => e.type === "instruction.discovered").map((e) => e.payload);
    expect(found).toEqual([
      { path: "C:\\repo\\AGENTS.md", scope: "root", sizeBytes: 12, truncated: false },
      { path: "C:\\repo\\sub\\AGENTS.md", scope: "nested", sizeBytes: 14, truncated: false },
    ]);
  });

  it("CTX pipeline: tiny budget overflows → compaction runs → loop continues", async () => {
    // model asks for a tool whose result renders a huge block, then finishes
    const discovery = new ScriptedDiscovery([]);
    const pipeline = new ContextPipeline({ discovery: discovery as never });
    const { runtime, store, orch, events } = makeLoop(
      [
        ScriptedModelProvider.toolCall("big_tool", {}),
        ScriptedModelProvider.text("ok"),
      ],
      {
        pipeline,
        budget: TINY_BUDGET,
        orchResult: { status: "success", output: "x".repeat(10_000) },
      },
    );

    const { outcome } = await runLoop(runtime, store);
    expect(outcome.status).toBe("completed");
    expect(orch.calls.length).toBe(1);
  });

  it("CTX pipeline (plan.md Phase 5): compaction emits context events and a structured digest message", async () => {
    const discovery = new ScriptedDiscovery([]);
    const pipeline = new ContextPipeline({ discovery: discovery as never });
    const { runtime, store, events } = makeLoop(
      [
        ScriptedModelProvider.toolCall("big_tool", {}),
        ScriptedModelProvider.text("ok"),
      ],
      {
        pipeline,
        budget: TINY_BUDGET,
        orchResult: { status: "success", output: "y".repeat(10_000) },
      },
    );
    const session = await runtime.createSession({ agent: AGENT, cwd: "C:\\repo" });
    const turn = await runtime.startTurn(session.id, "make the thing pass tests");
    const outcome = await runtime.runTurn(session.id, turn.id, new AbortController().signal);

    expect(outcome.status).toBe("completed");
    const stored = await events.list(session.id);
    expect(stored.some((e) => e.type === "context.built")).toBe(true);
    const compacted = stored.find((e) => e.type === "context.compacted");
    expect(compacted?.payload.reactive).toBe(false);

    const messages = await store.listMessages(session.id);
    const digest = messages.find(
      (m) => m.role === "system" && m.content.includes("## User Goal / Exact User Requirements"),
    );
    expect(digest).toBeDefined();
    expect(digest!.content).toContain("make the thing pass tests");
  });

  it("P1-15: requiresVerification with no verifier blocks completion (never a silent pass)", async () => {
    const { runtime, store } = makeLoop([ScriptedModelProvider.text("done, task finished")], {
      task: {
        id: "p1-15-a",
        goal: "verify me",
        completionPolicy: { requiresVerification: true },
      },
      // verifier deliberately omitted
      maxVerificationFailures: 1,
    });
    const { outcome } = await runLoop(runtime, store);
    expect(outcome.status).toBe("failed");
    expect(outcome.terminationReason).toBe("verification_failed");
    expect(outcome.error?.code).toBe("VERIFICATION_FAILED");
    expect(outcome.error?.message).toContain("no verifier is configured");
  });

  it("P1-15: requiresChangedFile fails when nothing was changed", async () => {
    const { runtime, store } = makeLoop([ScriptedModelProvider.text("done"), ScriptedModelProvider.text("done")], {
      task: {
        id: "p1-15-b",
        goal: "change a file",
        completionPolicy: { requiresChangedFile: true },
      },
      changedPaths: () => [],
      maxVerificationFailures: 1,
    });
    const { outcome } = await runLoop(runtime, store);
    expect(outcome.status).toBe("failed");
    expect(outcome.error?.message).toContain("requires a changed file");
  });

  it("P1-15: requiresNoSideEffects fails when files were changed", async () => {
    const { runtime, store, orch } = makeLoop(
      [ScriptedModelProvider.toolCall("write_file", { path: "x.txt", content: "oops" }), ScriptedModelProvider.text("done"), ScriptedModelProvider.text("done")],
      {
        task: {
          id: "p1-15-c",
          goal: "answer only",
          completionPolicy: { requiresNoSideEffects: true },
        },
        changedPaths: () => ["x.txt"],
        maxVerificationFailures: 1,
      },
    );
    const { outcome } = await runLoop(runtime, store);
    expect(outcome.status).toBe("failed");
    expect(outcome.error?.message).toContain("requires no side effects");
    expect(orch.calls.map((c) => c.request.call.name)).toEqual(["write_file"]);
  });
});