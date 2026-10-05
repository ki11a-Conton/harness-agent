import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { newMemoryId, newSessionId, type MemoryEntry, type MemoryId, type MemoryStore, type ModelProvider, type ModelRequest } from "@ar/contracts";
import { JsonlMemoryStore, SqliteMemoryStore, type UsefulnessFeedback } from "@ar/memory";
import { MemoryRuntimeBridge, memoryToBlock } from "./memory-runtime-bridge.js";
import { createHarness } from "./create-harness.js";
const dirs: string[] = [];
const sqliteStores: SqliteMemoryStore[] = [];
afterEach(async () => {
  vi.restoreAllMocks(); for (const store of sqliteStores.splice(0)) store.close();
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});
type Capability = { recordUsefulnessFeedback?(id: MemoryId, feedback: UsefulnessFeedback): Promise<boolean> };
function memory(patch: Partial<MemoryEntry> = {}): MemoryEntry {
  return { id: newMemoryId(), content: "auditneedle check admitted persisted memory feedback", type: "procedural", sourceSession: newSessionId(), scope: "workspace",
    importance: .9, confidence: .9, novelty: .9, stability: .9, createdAt: 1, updatedAt: 1, deleted: false, ...patch };
}
async function directory(): Promise<string> { const dir = await mkdtemp(join(tmpdir(), "atomic-memory-bridge-")); dirs.push(dir); return dir; }
async function setup(backend: "jsonl" | "sqlite") {
  const dir = await directory(); const store = backend === "jsonl" ? new JsonlMemoryStore({ dataDir: dir }) : new SqliteMemoryStore({ dataDir: dir });
  if (store instanceof SqliteMemoryStore) sqliteStores.push(store); return store;
}
const score = { lexical: 1, recency: 1, usefulness: 1, confidence: 1, successEvidence: 1, scopeMatch: 1, total: 1 };

describe.each(["jsonl", "sqlite"] as const)("%s bridge atomic persistence", (backend) => {
  it("records every simultaneous signal across multiple bridges sharing the store", async () => {
    const store = await setup(backend); const entry = memory(); await store.write(entry);
    const first = new MemoryRuntimeBridge({ store, scope: "workspace" }); const second = new MemoryRuntimeBridge({ store, scope: "workspace" });
    await Promise.all(Array.from({ length: 16 }, (_, index) => (index % 2 ? first : second).recordInjected([entry.id])));
    expect((await store.get(entry.id))?.usefulness?.injectedCount).toBe(16);
  });
  it("preserves a removal before the feedback mutation rather than writing an old snapshot", async () => {
    const store = await setup(backend); const entry = memory(); await store.write(entry);
    const nativeAtomic = (store as Capability).recordUsefulnessFeedback?.bind(store);
    let mutated = false;
    const removeOnce = async () => { if (!mutated) { mutated = true; await store.remove(entry.id); } };
    const wrapper: MemoryStore & Capability = {
      write: (value) => store.write(value), search: (query, opts) => store.search(query, opts), list: (opts) => store.list(opts), remove: (id) => store.remove(id),
      get: async (id) => { const snapshot = await store.get(id); await removeOnce(); return snapshot; }, update: (value) => store.update(value),
      ...(nativeAtomic ? { recordUsefulnessFeedback: async (id: MemoryId, signal: UsefulnessFeedback) => { await removeOnce(); return nativeAtomic(id, signal); } } : {}),
    };
    await new MemoryRuntimeBridge({ store: wrapper, scope: "workspace" }).recordInjected([entry.id]);
    expect(mutated).toBe(true); expect((await store.get(entry.id))?.deleted).toBe(true); expect(await store.search("auditneedle")).toEqual([]);
  });
  it("preserves the latest editor content and retirement state at the feedback mutation boundary", async () => {
    const store = await setup(backend); const entry = memory(); await store.write(entry);
    const nativeAtomic = (store as Capability).recordUsefulnessFeedback?.bind(store);
    const edited: MemoryEntry = { ...entry, content: "user edited 中文记忆", state: { kind: "deprecated", at: 2, reason: "user retired" }, updatedAt: 2 };
    let mutated = false;
    const editOnce = async () => { if (!mutated) { mutated = true; await store.update(edited); } };
    const wrapper: MemoryStore & Capability = {
      write: (value) => store.write(value), search: (query, opts) => store.search(query, opts), list: (opts) => store.list(opts), remove: (id) => store.remove(id),
      get: async (id) => { const snapshot = await store.get(id); await editOnce(); return snapshot; }, update: (value) => store.update(value),
      ...(nativeAtomic ? { recordUsefulnessFeedback: async (id: MemoryId, signal: UsefulnessFeedback) => { await editOnce(); return nativeAtomic(id, signal); } } : {}),
    };
    await new MemoryRuntimeBridge({ store: wrapper, scope: "workspace" }).recordInjected([entry.id]);
    expect(mutated).toBe(true); const got = (await store.get(entry.id))!;
    expect(got.content).toBe(edited.content); expect(got.state).toEqual(edited.state); expect(got.updatedAt).toBe(2);
    expect(got.usefulness?.injectedCount).toBe(1);
  });
  it("missing/deleted feedback stays quiet and does not mutate reviewable tombstones", async () => {
    const store = await setup(backend); const entry = memory(); await store.write(entry); await store.remove(entry.id);
    const before = await store.get(entry.id); const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const bridge = new MemoryRuntimeBridge({ store, scope: "workspace" });
    await bridge.recordInjected([entry.id, newMemoryId()]); await bridge.recordOutcome([entry.id], { sessionId: entry.sourceSession, succeeded: true });
    expect(await store.get(entry.id)).toEqual(before); expect(stderr).not.toHaveBeenCalled();
  });
});

