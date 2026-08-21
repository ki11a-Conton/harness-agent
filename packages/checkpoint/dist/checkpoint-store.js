import { mkdir, readFile, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { CHECKPOINT_SCHEMA_VERSION, computeCheckpointChecksum, } from "@ar/contracts";
import { atomicWriteFile } from "@ar/store-integrity";
export class CheckpointStoreError extends Error {
    code;
    constructor(code, message) {
        super(message);
        this.name = "CheckpointStoreError";
        this.code = code;
    }
}
const LATEST_FILE = "latest.json";
const SAFE_ID = /^[A-Za-z0-9_-]+$/;
function assertSafeId(id) {
    if (id.length === 0 || !SAFE_ID.test(id)) {
        throw new CheckpointStoreError("UNSAFE_ID", `unsafe session id ${JSON.stringify(id)}: must match [A-Za-z0-9_-]+`);
    }
}
function isNodeError(err, code) {
    return err instanceof Error && "code" in err && err.code === code;
}
function parseCheckpoint(raw, label) {
    let parsed;
    try {
        parsed = JSON.parse(raw);
    }
    catch {
        return undefined;
    }
    if (typeof parsed !== "object" || parsed === null)
        return undefined;
    const record = parsed;
    if (record.schemaVersion !== CHECKPOINT_SCHEMA_VERSION)
        return undefined;
    const checkpoint = record;
    if (typeof checkpoint.checksum !== "string")
        return undefined;
    const { checksum: _sentinel, ...payload } = checkpoint;
    if (computeCheckpointChecksum(payload) !== checkpoint.checksum)
        return undefined;
    return checkpoint;
}
export class DurableCheckpointStore {
    root;
    constructor(opts) {
        this.root = resolve(opts.dataDir);
    }
    sessionDir(sessionId) {
        return join(this.root, "checkpoints", sessionId);
    }
    checkpointFile(sessionId, checkpointId) {
        return join(this.sessionDir(sessionId), `${checkpointId}.json`);
    }
    latestFile(sessionId) {
        return join(this.sessionDir(sessionId), LATEST_FILE);
    }
    async readValidated(file) {
        let raw;
        try {
            raw = await readFile(file, "utf8");
        }
        catch (err) {
            if (isNodeError(err, "ENOENT"))
                return undefined;
            throw new CheckpointStoreError("IO_ERROR", `read failed for ${file}: ${String(err)}`);
        }
        return parseCheckpoint(raw, file);
    }
    async writeAtomic(file, checkpoint) {
        // P2-35: durable atomic write (temp + fsync + rename over target) via the
        // shared primitive. The previous rm(target) before rename opened a window
        // where the target was momentarily absent; rename-over is atomic.
        try {
            await atomicWriteFile(file, JSON.stringify(checkpoint, null, 2));
        }
        catch (err) {
            throw new CheckpointStoreError("IO_ERROR", `write failed for ${file}: ${String(err)}`);
        }
    }
    async save(checkpoint) {
        if (checkpoint.schemaVersion !== CHECKPOINT_SCHEMA_VERSION) {
            throw new CheckpointStoreError("UNSUPPORTED_SCHEMA", `unsupported checkpoint schemaVersion ${String(checkpoint.schemaVersion)}`);
        }
        assertSafeId(checkpoint.sessionId);
        // Integrity gate BEFORE writing: reject a checkpoint whose checksum does
        // not match its payload (host build bug or mid-flight tampering).
        const { checksum: sentinel, ...payload } = checkpoint;
        if (computeCheckpointChecksum(payload) !== checkpoint.checksum) {
            throw new CheckpointStoreError("CORRUPT_RECORD", `checkpoint ${checkpoint.checkpointId} checksum mismatch before write`);
        }
        const dir = this.sessionDir(checkpoint.sessionId);
        const file = this.checkpointFile(checkpoint.sessionId, checkpoint.checkpointId);
        await mkdir(dir, { recursive: true });
        await this.writeAtomic(file, checkpoint);
        // Verify-by-read: only a checkpoint that parses AND validates may become
        // the latest pointer. A torn write leaves latest.json untouched, so the
        // last good checkpoint always survives.
        const verified = await this.readValidated(file);
        if (verified === undefined) {
            throw new CheckpointStoreError("CORRUPT_RECORD", `checkpoint ${checkpoint.checkpointId} did not validate on read-back; latest pointer left untouched`);
        }
        await this.writeAtomic(this.latestFile(checkpoint.sessionId), verified);
    }
    async loadLatest(sessionId) {
        assertSafeId(sessionId);
        const latest = await this.readValidated(this.latestFile(sessionId));
        if (latest !== undefined)
            return latest;
        // latest.json missing/corrupt: fall back to the newest valid checkpoint
        // in the session directory.
        const dir = this.sessionDir(sessionId);
        let entries;
        try {
            entries = await readdir(dir);
        }
        catch (err) {
            if (isNodeError(err, "ENOENT"))
                return undefined;
            throw new CheckpointStoreError("IO_ERROR", `list failed for ${dir}: ${String(err)}`);
        }
        const candidates = [];
        for (const entry of entries) {
            if (entry === LATEST_FILE || !entry.endsWith(".json"))
                continue;
            const checkpoint = await this.readValidated(join(dir, entry));
            if (checkpoint !== undefined)
                candidates.push({ checkpoint, file: entry });
        }
        if (candidates.length === 0)
            return undefined;
        candidates.sort((a, b) => b.checkpoint.createdAt - a.checkpoint.createdAt);
        return candidates[0].checkpoint;
    }
    async list(sessionId) {
        assertSafeId(sessionId);
        const dir = this.sessionDir(sessionId);
        let entries;
        try {
            entries = await readdir(dir);
        }
        catch (err) {
            if (isNodeError(err, "ENOENT"))
                return [];
            throw new CheckpointStoreError("IO_ERROR", `list failed for ${dir}: ${String(err)}`);
        }
        const checkpoints = [];
        for (const entry of entries) {
            if (entry === LATEST_FILE || !entry.endsWith(".json"))
                continue;
            const checkpoint = await this.readValidated(join(dir, entry));
            if (checkpoint !== undefined)
                checkpoints.push(checkpoint);
        }
        checkpoints.sort((a, b) => b.createdAt - a.createdAt);
        return checkpoints;
    }
}
//# sourceMappingURL=checkpoint-store.js.map