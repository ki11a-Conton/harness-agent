import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { newAskId, newSessionId } from "@ar/contracts";
import { JSONLAskUserStore } from "./ask-user-store.js";
let tempDirs = [];
async function tempDir() {
    const dir = await mkdtemp(join(tmpdir(), "ar-ask-user-"));
    tempDirs.push(dir);
    return dir;
}
afterEach(async () => {
    await Promise.all(tempDirs.map((d) => rm(d, { recursive: true, force: true })));
    tempDirs = [];
});
function makeAsk(overrides = {}) {
    const sessionId = newSessionId();
    return {
        id: newAskId(),
        sessionId,
        reason: "missing_critical_input",
        question: "which target?",
        status: "pending",
        createdAt: 1000,
        ...overrides,
    };
}
describe("P1-4 JSONLAskUserStore", () => {
    it("persists create/get/listPending round-trip", async () => {
        const dir = await tempDir();
        const store = new JSONLAskUserStore({ dataDir: dir });
        const ask = makeAsk();
        await store.create(ask);
        expect(await store.get(ask.id)).toEqual(ask);
        expect(await store.listPending(ask.sessionId)).toEqual([ask]);
        expect(await store.listPending(newSessionId())).toEqual([]);
    });
    it("markAnswered transitions to answered and holds the reply", async () => {
        const dir = await tempDir();
        const store = new JSONLAskUserStore({ dataDir: dir });
        const ask = makeAsk();
        await store.create(ask);
        await store.markAnswered(ask.id, { requestId: ask.id, text: "target A", answeredAt: 2000 });
        const updated = await store.get(ask.id);
        expect(updated?.status).toBe("answered");
        expect(updated?.answerText).toBe("target A");
        expect(await store.listPending(ask.sessionId)).toEqual([]);
        await expect(store.markAnswered(ask.id, { requestId: ask.id, text: "again", answeredAt: 3000 })).rejects.toThrow(/not pending/);
    });
    it("markWithdrawn transitions to withdrawn", async () => {
        const dir = await tempDir();
        const store = new JSONLAskUserStore({ dataDir: dir });
        const ask = makeAsk();
        await store.create(ask);
        await store.markWithdrawn(ask.id);
        expect((await store.get(ask.id))?.status).toBe("withdrawn");
        expect(await store.listPending(ask.sessionId)).toEqual([]);
    });
    it("unknown ids reject explicitly", async () => {
        const dir = await tempDir();
        const store = new JSONLAskUserStore({ dataDir: dir });
        await expect(store.get(newAskId())).resolves.toBeUndefined();
        await expect(store.markAnswered(newAskId(), { requestId: newAskId(), text: "x", answeredAt: 0 })).rejects.toThrow(/unknown ask/);
        await expect(store.markWithdrawn(newAskId())).rejects.toThrow(/unknown ask/);
    });
    it("survives a fresh store instance over the same file (durability)", async () => {
        const dir = await tempDir();
        const store1 = new JSONLAskUserStore({ dataDir: dir });
        const ask = makeAsk();
        await store1.create(ask);
        await store1.markAnswered(ask.id, { requestId: ask.id, text: "ok", answeredAt: 500 });
        // "Process restart": a new instance reads the same file.
        const store2 = new JSONLAskUserStore({ dataDir: dir });
        const reloaded = await store2.get(ask.id);
        expect(reloaded?.status).toBe("answered");
        expect(reloaded?.answerText).toBe("ok");
    });
    it("skips corrupt lines without failing the store", async () => {
        const dir = await tempDir();
        const store = new JSONLAskUserStore({ dataDir: dir });
        const ask = makeAsk();
        await store.create(ask);
        // Inject a corrupt line at the end.
        const file = join(dir, "ask-users.jsonl");
        const raw = await readFile(file, "utf8");
        await import("node:fs/promises").then((fs) => fs.writeFile(file, `${raw}not-json\n`, "utf8"));
        const store2 = new JSONLAskUserStore({ dataDir: dir });
        expect(await store2.get(ask.id)).toEqual(ask);
    });
});
//# sourceMappingURL=ask-user-store.test.js.map