import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentEvent, EventId } from "@ar/contracts";
import { newEventId, newSessionId } from "@ar/contracts";
import { JSONLEventStore } from "./event-store.js";

const SID = newSessionId();

let tempDir: string | undefined;

afterEach(async () => {
  if (tempDir !== undefined) {
    await rm(tempDir, { recursive: true, force: true });
    tempDir = undefined;
  }
});

async function freshDataDir(): Promise<string> {
  tempDir = await mkdtemp(join(tmpdir(), "events-"));
  return tempDir;
}

function makeEvent(over: Partial<AgentEvent> = {}): AgentEvent {
  return {
    id: newEventId(),
    sessionId: SID,
    sequence: 0,
    timestamp: Date.now(),
    type: "turn.started",
    payload: {},
    ...over,
  };
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
    expect(events.map((e) => ({ id: e.id, sequence: e.sequence }))).toEqual(
      [
        { id: e1.id, sequence: 0 },
        { id: e2.id, sequence: 1 },
        { id: e3.id, sequence: 2 },
      ],
    );
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
    const id: EventId = newEventId();
    await store.append(makeEvent({ id, sessionId: SID }));
    await expect(
      store.append(makeEvent({ id, sessionId: otherSid })),
    ).resolves.toBeDefined();
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
    const streamed: AgentEvent[] = [];
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
    expect((await store.list(SID, { afterSequence: 1 })).map((e) => e.id)).toEqual(
      ids.slice(2),
    );
    expect((await store.list(SID, { afterSequence: 1, limit: 2 })).map((e) => e.id)).toEqual(
      ids.slice(2, 4),
    );
    expect(
      (await store.list(SID, { limit: 2 })).map((e) => e.id),
    ).toEqual(ids.slice(0, 2));
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
    const line = (sequence: number) =>
      JSON.stringify({ schemaVersion: 1, event: { ...evt, sequence } });
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
    const badSid = unsafe as unknown as typeof SID;
    await expect(store.list(badSid)).rejects.toThrow(/unsafe session id/);
    await expect(store.append(makeEvent({ sessionId: badSid }))).rejects.toThrow(
      /unsafe session id/,
    );
  });

  it("treats a missing file as empty", async () => {
    const dataDir = await freshDataDir();
    const store = new JSONLEventStore({ dataDir });
    expect(await store.list(SID)).toEqual([]);
    expect(await store.nextSequence(SID)).toBe(0);
  });
});