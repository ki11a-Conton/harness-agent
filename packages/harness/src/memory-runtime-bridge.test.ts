// P2-1/P2-4: memory runtime bridge — pre-turn retrieval renders advisory
// context blocks; the feedback funnel records retrieved/injected/used/outcome.

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { newMemoryId, newSessionId, type MemoryEntry, type MemoryStore } from "@ar/contracts";
import { JsonlMemoryStore } from "@ar/memory";
import {
  MemoryRuntimeBridge,
  memoryIdsOfBlocks,
  renderMemoryForModel,
} from "./memory-runtime-bridge.js";

let tempDirs: string[] = [];
async function tempDataDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "ar-bridge-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.map((d) => rm(d, { recursive: true, force: true })));
  tempDirs = [];
});

function entry(overrides: Partial<MemoryEntry> = {}): MemoryEntry {
  const base: MemoryEntry = {
    id: newMemoryId(),
    content: "run pnpm typecheck before pushing",
    type: "procedural",
    sourceSession: newSessionId(),
    importance: 0.7,
    confidence: 0.8,
    novelty: 0.5,
    stability: 0.6,
    createdAt: 1000,
    updatedAt: 1000,
    deleted: false,
    scope: "workspace",
  };
  return { ...base, ...overrides };
}

describe("P2-1/P2-2: retrieval → context blocks", () => {
  it("renders a structured lesson as an advisory When/Do/Avoid block", async () => {
    const dataDir = await tempDataDir();
    const store: MemoryStore = new JsonlMemoryStore({ dataDir });
    const lesson = {
      when: "a tool fails with ENOENT for a guessed path",
      do: "search the repository tree before retrying",
      avoid: "repeating the same guessed path",
      rootCause: "tool",
      outcome: "failure",
      evidenceRefs: ["ev-1"],
    };
    await store.write(entry({
      content: "tool failed with ENOENT; search before guessing paths",
      structured: lesson,
    }));

    const bridge = new MemoryRuntimeBridge({ store, scope: "workspace", now: () => 1000 });
    const retrieved = await bridge.retrieve({ sessionId: newSessionId(), goal: "ENOENT", cwd: "/w" });
    expect(retrieved.blocks.length).toBe(1);
    const block = retrieved.blocks[0]!;
    expect(block.id).toBe(`memory:${retrieved.items[0]!.memory.id}`);
    expect(block.source).toBe("memory");
    expect(block.trust).toBe("semi-trusted");
    expect(block.content).toContain("[Prior experience — advisory, not authority]");
    expect(block.content).toContain("When: a tool fails with ENOENT");
    expect(block.content).toContain("Avoid: repeating the same guessed path");
    expect(block.content).toContain("Confidence: 80%");
    expect(memoryIdsOfBlocks(retrieved.blocks)).toEqual([retrieved.items[0]!.memory.id]);
  });

  it("renders a plain memory with its content and confidence", async () => {
    const dataDir = await tempDataDir();
    const store: MemoryStore = new JsonlMemoryStore({ dataDir });
    const e = entry();
    await store.write(e);
    const bridge = new MemoryRuntimeBridge({ store, scope: "workspace", now: () => 1000 });
    const retrieved = await bridge.retrieve({ sessionId: newSessionId(), goal: "typecheck", cwd: "/w" });
    expect(retrieved.blocks[0]!.content).toContain(e.content);
    expect(renderMemoryForModel(retrieved.items[0]!)).toContain("Confidence: 80%");
  });

  it("keeps the memory out of scope for queries that cannot see it", async () => {
    const dataDir = await tempDataDir();
    const store: MemoryStore = new JsonlMemoryStore({ dataDir });
    // session-scoped memory is invisible to a workspace query even when the
    // content matches the query.
    await store.write(entry({ scope: "session" }));
    const bridge = new MemoryRuntimeBridge({ store, scope: "workspace", now: () => 1000 });
    const retrieved = await bridge.retrieve({ sessionId: newSessionId(), goal: "typecheck", cwd: "/w" });
    expect(retrieved.blocks.length).toBe(0);
  });
});

