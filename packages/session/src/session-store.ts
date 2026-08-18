import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Message, Session, SessionId, SessionStore, Turn, TurnId } from "@ar/contracts";

/**
 * JSONL session store (SESSION-001).
 *
 * Layout under dataDir (deterministic paths, no index file needed):
 *   sessions/<sessionId>.json        session record      { schemaVersion, session }
 *   turns/<turnId>.json              turn record         { schemaVersion, turn }
 *   messages/<sessionId>.jsonl       append-only JSONL   { schemaVersion, message } per line
 *   state/<sessionId>.json           state snapshot      { schemaVersion, snapshot }
 *   archive/<sessionId>/             archived session (session.json, messages.jsonl,
 *                                    state.json, turns/<turnId>.json)
 *
 * All records are wrapped in { schemaVersion: 1 }. Reads reject records with an
 * unsupported schemaVersion (CORRUPT_RECORD). Writes are atomic (tmp file +
 * rename). Single-writer assumption: this store is meant for one process.
 */
export const SCHEMA_VERSION = 1 as const;

export type SessionStoreErrorCode =
  | "UNSAFE_ID"
  | "UNKNOWN_SESSION"
  | "UNKNOWN_TURN"
  | "UNKNOWN_PROMPT"
  | "CORRUPT_RECORD"
  | "IO_ERROR"
  | "UNSUPPORTED";

export class SessionStoreError extends Error {
  readonly code: SessionStoreErrorCode;

  constructor(code: SessionStoreErrorCode, message: string) {
    super(message);
    this.name = "SessionStoreError";
    this.code = code;
  }
}

const SAFE_ID = /^[A-Za-z0-9_-]+$/;

function assertSafeId(id: string, kind: "session" | "turn" | "message"): void {
  if (id.length === 0 || !SAFE_ID.test(id)) {
    throw new SessionStoreError(
      "UNSAFE_ID",
      `unsafe ${kind} id ${JSON.stringify(id)}: must match [A-Za-z0-9_-]+`,
    );
  }
}

function isNodeError(err: unknown, code: string): boolean {
  return err instanceof Error && "code" in err && (err as NodeJS.ErrnoException).code === code;
}

export interface JSONLSessionStoreOptions {
  dataDir: string;
}

interface SessionRecord {
  schemaVersion: number;
  session: Session;
}

interface TurnRecord {
  schemaVersion: number;
  turn: Turn;
}

interface SnapshotRecord {
  schemaVersion: number;
  snapshot: Record<string, unknown>;
}

export class JSONLSessionStore implements SessionStore {
  private readonly dataDir: string;
  private readonly sessionsDir: string;
  private readonly turnsDir: string;
  private readonly messagesDir: string;
  private readonly stateDir: string;
  private readonly archiveDir: string;

  constructor(opts: JSONLSessionStoreOptions) {
    this.dataDir = path.resolve(opts.dataDir);
    this.sessionsDir = path.join(this.dataDir, "sessions");
    this.turnsDir = path.join(this.dataDir, "turns");
    this.messagesDir = path.join(this.dataDir, "messages");
    this.stateDir = path.join(this.dataDir, "state");
    this.archiveDir = path.join(this.dataDir, "archive");
  }

  // ---- path helpers -------------------------------------------------------

  private sessionFile(id: SessionId): string {
    return path.join(this.sessionsDir, `${id}.json`);
  }

  private turnFile(id: TurnId): string {
    return path.join(this.turnsDir, `${id}.json`);
  }

  private messageFile(id: SessionId): string {
    return path.join(this.messagesDir, `${id}.jsonl`);
  }

  private stateFile(id: SessionId): string {
    return path.join(this.stateDir, `${id}.json`);
  }

  // ---- io helpers ---------------------------------------------------------

  private async ensureDirs(): Promise<void> {
    await mkdir(this.sessionsDir, { recursive: true });
    await mkdir(this.turnsDir, { recursive: true });
    await mkdir(this.messagesDir, { recursive: true });
    await mkdir(this.stateDir, { recursive: true });
    await mkdir(this.archiveDir, { recursive: true });
  }

