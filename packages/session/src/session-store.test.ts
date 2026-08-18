import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Message, Session, SessionId, Turn, TurnId } from "@ar/contracts";
import { newMessageId, newSessionId, newTurnId } from "@ar/contracts";
import { JSONLSessionStore, SessionStoreError } from "./session-store.js";

let dataDir: string;

beforeEach(async () => {
  dataDir = await mkdtemp(path.join(tmpdir(), "session-store-"));
});

afterEach(async () => {
  await rm(dataDir, { recursive: true, force: true });
});

function makeStore(): JSONLSessionStore {
  return new JSONLSessionStore({ dataDir });
}

function makeSession(overrides?: Partial<Session>): Session {
  return {
    id: newSessionId(),
    agentId: "agent_demo" as Session["agentId"],
    model: { providerId: "demo", modelId: "demo-1" },
    cwd: "C:\\work",
    status: "active",
    createdAt: 1000,
    updatedAt: 1000,
    ...overrides,
  };
}

function makeTurn(sessionId: SessionId, overrides?: Partial<Turn>): Turn {
  return {
    id: newTurnId(),
    sessionId,
    input: { sessionId, text: "hello" },
    status: "running",
    startedAt: 2000,
    ...overrides,
  };
}

function makeMessage(sessionId: SessionId, turnId?: TurnId, overrides?: Partial<Message>): Message {
  return {
    id: newMessageId(),
    sessionId,
    ...(turnId !== undefined ? { turnId } : {}),
    role: "user",
    content: "hi",
    createdAt: 3000,
    ...overrides,
  };
}

