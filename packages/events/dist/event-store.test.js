import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { EVENT_ABI_VERSION, makeEvent, makeSessionId, newEventId, newSessionId } from "@ar/contracts";
import { JSONLEventStore } from "./event-store.js";
// Shared Q-9 fixture builder: default session is `session_0001`, which is the
// single session this suite scopes all assertions to, so SID stays stable.
const SID = makeSessionId(1);
let tempDir;
afterEach(async () => {
    if (tempDir !== undefined) {
        await rm(tempDir, { recursive: true, force: true });
        tempDir = undefined;
    }
});
async function freshDataDir() {
    tempDir = await mkdtemp(join(tmpdir(), "events-"));
    return tempDir;
}
describe("JSONLEventStore (EVENT-001)", () => {
    it("append/list roundtrip with monotonic sequence", async () => {
        const store = new JSONLEventStore({ dataDir: await freshDataDir() });
        const e1 = await store.append(makeEvent());
        const e2 = await store.append(makeEvent());
        const e3 = await store.append(makeEvent());
        expect(e1.sequence).toBe(0);
        expect(e2.sequence).toBe(1);
        expect(e3.sequence).toBe(2);
        const events = await store.list(SID);
        expect(events.map((e) => ({ id: e.id, sequence: e.sequence }))).toEqual([
            { id: e1.id, sequence: 0 },
            { id: e2.id, sequence: 1 },
            { id: e3.id, sequence: 2 },
        ]);
    });
    it("rejects duplicate event id in the same session", async () => {
        const store = new JSONLEventStore({ dataDir: await freshDataDir() });
        const event = makeEvent();
        await store.append(event);
        await expect(store.append({ ...event })).rejects.toThrow(/duplicate event id/);
    });
    it("allows the same event id across different sessions", async () => {
        const store = new JSONLEventStore({ dataDir: await freshDataDir() });
        const otherSid = newSessionId();
        const id = newEventId();
        await store.append(makeEvent({ id, sessionId: SID }));
        await expect(store.append(makeEvent({ id, sessionId: otherSid }))).resolves.toBeDefined();
    });
    it("nextSequence starts at 0 and advances", async () => {
        const store = new JSONLEventStore({ dataDir: await freshDataDir() });
        expect(await store.nextSequence(SID)).toBe(0);
        await store.append(makeEvent());
        await store.append(makeEvent());
        expect(await store.nextSequence(SID)).toBe(2);
    });
    it("stream iterates all events in order", async () => {
        const store = new JSONLEventStore({ dataDir: await freshDataDir() });
        const ids = [newEventId(), newEventId(), newEventId()];
        for (const id of ids) {
            await store.append(makeEvent({ id }));
        }
        const streamed = [];
        for await (const event of store.stream(SID)) {
            streamed.push(event);
        }
        expect(streamed.map((e) => e.id)).toEqual(ids);
    });
    it("filters by afterSequence and limit", async () => {
        const store = new JSONLEventStore({ dataDir: await freshDataDir() });
        const ids = [newEventId(), newEventId(), newEventId(), newEventId(), newEventId()];
        for (const id of ids) {
            await store.append(makeEvent({ id }));
        }
        expect((await store.list(SID, { afterSequence: 1 })).map((e) => e.id)).toEqual(ids.slice(2));
        expect((await store.list(SID, { afterSequence: 1, limit: 2 })).map((e) => e.id)).toEqual(ids.slice(2, 4));
        expect((await store.list(SID, { limit: 2 })).map((e) => e.id)).toEqual(ids.slice(0, 2));
    });
    it("recovers events and sequence after a restart", async () => {
        const dataDir = await freshDataDir();
        const first = new JSONLEventStore({ dataDir });
        const ids = [newEventId(), newEventId(), newEventId()];
        for (const id of ids) {
            await first.append(makeEvent({ id }));
        }
        const second = new JSONLEventStore({ dataDir });
        expect((await second.list(SID)).map((e) => e.id)).toEqual(ids);
        expect(await second.nextSequence(SID)).toBe(3);
        const next = await second.append(makeEvent());
        expect(next.sequence).toBe(3);
        expect(await second.list(SID)).toHaveLength(4);
    });
    it("throws on corrupt file with non-increasing sequence", async () => {
        const dataDir = await freshDataDir();
        const path = join(dataDir, `${SID}.jsonl`);
        const evt = makeEvent();
        const line = (sequence) => JSON.stringify({ schemaVersion: 1, event: { ...evt, sequence } });
        await writeFile(path, `${line(1)}\n${line(0)}\n`, "utf8");
        const store = new JSONLEventStore({ dataDir });
        await expect(store.list(SID)).rejects.toThrow(/not strictly increasing/);
    });
    it("throws on corrupt file with invalid json line", async () => {
        const dataDir = await freshDataDir();
        const path = join(dataDir, `${SID}.jsonl`);
        await writeFile(path, `{"schemaVersion": 1\nnot-json\n`, "utf8");
        const store = new JSONLEventStore({ dataDir });
        await expect(store.list(SID)).rejects.toThrow(/invalid json/);
    });
    it("throws on corrupt file with unsupported schemaVersion", async () => {
        const dataDir = await freshDataDir();
        const path = join(dataDir, `${SID}.jsonl`);
        const evt = makeEvent();
        await writeFile(path, `${JSON.stringify({ schemaVersion: 2, event: evt })}\n`, "utf8");
        const store = new JSONLEventStore({ dataDir });
        await expect(store.list(SID)).rejects.toThrow(/unsupported record shape/);
    });
    it.each([
        ["../evil"],
        ["a/b"],
        ["a\\b"],
        [".."],
        ["..\\..\\etc"],
    ])("rejects unsafe session id %j", async (unsafe) => {
        const store = new JSONLEventStore({ dataDir: await freshDataDir() });
        const badSid = unsafe;
        await expect(store.list(badSid)).rejects.toThrow(/unsafe session id/);
        await expect(store.append(makeEvent({ sessionId: badSid }))).rejects.toThrow(/unsafe session id/);
    });
    it("treats a missing file as empty", async () => {
        const dataDir = await freshDataDir();
        const store = new JSONLEventStore({ dataDir });
        expect(await store.list(SID)).toEqual([]);
        expect(await store.nextSequence(SID)).toBe(0);
    });
    // ---- P2-33: Deterministic Event Ordering ---------------------------------
    it("assigns distinct globally monotonic sequences under concurrent parallel appends", async () => {
        const store = new JSONLEventStore({ dataDir: await freshDataDir() });
        const N = 50;
        // Fire all appends without awaiting between them to simulate parallel
        // tool/subagent completions landing back-to-back.
        const results = await Promise.all(Array.from({ length: N }, () => store.append(makeEvent())));
        const sequences = results.map((e) => e.sequence);
        // Strictly increasing => distinct and ordered, no duplicates, no gaps.
        for (let i = 0; i < sequences.length; i++) {
            expect(sequences[i]).toBe(i);
        }
        // list() returns append order, not wall-clock order of the caller.
        const listed = await store.list(SID);
        expect(listed.map((e) => e.sequence)).toEqual(sequences);
    });
    it("ignores a stale caller-supplied sequence (store is the sequence authority)", async () => {
        const store = new JSONLEventStore({ dataDir: await freshDataDir() });
        await store.append(makeEvent({ sequence: 999 }));
        const planted = await store.append(makeEvent({ sequence: 7 }));
        const stale = await store.append(makeEvent({ sequence: 0 }));
        expect(planted.sequence).toBe(1);
        expect(stale.sequence).toBe(2);
        // Persisted file keeps the authoritative order regardless of caller claims.
        const listed = await store.list(SID);
        expect(listed.map((e) => e.sequence)).toEqual([0, 1, 2]);
    });
    it("rejects NaN / negative / non-numeric timestamps (real timestamp requirement)", async () => {
        const store = new JSONLEventStore({ dataDir: await freshDataDir() });
        const bad = [
            (makeEvent({ timestamp: Number.NaN })),
            (makeEvent({ timestamp: -1 })),
            (makeEvent({ timestamp: Number.POSITIVE_INFINITY })),
            ({ ...makeEvent(), timestamp: "now" }),
        ];
        for (const ev of bad) {
            await expect(store.append(ev)).rejects.toThrow(/invalid event timestamp/);
        }
        // Nothing was written.
        expect(await store.list(SID)).toEqual([]);
        expect(await store.nextSequence(SID)).toBe(0);
    });
    it("preserves real completion timestamps regardless of append order", async () => {
        const store = new JSONLEventStore({ dataDir: await freshDataDir() });
        // Parallel completions land out of timestamp order; the store keeps each
        // real timestamp but orders them by append sequence.
        const first = await store.append(makeEvent({ timestamp: 300 }));
        const second = await store.append(makeEvent({ timestamp: 100 }));
        const third = await store.append(makeEvent({ timestamp: 200 }));
        expect(first.timestamp).toBe(300);
        expect(second.timestamp).toBe(100);
        expect(third.timestamp).toBe(200);
        // sequence is the order source of truth.
        expect([first.sequence, second.sequence, third.sequence]).toEqual([0, 1, 2]);
        const listed = await store.list(SID);
        expect(listed.map((e) => e.timestamp)).toEqual([300, 100, 200]);
    });
    // ---- P2-34: Event Schema Versioning --------------------------------------
    it("stamps the current ABI version on every persisted event", async () => {
        const store = new JSONLEventStore({ dataDir: await freshDataDir() });
        const stored = await store.append(makeEvent()); // producer supplies no schemaVersion
        expect(stored.schemaVersion).toBe(EVENT_ABI_VERSION);
        const listed = await store.list(SID);
        expect(listed[0].schemaVersion).toBe(EVENT_ABI_VERSION);
    });
    it("rejects an event claiming a different ABI version (fail-closed on write)", async () => {
        const store = new JSONLEventStore({ dataDir: await freshDataDir() });
        for (const v of [0, 2, EVENT_ABI_VERSION + 1]) {
            await expect(store.append(makeEvent({ schemaVersion: v }))).rejects.toThrow(/unsupported event ABI version/);
        }
        // Nothing was persisted.
        expect(await store.list(SID)).toEqual([]);
    });
    it("fails closed when reading an old/versionless event log (no silent misparse)", async () => {
        const dataDir = await freshDataDir();
        const path = join(dataDir, `${SID}.jsonl`);
        const evt = makeEvent();
        // A log written before event ABI versioning: no schemaVersion at all,
        // and a log claiming a future version — both must be rejected loudly.
        await writeFile(path, `${JSON.stringify({ schemaVersion: 1, event: evt })}\n`, "utf8");
        const store = new JSONLEventStore({ dataDir });
        await expect(store.list(SID)).rejects.toThrow(/unsupported event ABI version/);
        await expect(store.nextSequence(SID)).rejects.toThrow(/unsupported event ABI version/);
    });
    it("fails closed when reading an event that claims a future ABI version", async () => {
        const dataDir = await freshDataDir();
        const path = join(dataDir, `${SID}.jsonl`);
        const evt = makeEvent();
        await writeFile(path, `${JSON.stringify({ schemaVersion: 1, event: { ...evt, schemaVersion: 99 } })}\n`, "utf8");
        const store = new JSONLEventStore({ dataDir });
        await expect(store.list(SID)).rejects.toThrow(/migrate the event log/);
    });
    // ---- P2-35: Store Integrity ----------------------------------------------
    it("backup() snapshots the event log and excludes backups/temp (P2-35)", async () => {
        const store = new JSONLEventStore({ dataDir: await freshDataDir() });
        await store.append(makeEvent({ id: newEventId() }));
        await store.append(makeEvent({ id: newEventId() }));
        const result = await store.backup({ now: () => new Date("2026-01-02T03:04:05.060Z") });
        expect(result.path).toContain("backups/20260102T030405060");
        expect(result.files).toBe(1);
        const backed = await readFile(join(result.path, `${SID}.jsonl`), "utf8");
        expect(backed).toContain(`"id":"${(await store.list(SID))[0].id}"`);
        expect(await readdir(result.path)).toEqual([`${SID}.jsonl`]);
    });
    it("durable append lines survive a reopen (P2-35)", async () => {
        const dataDir = await freshDataDir();
        const store = new JSONLEventStore({ dataDir });
        const a = await store.append(makeEvent({ id: newEventId() }));
        const b = await store.append(makeEvent({ id: newEventId() }));
        const reopened = new JSONLEventStore({ dataDir });
        const listed = await reopened.list(SID);
        expect(listed.map((e) => e.id)).toEqual([a.id, b.id]);
        expect(listed.map((e) => e.sequence)).toEqual([0, 1]);
    });
});
//# sourceMappingURL=event-store.test.js.map