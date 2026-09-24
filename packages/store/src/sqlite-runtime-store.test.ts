import { spawn } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import {
  newAgentId,
  newAskId,
  newCheckpointId,
  newEventId,
  newMessageId,
  newPromptId,
  newSessionId,
  newTurnId,
  type AdmittedPrompt,
  type AgentEvent,
  type AskUserRequest,
  type CheckpointData,
  type Message,
  type Session,
  type Turn,
  type TurnId,
} from "@ar/contracts";
import { buildCheckpoint } from "@ar/contracts";
import { migrateJsonlToSqlite } from "./migrate.js";
import { SqliteRuntimeStore } from "./sqlite-runtime-store.js";

const tempDirs: string[] = [];
const stores: SqliteRuntimeStore[] = [];
async function freshDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "harness-store-"));
  tempDirs.push(dir);
  return dir;
}

function trackStore(store: SqliteRuntimeStore): SqliteRuntimeStore {
  stores.push(store);
  return store;
}

afterEach(async () => {
  for (const store of stores) store.close();
  stores.length = 0;
  await Promise.all(tempDirs.splice(0).map((d) => rm(d, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 })));
});

function session(): Session {
  return {
    id: newSessionId(),
    agentId: newAgentId(),
    model: { providerId: "p", modelId: "m" },
    cwd: "/work",
    status: "active",
    createdAt: 1,
    updatedAt: 1,
  };
}

function turn(sessionId: string): Turn {
  return {
    id: newTurnId(),
    sessionId: sessionId as never,
    input: { sessionId: sessionId as never, text: "do it" },
    status: "running",
    startedAt: 2,
  };
}

function message(sessionId: string, turnId: string, text: string): Message {
  return {
    id: newMessageId(),
    sessionId: sessionId as never,
    turnId: turnId as never,
    role: "assistant",
    content: text,
    createdAt: 3,
  };
}

function event(sessionId: string, type = "turn.started"): AgentEvent {
  return {
    id: newEventId(),
    sessionId: sessionId as never,
    sequence: 0,
    timestamp: 4,
    type: type as never,
    payload: {},
  };
}

