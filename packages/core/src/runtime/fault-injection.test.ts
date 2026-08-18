import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ModelEvent } from "@ar/contracts";
import { errorInfo } from "@ar/contracts";
import { ScriptedModelProvider } from "@ar/model";
import { RecoveryPolicy } from "../recovery/recovery.js";
import { AgentRuntime } from "./runtime.js";
import { MemoryEventStore, MemorySessionStore } from "../test/fakes.js";
import { FakeOrchestrator } from "../test/fake-orchestrator.js";
import { ContextPipeline } from "@ar/context";

const AGENT = {
  id: "test-agent" as never,
  name: "test-agent",
  description: "test",
  mode: "primary" as const,
  model: { providerId: "scripted", modelId: "scripted-model" },
  systemPrompt: "you are a test",
  tools: {},
  permissions: { rules: [] },
  skills: {},
  limits: {},
};

let cwd: string;

beforeEach(async () => {
  cwd = await mkdtemp(join(tmpdir(), "fault-"));
});

afterEach(async () => {
  await rm(cwd, { recursive: true, force: true });
});

function makeRuntime(
  provider: ScriptedModelProvider,
  orchestrator: FakeOrchestrator,
  opts?: {
    maxDurationMs?: number;
    context?: { maxTokens: number };
    recovery?: RecoveryPolicy;
    maxIterationsPerTurn?: number;
  },
) {
  const store = new MemorySessionStore();
  const events = new MemoryEventStore();
  const runtime = new AgentRuntime({
    store,
    events,
    modelProvider: provider,
    orchestrator,
    agents: [
      {
        ...AGENT,
        limits: {
          ...AGENT.limits,
          ...(opts?.maxDurationMs !== undefined ? { maxToolCalls: 0, maxDurationMs: opts.maxDurationMs } : {}),
        },
      },
    ],
    ...(opts?.maxIterationsPerTurn !== undefined ? { maxIterationsPerTurn: opts.maxIterationsPerTurn } : {}),
    ...(opts?.recovery !== undefined ? { recovery: opts.recovery } : {}),
    ...(opts?.context !== undefined
      ? {
          context: {
            pipeline: new ContextPipeline(),
            budget: { maxTokens: opts.context.maxTokens, reserved: { system: 0, task: 0, output: 0 }, dynamic: 0 },
          },
        }
      : {}),
  });
  return { store, events, runtime };
}

async function runOne(
  runtime: AgentRuntime,
  store: MemorySessionStore,
  events: MemoryEventStore,
  signal?: AbortSignal,
  text = "hello",
) {
  const session = await runtime.createSession({ agent: AGENT, cwd });
  const turn = await runtime.startTurn(session.id, text);
  const outcome = await runtime.runTurn(session.id, turn.id, signal ?? new AbortController().signal);
  return { session, turn, outcome, storedEvents: await events.list(session.id) };
}

function slowEvents(events: ModelEvent[], delayMs: number): AsyncIterable<ModelEvent> {
  return {
    [Symbol.asyncIterator]() {
      let i = 0;
      return {
        async next() {
          if (i >= events.length) return { done: true, value: undefined as unknown as ModelEvent };
          await new Promise((r) => setTimeout(r, delayMs));
          return { value: events[i++]!, done: false };
        },
      };
    },
  };
}