describe("JSONLSessionStore (SESSION-001)", () => {
  it("creates and reads back a session", async () => {
    const store = makeStore();
    const session = makeSession();
    await store.createSession(session);
    const got = await store.getSession(session.id);
    expect(got).toEqual(session);
  });

  it("updates a session", async () => {
    const store = makeStore();
    const session = makeSession();
    await store.createSession(session);
    const updated: Session = { ...session, status: "completed", updatedAt: 5000 };
    await store.updateSession(updated);
    expect(await store.getSession(session.id)).toEqual(updated);
  });

  it("throws UNKNOWN_SESSION when updating a missing session", async () => {
    const store = makeStore();
    await expect(store.updateSession(makeSession())).rejects.toMatchObject({
      code: "UNKNOWN_SESSION",
    });
  });

  it("lists sessions and filters by parentId and status", async () => {
    const store = makeStore();
    const parent = makeSession({ createdAt: 9000 });
    const child = makeSession({ parentId: parent.id, status: "active", createdAt: 1000 });
    const done = makeSession({ status: "completed", createdAt: 5000 });
    await store.createSession(parent);
    await store.createSession(child);
    await store.createSession(done);

    expect((await store.listSessions()).map((s) => s.id)).toEqual([
      parent.id,
      done.id,
      child.id,
    ]);
    expect((await store.listSessions({ parentId: parent.id })).map((s) => s.id)).toEqual([child.id]);
    expect((await store.listSessions({ status: "active" })).map((s) => s.id)).toEqual([
      parent.id,
      child.id,
    ]);
    expect(await store.listSessions({ parentId: parent.id, status: "completed" })).toEqual([]);
  });

  it("creates, reads, updates and lists turns", async () => {
    const store = makeStore();
    const session = makeSession();
    await store.createSession(session);
    const t1 = makeTurn(session.id, { startedAt: 500 });
    const t2 = makeTurn(session.id, { startedAt: 900 });
    await store.createTurn(t1);
    await store.createTurn(t2);
    expect(await store.getTurn(t1.id)).toEqual(t1);

    const finished: Turn = { ...t1, status: "completed", completedAt: 8000 };
    await store.updateTurn(finished);
    expect(await store.getTurn(t1.id)).toEqual(finished);

    expect(await store.listTurns(session.id)).toEqual([finished, t2]);
  });

  it("throws when creating a turn for an unknown session", async () => {
    const store = makeStore();
    await expect(store.createTurn(makeTurn(newSessionId()))).rejects.toMatchObject({
      code: "UNKNOWN_SESSION",
    });
  });

  it("throws UNKNOWN_TURN when updating a missing turn", async () => {
    const store = makeStore();
    await expect(store.updateTurn(makeTurn(newSessionId()))).rejects.toMatchObject({
      code: "UNKNOWN_TURN",
    });
  });

  it("does not leak turns of other sessions", async () => {
    const store = makeStore();
    const a = makeSession();
    const b = makeSession();
    await store.createSession(a);
    await store.createSession(b);
    await store.createTurn(makeTurn(a.id));
    await store.createTurn(makeTurn(b.id));
    expect((await store.listTurns(a.id)).length).toBe(1);
    expect((await store.listTurns(a.id))[0]!.sessionId).toBe(a.id);
  });

  it("appends and lists messages by session and by turn", async () => {
    const store = makeStore();
    const session = makeSession();
    const turn = makeTurn(session.id);
    await store.createSession(session);
    await store.createTurn(turn);

    const m1 = makeMessage(session.id, turn.id, { role: "user", content: "a", createdAt: 1 });
    const m2 = makeMessage(session.id, turn.id, { role: "tool", content: "b", createdAt: 2 });
    const m3 = makeMessage(session.id, undefined, { role: "system", content: "c", createdAt: 3 });
    await store.appendMessage(m1);
    await store.appendMessage(m2);
    await store.appendMessage(m3);

    expect(await store.listMessages(session.id)).toEqual([m1, m2, m3]);
    expect(await store.listMessagesByTurn(session.id, turn.id)).toEqual([m1, m2]);
  });

  it("rejects appending a message for an unknown session", async () => {
    const store = makeStore();
    await expect(store.appendMessage(makeMessage(newSessionId()))).rejects.toMatchObject({
      code: "UNKNOWN_SESSION",
    });
  });

  it("saves and loads state snapshots", async () => {
    const store = makeStore();
    const session = makeSession();
    await store.createSession(session);
    expect(await store.loadStateSnapshot(session.id)).toBeUndefined();

    const snapshot = { turns: [{ id: "turn_x", status: "completed" }] };
    await store.saveStateSnapshot(session.id, snapshot);
    expect(await store.loadStateSnapshot(session.id)).toEqual(snapshot);
  });

  it("rejects snapshots for an unknown session", async () => {
    const store = makeStore();
    await expect(store.saveStateSnapshot(newSessionId(), {})).rejects.toMatchObject({
      code: "UNKNOWN_SESSION",
    });
  });

  it("restores every record after restart (new instance, same dataDir)", async () => {
    const store = makeStore();
    const session = makeSession({ status: "active" });
    await store.createSession(session);
    const turn = makeTurn(session.id);
    await store.createTurn(turn);
    await store.appendMessage(makeMessage(session.id, turn.id, { content: "persist me" }));
    await store.saveStateSnapshot(session.id, { turns: [{ id: turn.id, status: "running" }] });

    const restarted = new JSONLSessionStore({ dataDir });
    expect(await restarted.getSession(session.id)).toEqual(session);
    expect(await restarted.getTurn(turn.id)).toEqual(turn);
    expect(await restarted.listTurns(session.id)).toEqual([turn]);
    expect(await restarted.listMessages(session.id)).toHaveLength(1);
    expect((await restarted.listMessages(session.id))[0]!.content).toBe("persist me");
    expect(await restarted.loadStateSnapshot(session.id)).toEqual({
      turns: [{ id: turn.id, status: "running" }],
    });
    expect((await restarted.listSessions()).map((s) => s.id)).toEqual([session.id]);
  });

  it("rejects unsafe session/turn ids (path traversal)", async () => {
    const store = makeStore();
    const badIds: string[] = ["../esc", "a/b", "a\\b", "..", "a:b", "", "a b"];
    for (const bad of badIds) {
      const sid = bad as SessionId;
      await expect(store.createSession(makeSession({ id: sid }))).rejects.toMatchObject({
        code: "UNSAFE_ID",
      });
      await expect(store.getSession(sid)).rejects.toMatchObject({ code: "UNSAFE_ID" });
      await expect(store.updateSession(makeSession({ id: sid }))).rejects.toMatchObject({
        code: "UNSAFE_ID",
      });
      await expect(store.getTurn(bad as TurnId)).rejects.toMatchObject({ code: "UNSAFE_ID" });
      await expect(store.listMessages(sid)).rejects.toMatchObject({ code: "UNSAFE_ID" });
    }
  });

  it("rejects records with an unsupported schemaVersion (CORRUPT_RECORD)", async () => {
    const store = new JSONLSessionStore({ dataDir });
    const session = makeSession();
    await store.createSession(session);
    await writeFile(
      path.join(dataDir, "sessions", `${session.id}.json`),
      JSON.stringify({ schemaVersion: 99, session }),
    );
    await expect(store.getSession(session.id)).rejects.toMatchObject({ code: "CORRUPT_RECORD" });
  });

  it("archives a session: moves all artifacts and hides it from the live store", async () => {
    const store = makeStore();
    const session = makeSession();
    const turn = makeTurn(session.id);
    await store.createSession(session);
    await store.createTurn(turn);
    await store.appendMessage(makeMessage(session.id, turn.id, { content: "persist me" }));
    await store.saveStateSnapshot(session.id, { turns: [] });

    const { archivedPath } = await store.archiveSession(session.id);
    expect(archivedPath).toBe(path.join(dataDir, "archive", session.id));

    expect(await store.getSession(session.id)).toBeUndefined();
    expect(await store.getTurn(turn.id)).toBeUndefined();
    expect(await store.listTurns(session.id)).toEqual([]);
    expect(await store.listSessions()).toEqual([]);
    expect(await store.loadStateSnapshot(session.id)).toBeUndefined();

    expect(await readFile(path.join(archivedPath, "session.json"), "utf8")).toContain(session.id);
    expect(await readFile(path.join(archivedPath, "messages.jsonl"), "utf8")).toContain("persist");
  });

  it("throws UNKNOWN_SESSION when archiving a missing session", async () => {
    const store = makeStore();
    await expect(store.archiveSession(newSessionId())).rejects.toMatchObject({
      code: "UNKNOWN_SESSION",
    });
  });

  it("exposes typed errors", async () => {
    const store = makeStore();
    try {
      await store.getTurn("../evil" as TurnId);
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(SessionStoreError);
      expect((err as SessionStoreError).code).toBe("UNSAFE_ID");
    }
  });
});