describe("SqliteRuntimeStore (P5-3)", () => {
  it("persists sessions/turns/messages/state snapshots and survives reopen", async () => {
    const dir = await freshDir();
    const store = trackStore(new SqliteRuntimeStore({ dataDir: dir }));
    const s = session();
    const t = turn(s.id);
    const m = message(s.id, t.id, "hello");
    await store.createSession(s);
    await store.createTurn(t);
    await store.appendMessage(m);
    await store.saveStateSnapshot(s.id, { plan: ["a"] });
    store.close();

    const reopened = trackStore(new SqliteRuntimeStore({ dataDir: dir }));
    expect(await reopened.getSession(s.id)).toEqual(s);
    expect(await reopened.getTurn(t.id)).toEqual(t);
    expect(await reopened.listMessages(s.id)).toEqual([m]);
    expect(await reopened.listMessagesByTurn(s.id, t.id as never)).toEqual([m]);
    expect(await reopened.loadStateSnapshot(s.id)).toEqual({ plan: ["a"] });
    expect(await reopened.listSessions()).toHaveLength(1);
    expect(await reopened.listTurns(s.id)).toHaveLength(1);
    reopened.close();
  });

  it("updates sessions/turns and filters listSessions by parent/status", async () => {
    const store = trackStore(new SqliteRuntimeStore({ dataDir: await freshDir() }));
    const parent = session();
    const child = { ...session(), id: newSessionId(), parentId: parent.id, status: "completed" as const };
    await store.createSession(parent);
    await store.createSession(child);
    expect(await store.listSessions({ parentId: parent.id })).toEqual([child]);
    expect(await store.listSessions({ status: "completed" })).toEqual([child]);
    await store.updateSession({ ...child, status: "cancelled" });
    expect(await store.listSessions({ status: "cancelled" })).toHaveLength(1);
  });

  it("assigns strictly increasing per-session event sequences under interleaving", async () => {
    const store = trackStore(new SqliteRuntimeStore({ dataDir: await freshDir() }));
    const sid = newSessionId();
    const others = newSessionId();
    await Promise.all([
      store.append(event(sid)),
      store.append(event(sid)),
      store.append(event(others)),
      store.append(event(sid)),
    ]);
    const mine = await store.list(sid);
    expect(mine.map((e) => e.sequence)).toEqual([0, 1, 2]);
    // nextSequence and stream agree
    expect(await store.nextSequence(sid)).toBe(3);
    const streamed: AgentEvent[] = [];
    for await (const e of store.stream(sid)) streamed.push(e);
    expect(streamed).toHaveLength(3);
  });

  it("rejects duplicate event ids", async () => {
    const store = trackStore(new SqliteRuntimeStore({ dataDir: await freshDir() }));
    const e = event(newSessionId());
    await store.append(e);
    await expect(store.append(e)).rejects.toThrow();
  });

  it("inbox: admit/list/promote/consume lifecycle", async () => {
    const store = trackStore(new SqliteRuntimeStore({ dataDir: await freshDir() }));
    const sid = newSessionId();
    const prompt: AdmittedPrompt = {
      id: newPromptId(),
      sessionId: sid,
      text: "steer",
      kind: "steer",
      status: "pending",
      admittedAt: 1,
    };
    await store.admit(prompt);
    expect(await store.listPending(sid)).toHaveLength(1);
    await store.markPromoted(prompt.id);
    expect(await store.listPending(sid)).toHaveLength(0);
    await store.markConsumed(prompt.id);
    const all = await store.listAll(sid);
    expect(all[0]!.status).toBe("consumed");
  });

  it("P38.3-3 — listRecoverable observes promoted prompts (INV-P38.3-003)", async () => {
    const store = trackStore(new SqliteRuntimeStore({ dataDir: await freshDir() }));
    try {
      const sid = newSessionId();
      const prompt: AdmittedPrompt = {
        id: newPromptId(),
        sessionId: sid,
        text: "recoverable-promoted",
        kind: "followup",
        status: "pending",
        admittedAt: 1,
      };
      await store.admit(prompt);
      await store.bindPromotion(prompt.id, "turn_recover" as TurnId);
      // listPending (pending only) must NOT see the promoted prompt — this is
      // why hydration MUST use listRecoverable.
      expect((await store.listPending(sid)).find((p) => p.id === prompt.id)).toBeUndefined();
      // listRecoverable (pending + promoted) MUST observe it.
      const recoverable = await store.listRecoverable(sid);
      const observed = recoverable.find((p) => p.id === prompt.id)!;
      expect(observed.status).toBe("promoted");
      expect(observed.promotedTurnId).toBe("turn_recover" as TurnId);
      // consumed prompts are excluded from recovery.
      await store.markConsumed(prompt.id);
      expect((await store.listRecoverable(sid)).find((p) => p.id === prompt.id)).toBeUndefined();
    } finally {
      store.close();
    }
  });

  it("askUser: create/listPending/answer/withdraw via the composition surface", async () => {
    const store = trackStore(new SqliteRuntimeStore({ dataDir: await freshDir() }));
    const sid = newSessionId();
    const request: AskUserRequest = {
      id: newAskId(),
      sessionId: sid,
      reason: "missing_critical_input",
      question: "ok?",
      status: "pending",
      createdAt: 1,
    };
    await store.askUser.create(request);
    expect(await store.askUser.listPending(sid)).toHaveLength(1);
    await store.askUser.markAnswered(request.id, { requestId: request.id, text: "yes", answeredAt: 2 });
    const answered = await store.askUser.get(request.id);
    expect(answered?.status).toBe("answered");
    expect(answered?.answerText).toBe("yes");
    // answering again no-ops
    await store.askUser.markAnswered(request.id, { requestId: request.id, text: "again", answeredAt: 3 });
    expect((await store.askUser.get(request.id))?.answerText).toBe("yes");
  });

  it("checkpoints: save/loadLatest/list via the composition surface", async () => {
    const store = trackStore(new SqliteRuntimeStore({ dataDir: await freshDir() }));
    const sid = newSessionId();
    const cp = (id: string, at: number): CheckpointData =>
      ({
        checkpointId: newCheckpointId(),
        sessionId: sid,
        createdAt: at,
        agentId: newAgentId(),
        reason: "test",
        phase: "idle",
        iteration: 1,
        state: { goal: `g${id}` },
        toolLedger: [],
        childSessions: [],
        lastEventSequence: 0,
        effectiveAgentConfigRef: "cfg-1",
        contextRefs: [],
        checksum: "test",
        schemaVersion: 1,
      }) as unknown as CheckpointData;
    await store.checkpoints.save(cp("a", 1));
    await store.checkpoints.save(cp("b", 2));
    const latest = await store.checkpoints.loadLatest(sid);
    expect(latest?.state).toEqual({ goal: "gb" });
    expect(await store.checkpoints.list(sid)).toHaveLength(2);
  });
});

