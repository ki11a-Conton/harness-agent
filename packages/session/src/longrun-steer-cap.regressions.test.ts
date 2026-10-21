import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { newPromptId, newSessionId, newTurnId } from "@ar/contracts";
import type { AdmittedPrompt, InboxStore, PromptKind, SessionId, TurnId } from "@ar/contracts";
import { JSONLInboxStore, MemInboxStore } from "./inbox.js";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

async function dataDir(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "ar-longrun-steer-cap-"));
  directories.push(directory); return directory;
}

async function storeFor(backend: "memory" | "jsonl"): Promise<InboxStore> {
  return backend === "memory" ? new MemInboxStore({ maxPending: 1 })
    : new JSONLInboxStore({ dataDir: await dataDir(), maxPending: 1 });
}

function prompt(sessionId: SessionId, kind: PromptKind, turnId?: TurnId): AdmittedPrompt {
  return { id: newPromptId(), sessionId, kind, text: `${kind}: preserve this admitted input`, admittedAt: 1000,
    ...(turnId === undefined ? { status: "pending" as const }
      : { status: "promoted" as const, promotedAt: 1001, promotedTurnId: turnId }) };
}

describe.each(["memory", "jsonl"] as const)("long-running promoted steer capacity in %s inbox", backend => {
  it("rejects a second prebound promoted steer until the first is consumed", async () => {
    const store = await storeFor(backend), sessionId = newSessionId(), turnId = newTurnId();
    const first = prompt(sessionId, "steer", turnId), second = prompt(sessionId, "steer", turnId);
    await store.admit(first);
    expect(await store.listPending(sessionId)).toEqual([]);
    await expect(store.admit(second)).rejects.toMatchObject({ code: "QUEUE_FULL" });
    expect((await store.listAll(sessionId)).map(item => item.id)).toEqual([first.id]);

    await store.markConsumed(first.id);
    await expect(store.admit(second)).resolves.toBeUndefined();
    expect((await store.listAll(sessionId)).map(item => [item.id, item.status, item.promotedTurnId])).toEqual([
      [first.id, "consumed", turnId], [second.id, "promoted", turnId],
    ]);
  });

  it("keeps a pending steer's capacity reservation after promotion", async () => {
    const store = await storeFor(backend), sessionId = newSessionId(), turnId = newTurnId();
    const first = prompt(sessionId, "steer"), next = prompt(sessionId, "followup");
    await store.admit(first);
    await expect(store.admit(next)).rejects.toMatchObject({ code: "QUEUE_FULL" });
    await store.bindPromotion(first.id, turnId);
    await expect(store.admit(next)).rejects.toMatchObject({ code: "QUEUE_FULL" });

    await store.markConsumed(first.id);
    await store.admit(next);
    expect((await store.listPending(sessionId)).map(item => item.id)).toEqual([next.id]);
  });

  it("releases a promoted followup's capacity before its turn completes", async () => {
    const store = await storeFor(backend), sessionId = newSessionId();
    const followup = prompt(sessionId, "followup"), correction = prompt(sessionId, "steer", newTurnId());
    await store.admit(followup);
    await expect(store.admit(correction)).rejects.toMatchObject({ code: "QUEUE_FULL" });
    await store.bindPromotion(followup.id, newTurnId());
    await expect(store.admit(correction)).resolves.toBeUndefined();
    expect((await store.listAll(sessionId)).map(item => [item.id, item.status])).toEqual([
      [followup.id, "promoted"], [correction.id, "promoted"],
    ]);
    await expect(store.admit(prompt(sessionId, "steer", newTurnId()))).rejects.toMatchObject({ code: "QUEUE_FULL" });
  });
});

describe("JSONL steer capacity after reopening the durable inbox", () => {
  it("retains a promoted steer's reservation and durably releases it after consume", async () => {
    const directory = await dataDir(), sessionId = newSessionId(), turnId = newTurnId();
    const first = prompt(sessionId, "steer", turnId), second = prompt(sessionId, "steer", turnId);
    await new JSONLInboxStore({ dataDir: directory, maxPending: 1 }).admit(first);

    const reopened = new JSONLInboxStore({ dataDir: directory, maxPending: 1 });
    expect(await reopened.listAll(sessionId)).toEqual([first]);
    await expect(reopened.admit(second)).rejects.toMatchObject({ code: "QUEUE_FULL" });
    await reopened.markConsumed(first.id);

    const reopenedAfterConsume = new JSONLInboxStore({ dataDir: directory, maxPending: 1 });
    await expect(reopenedAfterConsume.admit(second)).resolves.toBeUndefined();
    expect((await reopenedAfterConsume.listAll(sessionId)).map(item => [item.id, item.status, item.promotedTurnId])).toEqual([
      [first.id, "consumed", turnId], [second.id, "promoted", turnId],
    ]);
  });

  it("does not count a promoted followup after reopening", async () => {
    const directory = await dataDir(), sessionId = newSessionId(), turnId = newTurnId();
    const first = prompt(sessionId, "followup"), correction = prompt(sessionId, "steer", turnId);
    const original = new JSONLInboxStore({ dataDir: directory, maxPending: 1 });
    await original.admit(first); await original.bindPromotion(first.id, turnId);

    const reopened = new JSONLInboxStore({ dataDir: directory, maxPending: 1 });
    await expect(reopened.admit(correction)).resolves.toBeUndefined();
    expect((await reopened.listAll(sessionId)).map(item => [item.id, item.status, item.promotedTurnId])).toEqual([
      [first.id, "promoted", turnId], [correction.id, "promoted", turnId],
    ]);
  });
});
