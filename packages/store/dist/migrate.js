import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
const SESSION_SCHEMA_VERSION = 1;
function parseRecord(raw, label) {
    if (typeof raw !== "object" || raw === null) {
        throw new Error(`migrate: corrupt ${label}: not an object`);
    }
    return raw;
}
async function readDirSafe(dir) {
    try {
        return await readdir(dir);
    }
    catch {
        return [];
    }
}
async function readJsonFile(file) {
    try {
        const raw = await readFile(file, "utf8");
        return JSON.parse(raw);
    }
    catch (err) {
        if (err.code === "ENOENT")
            return undefined;
        throw new Error(`migrate: cannot read ${file}: ${String(err)}`);
    }
}
/**
 * Migrate a JSONL source layout into a SqliteRuntimeStore. When `dryRun` is
 * true the target is never written (pass a store you can discard, or rely on
 * the target being created lazily — events/sessions are only inserted when
 * not dry-running).
 */
export async function migrateJsonlToSqlite(input) {
    const { source, target, dryRun } = input;
    const counts = { sessions: 0, turns: 0, messages: 0, states: 0, events: 0 };
    let allSourcesClean = true;
    // --- sessions ------------------------------------------------------------
    for (const file of await readDirSafe(join(source.sessionDataDir, "sessions"))) {
        if (!file.endsWith(".json"))
            continue;
        const rec = await readJsonFile(join(source.sessionDataDir, "sessions", file));
        if (rec === undefined || rec.session === undefined) {
            allSourcesClean = false;
            continue;
        }
        counts.sessions += 1;
        if (!dryRun && (await target.getSession(rec.session.id)) === undefined) {
            await target.createSession(rec.session);
        }
    }
    // --- turns ---------------------------------------------------------------
    for (const file of await readDirSafe(join(source.sessionDataDir, "turns"))) {
        if (!file.endsWith(".json"))
            continue;
        const rec = await readJsonFile(join(source.sessionDataDir, "turns", file));
        if (rec === undefined || rec.turn === undefined) {
            allSourcesClean = false;
            continue;
        }
        counts.turns += 1;
        if (!dryRun && (await target.getTurn(rec.turn.id)) === undefined) {
            await target.createTurn(rec.turn);
        }
    }
    // --- messages ------------------------------------------------------------
    for (const file of await readDirSafe(join(source.sessionDataDir, "messages"))) {
        if (!file.endsWith(".jsonl"))
            continue;
        const sessionId = file.replace(/\.jsonl$/, "");
        let raw;
        try {
            raw = await readFile(join(source.sessionDataDir, "messages", file), "utf8");
        }
        catch {
            allSourcesClean = false;
            continue;
        }
        for (const line of raw.split("\n")) {
            if (line.trim() === "")
                continue;
            let rec;
            try {
                rec = parseRecord(JSON.parse(line), "message line");
            }
            catch {
                allSourcesClean = false;
                continue;
            }
            if (rec.message === undefined) {
                allSourcesClean = false;
                continue;
            }
            counts.messages += 1;
            if (!dryRun) {
                const existing = await target.listMessages(sessionId);
                if (!existing.some((m) => m.id === rec.message.id)) {
                    await target.appendMessage(rec.message);
                }
            }
        }
    }
    // --- state snapshots -----------------------------------------------------
    for (const file of await readDirSafe(join(source.sessionDataDir, "state"))) {
        if (!file.endsWith(".json"))
            continue;
        const sessionId = file.replace(/\.json$/, "");
        const rec = await readJsonFile(join(source.sessionDataDir, "state", file));
        if (rec === undefined) {
            allSourcesClean = false;
            continue;
        }
        counts.states += 1;
        if (!dryRun && (await target.loadStateSnapshot(sessionId)) === undefined) {
            const { schemaVersion: _ignored, ...snapshot } = rec;
            await target.saveStateSnapshot(sessionId, snapshot);
        }
    }
    // --- events (order per file preserves sequence order) ---------------------
    for (const file of await readDirSafe(source.eventDataDir)) {
        if (!file.endsWith(".jsonl"))
            continue;
        const sessionId = file.replace(/\.jsonl$/, "");
        let raw;
        try {
            raw = await readFile(join(source.eventDataDir, file), "utf8");
        }
        catch {
            allSourcesClean = false;
            continue;
        }
        for (const line of raw.split("\n")) {
            if (line.trim() === "")
                continue;
            let event;
            try {
                const rec = parseRecord(JSON.parse(line), "event line");
                if (rec.event === undefined)
                    throw new Error("no event field");
                event = rec.event;
            }
            catch {
                allSourcesClean = false;
                continue;
            }
            counts.events += 1;
            if (!dryRun) {
                try {
                    await target.append({ ...event, sessionId: sessionId });
                }
                catch {
                    // duplicate id — already migrated, keep counting (idempotent)
                }
            }
        }
    }
    void SESSION_SCHEMA_VERSION;
    return { ...counts, dryRun: dryRun ?? false, allSourcesClean };
}
//# sourceMappingURL=migrate.js.map