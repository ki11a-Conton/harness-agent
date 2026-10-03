import { describe, expect, it, vi } from "vitest";
import type { AgentDefinition, ContextBlock, ModelProvider } from "@ar/contracts";
import { ManualTimer, newAgentId } from "@ar/contracts";
import { EchoModelProvider } from "@ar/model";
import { AgentRuntime, type AgentRuntimeDeps, type TurnOutcome } from "./runtime.js";
import { MemoryEventStore, MemorySessionStore } from "../test/fakes.js";
import { FakeOrchestrator } from "../test/fake-orchestrator.js";
import { RunBudgetTracker } from "./run-budget.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
async function flush() { for (let i = 0; i < 100; i++) await Promise.resolve(); }
const memory: ContextBlock = {
  id: "memory:late", source: "memory", trust: "semi-trusted", priority: 1,
  tokens: 2, content: "late memory", compressible: true, ephemeral: false,
};
function setup(callback: NonNullable<AgentRuntimeDeps["memoryBlocks"]>, options: {
  duration?: number; timeout?: number; feedback?: AgentRuntimeDeps["onMemoryRetrieved"];
} = {}) {
  const timer = new ManualTimer();
  const store = new MemorySessionStore();
  const events = new MemoryEventStore();
  const orchestrator = new FakeOrchestrator();
  const generate = vi.fn();
  const base = new EchoModelProvider();
  const modelProvider: ModelProvider = { id: base.id, listModels: () => base.listModels(), createClient(model, config) {
    const client = base.createClient(model, config);
    return { generate(request, signal) { generate(); return client.generate(request, signal); } };
  } };
  const agent: AgentDefinition = {
    id: newAgentId(), name: "prefetch-test", description: "offline", mode: "primary",
    model: { providerId: "echo", modelId: "offline" }, systemPrompt: "offline",
    tools: {}, permissions: { rules: [] }, skills: {},
    limits: options.duration === undefined ? {} : { maxDurationMs: options.duration },
  };
  const complete = vi.fn();
  const fence = vi.fn(async () => {});
  const runtime = new AgentRuntime({
    store, events, orchestrator, agents: [agent], modelProvider, memoryBlocks: callback,
    timer, now: () => timer.now(), onTurnComplete: complete,
    durabilityFence: { durabilityLevel: "memory", flushThrough: fence },
    ...(options.timeout !== undefined ? { memoryRetrievalTimeoutMs: options.timeout } : {}),
    ...(options.feedback !== undefined ? { onMemoryRetrieved: options.feedback } : {}),
  });
  async function start(cwd = "/offline") {
    const session = await runtime.createSession({ agent, cwd });
    const turn = await runtime.startTurn(session.id, "task");
    return { session, turn };
  }
  return { runtime, store, events, generate, orchestrator, timer, complete, fence, start };
}

