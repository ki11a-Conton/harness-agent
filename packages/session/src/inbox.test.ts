import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { newSessionId, type TurnId } from "@ar/contracts";
import { JSONLInboxStore, MemInboxStore, SessionInbox } from "./inbox.js";

const SESSION = newSessionId();

let tempDirs: string[] = [];
async function makeDataDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "harness-inbox-"));
  tempDirs.push(dir);
  return dir;
}

describe("SessionInbox (MemInboxStore)", () => {
  it("admits steer and followup prompts, keeping kinds separate", async () => {
    const inbox = new SessionInbox(new MemInboxStore());
    const steer = await inbox.admit(SESSION, "stop touching docs/", "steer");
    const followup = await inbox.admit(SESSION, "now fix the tests", "followup");

    expect(steer.status).toBe("pending");
    expect(followup.kind).toBe("followup");
    const pending = await inbox.listPending(SESSION);
    expect(pending.map((p) => p.id)).toEqual([steer.id, followup.id]);
  });

  it("nextFollowup returns followups only and promotes them", async () => {
    const inbox = new SessionInbox(new MemInboxStore());
    await inbox.admit(SESSION, "steer me", "steer");
    const f1 = await inbox.admit(SESSION, "follow 1", "followup");
    const f2 = await inbox.admit(SESSION, "follow 2", "followup");

    expect((await inbox.nextFollowup(SESSION))?.id).toBe(f1.id);
    expect((await inbox.nextFollowup(SESSION))?.id).toBe(f2.id);
    expect(await inbox.nextFollowup(SESSION)).toBeUndefined();
    // steer prompts are never returned by the followup queue
    const all = await (await inbox.listPending(SESSION));
    expect(all.some((p) => p.id === f1.id || p.id === f2.id)).toBe(false);
  });

  it("consumes prompts after promotion", async () => {
    const inbox = new SessionInbox(new MemInboxStore());
    const steer = await inbox.admit(SESSION, "steer", "steer");
    const store = (inbox as unknown as { store: MemInboxStore }).store;
    await store.markPromoted(steer.id);
    await inbox.consume(steer.id);
    const record = store.prompts.find((p) => p.id === steer.id)!;
    expect(record.status).toBe("consumed");
    expect(record.promotedAt).toBeDefined();
    expect(record.consumedAt).toBeDefined();
    expect(await inbox.listPending(SESSION)).toEqual([]);
  });
});