describe("P5-5: cross-process correctness (WAL + BEGIN IMMEDIATE)", () => {
  it("two connections interleaved on one file never collide on sequences", async () => {
    const dir = await freshDir();
    const sid = newSessionId();
    const dbPath = join(dir, "runtime.db");
    const a = new SqliteRuntimeStore({ db: new DatabaseSync(dbPath) });
    const b = new SqliteRuntimeStore({ db: new DatabaseSync(dbPath) });
    await Promise.all(
      Array.from({ length: 50 }, (_, i) =>
        i % 2 === 0 ? a.append(event(sid, "a")) : b.append(event(sid, "b")),
      ),
    );
    const events = await a.list(sid);
    expect(events).toHaveLength(50);
    const seqs = events.map((e) => e.sequence);
    expect(seqs).toEqual([...seqs].sort((x, y) => x - y));
    expect(new Set(seqs).size).toBe(50);
    a.close();
    b.close();
  });

  it("two separate processes append the same session without loss", async () => {
    const dir = await freshDir();
    const dbPath = join(dir, "runtime.db");
    // writer script: open the db, append 30 events, exit 0.
    const script = (name: string, sid: string): string => `
      const { DatabaseSync } = require("node:sqlite");
      const { SqliteRuntimeStore } = require(${JSON.stringify(new URL("./sqlite-runtime-store.ts", import.meta.url).pathname)});
    `;
    void script;
    // Use a standalone JS snippet against the compiled dist? Simpler: run two
    // node -e scripts that only touch the DB via raw SQL through DatabaseSync,
    // which is exactly the WAL/IMMEDIATE behaviour under test.
    // Pre-create the table in the parent so the child processes only run
    // INSERT transactions (concurrent DDL is what locks in WAL mode).
    const setup = new DatabaseSync(dbPath);
    setup.exec("PRAGMA journal_mode=WAL;");
    setup.exec("CREATE TABLE IF NOT EXISTS ev (session_id TEXT, seq INTEGER, name TEXT, PRIMARY KEY(session_id, seq));");
    setup.close();
    const sid = newSessionId();
    const runWriter = (name: string) =>
      new Promise<number>((resolve, reject) => {
        const child = spawn(
          process.execPath,
          [
            "-e",
            `
const { DatabaseSync } = require("node:sqlite");
const db = new DatabaseSync(${JSON.stringify(dbPath)});
db.exec("PRAGMA busy_timeout=8000;");
for (let i = 0; i < 30; i++) {
  db.exec("BEGIN IMMEDIATE");
  const row = db.prepare("SELECT COALESCE(MAX(seq),-1)+1 AS s FROM ev WHERE session_id=?").get(${JSON.stringify(sid)});
  db.prepare("INSERT INTO ev (session_id, seq, name) VALUES (?,?,?)").run(${JSON.stringify(sid)}, row.s, ${JSON.stringify(name)});
  db.exec("COMMIT");
}
db.close();
`,
          ],
          { stdio: ["ignore", "ignore", "pipe"] },
        );
        let stderr = "";
        child.stderr?.on("data", (d) => {
          stderr += String(d);
        });
        child.on("exit", (code) => {
          if (code !== 0 && stderr !== "") process.stderr.write(`[store-p5-5] ${stderr}`);
          resolve(code ?? 1);
        });
        child.on("error", reject);
      });
    const [codeA, codeB] = await Promise.all([runWriter("a"), runWriter("b")]);
    expect(codeA).toBe(0);
    expect(codeB).toBe(0);
    const check = new DatabaseSync(dbPath);
    const rows = check.prepare("SELECT seq FROM ev WHERE session_id = ? ORDER BY seq").all(sid) as { seq: number }[];
    check.close();
    expect(rows).toHaveLength(60);
    const seqs = rows.map((r) => r.seq);
    expect(new Set(seqs).size).toBe(60);
    expect(seqs.every((s, i) => s === i)).toBe(true);
  });
});