describe("R6: optional read-only memory prefetch obeys the turn lifecycle", () => {
  it.each(["cancel", "deadline"] as const)("settles %s without waiting for an abort-oblivious callback", async (mode) => {
    const source = deferred<ContextBlock[]>();
    const called = vi.fn((_input: Parameters<NonNullable<AgentRuntimeDeps["memoryBlocks"]>>[0]) => source.promise);
    const env = setup(called, { duration: 5 });
    const { session, turn } = await env.start();
    const abort = new AbortController();
    let result: TurnOutcome | undefined;
    const run = env.runtime.runTurn(session.id, turn.id, abort.signal).then((outcome) => { result = outcome; return outcome; });
    await flush();
    expect(called).toHaveBeenCalledTimes(1);
    if (mode === "cancel") abort.abort(); else env.timer.advance(6);
    await flush();
    try {
      expect(result?.status).toBe(mode === "cancel" ? "cancelled" : "failed");
      expect(result?.terminationReason).toBe(mode === "cancel" ? "cancelled" : "time_limit");
      expect(env.generate).not.toHaveBeenCalled();
      expect(env.orchestrator.calls).toHaveLength(0);
      expect(env.complete).toHaveBeenCalledTimes(1);
      expect(env.fence).toHaveBeenCalledTimes(1);
      expect((await env.store.getTurn(turn.id))?.status).toBe(result?.status);
      expect(env.timer.pendingCount()).toBe(0);
    } finally { source.resolve([memory]); await run; }
  });

  it("does not invoke retrieval or a model for an already aborted turn", async () => {
    const called = vi.fn(async (_input: Parameters<NonNullable<AgentRuntimeDeps["memoryBlocks"]>>[0]) => [memory]);
    const env = setup(called);
    const { session, turn } = await env.start();
    const abort = new AbortController(); abort.abort();
    expect((await env.runtime.runTurn(session.id, turn.id, abort.signal)).status).toBe("cancelled");
    expect(called).not.toHaveBeenCalled();
    expect(env.generate).not.toHaveBeenCalled();
    expect(env.events.events.some((event) => event.type === "memory.retrieved")).toBe(false);
  });

  it("counts successful retrieval time in the original duration budget", async () => {
    const env = setup(async () => { env.timer.advance(6); return [memory]; }, { duration: 5 });
    const { session, turn } = await env.start();
    const outcome = await env.runtime.runTurn(session.id, turn.id, new AbortController().signal);
    expect(outcome.status).toBe("failed");
    expect(outcome.terminationReason).toBe("time_limit");
    expect(env.generate).not.toHaveBeenCalled();
    expect(env.events.events.some((event) => event.type === "memory.retrieved")).toBe(false);
    expect(outcome.state?.memoryRefs).toEqual([]);
  });

  it("fences a late resolution and bounds in-flight callbacks across subsequent turns and workspaces", async () => {
    const source = deferred<ContextBlock[]>();
    const called = vi.fn((_input: Parameters<NonNullable<AgentRuntimeDeps["memoryBlocks"]>>[0]) => source.promise);
    const env = setup(called);
    const { session, turn } = await env.start();
    const abort = new AbortController();
    let first: TurnOutcome | undefined;
    const run = env.runtime.runTurn(session.id, turn.id, abort.signal).then((value) => { first = value; return value; });
    await flush(); abort.abort(); await flush();
    try {
      expect(first?.status).toBe("cancelled");
      // SESSION_BUSY must have been released, but the external callback slot
      // remains reserved until the real promise settles.
      const next = await env.runtime.startTurn(session.id, "next task");
      expect((await env.runtime.runTurn(session.id, next.id, new AbortController().signal)).status).toBe("completed");
      const other = await env.start("/other-workspace");
      expect((await env.runtime.runTurn(other.session.id, other.turn.id, new AbortController().signal)).status).toBe("completed");
      expect(called).toHaveBeenCalledTimes(1);
      expect(env.events.events.filter((event) => event.type === "runtime.degraded" && event.payload.reason === "memory_prefetch_busy")).toHaveLength(2);
      source.resolve([memory]); await run; await flush();
      expect(env.events.events.some((event) => event.type === "memory.retrieved")).toBe(false);
      expect(first?.state?.memoryRefs).toEqual([]);
      called.mockImplementation(async () => []);
      const third = await env.runtime.startTurn(session.id, "third task");
      expect((await env.runtime.runTurn(session.id, third.id, new AbortController().signal)).status).toBe("completed");
      expect(called).toHaveBeenCalledTimes(2);
    } finally { source.resolve([]); await run; }
  });

  it("uses an optional retrieval timeout as an explicit degraded outcome", async () => {
    const source = deferred<ContextBlock[]>();
    const called = vi.fn((_input: Parameters<NonNullable<AgentRuntimeDeps["memoryBlocks"]>>[0]) => source.promise);
    const env = setup(called, { timeout: 3, duration: 50 });
    const { session, turn } = await env.start();
    let result: TurnOutcome | undefined;
    const run = env.runtime.runTurn(session.id, turn.id, new AbortController().signal).then((value) => { result = value; return value; });
    await flush(); env.timer.advance(3); await flush();
    try {
      expect(result?.status).toBe("completed");
      expect(env.generate).toHaveBeenCalledTimes(1);
      expect(env.events.events.some((event) => event.type === "runtime.degraded" && event.payload.reason === "memory_prefetch_timeout")).toBe(true);
      expect(result?.state?.memoryRefs).toEqual([]);
      expect(called.mock.calls[0]?.[0]?.signal?.aborted).toBe(true);
      expect(env.timer.pendingCount()).toBe(0);
    } finally { source.resolve([memory]); await run; }
  });

  it("persists a failed terminal turn for an immediate provider rejection", async () => {
    const env = setup(async () => { throw new Error("private provider details"); });
    const { session, turn } = await env.start();
    const outcome = await env.runtime.runTurn(session.id, turn.id, new AbortController().signal);
    expect(outcome.status).toBe("failed");
    expect(outcome.error?.code).toBe("INTERNAL_ERROR");
    expect(outcome.terminationReason).toBe("provider_error");
    expect(outcome.error?.message).not.toContain("private provider details");
    expect((await env.store.getTurn(turn.id))?.status).toBe("failed");
    expect(env.generate).not.toHaveBeenCalled();
    expect(env.complete).toHaveBeenCalledTimes(1);
    expect(env.fence).toHaveBeenCalledTimes(1);
  });

  it("observes late rejections after cancellation and never injects their data", async () => {
    const source = deferred<ContextBlock[]>();
    const env = setup(() => source.promise);
    const { session, turn } = await env.start();
    const abort = new AbortController();
    let result: TurnOutcome | undefined;
    const run = env.runtime.runTurn(session.id, turn.id, abort.signal).then((value) => { result = value; return value; });
    await flush(); abort.abort(); await flush();
    try { expect(result?.status).toBe("cancelled"); }
    finally { source.reject(new Error("late rejection")); await run; await flush(); }
    expect(env.events.events.some((event) => event.type === "memory.retrieved")).toBe(false);
  });

  it("passes cancellation/deadline to fast retrieval and preserves returned memory references", async () => {
    const called = vi.fn(async (_input: Parameters<NonNullable<AgentRuntimeDeps["memoryBlocks"]>>[0]) => [memory]);
    const env = setup(called, { duration: 50 });
    const { session, turn } = await env.start();
    const outcome = await env.runtime.runTurn(session.id, turn.id, new AbortController().signal);
    expect(outcome.status).toBe("completed");
    expect(outcome.state?.memoryRefs).toEqual(["late"]);
    expect(env.events.events.filter((event) => event.type === "memory.retrieved")).toHaveLength(1);
    expect(called.mock.calls[0]?.[0]).toMatchObject({ sessionId: session.id, turnId: turn.id, cwd: "/offline", deadline: 51 });
    expect(called.mock.calls[0]?.[0]?.signal).toBeInstanceOf(AbortSignal);
    expect(env.timer.pendingCount()).toBe(0);
  });

  it("gives cancellation priority over a same-boundary resolved promise", async () => {
    const source = deferred<ContextBlock[]>();
    const env = setup(() => source.promise);
    const { session, turn } = await env.start();
    const abort = new AbortController();
    const run = env.runtime.runTurn(session.id, turn.id, abort.signal);
    await flush(); source.resolve([memory]); abort.abort();
    const outcome = await run;
    expect(outcome.status).toBe("cancelled");
    expect(outcome.state?.memoryRefs).toEqual([]);
    expect(env.generate).not.toHaveBeenCalled();
  });

  it("carries the resumed turn counter and checks it before optional retrieval", async () => {
    const called = vi.fn(async () => []);
    const env = setup(called);
    const { session, turn } = await env.start();
    const snapshot = await env.store.loadStateSnapshot(session.id);
    // Effective policy is frozen per session; use its existing resume seed
    // seam, preserving the already-consumed counter rather than refreshing it.
    const effective = snapshot!.effectiveAgent as AgentDefinition;
    effective.limits.maxTurns = 1;
    const outcome = await env.runtime.runTurn(session.id, turn.id, new AbortController().signal, {
      budgetSeed: { ...new RunBudgetTracker(effective.limits, () => 0).snapshot(), usedTurns: 1 },
    });
    expect(outcome.status).toBe("failed");
    expect(outcome.error?.message).toContain("maxTurns");
    expect(called).not.toHaveBeenCalled();
    expect(env.generate).not.toHaveBeenCalled();
  });

  it("prioritizes the hard deadline over a soft timeout at the same boundary", async () => {
    const source = deferred<ContextBlock[]>();
    const env = setup(() => source.promise, { duration: 5, timeout: 6 });
    const { session, turn } = await env.start();
    let outcome: TurnOutcome | undefined;
    const run = env.runtime.runTurn(session.id, turn.id, new AbortController().signal).then((value) => { outcome = value; return value; });
    await flush(); env.timer.advance(6); await flush();
    try {
      expect(outcome?.terminationReason).toBe("time_limit");
      expect(env.events.events.some((event) => event.type === "runtime.degraded")).toBe(false);
      expect(env.generate).not.toHaveBeenCalled();
    } finally { source.resolve([]); await run; }
  });

  it("does not start retrieval for a zero soft timeout", async () => {
    const called = vi.fn(async () => []);
    const env = setup(called, { timeout: 0 });
    const { session, turn } = await env.start();
    expect((await env.runtime.runTurn(session.id, turn.id, new AbortController().signal)).status).toBe("completed");
    expect(called).not.toHaveBeenCalled();
    expect(env.events.events.some((event) => event.type === "runtime.degraded" && event.payload.reason === "memory_prefetch_timeout")).toBe(true);
  });

  it("fully awaits admitted feedback before cancellation and its durability fence", async () => {
    const writing = deferred<void>();
    const feedback = vi.fn(() => writing.promise);
    const env = setup(async () => [memory], { feedback });
    const { session, turn } = await env.start();
    const abort = new AbortController();
    let outcome: TurnOutcome | undefined;
    const run = env.runtime.runTurn(session.id, turn.id, abort.signal).then((value) => { outcome = value; return value; });
    await flush(); expect(feedback).toHaveBeenCalledTimes(1);
    abort.abort(); await flush();
    try {
      expect(outcome).toBeUndefined();
      expect(env.fence).not.toHaveBeenCalled();
      expect(env.generate).not.toHaveBeenCalled();
    } finally { writing.resolve(); await run; }
    expect(outcome?.status).toBe("cancelled");
    expect(env.fence).toHaveBeenCalledTimes(1);
    expect(env.complete).toHaveBeenCalledTimes(1);
  });

  it("settles a rejected admitted feedback callback without calling the model", async () => {
    const env = setup(async () => [memory], { feedback: async () => { throw new Error("private feedback details"); } });
    const { session, turn } = await env.start();
    const outcome = await env.runtime.runTurn(session.id, turn.id, new AbortController().signal);
    expect(outcome.status).toBe("failed");
    expect(outcome.terminationReason).toBe("provider_error");
    expect(outcome.error?.message).toBe("memory feedback failed");
    expect(env.generate).not.toHaveBeenCalled();
    expect(env.fence).toHaveBeenCalledTimes(1);
  });
});