describe("runtime fault injection (CORE-FAULT-001)", () => {
  it("model.error without recovery policy fails the turn immediately", async () => {
    const provider = new ScriptedModelProvider([
      [{ type: "error", error: errorInfo("MODEL_ERROR", "transient"), timestamp: 0 }],
    ]);
    const { runtime, store, events } = makeRuntime(provider, new FakeOrchestrator());
    const { outcome, storedEvents } = await runOne(runtime, store, events);

    expect(outcome.status).toBe("failed");
    expect(outcome.error?.code).toBe("MODEL_ERROR");
    expect(storedEvents.map((e) => e.type)).toContain("model.failed");
    expect(storedEvents.map((e) => e.type)).toContain("turn.failed");
    expect(storedEvents.filter((e) => e.type === "model.retry")).toHaveLength(0);
  });

  it("model.error with recovery policy retries and then completes", async () => {
    const provider = new ScriptedModelProvider([
      [{ type: "error", error: errorInfo("MODEL_ERROR", "transient"), timestamp: 0 }],
      ScriptedModelProvider.text("ok"),
    ]);
    const { runtime, store, events } = makeRuntime(provider, new FakeOrchestrator(), {
      recovery: new RecoveryPolicy(),
    });
    const { outcome, storedEvents } = await runOne(runtime, store, events);

    expect(outcome.status).toBe("completed");
    expect(storedEvents.filter((e) => e.type === "model.retry")).toHaveLength(1);
    expect(storedEvents.map((e) => e.type)).toContain("model.completed");
    expect(storedEvents.map((e) => e.type)).toContain("turn.completed");
  });

  it("exhausted retries turn.failed with MODEL_ERROR and no turn.completed", async () => {
    const provider = new ScriptedModelProvider([
      [{ type: "error", error: errorInfo("MODEL_ERROR", "e1"), timestamp: 0 }],
      [{ type: "error", error: errorInfo("MODEL_ERROR", "e2"), timestamp: 0 }],
      [{ type: "error", error: errorInfo("MODEL_ERROR", "e3"), timestamp: 0 }],
    ]);
    const { runtime, store, events } = makeRuntime(provider, new FakeOrchestrator(), {
      recovery: new RecoveryPolicy(),
    });
    const { outcome, storedEvents } = await runOne(runtime, store, events);

    expect(outcome.status).toBe("failed");
    expect(outcome.error?.code).toBe("MODEL_ERROR");
    const types = storedEvents.map((e) => e.type);
    expect(types.filter((t) => t === "model.retry").length).toBeGreaterThanOrEqual(2);
    expect(types).toContain("model.failed");
    expect(types).toContain("turn.failed");
    expect(types).not.toContain("turn.completed");
  });

  it("mid-stream error triggers retry and fallback completes", async () => {
    const provider = new ScriptedModelProvider([
      [
        { type: "started", timestamp: 0 },
        { type: "text_delta", text: "partial ", timestamp: 0 },
        { type: "error", error: errorInfo("MODEL_ERROR", "mid-stream"), timestamp: 0 },
      ],
      ScriptedModelProvider.text("fallback"),
    ]);
    const { runtime, store, events } = makeRuntime(provider, new FakeOrchestrator(), {
      recovery: new RecoveryPolicy(),
    });
    const { outcome, storedEvents } = await runOne(runtime, store, events);

    expect(outcome.status).toBe("completed");
    expect(storedEvents.filter((e) => e.type === "model.retry")).toHaveLength(1);
  });

  it("user cancellation produces turn.cancelled, no turn.completed", async () => {
    const provider = new ScriptedModelProvider([
      slowEvents(
        [
          { type: "started", timestamp: 0 },
          { type: "text_delta", text: "slow", timestamp: 0 },
          { type: "completed", result: { finishReason: "stop" as const, text: "slow" }, timestamp: 0 },
        ],
        20,
      ),
    ]);
    const { runtime, store, events } = makeRuntime(provider, new FakeOrchestrator());
    const ac = new AbortController();
    const promise = runOne(runtime, store, events, ac.signal);
    await new Promise((r) => setTimeout(r, 15));
    ac.abort();
    const { outcome, storedEvents } = await promise;

    expect(outcome.status).toBe("cancelled");
    expect(outcome.turn.status).toBe("cancelled");
    const types = storedEvents.map((e) => e.type);
    expect(types).toContain("turn.cancelled");
    expect(types).not.toContain("turn.completed");
  });

  it("tool failure surfaces as MODEL_ERROR (no second script to recover)", async () => {
    const provider = new ScriptedModelProvider([
      ScriptedModelProvider.toolCall("read", { path: "/etc/passwd" }),
    ]);
    const orch = new FakeOrchestrator({ status: "failed", error: errorInfo("TOOL_SCHEMA_ERROR", "permission denied") });
    const { runtime, store, events } = makeRuntime(provider, orch);
    const { outcome } = await runOne(runtime, store, events);

    expect(outcome.status).toBe("failed");
    expect(outcome.error?.code).toBe("MODEL_ERROR");
  });

  it("tool call failure followed by model recovery completes the turn", async () => {
    const provider = new ScriptedModelProvider([
      ScriptedModelProvider.toolCall("read", { path: "/etc/passwd" }),
      ScriptedModelProvider.text("recovered after tool error"),
    ]);
    const orch = new FakeOrchestrator({ status: "failed", error: errorInfo("TOOL_SCHEMA_ERROR", "permission denied") });
    const { runtime, store, events } = makeRuntime(provider, orch);
    const { outcome } = await runOne(runtime, store, events);

    expect(outcome.status).toBe("completed");
  });

  it("context overflow emits run.limit_reached then turn.failed with RESOURCE_LIMIT", async () => {
    const provider = new ScriptedModelProvider([ScriptedModelProvider.text("hi")]);
    const { runtime, store, events } = makeRuntime(provider, new FakeOrchestrator(), {
      context: { maxTokens: 1 },
    });
    const { outcome, storedEvents } = await runOne(runtime, store, events);

    expect(outcome.status).toBe("failed");
    expect(outcome.error?.code).toBe("RESOURCE_LIMIT");
    expect(storedEvents.map((e) => e.type)).toContain("run.limit_reached");
    expect(storedEvents.map((e) => e.type)).toContain("turn.failed");
  });
});