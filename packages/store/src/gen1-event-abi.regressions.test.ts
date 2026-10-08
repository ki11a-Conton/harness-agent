import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { EVENT_ABI_VERSION, newEventId, newMessageId, newSessionId, type AgentEvent, type Message } from "@ar/contracts";
import { SqliteRuntimeStore } from "./sqlite-runtime-store.js";

const stores: SqliteRuntimeStore[] = [];
afterEach(() => { for (const store of stores.splice(0)) store.close(); });
function fixture() {
  const db = new DatabaseSync(":memory:");
  const store = new SqliteRuntimeStore({ db });
  stores.push(store);
  const sessionId = newSessionId();
  const event: AgentEvent = { id: newEventId(), sessionId, sequence: 0, timestamp: 1, type: "turn.started", payload: {} };
  return { db, store, sessionId, event };
}

describe("Gen1 SQLite event ABI parity", () => {
  it("stamps the current ABI before persisting a caller's unversioned event", async () => {
    const { store, sessionId, event } = fixture();
    expect((await store.append(event)).schemaVersion).toBe(EVENT_ABI_VERSION);
    expect((await store.list(sessionId))[0]?.schemaVersion).toBe(EVENT_ABI_VERSION);
  });

  it("rejects an unsupported append ABI without consuming a sequence", async () => {
    const { store, sessionId, event } = fixture();
    await expect(store.append({ ...event, schemaVersion: 999 as never })).rejects.toThrow(/unsupported event ABI/);
    expect(await store.list(sessionId)).toEqual([]);
    expect((await store.append(event)).sequence).toBe(0);
  });

  it.each([undefined, 999])("rejects persisted ABI %s in list and stream rather than replaying it", async (schemaVersion) => {
    const { db, store, sessionId, event } = fixture();
    db.prepare("INSERT INTO events (session_id, sequence, doc) VALUES (?, ?, ?)")
      .run(sessionId, 0, JSON.stringify({ ...event, schemaVersion }));
    await expect(store.list(sessionId)).rejects.toThrow(/unsupported event ABI/);
    await expect((async () => { for await (const _event of store.stream(sessionId)) { /* exhaust */ } })()).rejects.toThrow(/unsupported event ABI/);
  });

  it("rejects unsupported tool-outcome ABI before committing transcript state", async () => {
    const { store, sessionId, event } = fixture();
    const toolMessage: Message = { id: newMessageId(), sessionId, role: "tool", content: "result", createdAt: 1 };
    await expect(store.commitToolOutcome({ toolMessage, outcomeEvent: { ...event, schemaVersion: 999 as never } })).rejects.toThrow(/unsupported event ABI/);
    expect(await store.listMessages(sessionId)).toEqual([]);
    expect(await store.list(sessionId)).toEqual([]);
  });
});
