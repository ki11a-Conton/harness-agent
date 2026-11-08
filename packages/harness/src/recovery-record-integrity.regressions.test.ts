import { chmod, mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { PromptId, TurnId } from "@ar/contracts";
import type { RecoveryRecord } from "@ar/core";
import { DurableRecoveryStore } from "./durable-recovery-store.js";

const dirs: string[] = [];
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true, maxRetries: 8 }); });
async function fixture() {
  const dataDir = await mkdtemp(join(tmpdir(), "ar-recovery-record-")); dirs.push(dataDir);
  const store = new DurableRecoveryStore({ dataDir });
  const record = await store.putRecord({ taskId: "turn_a" as TurnId, lineageId: "lineage_a", promptId: "prompt_a" as PromptId,
    state: "RETRY_SCHEDULED", attempt: 1, maxRecoveryAttempts: 3, nextAttemptAt: 1000, lastError: "transient", policyVersion: "e2-10-policy-v1" });
  return { store, dataDir, record, file: join(dataDir, "recovery", "turn_a.json") };
}
const invalid: Array<[string, Record<string, unknown>]> = [
  ["negative attempt", { attempt: -1 }], ["fractional attempt", { attempt: 1.5 }],
  ["nonfinite budget", { maxRecoveryAttempts: Infinity }], ["nonfinite due time", { nextAttemptAt: NaN }],
  ["invalid lease", { lease: { owner: "other", expiresAt: "later" } }],
  ["invalid reconciliation flag", { needsReconcile: "yes" }], ["invalid error", { lastError: {} }],
  ["missing lineage", { lineageId: undefined }], ["missing policy", { policyVersion: undefined }],
];

describe("recovery record integrity before admission and persistence", () => {
  it.each(invalid)("refuses %s before replacing an acknowledged record", async (_name, patch) => {
    const { store, record, file } = await fixture(), before = await readFile(file, "utf8");
    await expect(store.putRecord({ ...record, ...patch } as RecoveryRecord)).rejects.toMatchObject({ code: "UNSUPPORTED_SCHEMA" });
    expect(await readFile(file, "utf8")).toBe(before);
    expect(await store.getRecord(record.taskId as TurnId)).toEqual(record);
    const updated = await store.putRecord({ ...record, attempt: 2 });
    expect(updated.version).toBe(record.version! + 1);
  });

  it.each(invalid.filter(([, patch]) => !Object.values(patch).some(value => typeof value === "number" && !Number.isFinite(value))))(
    "refuses persisted %s on restart and never schedules it", async (_name, patch) => {
      const { store, file, record, dataDir } = await fixture();
      const envelope = JSON.parse(await readFile(file, "utf8")); envelope.record = { ...record, ...patch };
      await writeFile(file, JSON.stringify(envelope));
      await expect(new DurableRecoveryStore({ dataDir }).getRecord(record.taskId as TurnId)).rejects.toMatchObject({ code: "UNSUPPORTED_SCHEMA" });
      expect(await store.listDue(2000, 10)).toEqual([]);
    });

  it("rejects an envelope whose task identity differs from its filename", async () => {
    const { store, file, record } = await fixture();
    const envelope = JSON.parse(await readFile(file, "utf8")); envelope.record.taskId = "turn_other";
    await writeFile(file, JSON.stringify(envelope));
    await expect(store.getRecord(record.taskId as TurnId)).rejects.toMatchObject({ code: "CORRUPT_RECORD" });
    expect(await store.listDue(2000, 10)).toEqual([]);
  });

  it("refuses version overflow without losing the last CAS identity", async () => {
    const { store, file, record } = await fixture();
    const envelope = JSON.parse(await readFile(file, "utf8")); envelope.record.version = Number.MAX_SAFE_INTEGER;
    const before = JSON.stringify(envelope); await writeFile(file, before);
    await expect(store.putRecord({ ...record, version: Number.MAX_SAFE_INTEGER })).rejects.toMatchObject({ code: "UNSUPPORTED_SCHEMA" });
    expect(await readFile(file, "utf8")).toBe(before);
  });

  it("maintenance deletion respects the same live writer lock as updates", async () => {
    const { store, file, record } = await fixture(), before = await readFile(file, "utf8");
    const lock = `${file}.lock`, token = `${process.pid} another-live-owner`;
    await writeFile(lock, token);
    await expect(store.deleteRecord(record.taskId as TurnId)).rejects.toMatchObject({ code: "IO_ERROR" });
    expect(await readFile(file, "utf8")).toBe(before); expect(await readFile(lock, "utf8")).toBe(token);
    await rm(lock); await store.deleteRecord(record.taskId as TurnId);
    expect(await store.getRecord(record.taskId as TurnId)).toBeUndefined();
  });

  it("a read cannot quarantine bytes while another writer owns the record", async () => {
    const { store, file, record } = await fixture(), lock = `${file}.lock`, token = `${process.pid} live-maintenance`;
    await writeFile(file, "{ interrupted record"); await writeFile(lock, token);
    await expect(store.getRecord(record.taskId as TurnId)).rejects.toMatchObject({ code: "IO_ERROR" });
    expect(await readFile(file, "utf8")).toBe("{ interrupted record");
    expect(await readFile(lock, "utf8")).toBe(token);
    await rm(lock);
    await expect(store.getRecord(record.taskId as TurnId)).rejects.toMatchObject({ code: "CORRUPT_RECORD" });
    await expect(readFile(file)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)("cannot steal an unreadable old lock from a live owner", async () => {
    const { store, file, record } = await fixture(), lock = `${file}.lock`, token = `${process.pid} live-owner`;
    const before = await readFile(file, "utf8"), old = new Date(Date.now() - 60_000);
    await writeFile(lock, token); await utimes(lock, old, old); await chmod(lock, 0);
    let error: unknown;
    try { await store.putRecord({ ...record, attempt: 2 }); } catch (cause) { error = cause; }
    finally { await chmod(lock, 0o600).catch(cause => { if (cause.code !== "ENOENT") throw cause; }); }
    expect(error).toMatchObject({ code: "IO_ERROR" });
    expect(await readFile(file, "utf8")).toBe(before); expect(await readFile(lock, "utf8")).toBe(token);
  });

  it("keeps valid zero budgets, legacy versionless records, leases and reconciliation state readable", async () => {
    const { store, file, record, dataDir } = await fixture();
    const envelope = JSON.parse(await readFile(file, "utf8")); delete envelope.record.version;
    Object.assign(envelope.record, { attempt: 0, maxRecoveryAttempts: 0, lastError: null, needsReconcile: true,
      lease: { owner: "worker", expiresAt: 3000 } });
    await writeFile(file, JSON.stringify(envelope));
    expect(await new DurableRecoveryStore({ dataDir }).getRecord(record.taskId as TurnId)).toMatchObject(envelope.record);
    expect(await store.listDue(2000, 1)).toHaveLength(1);
  });
});