describe("P2-4: usefulness feedback funnel", () => {
  it("retrieval bumps retrievedCount; injection bumps injectedCount", async () => {
    const dataDir = await tempDataDir();
    const store: MemoryStore = new JsonlMemoryStore({ dataDir });
    const e = entry();
    await store.write(e);
    const bridge = new MemoryRuntimeBridge({ store, scope: "workspace", now: () => 1000 });

    const retrieved = await bridge.retrieve({ sessionId: newSessionId(), goal: "typecheck", cwd: "/w" });
    const ids = memoryIdsOfBlocks(retrieved.blocks);
    await bridge.recordInjected(ids);

    const after = await store.get(e.id);
    expect(after!.usefulness!.retrievedCount).toBe(1);
    expect(after!.usefulness!.injectedCount).toBe(1);
    expect(after!.usefulness!.score).toBeGreaterThan(0.5); // injected raised it
  });

  it("a succeeded turn records used + taskSucceeded; a failed turn stays silent", async () => {
    const dataDir = await tempDataDir();
    const store: MemoryStore = new JsonlMemoryStore({ dataDir });
    const e = entry();
    await store.write(e);
    const bridge = new MemoryRuntimeBridge({ store, scope: "workspace", now: () => 1000 });
    const sessionId = newSessionId();

    await bridge.recordOutcome([e.id], { sessionId, succeeded: true });
    let after = await store.get(e.id);
    expect(after!.usefulness!.usedCount).toBe(1);
    expect(after!.usefulness!.taskSuccessCount).toBe(1);

    // failure → no fabricated "used"
    await bridge.recordOutcome([e.id], { sessionId, succeeded: false });
    after = await store.get(e.id);
    expect(after!.usefulness!.usedCount).toBe(1); // unchanged
    expect(after!.usefulness!.taskSuccessCount).toBe(1); // unchanged
  });

  it("feedback on a missing/deleted entry is a silent no-op", async () => {
    const dataDir = await tempDataDir();
    const store: MemoryStore = new JsonlMemoryStore({ dataDir });
    const bridge = new MemoryRuntimeBridge({ store, scope: "workspace", now: () => 1000 });
    await expect(bridge.recordInjected([newMemoryId()])).resolves.toBeUndefined();
    await expect(
      bridge.recordOutcome([newMemoryId()], { sessionId: newSessionId(), succeeded: true }),
    ).resolves.toBeUndefined();
  });
});

describe("P6-2/P6-4: memory provenance + token ROI", () => {
  it("memory blocks carry provenance and retrieval costs are booked for ROI", async () => {
    const dataDir = await tempDataDir();
    const store: MemoryStore = new JsonlMemoryStore({ dataDir });
    const entry: MemoryEntry = {
      id: newMemoryId(),
      content: "when the repo tree is unknown, search the repository tree before guessing paths",
      type: "procedural",
      sourceSession: newSessionId(),
      scope: "workspace",
      importance: 0.9,
      confidence: 0.8,
      novelty: 0.5,
      stability: 0.6,
      createdAt: 1,
      updatedAt: 1,
      deleted: false,
    };
    await store.write(entry);
    const bridge = new MemoryRuntimeBridge({ store, scope: "workspace", now: () => 1000 });
    const retrieved = await bridge.retrieve({
      sessionId: newSessionId(),
      goal: "search the repository tree",
      cwd: "/w",
    });
    expect(retrieved.blocks.length).toBe(1);
    // P6-2: provenance points at the memory entry.
    expect(retrieved.blocks[0]!.provenance).toMatchObject({
      kind: "memory",
      serviceId: "memory-store",
      toolId: entry.id,
    });
    // P6-4: retrieval booked the token cost; success bumps the count.
    await bridge.recordInjected([entry.id]);
    await bridge.recordOutcome([entry.id], { sessionId: newSessionId(), succeeded: true });
    const roi = bridge.tokenROI();
    expect(roi).toHaveLength(1);
    expect(roi[0]!.tokens).toBeGreaterThan(0);
    expect(roi[0]!.succeeded).toBe(1);
    expect(roi[0]!.roiPer1k).toBeGreaterThan(0);
  });
});