it("legacy stores without atomic capability preserve retrieval and ROI while skipping unsafe durable writes", async () => {
  const entry = memory(); const get = vi.fn(async () => entry); const update = vi.fn(async () => undefined);
  const store: MemoryStore = { get, update, write: vi.fn(), remove: vi.fn(), search: vi.fn(async () => [entry]), list: vi.fn(async () => [entry]) };
  const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  const bridge = new MemoryRuntimeBridge({ store, scope: "workspace", now: () => 1 });
  const retrieved = await bridge.retrieve({ sessionId: entry.sourceSession, goal: "auditneedle", cwd: "/audit" });
  expect(retrieved.items.map((item) => item.memory.id)).toEqual([entry.id]); expect(retrieved.blocks[0]?.content).toContain("auditneedle");
  await bridge.recordInjected([entry.id]); await bridge.recordOutcome([entry.id], { sessionId: entry.sourceSession, succeeded: true });
  expect(get).not.toHaveBeenCalled(); expect(update).not.toHaveBeenCalled();
  expect(stderr).toHaveBeenCalledTimes(1); expect(stderr.mock.calls[0]?.[0]).toBe("[degraded] memory.usefulness.update: atomic feedback unavailable\n");
  expect(bridge.tokenROI()).toMatchObject([{ memoryId: entry.id, injected: 1, succeeded: 1, tokens: retrieved.blocks[0]!.tokens }]);
});

it("a throwing optional capability is observed and never breaks the feedback caller", async () => {
  const entry = memory(); const atomic = vi.fn(async () => { throw new Error("synthetic atomic feedback failure"); });
  const get = vi.fn(); const update = vi.fn();
  const store: MemoryStore & Capability = { get, update, write: vi.fn(), remove: vi.fn(), search: vi.fn(async () => [entry]), list: vi.fn(), recordUsefulnessFeedback: atomic };
  const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  const bridge = new MemoryRuntimeBridge({ store, scope: "workspace", now: () => 1 });
  await expect(bridge.recordRetrieved([memoryToBlock({ memory: entry, score })])).resolves.toBeUndefined();
  expect(atomic).toHaveBeenCalledWith(entry.id, { kind: "retrieved" }); expect(get).not.toHaveBeenCalled(); expect(update).not.toHaveBeenCalled();
  expect(stderr.mock.calls.map(([value]) => String(value)).join("")).toContain("[degraded] memory.usefulness.update:");
  expect(bridge.tokenROI()).toMatchObject([{ memoryId: entry.id, injected: 1 }]);
});

