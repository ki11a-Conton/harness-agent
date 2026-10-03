import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { newMemoryId } from "@ar/contracts";
import type { MemoryEntry, ModelProvider, ModelRequest } from "@ar/contracts";
import { createHarness } from "./create-harness.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => { resolve = yes; });
  return { promise, resolve };
}
async function flush() { for (let i = 0; i < 100; i++) await Promise.resolve(); }
const dirs: string[] = [];
afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function fixture(duration?: number) {
  const dir = await mkdtemp(join(tmpdir(), "r6-production-memory-")); dirs.push(dir);
  const entered = deferred<void>();
  const source = deferred<MemoryEntry[]>();
  const retrieved = deferred<void>();
  const modelEntered = deferred<ModelRequest>();
  const modelGate = deferred<void>();
  const requests: ModelRequest[] = [];
  const provider: ModelProvider = {
    id: "memory-review", listModels: async () => [{ id: "offline", name: "Offline", capabilities: { contextWindowTokens: 128000 } }],
    createClient: () => ({ generate: async function* (request) {
      requests.push(structuredClone(request)); modelEntered.resolve(request);
      yield { type: "started", timestamp: 0 };
      await modelGate.promise;
      yield { type: "completed", timestamp: 0, result: { finishReason: "stop", text: "done" } };
    } }),
  };
  const harness = await createHarness({
    cwd: dir, dataDir: join(dir, "data"), profile: "test", modelProvider: provider, now: () => Date.now(),
    model: { providerId: provider.id, modelId: "offline" }, memory: { enabled: true, scope: "workspace" },
    featureFlags: { skills: false, mcp: false, delegation: false, learning: false },
    ...(duration !== undefined ? { limits: { maxDurationMs: duration } } : {}),
  });
  const session = await harness.runtime.createSession({ agent: harness.agents[0]!, cwd: dir });
  const memory: MemoryEntry = {
    id: newMemoryId(), content: "task safe useful memory hint", type: "procedural", sourceSession: session.id,
    importance: 0.7, confidence: 0.8, novelty: 0.5, stability: 0.6,
    createdAt: Date.now(), updatedAt: Date.now(), deleted: false, scope: "global",
  };
  await harness.memoryStore!.write(memory);
  const search = vi.spyOn(harness.memoryStore!, "search").mockImplementation(async () => { entered.resolve(); return source.promise; });
  const retrieve = harness.memoryBridge!.retrieve.bind(harness.memoryBridge!);
  vi.spyOn(harness.memoryBridge!, "retrieve").mockImplementation(async (input) => {
    try { return await retrieve(input); } finally { retrieved.resolve(); }
  });
  const injected = vi.spyOn(harness.memoryBridge!, "recordInjected");
  async function releaseLate() {
    source.resolve([memory]); await retrieved.promise; await flush();
    await Promise.all(injected.mock.results.map((result) => result.value));
  }
  async function close() {
    source.resolve([]); modelGate.resolve();
    await retrieved.promise; await flush();
    await Promise.all(injected.mock.results.map((result) => result.value));
    await harness.close();
  }
  return { harness, session, memory, entered, source, modelEntered, modelGate, requests, search, injected, releaseLate, close };
}

describe("R6 production read-only memory preparation and admitted feedback", () => {
  it.each(["cancel", "deadline"] as const)("does not persist late retrieval/injection feedback after %s", async (mode) => {
    const env = await fixture(mode === "deadline" ? 5 : undefined);
    if (mode === "deadline") vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    const turn = await env.harness.runtime.startTurn(env.session.id, "task first");
    const abort = new AbortController();
    const run = env.harness.runtime.runTurn(env.session.id, turn.id, abort.signal);
    try {
      await env.entered.promise;
      if (mode === "cancel") abort.abort(); else await vi.advanceTimersByTimeAsync(6);
      const outcome = await run;
      expect(outcome.status).toBe(mode === "cancel" ? "cancelled" : "failed");
      expect(outcome.terminationReason).toBe(mode === "cancel" ? "cancelled" : "time_limit");
      expect(env.requests).toHaveLength(0);
      vi.useRealTimers();
      await env.releaseLate();
      expect((await env.harness.memoryStore!.get(env.memory.id))?.usefulness).toBeUndefined();
      expect(env.injected).not.toHaveBeenCalled();
      expect(env.harness.memoryBridge!.tokenROI()).toEqual([]);
      expect(outcome.state?.memoryRefs).toEqual([]);
    } finally { abort.abort(); env.source.resolve([]); await run; await env.close(); }
  });

  it("never credits late first-turn memory to a busy second turn that saw no memory", async () => {
    const env = await fixture();
    const first = await env.harness.runtime.startTurn(env.session.id, "task first");
    const abort = new AbortController();
    const runFirst = env.harness.runtime.runTurn(env.session.id, first.id, abort.signal);
    let runSecond: ReturnType<typeof env.harness.runtime.runTurn> | undefined;
    try {
      await env.entered.promise; abort.abort();
      expect((await runFirst).status).toBe("cancelled");
      const second = await env.harness.runtime.startTurn(env.session.id, "task second");
      runSecond = env.harness.runtime.runTurn(env.session.id, second.id, new AbortController().signal);
      const request = await env.modelEntered.promise;
      await env.releaseLate();
      env.modelGate.resolve();
      const outcome = await runSecond;
      expect(outcome.status).toBe("completed");
      expect(outcome.state?.memoryRefs).toEqual([]);
      expect(request.system).not.toContain(env.memory.content);
      expect(env.search).toHaveBeenCalledTimes(1);
      expect((await env.harness.memoryStore!.get(env.memory.id))?.usefulness).toBeUndefined();
      expect(env.injected).not.toHaveBeenCalled();
    } finally { abort.abort(); env.source.resolve([]); env.modelGate.resolve(); await runFirst; await runSecond; await env.close(); }
  });

  it("preserves the retrieved/injected/used/success funnel for admitted memory", async () => {
    const env = await fixture();
    env.source.resolve([env.memory]); env.modelGate.resolve();
    const turn = await env.harness.runtime.startTurn(env.session.id, "task successful");
    try {
      const outcome = await env.harness.runtime.runTurn(env.session.id, turn.id, new AbortController().signal);
      expect(outcome.status).toBe("completed");
      expect(outcome.state?.memoryRefs).toEqual([env.memory.id]);
      expect(env.requests[0]?.system).toContain(env.memory.content);
      expect((await env.harness.memoryStore!.get(env.memory.id))?.usefulness).toMatchObject({ retrievedCount: 1, injectedCount: 1, usedCount: 1, taskSuccessCount: 1 });
      expect(env.harness.memoryBridge!.tokenROI()).toMatchObject([{ memoryId: env.memory.id, injected: 1, succeeded: 1 }]);
    } finally { await env.close(); }
  });
});
