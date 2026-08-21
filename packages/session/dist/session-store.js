import { mkdir, readdir, readFile, rename } from "node:fs/promises";
import path from "node:path";
import { appendDurable, atomicWriteFile, backupTree } from "@ar/store-integrity";
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
export const SCHEMA_VERSION = 1;
export class SessionStoreError extends Error {
    code;
    constructor(code, message) {
        super(message);
        this.name = "SessionStoreError";
        this.code = code;
    }
}
const SAFE_ID = /^[A-Za-z0-9_-]+$/;
function assertSafeId(id, kind) {
    if (id.length === 0 || !SAFE_ID.test(id)) {
        throw new SessionStoreError("UNSAFE_ID", `unsafe ${kind} id ${JSON.stringify(id)}: must match [A-Za-z0-9_-]+`);
    }
}
function isNodeError(err, code) {
    return err instanceof Error && "code" in err && err.code === code;
}
export class JSONLSessionStore {
    dataDir;
    sessionsDir;
    turnsDir;
    messagesDir;
    stateDir;
    archiveDir;
    constructor(opts) {
        this.dataDir = path.resolve(opts.dataDir);
        this.sessionsDir = path.join(this.dataDir, "sessions");
        this.turnsDir = path.join(this.dataDir, "turns");
        this.messagesDir = path.join(this.dataDir, "messages");
        this.stateDir = path.join(this.dataDir, "state");
        this.archiveDir = path.join(this.dataDir, "archive");
    }
    // ---- path helpers -------------------------------------------------------
    sessionFile(id) {
        return path.join(this.sessionsDir, `${id}.json`);
    }
    turnFile(id) {
        return path.join(this.turnsDir, `${id}.json`);
    }
    messageFile(id) {
        return path.join(this.messagesDir, `${id}.jsonl`);
    }
    stateFile(id) {
        return path.join(this.stateDir, `${id}.json`);
    }
    // ---- io helpers ---------------------------------------------------------
    async ensureDirs() {
        await mkdir(this.sessionsDir, { recursive: true });
        await mkdir(this.turnsDir, { recursive: true });
        await mkdir(this.messagesDir, { recursive: true });
        await mkdir(this.stateDir, { recursive: true });
        await mkdir(this.archiveDir, { recursive: true });
    }
    async readJson(file) {
        let raw;
        try {
            raw = await readFile(file, "utf8");
        }
        catch (err) {
            if (isNodeError(err, "ENOENT"))
                return undefined;
            throw new SessionStoreError("IO_ERROR", `read failed for ${file}: ${String(err)}`);
        }
        try {
            const parsed = JSON.parse(raw);
            if (typeof parsed !== "object" || parsed === null) {
                throw new Error("record is not an object");
            }
            const record = parsed;
            if (record.schemaVersion !== SCHEMA_VERSION) {
                throw new Error(`unsupported schemaVersion ${String(record.schemaVersion)}`);
            }
            return record;
        }
        catch (err) {
            throw new SessionStoreError("CORRUPT_RECORD", `corrupt record ${file}: ${String(err)}`);
        }
    }
    async writeJsonAtomic(file, payload) {
        // P2-35: durable atomic write (temp + fsync + rename over target) via the
        // shared primitive. The previous tmp -> rm(target) -> rename left a window
        // where the target was absent between rm and rename; rename-over is atomic.
        try {
            await atomicWriteFile(file, JSON.stringify({ schemaVersion: SCHEMA_VERSION, ...payload }, null, 2));
        }
        catch (err) {
            throw new SessionStoreError("IO_ERROR", `write failed for ${file}: ${String(err)}`);
        }
    }
    async appendJsonLine(file, payload) {
        // P2-35: durable append (write + fsync) so an acked message survives a crash.
        try {
            await appendDurable(file, `${JSON.stringify({ schemaVersion: SCHEMA_VERSION, ...payload })}\n`);
        }
        catch (err) {
            throw new SessionStoreError("IO_ERROR", `append failed for ${file}: ${String(err)}`);
        }
    }
    async moveIfExists(src, dest) {
        try {
            await rename(src, dest);
        }
        catch (err) {
            if (isNodeError(err, "ENOENT"))
                return;
            throw new SessionStoreError("IO_ERROR", `move failed ${src} -> ${dest}: ${String(err)}`);
        }
    }
    async readSessionDoc(id) {
        const rec = await this.readJson(this.sessionFile(id));
        return rec?.session;
    }
    async readMessages(sessionId) {
        let raw;
        try {
            raw = await readFile(this.messageFile(sessionId), "utf8");
        }
        catch (err) {
            if (isNodeError(err, "ENOENT"))
                return [];
            throw new SessionStoreError("IO_ERROR", `read failed for ${this.messageFile(sessionId)}: ${String(err)}`);
        }
        const messages = [];
        const lines = raw.split("\n");
        for (let i = 0; i < lines.length; i++) {
            const line = lines[i];
            if (line === undefined || line.trim() === "")
                continue;
            try {
                const rec = JSON.parse(line);
                if (rec.schemaVersion !== SCHEMA_VERSION) {
                    throw new Error(`unsupported schemaVersion ${String(rec.schemaVersion)}`);
                }
                messages.push(rec.message);
            }
            catch (err) {
                throw new SessionStoreError("CORRUPT_RECORD", `corrupt message line ${i + 1} in ${this.messageFile(sessionId)}: ${String(err)}`);
            }
        }
        return messages;
    }
    // ---- SessionStore: sessions ---------------------------------------------
    async createSession(session) {
        assertSafeId(session.id, "session");
        await this.ensureDirs();
        await this.writeJsonAtomic(this.sessionFile(session.id), { session });
    }
    async getSession(id) {
        assertSafeId(id, "session");
        return this.readSessionDoc(id);
    }
    async updateSession(session) {
        assertSafeId(session.id, "session");
        const existing = await this.readSessionDoc(session.id);
        if (!existing) {
            throw new SessionStoreError("UNKNOWN_SESSION", `cannot update unknown session ${session.id}`);
        }
        await this.writeJsonAtomic(this.sessionFile(session.id), { session });
    }
    async listSessions(opts) {
        await this.ensureDirs();
        let files;
        try {
            files = (await readdir(this.sessionsDir)).filter((f) => f.endsWith(".json"));
        }
        catch (err) {
            throw new SessionStoreError("IO_ERROR", `list sessions failed: ${String(err)}`);
        }
        const sessions = [];
        for (const file of files) {
            const rec = await this.readJson(path.join(this.sessionsDir, file));
            if (rec?.session === undefined)
                continue;
            if (opts?.parentId !== undefined && rec.session.parentId !== opts.parentId)
                continue;
            if (opts?.status !== undefined && rec.session.status !== opts.status)
                continue;
            sessions.push(rec.session);
        }
        sessions.sort((a, b) => b.createdAt - a.createdAt);
        return sessions;
    }
    // ---- SessionStore: turns -------------------------------------------------
    async createTurn(turn) {
        assertSafeId(turn.id, "turn");
        assertSafeId(turn.sessionId, "session");
        await this.ensureDirs();
        const session = await this.readSessionDoc(turn.sessionId);
        if (!session) {
            throw new SessionStoreError("UNKNOWN_SESSION", `cannot create turn for unknown session ${turn.sessionId}`);
        }
        await this.writeJsonAtomic(this.turnFile(turn.id), { turn });
    }
    async getTurn(id) {
        assertSafeId(id, "turn");
        const rec = await this.readJson(this.turnFile(id));
        return rec?.turn;
    }
    async updateTurn(turn) {
        assertSafeId(turn.id, "turn");
        const existing = await this.getTurn(turn.id);
        if (!existing) {
            throw new SessionStoreError("UNKNOWN_TURN", `cannot update unknown turn ${turn.id}`);
        }
        await this.writeJsonAtomic(this.turnFile(turn.id), { turn });
    }
    async listTurns(sessionId) {
        assertSafeId(sessionId, "session");
        await this.ensureDirs();
        let files;
        try {
            files = (await readdir(this.turnsDir)).filter((f) => f.endsWith(".json"));
        }
        catch (err) {
            throw new SessionStoreError("IO_ERROR", `list turns failed: ${String(err)}`);
        }
        const turns = [];
        for (const file of files) {
            const rec = await this.readJson(path.join(this.turnsDir, file));
            if (rec?.turn?.sessionId === sessionId)
                turns.push(rec.turn);
        }
        turns.sort((a, b) => a.startedAt - b.startedAt);
        return turns;
    }
    // ---- SessionStore: messages ----------------------------------------------
    async appendMessage(message) {
        assertSafeId(message.id, "message");
        assertSafeId(message.sessionId, "session");
        if (message.turnId !== undefined)
            assertSafeId(message.turnId, "turn");
        await this.ensureDirs();
        const session = await this.readSessionDoc(message.sessionId);
        if (!session) {
            throw new SessionStoreError("UNKNOWN_SESSION", `cannot append message for unknown session ${message.sessionId}`);
        }
        await this.appendJsonLine(this.messageFile(message.sessionId), { message });
    }
    async listMessages(sessionId) {
        assertSafeId(sessionId, "session");
        return this.readMessages(sessionId);
    }
    async listMessagesByTurn(sessionId, turnId) {
        assertSafeId(sessionId, "session");
        assertSafeId(turnId, "turn");
        const all = await this.listMessages(sessionId);
        return all.filter((m) => m.turnId === turnId);
    }
    // ---- SessionStore: state snapshots ---------------------------------------
    async saveStateSnapshot(sessionId, snapshot) {
        assertSafeId(sessionId, "session");
        await this.ensureDirs();
        const session = await this.readSessionDoc(sessionId);
        if (!session) {
            throw new SessionStoreError("UNKNOWN_SESSION", `cannot save snapshot for unknown session ${sessionId}`);
        }
        await this.writeJsonAtomic(this.stateFile(sessionId), { snapshot });
    }
    async loadStateSnapshot(sessionId) {
        assertSafeId(sessionId, "session");
        const rec = await this.readJson(this.stateFile(sessionId));
        return rec?.snapshot;
    }
    // ---- archive (extra capability used by SessionService.archive) ------------
    /**
     * Move every on-disk artifact of a session into dataDir/archive/<sessionId>.
     * Returns the archive directory path. After archiving, getSession/getTurn/
     * listTurns for that session return nothing (fail-closed).
     */
    async archiveSession(id) {
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
        let files;
        try {
            files = (await readdir(this.turnsDir)).filter((f) => f.endsWith(".json"));
        }
        catch (err) {
            throw new SessionStoreError("IO_ERROR", `archive scan failed: ${String(err)}`);
        }
        for (const file of files) {
            const rec = await this.readJson(path.join(this.turnsDir, file));
            if (rec?.turn?.sessionId !== id)
                continue;
            await mkdir(turnsDest, { recursive: true });
            await this.moveIfExists(path.join(this.turnsDir, file), path.join(turnsDest, file));
        }
        return { archivedPath: destDir };
    }
    /**
     * P2-35 backup: copy the whole session store (sessions/turns/messages/state
     * and their archives) to `<dataDir>/backups/<stamp>/`, excluding temp files
     * and the `backups` directory itself. Use it before destructive ops or as a
     * scheduled integrity checkpoint.
     */
    async backup(opts = {}) {
        await this.ensureDirs();
        return backupTree(this.dataDir, { now: opts.now });
    }
}
//# sourceMappingURL=session-store.js.map