function provider(requests: ModelRequest[]): ModelProvider {
  return { id: "atomic-feedback-offline", listModels: async () => [{ id: "offline", name: "Offline", capabilities: { contextWindowTokens: 128000 } }],
    createClient: () => ({ generate: async function* (request) {
      requests.push(structuredClone(request)); yield { type: "started", timestamp: 1 };
      yield { type: "completed", timestamp: 1, result: { text: "offline fixture completed", finishReason: "stop" } };
    } }) };
}

describe.each(["jsonl", "sqlite"] as const)("%s actual Harness feedback admission", (backend) => {
  it("four concurrent admitted successful turns retain four of every observed feedback signal", async () => {
    const cwd = await directory(); await writeFile(join(cwd, "AGENTS.md"), "# Synthetic offline workspace\n");
    const requests: ModelRequest[] = []; const modelProvider = provider(requests);
    const harness = await createHarness({ cwd, dataDir: join(cwd, "data"), profile: "test", modelProvider,
      model: { providerId: modelProvider.id, modelId: "offline" }, memory: { enabled: true, scope: "workspace", ...(backend === "sqlite" ? { dbPath: join(cwd, "memory-db") } : {}) },
      featureFlags: { skills: false, mcp: false, delegation: false, learning: false } });
    try {
      const sessions = await Promise.all(Array.from({ length: 4 }, () => harness.runtime.createSession({ agent: harness.agents[0]!, cwd })));
      const now = Date.now(); const entry = memory({ sourceSession: sessions[0]!.id, createdAt: now, updatedAt: now }); await harness.memoryStore!.write(entry);
      const outcomes = await Promise.all(sessions.map(async (session) => {
        const turn = await harness.runtime.startTurn(session.id, "auditneedle"); return harness.runtime.runTurn(session.id, turn.id, new AbortController().signal);
      }));
      expect(outcomes.map((outcome) => outcome.status)).toEqual(Array(4).fill("completed")); expect(requests).toHaveLength(4);
      for (const request of requests) { expect(request.system).toContain(entry.content); expect(request.system).toContain("source=memory"); expect(request.system).toContain("trust=semi-trusted"); }
      for (const outcome of outcomes) expect(outcome.state?.memoryRefs).toEqual([entry.id]);
      const events = (await Promise.all(sessions.map((session) => harness.events.list(session.id)))).flat();
      expect(events.filter((event) => event.type === "memory.retrieved")).toHaveLength(4);
      expect((await harness.memoryStore!.get(entry.id))?.usefulness).toMatchObject({ retrievedCount: 4, injectedCount: 4, usedCount: 4, taskSuccessCount: 4, verificationPassedCount: 0 });
    } finally { await harness.close(); }
  });
  it("an unsupported optional feedback capability still admits memory and completes a model turn", async () => {
    const cwd = await directory(); await writeFile(join(cwd, "AGENTS.md"), "# Synthetic legacy store workspace\n");
    const requests: ModelRequest[] = []; const modelProvider = provider(requests);
    const harness = await createHarness({ cwd, dataDir: join(cwd, "data"), profile: "test", modelProvider,
      model: { providerId: modelProvider.id, modelId: "offline" }, memory: { enabled: true, scope: "workspace", ...(backend === "sqlite" ? { dbPath: join(cwd, "memory-db") } : {}) },
      featureFlags: { skills: false, mcp: false, delegation: false, learning: false } });
    try {
      Object.assign(harness.memoryStore!, { recordUsefulnessFeedback: undefined });
      const session = await harness.runtime.createSession({ agent: harness.agents[0]!, cwd }); const now = Date.now();
      const entry = memory({ sourceSession: session.id, createdAt: now, updatedAt: now }); await harness.memoryStore!.write(entry);
      const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
      const turn = await harness.runtime.startTurn(session.id, "auditneedle"); const outcome = await harness.runtime.runTurn(session.id, turn.id, new AbortController().signal);
      expect(outcome.status).toBe("completed"); expect(requests).toHaveLength(1); expect(requests[0]?.system).toContain(entry.content);
      expect(outcome.state?.memoryRefs).toEqual([entry.id]); expect((await harness.memoryStore!.get(entry.id))?.usefulness).toBeUndefined();
      expect(stderr.mock.calls.filter(([value]) => String(value).includes("atomic feedback unavailable"))).toHaveLength(1);
    } finally { await harness.close(); }
  });
});