describe("P5-4: JSONL → SQLite migration", () => {
  it("migrates sessions/turns/messages/states/events idempotently with a dry-run report", async () => {
    const root = await freshDir();
    const jsonlSession = join(root, "session");
    const jsonlEvent = join(root, "events");
    const sid = newSessionId();
    const tid = newTurnId();
    const mid = newMessageId();
    // source layout (JSONLSessionStore / JSONLEventStore formats)
    await mkdir(join(jsonlSession, "sessions"), { recursive: true });
    await mkdir(join(jsonlSession, "turns"), { recursive: true });
    await mkdir(join(jsonlSession, "messages"), { recursive: true });
    await mkdir(join(jsonlSession, "state"), { recursive: true });
    const s = { ...session(), id: sid };
    const t = { ...turn(sid), id: tid };
    const m = message(sid, tid, "hi");
    void mid;
    await writeFile(
      join(jsonlSession, "sessions", `${sid}.json`),
      JSON.stringify({ schemaVersion: 1, session: s }),
    );
    await writeFile(join(jsonlSession, "turns", `${tid}.json`), JSON.stringify({ schemaVersion: 1, turn: t }));
    await writeFile(
      join(jsonlSession, "messages", `${sid}.jsonl`),
      `${JSON.stringify({ schemaVersion: 1, message: m })}\n`,
    );
    await writeFile(
      join(jsonlSession, "state", `${sid}.json`),
      JSON.stringify({ schemaVersion: 1, plan: ["x"] }),
    );
    await mkdir(jsonlEvent, { recursive: true });
    const e1 = event(sid);
    const e2 = { ...event(sid), id: newEventId() };
    await writeFile(
      join(jsonlEvent, `${sid}.jsonl`),
      `${JSON.stringify({ schemaVersion: 1, event: e1 })}\n${JSON.stringify({ schemaVersion: 1, event: e2 })}\n`,
    );

    const target = trackStore(new SqliteRuntimeStore({ dataDir: join(root, "sqlite") }));
    try {
      // dry run: counts but writes nothing
      const dry = await migrateJsonlToSqlite({
        source: { sessionDataDir: jsonlSession, eventDataDir: jsonlEvent },
        target,
        dryRun: true,
      });
      expect(dry).toMatchObject({ sessions: 1, turns: 1, messages: 1, states: 1, events: 2, dryRun: true });
      expect(await target.listSessions()).toHaveLength(0);

      // real run
      const report = await migrateJsonlToSqlite({
        source: { sessionDataDir: jsonlSession, eventDataDir: jsonlEvent },
        target,
      });
      expect(report).toMatchObject({ sessions: 1, turns: 1, messages: 1, states: 1, events: 2 });
      expect(await target.getSession(sid)).toEqual(s);
      expect(await target.getTurn(tid)).toEqual(t);
      expect(await target.listMessages(sid)).toHaveLength(1);
      expect(await target.loadStateSnapshot(sid)).toEqual({ plan: ["x"] });
      const events = await target.list(sid);
      expect(events.map((e) => e.sequence)).toEqual([0, 1]);

      // idempotent re-run: same counts, no duplicates
      const again = await migrateJsonlToSqlite({
        source: { sessionDataDir: jsonlSession, eventDataDir: jsonlEvent },
        target,
      });
      expect(again.events).toBe(2);
      expect(await target.list(sid)).toHaveLength(2);
      expect(await target.listMessages(sid)).toHaveLength(1);
    } finally {
      target.close();
    }
  });
  it("P26-1: 100 concurrent appendNew calls get exactly sequences 0..99 (no dup, no gap)", async () => {
    const store = trackStore(new SqliteRuntimeStore({ dataDir: await freshDir() }));
    const sid = newSessionId();
    const ev = (i: number): Omit<AgentEvent, "sequence"> => ({
      id: newEventId(),
      sessionId: sid,
      timestamp: i,
      type: "model.started",
      payload: { i },
    });
    const results = await Promise.all(
      Array.from({ length: 100 }, (_, i) => store.appendNew(ev(i))),
    );
    const seqs = results.map((e) => e.sequence).sort((a, b) => a - b);
    expect(seqs).toEqual(Array.from({ length: 100 }, (_, i) => i));
    expect(new Set(results.map((e) => e.id)).size).toBe(100);
    const listed = await store.list(sid);
    expect(listed).toHaveLength(100);
    expect(listed.map((e) => e.sequence)).toEqual(Array.from({ length: 100 }, (_, i) => i));
  });
  it("P26-3: declares process level honestly and flushThrough checkpoints the WAL", async () => {
    const dir = await freshDir();
    const store = trackStore(new SqliteRuntimeStore({ dataDir: dir }));
    expect(store.durabilityLevel).toBe("process");
    const sid = newSessionId();
    const a = await store.appendNew({
      id: newEventId(), sessionId: sid, timestamp: 1, type: "model.started", payload: {},
    });
    await store.flushThrough(sid, a.sequence);
    // The fence validates the sequence actually committed (fail-closed).
    await expect(store.flushThrough(sid, 999)).rejects.toThrow("not committed");
    store.close();
    const reopened = trackStore(new SqliteRuntimeStore({ dataDir: dir }));
    expect(await reopened.list(sid)).toHaveLength(1);
  });
  it("P26-6: commitToolOutcome commits message + event + checkpoint atomically", async () => {
    const store = trackStore(new SqliteRuntimeStore({ dataDir: await freshDir() }));
    const sid = newSessionId();
    const msg: Message = {
      id: newMessageId(), sessionId: sid, role: "tool", content: "out",
      toolCallId: "tc1" as never, createdAt: 1,
    };
    const outcomeEvent = {
      id: newEventId(), sessionId: sid, timestamp: 1, type: "tool.completed" as const,
      payload: { toolCallId: "tc1" },
    };
    const checkpoint = buildCheckpoint({
      schemaVersion: 1 as const,
      checkpointId: newCheckpointId(),
      sessionId: sid,
      agentId: newAgentId() as never,
      createdAt: 1,
      reason: "tool",
      phase: "idle",
      iteration: 1,
      state: { goal: "g" } as never,
      toolLedger: [],
      childSessions: [],
      lastEventSequence: 0,
      effectiveAgentConfigRef: "cfg",
      contextRefs: [],
    });
    const { event } = await store.commitToolOutcome({
      toolMessage: msg,
      outcomeEvent,
      checkpoint,
    });
    expect(event.sequence).toBe(0);
    expect(await store.listMessages(sid)).toHaveLength(1);
    expect((await store.list(sid))[0]!.type).toBe("tool.completed");
    expect(await store.checkpoints.loadLatest(sid)).toBeDefined();
  });

  it("P26-6: a failing commit rolls back EVERYTHING (no partial write)", async () => {
    const store = trackStore(new SqliteRuntimeStore({ dataDir: await freshDir() }));
    const sid = newSessionId();
    // Seed one event so the duplicate check has something to collide with.
    await store.appendNew({ id: newEventId(), sessionId: sid, timestamp: 1, type: "turn.started", payload: {} });
    const dupId = newEventId();
    await store.appendNew({ id: dupId, sessionId: sid, timestamp: 2, type: "turn.started", payload: {} });
    const msg: Message = {
      id: newMessageId(), sessionId: sid, role: "tool", content: "out",
      toolCallId: "tc1" as never, createdAt: 1,
    };
    // Duplicate event id → the whole commit must roll back: no message, no event.
    await expect(
      store.commitToolOutcome({
        toolMessage: msg,
        outcomeEvent: { id: dupId, sessionId: sid, timestamp: 3, type: "tool.completed", payload: {} },
      }),
    ).rejects.toThrow("duplicate event id");
    expect(await store.listMessages(sid)).toHaveLength(0);
    expect(await store.list(sid)).toHaveLength(2);
  });
});