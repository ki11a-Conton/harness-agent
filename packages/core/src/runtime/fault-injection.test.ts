import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ModelEvent, ToolCallRequest, ToolExecutionContext, ToolOrchestrator, ToolResult, ToolSemantics } from "@ar/contracts";
import { DEFAULT_TOOL_SEMANTICS, errorInfo, newToolCallId } from "@ar/contracts";
import { ManualTimer, type Timer } from "@ar/contracts";
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
  orchestrator: FakeOrchestrator | ToolOrchestrator,
  opts?: {
    maxDurationMs?: number;
    context?: { maxTokens: number };
    recovery?: RecoveryPolicy;
    maxIterationsPerTurn?: number;
    /** Q-7: inject a deterministic timer so retry backoff is drivable, not slept. */
    timer?: Timer;
    now?: () => number;
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
    ...(opts?.timer !== undefined ? { timer: opts.timer } : {}),
    ...(opts?.now !== undefined ? { now: opts.now } : {}),
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

/** Rejects after `ms` — used as a guard so a cancelled turn that fails to abort
 * promptly surfaces as a test failure instead of hanging. */
async function hang(ms: number): Promise<never> {
  return new Promise((_resolve, reject) => setTimeout(() => reject(new Error(`hung ${ms}ms`)), ms));
}

/** P2-37: orchestrator whose tool calls are gated (blocked) until released, or
 * until the execution `signal` aborts (at which point the in-flight call
 * returns a CANCELLED result). Lets a test interrupt a tool batch deterministically. */
class GatedOrchestrator implements ToolOrchestrator {
  calls: string[] = [];
  private waiters: Array<{ settled: boolean; resolve: (cancelled: boolean) => void }> = [];
  constructor(private readonly total: number) {}

  async execute(request: ToolCallRequest, ctx: ToolExecutionContext): Promise<ToolResult> {
    const idx = this.calls.length;
    this.calls.push(request.call.name);
    if (idx >= this.total) return { status: "success", output: "ok" };
    const waiter: { settled: boolean; resolve: (cancelled: boolean) => void } = {
      settled: false,
      resolve: () => {},
    };
    this.waiters[idx] = waiter;
    const settled = new Promise<boolean>((resolve) => (waiter.resolve = resolve));
    const onAbort = () => {
      if (!waiter.settled) {
        waiter.settled = true;
        waiter.resolve(true);
      }
    };
    ctx.signal.addEventListener("abort", onAbort, { once: true });
    const cancelled = await settled;
    ctx.signal.removeEventListener("abort", onAbort);
    return cancelled ? { status: "cancelled" } : { status: "success", output: "ok" };
  }

  release(idx: number): void {
    const w = this.waiters[idx];
    if (w && !w.settled) {
      w.settled = true;
      w.resolve(false);
    }
  }

  async awaitCall(n: number): Promise<void> {
    while (this.calls.length < n + 1) await new Promise((r) => setTimeout(r, 1));
  }
}

/**
 * P18-5: an orchestrator whose in-flight calls IGNORE the abort signal —
 * they only settle when explicitly released. Distinguishes synthetic
 * cancellation (cancellable semantics → the controller does not wait) from
 * honest settlement (non-cancellable semantics → the controller waits for the
 * real result instead of fabricating a cancellation).
 */
class ObliviousOrchestrator implements ToolOrchestrator {
  calls: string[] = [];
  private waiters: Array<() => void> = [];
  constructor(private readonly total: number) {}

  async execute(request: ToolCallRequest, _ctx: ToolExecutionContext): Promise<ToolResult> {
    const idx = this.calls.length;
    this.calls.push(request.call.name);
    if (idx >= this.total) return { status: "success", output: "ok" };
    return new Promise<ToolResult>((resolve) => {
      this.waiters[idx] = () => resolve({ status: "success", output: "ok" });
    });
  }

  release(idx: number): void {
    this.waiters[idx]?.();
  }

  async awaitCall(n: number): Promise<void> {
    while (this.calls.length < n + 1) await new Promise((r) => setTimeout(r, 1));
  }
}

function makeP37Runtime(
  provider: ScriptedModelProvider,
  orchestrator: GatedOrchestrator | ToolOrchestrator,
  opts?: {
    toolSemanticsOf?: (name: string) => ToolSemantics | undefined;
  },
) {
  const store = new MemorySessionStore();
  const events = new MemoryEventStore();
  const runtime = new AgentRuntime({
    store,
    events,
    modelProvider: provider,
    orchestrator,
    agents: [{ ...AGENT, limits: {} }],
    ...(opts?.toolSemanticsOf !== undefined
      ? {
          toolSemanticsOf: (name: string) => opts.toolSemanticsOf!(name) ?? DEFAULT_TOOL_SEMANTICS,
        }
      : {}),
  });
  return { runtime, store, events };
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

  /** Q-7: the retry backoff is injectable — a ManualTimer drives it with no real
   *  wall-clock wait (proves the runtime routes retryDelayMs through `timer`). */
  it("model retry backoff advances via an injected ManualTimer, not the real clock", async () => {
    const timer = new ManualTimer();
    const provider = new ScriptedModelProvider([
      [{ type: "error", error: errorInfo("MODEL_ERROR", "transient"), timestamp: 0 }],
      ScriptedModelProvider.text("ok"),
    ]);
    const { runtime, store, events } = makeRuntime(provider, new FakeOrchestrator(), {
      recovery: new RecoveryPolicy(),
      timer,
    });
    const session = await runtime.createSession({ agent: AGENT, cwd });
    const turn = await runtime.startTurn(session.id, "hello");
    const runPromise = runtime.runTurn(session.id, turn.id, new AbortController().signal);

    // Wait (bounded, microtask-scale) until the retry sleep is registered on the
    // ManualTimer. This asserts the runtime actually parked on the injectable
    // backoff rather than a real setTimeout.
    for (let i = 0; i < 100 && timer.pendingCount() === 0; i += 1) {
      await new Promise((r) => setTimeout(r, 1));
    }
    expect(timer.pendingCount()).toBe(1);

    // Advance virtual time past the backoff; the turn completes instantly.
    timer.advance(500);
    const outcome = await runPromise;

    expect(outcome.status).toBe("completed");
    const storedEvents = await events.list(session.id);
    expect(storedEvents.filter((e) => e.type === "model.retry")).toHaveLength(1);
    expect(storedEvents.map((e) => e.type)).toContain("model.completed");
    expect(timer.pendingCount()).toBe(0);
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

  it("P2-37: interrupt mid serial-write chain keeps the committed effect, cancels, and skips remaining writes", async () => {
    const provider = new ScriptedModelProvider([
      ScriptedModelProvider.toolCall("write_file", { path: "a.txt", content: "1" }),
      ScriptedModelProvider.toolCall("write_file", { path: "b.txt", content: "2" }),
      ScriptedModelProvider.toolCall("write_file", { path: "c.txt", content: "3" }),
    ]);
    const orch = new GatedOrchestrator(3); // write_file is serial (default capability)
    const { runtime, store, events } = makeP37Runtime(provider, orch);
    const ac = new AbortController();
    const done = runOne(runtime, store, events, ac.signal);
    await orch.awaitCall(0); // first write in-flight
    orch.release(0);         // a.txt commits (success → partial effect)
    await orch.awaitCall(1); // second write now in-flight
    ac.abort();              // user interrupt hits the running batch
    const { outcome } = await done;

    expect(outcome.status).toBe("cancelled");
    // a.txt already committed and is KEPT (cancel is not a rollback):
    expect(outcome.state?.filesChanged).toEqual(["a.txt"]);
    // b.txt was interrupted (started, then cancelled) — not committed;
    // c.txt was never even started.
    expect(orch.calls).toEqual(["write_file", "write_file"]);
  });

  it("P2-37: interrupt during a parallel READ batch is honored promptly (reads do not hang the turn)", async () => {
    // A SINGLE model generation that emits three concurrent read_file calls —
    // the runtime batches the concurrency-safe reads into one parallel batch.
    const provider = new ScriptedModelProvider([
      [
        {
          type: "completed",
          result: {
            finishReason: "tool_calls" as const,
            toolCalls: ["x", "y", "z"].map((path) => ({
              id: newToolCallId(),
              name: "read_file",
              args: { path },
            })),
          },
          timestamp: 0,
        },
      ],
    ]);
    const orch = new GatedOrchestrator(3);
    const { runtime, store, events } = makeP37Runtime(provider, orch, {
      toolSemanticsOf: (name) =>
        name === "read_file"
          ? { ...DEFAULT_TOOL_SEMANTICS, retrySafety: "safe", concurrencySafety: true }
          : undefined,
    });
    const ac = new AbortController();
    const done = runOne(runtime, store, events, ac.signal);
    await orch.awaitCall(2); // all three reads issued in parallel, all still gated
    ac.abort();              // interrupt
    // The turn resolves promptly even though none of the gated reads were
    // released — the batch aborts rather than waiting (a 2s timeout guards a hang).
    const outcome = await Promise.race([done.then((r) => r.outcome), hang(2000)]);
    expect(outcome.status).toBe("cancelled");
    expect(orch.calls).toEqual(["read_file", "read_file", "read_file"]);
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

describe("runtime partial failure semantics (P2-38)", () => {
  it("immediate model error with no tools ⇒ failed_no_effect", async () => {
    const provider = new ScriptedModelProvider([
      [{ type: "error", error: errorInfo("MODEL_ERROR", "boom"), timestamp: 0 }],
    ]);
    const { runtime, store, events } = makeRuntime(provider, new FakeOrchestrator());
    const { outcome } = await runOne(runtime, store, events);
    expect(outcome.status).toBe("failed");
    expect(outcome.statusDetail).toBe("failed_no_effect");
  });

  it("committed write then resource limit ⇒ failed_with_effects", async () => {
    const provider = new ScriptedModelProvider([
      ScriptedModelProvider.toolCall("write_file", { path: "a.txt", content: "1" }),
    ]);
    const { runtime, store, events } = makeRuntime(provider, new FakeOrchestrator(), { maxIterationsPerTurn: 1 });
    const { outcome } = await runOne(runtime, store, events);
    expect(outcome.status).toBe("failed");
    expect(outcome.statusDetail).toBe("failed_with_effects");
    // the committed effect is kept, not rolled back
    expect(outcome.state?.filesChanged).toEqual(["a.txt"]);
  });

  it("cancel before any tool ⇒ cancelled_no_effect", async () => {
    const provider = new ScriptedModelProvider([ScriptedModelProvider.text("hi")]);
    const { runtime, store, events } = makeRuntime(provider, new FakeOrchestrator());
    const ac = new AbortController();
    ac.abort();
    const { outcome } = await runOne(runtime, store, events, ac.signal);
    expect(outcome.status).toBe("cancelled");
    expect(outcome.statusDetail).toBe("cancelled_no_effect");
  });

  it("committed write then interrupt ⇒ cancelled_with_effects", async () => {
    const provider = new ScriptedModelProvider([
      ScriptedModelProvider.toolCall("write_file", { path: "a.txt", content: "1" }),
      ScriptedModelProvider.toolCall("write_file", { path: "b.txt", content: "2" }),
      ScriptedModelProvider.toolCall("write_file", { path: "c.txt", content: "3" }),
    ]);
    const orch = new GatedOrchestrator(3);
    const { runtime, store, events } = makeP37Runtime(provider, orch);
    const ac = new AbortController();
    const done = runOne(runtime, store, events, ac.signal);
    await orch.awaitCall(0);
    orch.release(0); // a.txt commits (a committed effect exists)
    await orch.awaitCall(1); // b.txt in-flight
    ac.abort(); // interrupt
    const { outcome } = await done;
    expect(outcome.status).toBe("cancelled");
    expect(outcome.statusDetail).toBe("cancelled_with_effects");
    expect(outcome.state?.filesChanged).toEqual(["a.txt"]);
  });

  it("only-denied attempt then resource limit ⇒ blocked", async () => {
    const denied = new FakeOrchestrator({
      status: "denied",
      error: errorInfo("PERMISSION_DENIED", "policy blocks exec"),
    });
    const provider = new ScriptedModelProvider([
      ScriptedModelProvider.toolCall("exec", { command: "ls" }),
    ]);
    const { runtime, store, events } = makeRuntime(provider, denied, { maxIterationsPerTurn: 1 });
    const { outcome } = await runOne(runtime, store, events);
    expect(outcome.status).toBe("failed");
    expect(outcome.statusDetail).toBe("blocked");
    expect(outcome.error?.code).toBe("RESOURCE_LIMIT");
  });
});
describe("P15-6: cancellation settlement invariant", () => {
  function multiReadScript(count: number): ModelEvent[] {
    const deltas: ModelEvent[] = [];
    const calls: Array<{ id: string; name: string; args: Record<string, unknown> }> = [];
    for (let i = 0; i < count; i++) {
      deltas.push({ type: "tool_call_delta", toolCall: { id: `tc-${i}` as never, name: "read_file", args: { path: `f${i}` } }, timestamp: 0 } as never);
      calls.push({ id: `tc-${i}` as never, name: "read_file", args: { path: `f${i}` } });
    }
    deltas.push({ type: "completed", result: { finishReason: "tool_calls", toolCalls: calls }, timestamp: 0 } as never);
    return deltas;
  }

  /** Every model-emitted tool call must settle in the message trail (the
   *  transcript/replay truth): one tool message per call id, never zero. */
  function settleCount(store: MemorySessionStore, sessionId: string): number {
    return store.messages.filter((m) => m.role === "tool" && m.sessionId === sessionId).length;
  }

  it("abort mid parallel reads: every in-flight read settles (none disappear from the trail)", async () => {
    const gate = new GatedOrchestrator(3);
    const provider = new ScriptedModelProvider([multiReadScript(3), ScriptedModelProvider.text("done")]);
    const { store, events, runtime } = makeRuntime(provider, gate);
    const session = await runtime.createSession({ agent: AGENT, cwd });
    const turn = await runtime.startTurn(session.id, "go");
    const ac = new AbortController();
    const runP = runtime.runTurn(session.id, turn.id, ac.signal);

    await new Promise((r) => setTimeout(r, 30));
    ac.abort();
    const outcome = await runP;
    expect(outcome.status).toBe("cancelled");

    // All 3 model-emitted calls settled in the message trail (committed ones
    // as their real result, in-flight/queued ones as synthetic cancelled).
    const settled = settleCount(store, session.id);
    expect(settled).toBe(3);
    const cancelledMsgs = store.messages.filter(
      (m) => m.role === "tool" && m.sessionId === session.id && String(m.content).includes("cancelled"),
    );
    expect(cancelledMsgs.length).toBeGreaterThanOrEqual(1);
  });

  it("abort while a serial write executes: the write and the remaining calls all settle", async () => {
    // ONE model response carrying two write calls — the batch runs serially
    // (writes are not concurrency-safe), so abort lands mid-chain.
    const gate = new GatedOrchestrator(2);
    const provider = new ScriptedModelProvider([
      multiReadScript(2), // reuse: two calls, gated
      ScriptedModelProvider.text("done"),
    ]);
    const { store, events, runtime } = makeRuntime(provider, gate);
    const session = await runtime.createSession({ agent: AGENT, cwd });
    const turn = await runtime.startTurn(session.id, "go");
    const ac = new AbortController();
    const runP = runtime.runTurn(session.id, turn.id, ac.signal);

    await new Promise((r) => setTimeout(r, 30));
    ac.abort();
    const outcome = await runP;
    expect(outcome.status).toBe("cancelled");

    expect(settleCount(store, session.id)).toBe(2); // write a + write b both settle
  });

  it("abort after a side effect committed: committed stays success, later calls settle as cancelled", async () => {
    const gate = new GatedOrchestrator(2); // both writes gated
    const provider = new ScriptedModelProvider([
      ScriptedModelProvider.toolCall("write_file", { path: "a" }),
      ScriptedModelProvider.toolCall("write_file", { path: "b" }),
      ScriptedModelProvider.text("done"),
    ]);
    const { store, events, runtime } = makeRuntime(provider, gate);
    const session = await runtime.createSession({ agent: AGENT, cwd });
    const turn = await runtime.startTurn(session.id, "go");
    const ac = new AbortController();
    const runP = runtime.runTurn(session.id, turn.id, ac.signal);

    await new Promise((r) => setTimeout(r, 30));
    gate.release(0); // write a COMMITS
    await new Promise((r) => setTimeout(r, 20));
    ac.abort(); // before write b starts
    const outcome = await runP;
    expect(outcome.status).toBe("cancelled");

    const committed = store.messages.filter(
      (m) => m.role === "tool" && m.sessionId === session.id && !String(m.content).includes("cancelled"),
    );
    expect(committed.length).toBe(1); // the committed write a
    expect(settleCount(store, session.id)).toBe(2); // a + synthetic-cancelled b
  });

  it("repeated abort settles exactly once (no duplicate settlement)", async () => {
    const gate = new GatedOrchestrator(1);
    const provider = new ScriptedModelProvider([
      ScriptedModelProvider.toolCall("read_file", { path: "a" }),
      ScriptedModelProvider.text("done"),
    ]);
    const { store, events, runtime } = makeRuntime(provider, gate);
    const session = await runtime.createSession({ agent: AGENT, cwd });
    const turn = await runtime.startTurn(session.id, "go");
    const ac = new AbortController();
    const runP = runtime.runTurn(session.id, turn.id, ac.signal);

    await new Promise((r) => setTimeout(r, 30));
    ac.abort();
    ac.abort(); // repeated abort must not double-settle
    await runP;

    expect(settleCount(store, session.id)).toBe(1); // exactly one settlement per call
  });
});

describe("P18-5: tool cancellation settlement is cancellable-aware", () => {
  function twoReadsScript(readA: import("@ar/contracts").ToolCall, readB: import("@ar/contracts").ToolCall): ModelEvent[] {
    return [
      { type: "started", timestamp: 0 },
      { type: "tool_call_delta", toolCall: readA, timestamp: 0 },
      { type: "tool_call_delta", toolCall: readB, timestamp: 0 },
      { type: "completed", result: { finishReason: "tool_calls", toolCalls: [readA, readB] }, timestamp: 0 },
    ];
  }

  it("cancellable in-flight calls settle as cancelled WITHOUT waiting for an abort-oblivious tool", async () => {
    const readA = { id: newToolCallId(), name: "read_file", args: { path: "a.txt" } };
    const readB = { id: newToolCallId(), name: "read_file", args: { path: "b.txt" } };
    const provider = new ScriptedModelProvider([
      twoReadsScript(readA, readB),
      ScriptedModelProvider.text("done"),
    ]);
    const orch = new ObliviousOrchestrator(2);
    const { runtime, store, events } = makeP37Runtime(provider, orch, {
      toolSemanticsOf: (name) =>
        name === "read_file"
          ? { ...DEFAULT_TOOL_SEMANTICS, retrySafety: "safe", concurrencySafety: true, cancellable: true }
          : undefined,
    });
    const ac = new AbortController();
    const done = runOne(runtime, store, events, ac.signal);
    await orch.awaitCall(1); // both reads in flight, tool IGNORES abort
    ac.abort();
    // cancellable → synthetic cancelled immediately; the turn must NOT hang
    // waiting for the oblivious tool (2s guard).
    const { outcome, storedEvents } = await Promise.race([done, hang(2000)]);
    expect(outcome.status).toBe("cancelled");
    // Both calls settled in the transcript — nothing vanished.
    const messages = await store.listMessages((await store.listSessions())[0]!.id);
    expect(messages.filter((m) => m.role === "tool")).toHaveLength(2);
    // No orchestrator-level completion fired (the tool never really finished).
    expect(storedEvents.some((e) => e.type === "tool.completed" && e.payload.status === "success")).toBe(false);
  });

  it("NON-cancellable in-flight calls are NOT lied about: the controller waits for the real result", async () => {
    const readA = { id: newToolCallId(), name: "read_file", args: { path: "a.txt" } };
    const readB = { id: newToolCallId(), name: "read_file", args: { path: "b.txt" } };
    const provider = new ScriptedModelProvider([
      twoReadsScript(readA, readB),
      ScriptedModelProvider.text("done"),
    ]);
    const orch = new ObliviousOrchestrator(2);
    const { runtime, store, events } = makeP37Runtime(provider, orch, {
      toolSemanticsOf: (name) =>
        name === "read_file"
          ? { ...DEFAULT_TOOL_SEMANTICS, retrySafety: "safe", concurrencySafety: true, cancellable: false }
          : undefined,
    });
    const ac = new AbortController();
    const done = runOne(runtime, store, events, ac.signal);
    await orch.awaitCall(1);
    ac.abort();
    // Give the controller a moment — it MUST still be waiting (not resolved).
    await new Promise((r) => setTimeout(r, 30));
    expect(orch.calls).toHaveLength(2);
    // Release the real results; the transcript records SUCCESS (what actually
    // happened), never a fabricated cancellation.
    orch.release(0);
    orch.release(1);
    const { outcome } = await Promise.race([done, hang(2000)]);
    expect(outcome.status).toBe("cancelled"); // the TURN aborted…
    // …but the CALLS settled with their REAL result: the transcript shows the
    // success output ("ok"), never a fabricated cancellation.
    const messages = await store.listMessages((await store.listSessions())[0]!.id);
    const toolMsgs = messages.filter((m) => m.role === "tool");
    expect(toolMsgs).toHaveLength(2);
    expect(toolMsgs.every((m) => String(m.content).includes("ok"))).toBe(true);
    expect(toolMsgs.some((m) => String(m.content).includes("cancelled"))).toBe(false);
  });
});
