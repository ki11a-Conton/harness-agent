import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { newSessionId } from "@ar/contracts";
import { JSONLInboxStore, MemInboxStore, SessionInbox } from "./inbox.js";
const SESSION = newSessionId();
let tempDirs = [];
async function makeDataDir() {
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
        const store = inbox.store;
        await store.markPromoted(steer.id);
        await inbox.consume(steer.id);
        const record = store.prompts.find((p) => p.id === steer.id);
        expect(record.status).toBe("consumed");
        expect(record.promotedAt).toBeDefined();
        expect(record.consumedAt).toBeDefined();
        expect(await inbox.listPending(SESSION)).toEqual([]);
    });
});
describe("JSONLInboxStore", () => {
    afterEach(async () => {
        for (const dir of tempDirs.splice(0)) {
            await rm(dir, { recursive: true, force: true }).catch(() => { });
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
        expect(pending[0].id).toBe(steer.id);
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
        await second.consume(promoted.id);
        const third = new SessionInbox(new JSONLInboxStore({ dataDir: dir }));
        expect(await third.listPending(SESSION)).toEqual([]);
    });
    it("skips corrupt lines and throws on unknown prompt ids", async () => {
        const dir = await makeDataDir();
        const { writeFile } = await import("node:fs/promises");
        await writeFile(join(dir, "inbox.jsonl"), "{not json\n", "utf8");
        const store = new JSONLInboxStore({ dataDir: dir });
        await expect(store.markConsumed("prompt_unknown")).rejects.toThrow(/unknown prompt/);
    });
});
//# sourceMappingURL=inbox.test.js.map