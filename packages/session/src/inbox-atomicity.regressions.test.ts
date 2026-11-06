import { mkdtemp, mkdir, readFile, rename, rm, rmdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { newPromptId, newSessionId, newTurnId, type AdmittedPrompt, type SessionId } from "@ar/contracts";
import { JSONLInboxStore } from "./inbox.js";
const dirs: string[] = [];
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });
const prompt = (sessionId: SessionId, text: string): AdmittedPrompt => ({ id: newPromptId(), sessionId, text,
  kind: "followup", status: "pending", admittedAt: Date.now() });
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "inbox-atomicity-")); dirs.push(dir);
  const sessionId = newSessionId(), initial = prompt(sessionId, "existing task");
  await new JSONLInboxStore({ dataDir: dir }).admit(initial);
  return { dir, sessionId, initial, file: join(dir, "inbox.jsonl"), store: new JSONLInboxStore({ dataDir: dir }) };
}
async function blockedFile(file: string, action: () => Promise<void>) {
  await rename(file, file + ".kept"); await mkdir(file);
  try { await action(); }
  finally { await rmdir(file); await rename(file + ".kept", file); }
}

describe("JSONL inbox committed snapshots", () => {
  it.each(["listPending", "listRecoverable", "listAll"] as const)("shares a complete first snapshot across concurrent %s readers", async method => {
    const h = await fixture();
    const rows = await Promise.all([h.store[method](h.sessionId), h.store[method](h.sessionId)]);
    expect(rows.map(row => row.map(p => p.id))).toEqual([[h.initial.id], [h.initial.id]]);
  });

  it("does not overwrite an existing real file when first reading and admitting concurrently", async () => {
    const h = await fixture(), next = prompt(h.sessionId, "new task");
    await Promise.all([h.store.listPending(h.sessionId), h.store.admit(next)]);
    const durable = await new JSONLInboxStore({ dataDir: h.dir }).listPending(h.sessionId);
    expect(durable.map(p => p.id)).toEqual([h.initial.id, next.id]);
    expect((await readFile(h.file, "utf8")).trim().split("\n")).toHaveLength(2);
  });

  it("retries a failed physical first read before a later admission", async () => {
    const h = await fixture();
    await blockedFile(h.file, async () => { await expect(h.store.listPending(h.sessionId)).rejects.toThrow(); });
    const next = prompt(h.sessionId, "after storage recovery"); await h.store.admit(next);
    expect((await new JSONLInboxStore({ dataDir: h.dir }).listPending(h.sessionId)).map(p => p.id)).toEqual([h.initial.id, next.id]);
  });

  it("does not publish a failed admission in memory or through a later successful disk write", async () => {
    const h = await fixture(); await h.store.listPending(h.sessionId);
    const refused = prompt(h.sessionId, "uncommitted task");
    await blockedFile(h.file, async () => { await expect(h.store.admit(refused)).rejects.toThrow(); });
    expect((await h.store.listPending(h.sessionId)).map(p => p.id)).toEqual([h.initial.id]);
    const next = prompt(h.sessionId, "valid later task"); await h.store.admit(next);
    expect((await new JSONLInboxStore({ dataDir: h.dir }).listPending(h.sessionId)).map(p => p.id)).toEqual([h.initial.id, next.id]);
  });

  it.each(["markPromoted", "bindPromotion"] as const)("failed %s cannot authorize consuming an unpromoted prompt", async method => {
    const h = await fixture(); const before = (await h.store.listPending(h.sessionId))[0]!;
    await blockedFile(h.file, async () => {
      const action = method === "markPromoted" ? h.store.markPromoted(h.initial.id) : h.store.bindPromotion(h.initial.id, newTurnId());
      await expect(action).rejects.toThrow();
    });
    expect(before.status).toBe("pending");
    await expect(h.store.markConsumed(h.initial.id)).rejects.toMatchObject({ code: "CONSUME_NOT_PROMOTED" });
    expect((await new JSONLInboxStore({ dataDir: h.dir }).listAll(h.sessionId))[0]).toMatchObject({ status: "pending" });
  });

  it("failed consumption keeps the bound task recoverable until its consume record commits", async () => {
    const h = await fixture(); const turnId = newTurnId(); await h.store.bindPromotion(h.initial.id, turnId);
    await blockedFile(h.file, async () => { await expect(h.store.markConsumed(h.initial.id)).rejects.toThrow(); });
    expect((await h.store.listRecoverable(h.sessionId))[0]).toMatchObject({ id: h.initial.id, status: "promoted", promotedTurnId: turnId });
    await h.store.markConsumed(h.initial.id);
    expect(await new JSONLInboxStore({ dataDir: h.dir }).listRecoverable(h.sessionId)).toEqual([]);
  });
});