describe("JSONLInboxStore", () => {
  afterEach(async () => {
    for (const dir of tempDirs.splice(0)) {
      await rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  });

  it("persists prompts across store instances (admit → reload → pending)", async () => {
    const dir = await makeDataDir();
    const first = new SessionInbox(new JSONLInboxStore({ dataDir: dir }));
    const steer = await first.admit(SESSION, "steer text", "steer");
    await first.admit(SESSION, "follow text", "followup");

    const second = new SessionInbox(new JSONLInboxStore({ dataDir: dir }));
    const pending = await second.listPending(SESSION);
    expect(pending.map((p) => p.text)).toEqual(["steer text", "follow text"]);
    expect(pending[0]!.id).toBe(steer.id);

    const raw = await readFile(join(dir, "inbox.jsonl"), "utf8");
    expect(raw.trim().split("\n")).toHaveLength(2);
  });

  it("propagates promoted/consumed transitions across instances", async () => {
    const dir = await makeDataDir();
    const inbox = new SessionInbox(new JSONLInboxStore({ dataDir: dir }));
    const followup = await inbox.admit(SESSION, "next task", "followup");

    const second = new SessionInbox(new JSONLInboxStore({ dataDir: dir }));
    const promoted = await second.nextFollowup(SESSION);
    expect(promoted?.id).toBe(followup.id);
    await second.consume(promoted!.id);

    const third = new SessionInbox(new JSONLInboxStore({ dataDir: dir }));
    expect(await third.listPending(SESSION)).toEqual([]);
  });

  it("skips corrupt lines and throws on unknown prompt ids", async () => {
    const dir = await makeDataDir();
    const { writeFile } = await import("node:fs/promises");
    await writeFile(join(dir, "inbox.jsonl"), "{not json\n", "utf8");

    const store = new JSONLInboxStore({ dataDir: dir });
    await expect(store.markConsumed("prompt_unknown" as never)).rejects.toThrow(/unknown prompt/);
  });
});

describe("P38.3-3 — promoted reconciliation reachable (listRecoverable)", () => {
  afterEach(async () => {
    for (const dir of tempDirs.splice(0)) {
      await rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  });

  it("Reachability — listRecoverable observes promoted prompts in every production store (fails with listPending)", async () => {
    const stores: Array<{ label: string; store: MemInboxStore | JSONLInboxStore }> = [
      { label: "MemInboxStore", store: new MemInboxStore() },
      { label: "JSONLInboxStore", store: new JSONLInboxStore({ dataDir: await makeDataDir() }) },
    ];
    for (const { label, store } of stores) {
      const inbox = new SessionInbox(store);
      const p = await inbox.admit(SESSION, "recoverable-promoted", "followup");
      await store.bindPromotion(p.id, "turn_recover" as TurnId);

      // listPending (pending only) must NOT see the promoted prompt — this is
      // exactly why hydration MUST use listRecoverable.
      const pending = await store.listPending(SESSION);
      expect(pending.find((x) => x.id === p.id)).toBeUndefined();

      // listRecoverable (pending + promoted) MUST observe it.
      const recoverable = await store.listRecoverable(SESSION);
      const observed = recoverable.find((x) => x.id === p.id)!;
      expect(observed.status).toBe("promoted");
      expect(observed.promotedTurnId).toBe("turn_recover" as TurnId);

      // consumed prompts are excluded from recovery.
      await store.markConsumed(p.id);
      const after = await store.listRecoverable(SESSION);
      expect(after.find((x) => x.id === p.id)).toBeUndefined();
    }
  });
});

describe("P38.3-1 — split followup durable bind from final consume", () => {
  afterEach(async () => {
    for (const dir of tempDirs.splice(0)) {
      await rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  });

  it("Test 1 — same identity binding is idempotent (bind P→T1 twice → still T1)", async () => {
    for (const store of [new MemInboxStore(), new JSONLInboxStore({ dataDir: await makeDataDir() })]) {
      const inbox = new SessionInbox(store);
      const p = await inbox.admit(SESSION, "lineage", "followup");
      await store.bindPromotion(p.id, "turn_T1" as TurnId);
      await store.bindPromotion(p.id, "turn_T1" as TurnId); // idempotent
      const all = await store.listAll(SESSION);
      const record = all.find((x) => x.id === p.id)!;
      expect(record.status).toBe("promoted");
      expect(record.promotedTurnId).toBe("turn_T1" as TurnId);
      expect(record.promotedAt).toBeDefined();
    }
  });

  it("Test 2 — conflicting identity is rejected (bind P→T1 then P→T2 → PROMOTION_CONFLICT, still T1)", async () => {
    for (const store of [new MemInboxStore(), new JSONLInboxStore({ dataDir: await makeDataDir() })]) {
      const inbox = new SessionInbox(store);
      const p = await inbox.admit(SESSION, "lineage", "followup");
      await store.bindPromotion(p.id, "turn_T1" as TurnId);
      await expect(store.bindPromotion(p.id, "turn_T2" as TurnId)).rejects.toMatchObject({
        code: "PROMOTION_CONFLICT",
      });
      const all = await store.listAll(SESSION);
      const record = all.find((x) => x.id === p.id)!;
      expect(record.promotedTurnId).toBe("turn_T1" as TurnId);
    }
  });

  it("Test 3 — consume requires a promoted lineage (pending unbound consume fails closed)", async () => {
    for (const store of [new MemInboxStore(), new JSONLInboxStore({ dataDir: await makeDataDir() })]) {
      const inbox = new SessionInbox(store);
      const p = await inbox.admit(SESSION, "unbound", "followup");
      await expect(store.markConsumed(p.id)).rejects.toMatchObject({
        code: "CONSUME_NOT_PROMOTED",
      });
      const all = await store.listAll(SESSION);
      expect(all.find((x) => x.id === p.id)!.status).toBe("pending");
    }
  });

  it("Test 4 — consumed record retains promotedTurnId lineage", async () => {
    for (const store of [new MemInboxStore(), new JSONLInboxStore({ dataDir: await makeDataDir() })]) {
      const inbox = new SessionInbox(store);
      const p = await inbox.admit(SESSION, "bound-then-consumed", "followup");
      await store.bindPromotion(p.id, "turn_T1" as TurnId);
      await store.markConsumed(p.id);
      const all = await store.listAll(SESSION);
      const record = all.find((x) => x.id === p.id)!;
      expect(record.status).toBe("consumed");
      expect(record.promotedTurnId).toBe("turn_T1" as TurnId); // lineage retained
      expect(record.consumedAt).toBeDefined();
    }
  });
});

describe("P15-3: inbox queue bound", () => {
  it("MemInboxStore rejects admission past maxPending with a typed QUEUE_FULL", async () => {
    const inbox = new SessionInbox(new MemInboxStore({ maxPending: 2 }));
    const sessionId = newSessionId();
    await inbox.admit(sessionId, "one");
    await inbox.admit(sessionId, "two");
    await expect(inbox.admit(sessionId, "three")).rejects.toMatchObject({ code: "QUEUE_FULL" });
  });

  it("JSONLInboxStore rejects admission past maxPending (durable, no silent drop)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ar-inbox-bound-"));
    try {
      const store = new JSONLInboxStore({ dataDir: dir, maxPending: 1 });
      const inbox = new SessionInbox(store);
      const sessionId = newSessionId();
      await inbox.admit(sessionId, "one");
      await expect(inbox.admit(sessionId, "two")).rejects.toMatchObject({ code: "QUEUE_FULL" });
      // the admitted prompt is intact on disk (durable truth, not RAM)
      const pending = await inbox.listPending(sessionId);
      expect(pending).toHaveLength(1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("10k admissions do not grow memory without bound — rejects at the cap", async () => {
    const inbox = new SessionInbox(new MemInboxStore({ maxPending: 100 }));
    const sessionId = newSessionId();
    let admitted = 0;
    for (let i = 0; i < 10_000; i++) {
      try {
        await inbox.admit(sessionId, `input-${i}`);
        admitted += 1;
      } catch (err) {
        expect((err as { code?: string }).code).toBe("QUEUE_FULL");
        break;
      }
    }
    expect(admitted).toBe(100);
  });
});