  private async readJson<T>(file: string): Promise<T | undefined> {
    let raw: string;
    try {
      raw = await readFile(file, "utf8");
    } catch (err) {
      if (isNodeError(err, "ENOENT")) return undefined;
      throw new SessionStoreError("IO_ERROR", `read failed for ${file}: ${String(err)}`);
    }
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (typeof parsed !== "object" || parsed === null) {
        throw new Error("record is not an object");
      }
      const record = parsed as Record<string, unknown>;
      if (record.schemaVersion !== SCHEMA_VERSION) {
        throw new Error(`unsupported schemaVersion ${String(record.schemaVersion)}`);
      }
      return record as T;
    } catch (err) {
      throw new SessionStoreError("CORRUPT_RECORD", `corrupt record ${file}: ${String(err)}`);
    }
  }

  private async writeJsonAtomic(file: string, payload: Record<string, unknown>): Promise<void> {
    const tmp = `${file}.tmp`;
    try {
      await writeFile(tmp, JSON.stringify({ schemaVersion: SCHEMA_VERSION, ...payload }, null, 2), "utf8");
      await rm(file, { force: true });
      await rename(tmp, file);
    } catch (err) {
      throw new SessionStoreError("IO_ERROR", `write failed for ${file}: ${String(err)}`);
    }
  }

  private async appendJsonLine(file: string, payload: Record<string, unknown>): Promise<void> {
    const line = JSON.stringify({ schemaVersion: SCHEMA_VERSION, ...payload });
    try {
      await writeFile(file, `${line}\n`, { flag: "a", encoding: "utf8" });
    } catch (err) {
      throw new SessionStoreError("IO_ERROR", `append failed for ${file}: ${String(err)}`);
    }
  }

  private async moveIfExists(src: string, dest: string): Promise<void> {
    try {
      await rename(src, dest);
    } catch (err) {
      if (isNodeError(err, "ENOENT")) return;
      throw new SessionStoreError("IO_ERROR", `move failed ${src} -> ${dest}: ${String(err)}`);
    }
  }

  private async readSessionDoc(id: SessionId): Promise<Session | undefined> {
    const rec = await this.readJson<SessionRecord>(this.sessionFile(id));
    return rec?.session;
  }

  private async readMessages(sessionId: SessionId): Promise<Message[]> {
    let raw: string;
    try {
      raw = await readFile(this.messageFile(sessionId), "utf8");
    } catch (err) {
      if (isNodeError(err, "ENOENT")) return [];
      throw new SessionStoreError("IO_ERROR", `read failed for ${this.messageFile(sessionId)}: ${String(err)}`);
    }
    const messages: Message[] = [];
    const lines = raw.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (line === undefined || line.trim() === "") continue;
      try {
        const rec = JSON.parse(line) as Record<string, unknown>;
        if (rec.schemaVersion !== SCHEMA_VERSION) {
          throw new Error(`unsupported schemaVersion ${String(rec.schemaVersion)}`);
        }
        messages.push(rec.message as Message);
      } catch (err) {
        throw new SessionStoreError(
          "CORRUPT_RECORD",
          `corrupt message line ${i + 1} in ${this.messageFile(sessionId)}: ${String(err)}`,
        );
      }
    }
    return messages;
  }

  // ---- SessionStore: sessions ---------------------------------------------

  async createSession(session: Session): Promise<void> {
    assertSafeId(session.id, "session");
    await this.ensureDirs();
    await this.writeJsonAtomic(this.sessionFile(session.id), { session });
  }

  async getSession(id: SessionId): Promise<Session | undefined> {
    assertSafeId(id, "session");
    return this.readSessionDoc(id);
  }

  async updateSession(session: Session): Promise<void> {
    assertSafeId(session.id, "session");
    const existing = await this.readSessionDoc(session.id);
    if (!existing) {
      throw new SessionStoreError("UNKNOWN_SESSION", `cannot update unknown session ${session.id}`);
    }
    await this.writeJsonAtomic(this.sessionFile(session.id), { session });
  }

  async listSessions(opts?: { parentId?: SessionId; status?: Session["status"] }): Promise<Session[]> {
    await this.ensureDirs();
    let files: string[];
    try {
      files = (await readdir(this.sessionsDir)).filter((f) => f.endsWith(".json"));
    } catch (err) {
      throw new SessionStoreError("IO_ERROR", `list sessions failed: ${String(err)}`);
    }
    const sessions: Session[] = [];
    for (const file of files) {
      const rec = await this.readJson<SessionRecord>(path.join(this.sessionsDir, file));
      if (rec?.session === undefined) continue;
      if (opts?.parentId !== undefined && rec.session.parentId !== opts.parentId) continue;
      if (opts?.status !== undefined && rec.session.status !== opts.status) continue;
      sessions.push(rec.session);
    }
    sessions.sort((a, b) => b.createdAt - a.createdAt);
    return sessions;
  }

  // ---- SessionStore: turns -------------------------------------------------

  async createTurn(turn: Turn): Promise<void> {
    assertSafeId(turn.id, "turn");
    assertSafeId(turn.sessionId, "session");
    await this.ensureDirs();
    const session = await this.readSessionDoc(turn.sessionId);
    if (!session) {
      throw new SessionStoreError("UNKNOWN_SESSION", `cannot create turn for unknown session ${turn.sessionId}`);
    }
    await this.writeJsonAtomic(this.turnFile(turn.id), { turn });
  }

  async getTurn(id: TurnId): Promise<Turn | undefined> {
    assertSafeId(id, "turn");
    const rec = await this.readJson<TurnRecord>(this.turnFile(id));
    return rec?.turn;
  }

  async updateTurn(turn: Turn): Promise<void> {
    assertSafeId(turn.id, "turn");
    const existing = await this.getTurn(turn.id);
    if (!existing) {
      throw new SessionStoreError("UNKNOWN_TURN", `cannot update unknown turn ${turn.id}`);
    }
    await this.writeJsonAtomic(this.turnFile(turn.id), { turn });
  }

  async listTurns(sessionId: SessionId): Promise<Turn[]> {
    assertSafeId(sessionId, "session");
    await this.ensureDirs();
    let files: string[];
    try {
      files = (await readdir(this.turnsDir)).filter((f) => f.endsWith(".json"));
    } catch (err) {
      throw new SessionStoreError("IO_ERROR", `list turns failed: ${String(err)}`);
    }
    const turns: Turn[] = [];
    for (const file of files) {
      const rec = await this.readJson<TurnRecord>(path.join(this.turnsDir, file));
      if (rec?.turn?.sessionId === sessionId) turns.push(rec.turn);
    }
    turns.sort((a, b) => a.startedAt - b.startedAt);
    return turns;
  }

  // ---- SessionStore: messages ----------------------------------------------

  async appendMessage(message: Message): Promise<void> {
    assertSafeId(message.id, "message");
    assertSafeId(message.sessionId, "session");
    if (message.turnId !== undefined) assertSafeId(message.turnId, "turn");
    await this.ensureDirs();
    const session = await this.readSessionDoc(message.sessionId);
    if (!session) {
      throw new SessionStoreError("UNKNOWN_SESSION", `cannot append message for unknown session ${message.sessionId}`);
    }
    await this.appendJsonLine(this.messageFile(message.sessionId), { message });
  }

  async listMessages(sessionId: SessionId): Promise<Message[]> {
    assertSafeId(sessionId, "session");
    return this.readMessages(sessionId);
  }

  async listMessagesByTurn(sessionId: SessionId, turnId: TurnId): Promise<Message[]> {
    assertSafeId(sessionId, "session");
    assertSafeId(turnId, "turn");
    const all = await this.listMessages(sessionId);
    return all.filter((m) => m.turnId === turnId);
  }

  // ---- SessionStore: state snapshots ---------------------------------------

  async saveStateSnapshot(sessionId: SessionId, snapshot: Record<string, unknown>): Promise<void> {
    assertSafeId(sessionId, "session");
    await this.ensureDirs();
    const session = await this.readSessionDoc(sessionId);
    if (!session) {
      throw new SessionStoreError("UNKNOWN_SESSION", `cannot save snapshot for unknown session ${sessionId}`);
    }
    await this.writeJsonAtomic(this.stateFile(sessionId), { snapshot });
  }

  async loadStateSnapshot(sessionId: SessionId): Promise<Record<string, unknown> | undefined> {
    assertSafeId(sessionId, "session");
    const rec = await this.readJson<SnapshotRecord>(this.stateFile(sessionId));
    return rec?.snapshot;
  }

  // ---- archive (extra capability used by SessionService.archive) ------------

  /**
   * Move every on-disk artifact of a session into dataDir/archive/<sessionId>.
   * Returns the archive directory path. After archiving, getSession/getTurn/
   * listTurns for that session return nothing (fail-closed).
   */
  async archiveSession(id: SessionId): Promise<{ archivedPath: string }> {
    assertSafeId(id, "session");
    await this.ensureDirs();
    const session = await this.readSessionDoc(id);
    if (!session) {
      throw new SessionStoreError("UNKNOWN_SESSION", `cannot archive unknown session ${id}`);
    }
    const destDir = path.join(this.archiveDir, id);
    await mkdir(destDir, { recursive: true });

    await this.moveIfExists(this.sessionFile(id), path.join(destDir, "session.json"));
    await this.moveIfExists(this.messageFile(id), path.join(destDir, "messages.jsonl"));
    await this.moveIfExists(this.stateFile(id), path.join(destDir, "state.json"));

    const turnsDest = path.join(destDir, "turns");
    let files: string[];
    try {
      files = (await readdir(this.turnsDir)).filter((f) => f.endsWith(".json"));
    } catch (err) {
      throw new SessionStoreError("IO_ERROR", `archive scan failed: ${String(err)}`);
    }
    for (const file of files) {
      const rec = await this.readJson<TurnRecord>(path.join(this.turnsDir, file));
      if (rec?.turn?.sessionId !== id) continue;
      await mkdir(turnsDest, { recursive: true });
      await this.moveIfExists(path.join(this.turnsDir, file), path.join(turnsDest, file));
    }
    return { archivedPath: destDir };
  }
}
