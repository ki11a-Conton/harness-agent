/**
 * E4-08 — durable RecoveryStore: crash/restart continuity, CAS contention,
 * lease expiry, corrupt-record quarantine, and due-scan. Two independent store
 * clients over the same directory stand in for two processes/workers.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DurableRecoveryStore, RecoveryStoreError, DURABLE_RECOVERY_SCHEMA_VERSION } from "./durable-recovery-store.js";
import type { RecoveryRecord } from "@ar/core";
import type { PromptId, TurnId } from "@ar/contracts";

const tid = (s: string): TurnId => s as unknown as TurnId;

let dir: string;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), "e4-08-rec-")); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

function baseRecord(taskId: string, over: Partial<RecoveryRecord> = {}): RecoveryRecord {
  return {
    taskId: tid(taskId),
    lineageId: `lin-${taskId}`,
    state: "PENDING",
    attempt: 0,
    maxRecoveryAttempts: 3,
    nextAttemptAt: 1000,
    lastError: null,
    policyVersion: "e2-10-policy-v1",
    promptId: `prompt-${taskId}` as unknown as PromptId,
    ...over,
  };
}

async function codes(fn: () => Promise<unknown>): Promise<string> {
  try {
    await fn();
    return "NO_THROW";
  } catch (err) {
    return err instanceof RecoveryStoreError ? err.code : `OTHER:${String(err)}`;
  }
}

describe("DurableRecoveryStore", () => {
  it("persists a fresh record and assigns version 1", async () => {
    const store = new DurableRecoveryStore({ dataDir: dir });
    const stored = await store.putRecord(baseRecord("t1"));
    expect(stored.version).toBe(1);
    const back = await store.getRecord(tid("t1"));
    expect(back?.state).toBe("PENDING");
    expect(back?.version).toBe(1);
  });

  it("survives a process restart: a new client sees the prior attempt budget", async () => {
    const a = new DurableRecoveryStore({ dataDir: dir });
    const written = await a.putRecord(baseRecord("t1", { state: "RETRY_SCHEDULED", attempt: 1, nextAttemptAt: 5000 }));
    // "process A exits"; a fresh client B over the same dir:
    const b = new DurableRecoveryStore({ dataDir: dir });
    const recovered = await b.getRecord(tid("t1"));
    expect(recovered?.attempt).toBe(1);
    expect(recovered?.nextAttemptAt).toBe(5000);
    expect(recovered?.state).toBe("RETRY_SCHEDULED");
    expect(recovered?.version).toBe(written.version);
  });

  it("CAS: two clients racing the same version — exactly one write wins", async () => {
    const store = new DurableRecoveryStore({ dataDir: dir });
    const v1 = await store.putRecord(baseRecord("t1")); // version 1
    // Both read version 1, both try to write version 1 -> one wins, one conflicts.
    const clientA = new DurableRecoveryStore({ dataDir: dir });
    const clientB = new DurableRecoveryStore({ dataDir: dir });
    const recA = { ...(await clientA.getRecord(tid("t1")))!, state: "RECOVERY_IN_PROGRESS" as const };
    const recB = { ...(await clientB.getRecord(tid("t1")))!, state: "RECOVERY_IN_PROGRESS" as const };
    expect(recA.version).toBe(v1.version);
    const first = await clientA.putRecord(recA); // wins -> version 2
    expect(first.version).toBe(2);
    expect(await codes(() => clientB.putRecord(recB))).toBe("CAS_CONFLICT"); // stale version 1
  });

  it("a fresh write over an existing record is rejected (no silent overwrite)", async () => {
    const store = new DurableRecoveryStore({ dataDir: dir });
    await store.putRecord(baseRecord("t1"));
    expect(await codes(() => store.putRecord(baseRecord("t1")))).toBe("CAS_CONFLICT");
  });

  it("expired lease is re-acquirable by a new owner via CAS", async () => {
    let clock = 1000;
    const store = new DurableRecoveryStore({ dataDir: dir, now: () => clock });
    const leased = await store.putRecord({ ...baseRecord("t1"), lease: { owner: "dead-owner", expiresAt: 1500 } });
    // owner advances the clock past expiry and re-acquires with the current version
    clock = 2000;
    const reacquired = await store.putRecord({ ...leased, lease: { owner: "new-owner", expiresAt: 2500 } });
    expect(reacquired.lease?.owner).toBe("new-owner");
    expect(reacquired.version).toBe((leased.version ?? 0) + 1);
  });

  it("deleteRecord removes the record (idempotent on missing)", async () => {
    const store = new DurableRecoveryStore({ dataDir: dir });
    await store.putRecord(baseRecord("t1"));
    await store.deleteRecord(tid("t1"));
    expect(await store.getRecord(tid("t1"))).toBeUndefined();
    await store.deleteRecord(tid("t1")); // no throw
  });

  it("corrupt JSON is quarantined, reported, and NOT treated as absent", async () => {
    const store = new DurableRecoveryStore({ dataDir: dir });
    await store.putRecord(baseRecord("t1", { attempt: 2 }));
    // Corrupt the file on disk (simulates a torn/foreign write).
    const file = join(dir, "recovery", "t1.json");
    await writeFile(file, "{ not valid json", "utf8");
    expect(await codes(() => store.getRecord(tid("t1")))).toBe("CORRUPT_RECORD");
    // The corrupt file was moved aside (quarantined), not deleted, and no clean
    // record remains to be silently re-created with attempt 0.
    const remaining = (await readdir(join(dir, "recovery"))).filter((f) => f === "t1.json");
    expect(remaining).toEqual([]);
    const quarantined = (await readdir(join(dir, "recovery"))).filter((f) => f.startsWith("t1.json.corrupt-"));
    expect(quarantined.length).toBe(1);
  });

  it("unknown schema version fails closed", async () => {
    const store = new DurableRecoveryStore({ dataDir: dir });
    await store.putRecord(baseRecord("t1"));
    const file = join(dir, "recovery", "t1.json");
    const env = JSON.parse(await readFile(file, "utf8")) as { schemaVersion: string };
    env.schemaVersion = "999.0.0";
    await writeFile(file, JSON.stringify(env), "utf8");
    expect(await codes(() => store.getRecord(tid("t1")))).toBe("UNSUPPORTED_SCHEMA");
  });

  it("listDue returns non-terminal due records soonest-first, capped, excluding future + terminal", async () => {
    const store = new DurableRecoveryStore({ dataDir: dir });
    await store.putRecord(baseRecord("due-soon", { state: "RETRY_SCHEDULED", nextAttemptAt: 100 }));
    await store.putRecord(baseRecord("due-later", { state: "RETRY_SCHEDULED", nextAttemptAt: 200 }));
    await store.putRecord(baseRecord("future", { state: "RETRY_SCHEDULED", nextAttemptAt: 10_000 }));
    await store.putRecord(baseRecord("done", { state: "RECOVERED", nextAttemptAt: 50 }));
    const due = await store.listDue(1000, 10);
    expect(due.map((r) => r.taskId)).toEqual(["due-soon", "due-later"]);
    const capped = await store.listDue(1000, 1);
    expect(capped.map((r) => r.taskId)).toEqual(["due-soon"]);
  });

  it("rejects an unsafe task id (path traversal)", async () => {
    const store = new DurableRecoveryStore({ dataDir: dir });
    expect(await codes(() => store.putRecord(baseRecord("../escape")))).toBe("UNSAFE_ID");
  });

  it("envelope is a valid durable record on disk", async () => {
    const store = new DurableRecoveryStore({ dataDir: dir });
    await store.putRecord(baseRecord("t1"));
    const env = JSON.parse(await readFile(join(dir, "recovery", "t1.json"), "utf8")) as { schemaVersion: string; record: RecoveryRecord };
    expect(env.schemaVersion).toBe(DURABLE_RECOVERY_SCHEMA_VERSION);
    expect(env.record.taskId).toBe("t1");
  });
});
