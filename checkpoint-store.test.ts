import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import type { CheckpointData, SessionId } from "@ar/contracts";
import { buildCheckpoint, newCheckpointId, newSessionId } from "@ar/contracts";
import { DurableCheckpointStore } from "./checkpoint-store.js";

let tempDir: string | undefined;

afterEach(async () => {
  if (tempDir !== undefined) {
    await rm(tempDir, { recursive: true, force: true });
    tempDir = undefined;
  }
});

async function freshRoot(): Promise<string> {
  tempDir = await mkdtemp(join(tmpdir(), "ckpt-"));
  return tempDir;
}

function checkpoint(over: Partial<CheckpointData> = {}): CheckpointData {
  return buildCheckpoint({
    checkpointId: newCheckpointId(),
    schemaVersion: 1 as const,
    sessionId: newSessionId(),
    agentId: "agent_1" as never,
    createdAt: Date.now(),
    reason: "periodic:iteration",
    phase: "observing",
    iteration: 3,
    state: {
      goal: "build the harness",
      constraints: [],
      plan: [],
      decisions: [],
      completed: [],
      pending: ["verify"],
      filesChanged: [],
      commandsRun: [],
      testsRun: [],
      failures: [],
      importantFacts: [],
      openQuestions: [],
      toolRefs: [],
      artifactRefs: [],
      memoryRefs: [],
      childAgentRefs: [],
    },
    toolLedger: [
      { toolCallId: "toolcall_a" as never, tool: "exec", argsHash: "abc123", started: 0, completed: 1, status: "success", sideEffect: true },
    ],
    childSessions: [],
    lastEventSequence: 42,
    effectiveAgentConfigRef: "effective-agent-snapshot",
    contextRefs: [],
    ...over,
  });
}

describe("DurableCheckpointStore (P1-3)", () => {
  it("saves and loads the latest checkpoint round-trip with a matching checksum", async () => {
    const root = await freshRoot();
    const store = new DurableCheckpointStore({ dataDir: root });
    const data = checkpoint();

    await store.save(data);
    const loaded = await store.loadLatest(data.sessionId);

    expect(loaded).toBeDefined();
    expect(loaded!.sessionId).toBe(data.sessionId);
    expect(loaded!.checkpointId).toBe(data.checkpointId);
    expect(loaded!.reason).toBe("periodic:iteration");
    expect(loaded!.iteration).toBe(3);
    expect(loaded!.state.pending).toEqual(["verify"]);
    expect(loaded!.checksum).toBe(data.checksum);
  });

  it("keeps the newest of several checkpoints and lists them newest-first", async () => {
    const root = await freshRoot();
    const store = new DurableCheckpointStore({ dataDir: root });
    const session = newSessionId();
    const a = checkpoint({ sessionId: session, createdAt: 100 });
    const b = checkpoint({ sessionId: session, createdAt: 200, iteration: 7 });

    await store.save(a);
    await store.save(b);

    const latest = await store.loadLatest(session);
    expect(latest!.checkpointId).toBe(b.checkpointId);
    expect(latest!.iteration).toBe(7);

    const all = await store.list(session);
    expect(all.map((c) => c.checkpointId)).toEqual([b.checkpointId, a.checkpointId]);
  });

  it("ignores checkpoints of other sessions", async () => {
    const root = await freshRoot();
    const store = new DurableCheckpointStore({ dataDir: root });
    const s1 = newSessionId();
    const s2 = newSessionId();

    await store.save(checkpoint({ sessionId: s1 }));
    await store.save(checkpoint({ sessionId: s2, reason: "verification:passed" }));

    expect((await store.loadLatest(s1))!.reason).toBe("periodic:iteration");
    expect((await store.loadLatest(s2))!.reason).toBe("verification:passed");
  });

  it("rejects a checkpoint whose checksum does not match (fail-closed before write)", async () => {
    const root = await freshRoot();
    const store = new DurableCheckpointStore({ dataDir: root });
    const data = checkpoint();
    const tampered: CheckpointData = { ...data, iteration: 99 };

    await expect(store.save(tampered)).rejects.toMatchObject({
      code: "CORRUPT_RECORD",
    });

    // Nothing became latest; a load returns nothing at all.
    expect(await store.loadLatest(data.sessionId)).toBeUndefined();
  });

  it("a corrupt latest.json does not lose the last good checkpoint (loadLatest fallback)", async () => {
    const root = await freshRoot();
    const store = new DurableCheckpointStore({ dataDir: root });
    const session = newSessionId();
    const good = checkpoint({ sessionId: session, createdAt: 300 });
    await store.save(good);

    // Corrupt the latest pointer as if torn by a crash during write.
    const latestFile = join(root, "checkpoints", session, "latest.json");
    await writeFile(latestFile, "{ this is not valid json", "utf8");

    const loaded = await store.loadLatest(session);
    expect(loaded!.checkpointId).toBe(good.checkpointId);
    expect(loaded!.iteration).toBe(good.iteration);
  });

  it("bad checkpoints are skipped by list while good ones survive", async () => {
    const root = await freshRoot();
    const store = new DurableCheckpointStore({ dataDir: root });
    const session = newSessionId();
    const good = checkpoint({ sessionId: session, createdAt: 500 });
    await store.save(good);

    // Manually plant a corrupt checkpoint file alongside the good one.
    const badDir = join(root, "checkpoints", session);
    await writeFile(join(badDir, "session-bad.json"), "{\"schemaVersion\":1,\"iteration\":0", "utf8");

    const all = await store.list(session);
    expect(all).toHaveLength(1);
    expect(all[0]!.checkpointId).toBe(good.checkpointId);
  });

  it("returns undefined when a session has no checkpoints", async () => {
    const root = await freshRoot();
    const store = new DurableCheckpointStore({ dataDir: root });
    expect(await store.loadLatest(newSessionId())).toBeUndefined();
    expect(await store.list(newSessionId())).toEqual([]);
  });

  it("rejects unsafe session ids (path traversal)", async () => {
    const root = await freshRoot();
    const store = new DurableCheckpointStore({ dataDir: root });
    const data = checkpoint();
    await writeFile(join(root, "..", "escape-me"), "x", "utf8").catch(() => undefined);

    await expect(
      store.loadLatest("../../escape" as SessionId),
    ).rejects.toMatchObject({ code: "UNSAFE_ID" });
    await expect(
      store.save(checkpoint({ sessionId: "a/../b" as SessionId })),
    ).rejects.toMatchObject({ code: "UNSAFE_ID" });
  });

  it("round-trips a written checkpoint file exactly (read-back is the written bytes)", async () => {
    const root = await freshRoot();
    const store = new DurableCheckpointStore({ dataDir: root });
    const data = checkpoint({ childSessions: ["session_1" as never], contextRefs: ["path:AGENTS.md"] });

    await store.save(data);
    const raw = await readFile(
      join(root, "checkpoints", data.sessionId, `${data.checkpointId}.json`),
      "utf8",
    );
    const parsed = JSON.parse(raw) as CheckpointData;
    expect(parsed.checksum).toBe(data.checksum);
    expect(parsed.state.goal).toBe(data.state.goal);
    expect(parsed.childSessions).toEqual(["session_1"]);
  });
});