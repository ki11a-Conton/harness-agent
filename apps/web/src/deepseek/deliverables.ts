import { atomicReplace } from "@ar/store-integrity";
import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, readdir, realpath, unlink, type FileHandle } from "node:fs/promises";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { z } from "zod";
import { newEventId, type AgentEvent, type SessionId, type ToolDefinition, type ToolResult } from "@ar/contracts";
import { detectSecrets } from "@ar/security";
import { strToU8, zipSync } from "fflate";
import { compareText, type WorkspaceDiffHunk } from "./change-compare.js";
import { confinedPath, exact, inside, integer, record, requireFileSession, text, toolValue, WorkspaceRemoteError } from "./files.js";
import type { WorkspaceHost } from "./workspace.js";

const MAX_CAPTURE_FILES = 2_000, MAX_CAPTURE_BYTES = 32 * 1024 * 1024, MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_UPLOAD_BYTES = 4 * 1024 * 1024, MAX_PROMPT_FILE_BYTES = 48 * 1024;
const forbiddenName = /^(?:\.env(?:\..*)?|id_(?:rsa|dsa|ecdsa|ed25519)|credentials(?:\..*)?|.*\.(?:pem|key|p12|pfx))$/i;
const ignoredDirectory = new Set([".git", "node_modules", ".aws", ".ssh", ".gnupg"]);
interface CapturedFile { hash: string; text?: string; binary?: true; oversized?: true }
interface Capture { files: Record<string, CapturedFile> }
export interface ChangedFile { path: string; display: string; added: number; deleted: number; binary?: true; oversized?: true }
export interface ChangesSummary { turn: number; files: ChangedFile[]; total: number; added: number; deleted: number }
export type FileDiff = { kind: "text"; path: string; display: string; before: boolean; after: boolean; hunks: WorkspaceDiffHunk[]; coarse: boolean }
  | { kind: "binary" | "oversized"; path: string; display: string };
export interface FileUploadValue { receiptId: string; file: { attachmentId: string; name: string; bytes: number } }
export interface ResolvedUpload extends FileUploadValue { text: string }
interface StoredUpload extends FileUploadValue { sessionId: string; data: string }
export interface DeliverablesHost extends WorkspaceHost {
  sourceSequence?(sessionId: string, wireSequence: number, signal: AbortSignal): Promise<number | undefined>;
  withSessionLock?<T>(sessionId: string, action: () => Promise<T>): Promise<T>;
}
function errorResult(error: unknown, signal: AbortSignal): ToolResult {
  return { status: signal.aborted ? "cancelled" : "failed", error: { code: "PROCESS_ERROR", message: error instanceof Error ? error.message : String(error), retryable: false, safeToRetry: false },
    metadata: { remoteCode: error instanceof WorkspaceRemoteError ? error.code : "gateway/internal" } };
}
function statHash(info: { dev: number; ino: number; size: number; mtimeMs: number; ctimeMs: number }): string {
  return createHash("sha256").update(`${info.dev}:${info.ino}:${info.size}:${info.mtimeMs}:${info.ctimeMs}`).digest("hex");
}
async function boundedRead(file: FileHandle, cap: number, signal: AbortSignal): Promise<Buffer> {
  const chunks: Buffer[] = []; let bytes = 0;
  while (bytes <= cap) {
    signal.throwIfAborted();
    const chunk = Buffer.alloc(Math.min(64 * 1024, cap + 1 - bytes));
    const read = await file.read(chunk, 0, chunk.length, bytes);
    if (read.bytesRead === 0) return Buffer.concat(chunks, bytes);
    bytes += read.bytesRead; chunks.push(chunk.subarray(0, read.bytesRead));
  }
  throw new WorkspaceRemoteError("workspace-file/too-large", "File exceeded its bounded read cap");
}
function displayName(value: unknown): string {
  if (value === undefined) return "upload.bin";
  const name = text(value, "name").replaceAll("\\", "/").split("/").at(-1)!.replace(/[\x00-\x1f\x7f<>:"|?*]/g, "_").slice(0, 200).trim();
  if (!name || name === "." || name === "..") throw new WorkspaceRemoteError("session/attachment-invalid", "Upload filename is invalid");
  return name;
}
function decode(data: unknown): Buffer {
  if (typeof data !== "string" || data.length > Math.ceil(MAX_UPLOAD_BYTES / 3) * 4 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(data))
    throw new WorkspaceRemoteError("session/attachment-invalid", "Upload must be canonical bounded base64");
  const bytes = Buffer.from(data, "base64");
  if (bytes.toString("base64") !== data || bytes.length > MAX_UPLOAD_BYTES) throw new WorkspaceRemoteError("session/attachment-invalid", "Upload exceeds the byte limit");
  return bytes;
}

/** The real host keeps bounded turn-start/end captures, like the upstream live-Session recorder.
 * Historical sessions without captures return 404 instead of a comparison with today's files. */
export function createDeliverablesService(host: DeliverablesHost) {
  const starts = new Map<string, Capture>();
  const summaries = new Map<string, { summary: ChangesSummary; diffs: FileDiff[] }>();
  const memoryUploads = new Map<string, StoredUpload>();
  const endpoints = ["fileUploads/upload"];
  const captureSchema = z.object({ path: z.literal(".") }).strict();
  const captureTool: ToolDefinition = {
    name: "web_workspace_capture", description: "Capture bounded regular project files for truthful turn-start/end comparisons; never follow symlinks or expose credentials.",
    inputSchema: captureSchema, risk: "readonly", metadata: { name: "web_workspace_capture", version: "1.0.0", filesystem: true, process: false, network: false, sideEffect: false, interactive: false, retry: "safe", concurrencySafe: true },
    async execute(_input, context) {
      try {
        const { root } = await confinedPath(".", context);
        const files: Record<string, CapturedFile> = {};
        let fileCount = 0, totalBytes = 0;
        const ownedData = host.dataDir === undefined ? undefined : resolve(host.dataDir);
        async function walk(directory: string): Promise<void> {
          context.signal.throwIfAborted();
          const before = await lstat(directory);
          if (!before.isDirectory() || before.isSymbolicLink() || await realpath(directory) !== directory || !inside(root, directory))
            throw new WorkspaceRemoteError("workspace-file/outside-workspace", "Capture directory changed");
          for (const name of (await readdir(directory)).sort()) {
            context.signal.throwIfAborted();
            const path = resolve(directory, name);
            if (ownedData && path === ownedData && path !== root) continue;
            const info = await lstat(path);
            if (info.isSymbolicLink()) continue;
            if (info.isDirectory()) { if (!ignoredDirectory.has(name)) await walk(path); continue; }
            if (!info.isFile()) continue;
            if (++fileCount > MAX_CAPTURE_FILES) throw new WorkspaceRemoteError("workspace-file/too-large", "Workspace comparison exceeds its file-count cap");
            const key = relative(root, path).split(sep).join("/");
            if (forbiddenName.test(name) || info.size > MAX_FILE_BYTES) { files[key] = { hash: statHash(info), oversized: true }; continue; }
            totalBytes += info.size;
            if (totalBytes > MAX_CAPTURE_BYTES) throw new WorkspaceRemoteError("workspace-file/too-large", "Workspace comparison exceeds its total byte cap");
            const handle = await open(path, constants.O_RDONLY | (process.platform === "win32" ? 0 : constants.O_NOFOLLOW | constants.O_NONBLOCK));
            try {
              const opened = await handle.stat();
              if (!opened.isFile() || opened.dev !== info.dev || opened.ino !== info.ino || opened.size > MAX_FILE_BYTES || await realpath(path) !== path)
                throw new WorkspaceRemoteError("workspace-file/outside-workspace", "Capture file changed during resolution");
              const bytes = await boundedRead(handle, MAX_FILE_BYTES, context.signal);
              if (bytes.length > MAX_FILE_BYTES || bytes.length !== opened.size || statHash(opened) !== statHash(await handle.stat()))
                throw new WorkspaceRemoteError("workspace-file/too-large", "Capture file changed while being read");
              const hash = createHash("sha256").update(bytes).digest("hex");
              let decoded: string;
              try { decoded = new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
              catch { files[key] = { hash, binary: true }; continue; }
              if (detectSecrets(decoded).hasSecret) { files[key] = { hash, oversized: true }; continue; }
              files[key] = decoded.includes("\0") ? { hash, binary: true } : { hash, text: decoded };
            } finally { await handle.close(); }
          }
          const after = await lstat(directory);
          if (before.dev !== after.dev || before.ino !== after.ino || await realpath(directory) !== directory)
            throw new WorkspaceRemoteError("workspace-file/outside-workspace", "Capture directory changed while reading");
        }
        await walk(root);
        return { status: "success", output: { files } satisfies Capture };
      } catch (error) { return errorResult(error, context.signal); }
    },
  };
  host.registerTool?.(captureTool);

  function uploadPath(sessionId: string, receiptId: string): string {
    if (!/^[a-f0-9-]{36}$/.test(receiptId)) throw new WorkspaceRemoteError("session/attachment-invalid", "Invalid upload receipt");
    const owner = createHash("sha256").update(sessionId).digest("hex");
    return resolve(host.dataDir ?? host.cwd, "deepseek", "uploads", owner, `${receiptId}.json`);
  }
  const uploadSchema = z.object({ path: z.string(), operation: z.enum(["read", "write"]), sessionId: z.string(), receiptId: z.string(), data: z.string().optional(), name: z.string().optional() }).strict();
  function uploadTool(write: boolean): ToolDefinition {
    return { name: write ? "web_upload_write" : "web_upload_read", description: "Read or commit one bounded Session-owned file receipt at its server-minted host path.",
      inputSchema: uploadSchema, risk: write ? "side_effect" : "readonly", metadata: { name: write ? "web_upload_write" : "web_upload_read", version: "1.0.0", filesystem: true, process: false, network: false, sideEffect: write, interactive: false, retry: "safe" },
      async execute(raw, context) {
        const input = uploadSchema.parse(raw);
        try {
          if (input.path !== uploadPath(input.sessionId, input.receiptId) || input.operation !== (write ? "write" : "read")) throw new WorkspaceRemoteError("gateway/forbidden", "Receipt path or operation was not minted by its owner");
          context.signal.throwIfAborted();
          if (write) {
            const bytes = decode(input.data);
            if (detectSecrets(bytes.toString("utf8")).hasSecret) throw new WorkspaceRemoteError("gateway/forbidden", "Upload contains protected credentials");
            const stored: StoredUpload = { sessionId: input.sessionId, receiptId: input.receiptId, file: { attachmentId: createHash("sha256").update(bytes).digest("hex"), name: displayName(input.name), bytes: bytes.length }, data: bytes.toString("base64") };
            if (host.dataDir === undefined) memoryUploads.set(input.receiptId, stored);
            else {
              const root = await realpath(host.dataDir), directory = dirname(input.path);
              await mkdir(directory, { recursive: true, mode: 0o700 });
              const expected = join(root, "deepseek", "uploads", createHash("sha256").update(input.sessionId).digest("hex"));
              const same = (actual: string) => process.platform === "win32" ? actual.toLowerCase() === expected.toLowerCase() : actual === expected;
              if (!inside(root, await realpath(directory)) || !same(await realpath(directory))) throw new WorkspaceRemoteError("gateway/forbidden", "Upload directory is a symlink or outside its host root");
              const temporary = `${input.path}.${randomUUID()}.tmp`;
              try {
                const file = await open(temporary, "wx", 0o600);
                try { await file.writeFile(JSON.stringify(stored)); await file.sync(); } finally { await file.close(); }
                context.signal.throwIfAborted();
                if (!same(await realpath(directory))) throw new WorkspaceRemoteError("gateway/forbidden", "Upload directory changed");
                await atomicReplace(temporary, input.path, context.signal);
              } finally { await unlink(temporary).catch(error => { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }); }
            }
            return { status: "success", output: { receiptId: stored.receiptId, file: stored.file } satisfies FileUploadValue };
          }
          let stored: StoredUpload | undefined;
          if (host.dataDir === undefined) stored = memoryUploads.get(input.receiptId);
          else {
            const root = await realpath(host.dataDir), directory = dirname(input.path);
            const expected = join(root, "deepseek", "uploads", createHash("sha256").update(input.sessionId).digest("hex"));
            const same = (a: string, b: string) => process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
            if (!inside(root, await realpath(directory)) || !same(await realpath(directory), expected)) throw new WorkspaceRemoteError("gateway/forbidden", "Upload directory is outside its host root");
            const expectedFile = join(expected, basename(input.path));
            if ((await lstat(input.path)).isSymbolicLink()) throw new WorkspaceRemoteError("gateway/forbidden", "Upload receipt is a symlink");
            const file = await open(input.path, constants.O_RDONLY | (process.platform === "win32" ? 0 : constants.O_NOFOLLOW | constants.O_NONBLOCK));
            try {
              const info = await file.stat();
              if (!info.isFile() || info.nlink !== 1 || info.size > MAX_UPLOAD_BYTES * 2 || !same(await realpath(input.path), expectedFile)) throw new WorkspaceRemoteError("session/attachment-invalid", "Invalid upload receipt file");
              const bytes = await boundedRead(file, MAX_UPLOAD_BYTES * 2, context.signal), current = await file.stat();
              if (statHash(info) !== statHash(current) || bytes.length !== info.size || !same(await realpath(input.path), expectedFile)) throw new WorkspaceRemoteError("session/attachment-invalid", "Upload receipt changed during reading");
              stored = JSON.parse(bytes.toString("utf8")) as StoredUpload;
            }
            finally { await file.close(); }
          }
          if (!stored || stored.sessionId !== input.sessionId || stored.receiptId !== input.receiptId) throw new WorkspaceRemoteError("session/attachment-invalid", "File was not uploaded for this Session");
          const bytes = decode(stored.data), details = record(stored.file);
          if (details.bytes !== bytes.length || details.attachmentId !== createHash("sha256").update(bytes).digest("hex") || typeof details.name !== "string") throw new WorkspaceRemoteError("session/attachment-invalid", "Upload receipt integrity failed");
          return { status: "success", output: stored };
        } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return errorResult(new WorkspaceRemoteError("session/attachment-invalid", "File was not uploaded for this Session"), context.signal); return errorResult(error, context.signal); }
      } };
  }
  async function executeUpload(sessionId: string, definition: ToolDefinition, args: Record<string, unknown>, signal: AbortSignal): Promise<unknown> {
    if (!host.executeHostTool) throw new WorkspaceRemoteError("gateway/unavailable", "Controlled upload executor is unavailable");
    const result = await host.executeHostTool(sessionId, definition, args, signal);
    if (result.status !== "success") throw new WorkspaceRemoteError(String(result.metadata?.remoteCode ?? (result.status === "denied" ? "gateway/forbidden" : result.status === "cancelled" ? "gateway/cancelled" : "gateway/internal")), result.error?.message ?? "Upload receipt operation failed");
    return result.output;
  }
  async function upload(sessionId: string, data: string, name: unknown, signal: AbortSignal): Promise<FileUploadValue> {
    const commit = async (): Promise<FileUploadValue> => {
      signal.throwIfAborted(); await requireFileSession(host, sessionId); const receiptId = randomUUID();
      return await executeUpload(sessionId, uploadTool(true), { path: uploadPath(sessionId, receiptId), operation: "write", sessionId, receiptId, data, name: displayName(name) }, signal) as FileUploadValue;
    };
    return host.withSessionLock === undefined ? commit() : host.withSessionLock(sessionId, commit);
  }
  async function resolveUpload(sessionId: string, receiptId: string, signal: AbortSignal): Promise<ResolvedUpload> {
    await requireFileSession(host, sessionId);
    const stored = await executeUpload(sessionId, uploadTool(false), { path: uploadPath(sessionId, receiptId), operation: "read", sessionId, receiptId }, signal) as StoredUpload;
    const bytes = decode(stored.data);
    if (bytes.length > MAX_PROMPT_FILE_BYTES) throw new WorkspaceRemoteError("session/attachment-invalid", "This model-text admission accepts uploaded files up to 48 KiB; larger files remain staged without being sent");
    let content: string;
    try { content = new TextDecoder("utf-8", { fatal: true }).decode(bytes); } catch { throw new WorkspaceRemoteError("session/attachment-invalid", "This model-text admission supports UTF-8 files; binary attachments require a native attachment model adapter"); }
    if (content.includes("\0") || detectSecrets(content).hasSecret) throw new WorkspaceRemoteError("session/attachment-invalid", "Uploaded file is binary or contains protected credentials");
    return { receiptId, file: stored.file, text: content };
  }
  async function observe(event: AgentEvent): Promise<void> {
    if (event.payload.hostOnly === true || event.turnId === undefined || !["turn.started", "turn.completed", "turn.failed", "turn.cancelled"].includes(event.type)) return;
    const session = await requireFileSession(host, event.sessionId);
    // Descendant turns own their own files and are never attributed to their parent.
    if (session.parentId !== undefined) return;
    const signal = new AbortController().signal, key = `${event.sessionId}/${event.turnId}`;
    try {
      const snapshot = await toolValue(host, event.sessionId, captureTool.name, { path: "." }, signal) as Capture;
      if (event.type === "turn.started") { starts.set(key, snapshot); return; }
      const before = starts.get(key); starts.delete(key);
      if (!before) return;
      const files: ChangedFile[] = [], diffs: FileDiff[] = [];
      for (const path of [...new Set([...Object.keys(before.files), ...Object.keys(snapshot.files)])].sort()) {
        const old = before.files[path], next = snapshot.files[path];
        if (old?.hash === next?.hash) continue;
        if (old?.oversized || next?.oversized) { files.push({ path, display: path, added: 0, deleted: 0, oversized: true }); diffs.push({ kind: "oversized", path, display: path }); continue; }
        if (old?.binary || next?.binary) { files.push({ path, display: path, added: 0, deleted: 0, binary: true }); diffs.push({ kind: "binary", path, display: path }); continue; }
        const compared = compareText(old?.text ?? null, next?.text ?? null, 100);
        files.push({ path, display: path, added: compared.added, deleted: compared.deleted });
        diffs.push({ kind: "text", path, display: path, before: old !== undefined, after: next !== undefined, hunks: compared.hunks, coarse: compared.coarse });
      }
      if (!files.length) return;
      const turns = await host.harness.store.listTurns(session.id);
      const turn = turns.sort((a, b) => a.startedAt - b.startedAt || a.id.localeCompare(b.id)).findIndex(item => item.id === event.turnId) + 1;
      if (turn < 1) throw new WorkspaceRemoteError("gateway/internal", "Workspace change turn identity is missing");
      const summary: ChangesSummary = { turn, files, total: files.length, added: files.reduce((sum, file) => sum + file.added, 0), deleted: files.reduce((sum, file) => sum + file.deleted, 0) };
      const id = newEventId(), captured = { summary, diffs };
      // Publish the immutable backing value before the durable announcement can
      // become visible to a follower. The browser caches a single 404 forever.
      summaries.set(`${event.sessionId}/${id}`, captured);
      try {
        const announcement = await host.harness.events.appendNew({ id, sessionId: event.sessionId, turnId: event.turnId, timestamp: Date.now(), type: "tool.completed",
          payload: { tool: "web_workspace_changes", sourceSequence: event.sequence, turn, summary, hostOnly: true, derived: true, status: "success" } });
        summaries.set(`${event.sessionId}/${announcement.sequence}`, captured);
      } catch (error) { summaries.delete(`${event.sessionId}/${id}`); throw error; }
    } catch (error) {
      starts.delete(key);
      // Capture is an additional UI observer, not authority to fail a completed coding turn.
      console.error("Web workspace comparison unavailable", event.sessionId, event.turnId, error instanceof Error ? error.message : String(error));
    }
  }
  const summary = (sessionId: string, sourceSequence: number) => summaries.get(`${sessionId}/${sourceSequence}`)?.summary;
  const diff = async (sessionId: string, sourceSequence: number, index: number, signal: AbortSignal) => { signal.throwIfAborted(); return summaries.get(`${sessionId}/${sourceSequence}`)?.diffs[index]; };
  async function addressedCapture(sessionId: string, sourceSequence: number, signal: AbortSignal) {
    signal.throwIfAborted();
    const captured = summaries.get(`${sessionId}/${sourceSequence}`);
    if (captured) return captured;
    const source = (await host.harness.events.list(sessionId as SessionId, { afterSequence: sourceSequence - 1, limit: 1 }))[0];
    signal.throwIfAborted();
    return source?.sequence === sourceSequence ? summaries.get(`${sessionId}/${source.id}`) : undefined;
  }
  async function coordinates(request: Request): Promise<{ sessionId: string; sourceSequence: number; index?: number }> {
    const query = new URL(request.url).searchParams;
    for (const name of query.keys()) if (query.getAll(name).length !== 1 || !["sessionId", "seq", "index", "action", "application"].includes(name)) throw new WorkspaceRemoteError("gateway/bad-request", "Invalid file coordinates");
    const sessionId = text(query.get("sessionId"), "sessionId"); await requireFileSession(host, sessionId);
    const number = (name: string) => { const value = query.get(name); if (value === null || !/^\d+$/.test(value)) throw new WorkspaceRemoteError("gateway/bad-request", `Invalid ${name}`); return integer(Number(value), name, 0); };
    const wire = number("seq"), sourceSequence = host.sourceSequence ? await host.sourceSequence(sessionId, wire, request.signal) : wire;
    if (sourceSequence === undefined) throw new WorkspaceRemoteError("workspace-file/not-found", "No event owns those file coordinates");
    return { sessionId, sourceSequence, ...(query.has("index") ? { index: number("index") } : {}) };
  }
  async function exportSession(request: Request): Promise<Response> {
    const query = new URL(request.url).searchParams, sessionId = text(query.get("sessionId"), "sessionId");
    for (const name of query.keys()) if (query.getAll(name).length !== 1 || !["sessionId", "includeDescendants"].includes(name)) throw new WorkspaceRemoteError("gateway/bad-request", "Invalid export arguments");
    const descendants = query.get("includeDescendants"); if (descendants !== null && descendants !== "true" && descendants !== "false") throw new WorkspaceRemoteError("gateway/bad-request", "Invalid descendant option");
    await requireFileSession(host, sessionId);
    const sessions = await host.harness.store.listSessions(), owned = new Set([sessionId]);
    if (descendants === "true") { let changed = true; while (changed) { changed = false; for (const session of sessions) if (session.parentId && owned.has(session.parentId) && !owned.has(session.id)) { owned.add(session.id); changed = true; } } }
    const archive: Record<string, Uint8Array> = {}; let bytes = 0;
    const put = (name: string, value: unknown) => { const data = strToU8(JSON.stringify(value, null, 2)); bytes += data.length; if (bytes > MAX_CAPTURE_BYTES) throw new WorkspaceRemoteError("workspace-file/too-large", "Session export exceeds 32 MiB"); archive[name] = data; };
    for (const id of owned) {
      request.signal.throwIfAborted(); const current = await requireFileSession(host, id);
      const directory = `sessions/${createHash("sha256").update(id).digest("hex")}`;
      put(`${directory}/session.json`, current); put(`${directory}/messages.json`, await host.harness.store.listMessages(id as SessionId)); put(`${directory}/events.json`, await host.harness.events.list(id as SessionId)); put(`${directory}/turns.json`, await host.harness.store.listTurns(id as SessionId));
    }
    put("manifest.json", { format: "harness-agent-session-export", version: 1, sessionId, includeDescendants: descendants === "true", sessionIds: [...owned] });
    request.signal.throwIfAborted();
    const content = zipSync(archive, { level: 6 });
    return new Response(request.method === "HEAD" ? null : content, { headers: { "content-type": "application/zip", "content-length": String(content.length), "content-disposition": `attachment; filename="harness-session-${createHash("sha256").update(sessionId).digest("hex").slice(0, 12)}.zip"`, "cache-control": "no-store" } });
  }
  async function fetch(request: Request): Promise<Response | undefined> {
    const url = new URL(request.url), path = url.pathname;
    if (!["/api/changes.summary", "/api/changes.diff", "/api/changes.open", "/api/present.open", "/api/present.host", "/api/session/uploadFileBinary", "/api/session.export"].includes(path)) return undefined;
    const allowed = path === "/api/session/uploadFileBinary" ? ["POST"] : path === "/api/session.export" ? ["GET", "HEAD"] : path.endsWith(".open") ? ["GET", "POST"] : ["GET"];
    if (!allowed.includes(request.method)) return new Response(null, { status: 405, headers: { allow: allowed.join(", ") } });
    try {
      request.signal.throwIfAborted();
      if (path === "/api/present.host") return Response.json({ name: "Harness host", available: false, fileManager: null }, { headers: { "cache-control": "no-store" } });
      if (path === "/api/session.export") return await exportSession(request);
      if (path === "/api/session/uploadFileBinary") {
        if (request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() !== "application/octet-stream") return new Response("Expected application/octet-stream", { status: 415 });
        const sessionId = text(url.searchParams.get("sessionId"), "sessionId"); await requireFileSession(host, sessionId);
        const length = request.headers.get("content-length"); if (length !== null && (!/^\d+$/.test(length) || Number(length) > MAX_UPLOAD_BYTES)) throw new WorkspaceRemoteError("session/attachment-invalid", "Upload exceeds 4 MiB");
        const chunks: Uint8Array[] = []; let bytes = 0; const reader = request.body?.getReader();
        if (reader) try { while (true) { request.signal.throwIfAborted(); const item = await reader.read(); if (item.done) break; bytes += item.value.byteLength; if (bytes > MAX_UPLOAD_BYTES) { await reader.cancel(); throw new WorkspaceRemoteError("session/attachment-invalid", "Upload exceeds 4 MiB"); } chunks.push(item.value); } } finally { reader.releaseLock(); }
        const value = await upload(sessionId, Buffer.concat(chunks).toString("base64"), url.searchParams.get("name") ?? undefined, request.signal);
        return Response.json({ ok: true, value }, { headers: { "cache-control": "no-store" } });
      }
      const target = await coordinates(request);
      if (path.endsWith(".open")) {
        const action = url.searchParams.get("action") ?? "open"; if (action !== "open" && action !== "reveal") throw new WorkspaceRemoteError("gateway/bad-request", "Invalid file action");
        // A headless Web host has no verified native desktop opener. An authenticated path cannot manufacture that capability.
        return new Response("Host desktop unavailable.", { status: 409, headers: { "cache-control": "no-store" } });
      }
      const captured = await addressedCapture(target.sessionId, target.sourceSequence, request.signal);
      const value = path === "/api/changes.summary" ? captured?.summary
        : target.index === undefined ? undefined : captured?.diffs[target.index];
      return value === undefined ? new Response("Workspace comparison unavailable.", { status: 404 }) : Response.json(value, { headers: { "cache-control": "no-store" } });
    } catch (error) {
      const failure = error instanceof WorkspaceRemoteError ? error : new WorkspaceRemoteError(request.signal.aborted ? "gateway/cancelled" : "gateway/internal", request.signal.aborted ? "Request was cancelled" : "Host file operation failed");
      if (path === "/api/session/uploadFileBinary") return Response.json({ ok: false, error: { code: failure.code, message: failure.message, details: failure.details } }, { headers: { "cache-control": "no-store" } });
      return new Response(failure.message, { status: failure.code === "gateway/bad-request" ? 400 : failure.code === "gateway/forbidden" ? 403 : failure.code === "session/not-found" || failure.code === "workspace-file/not-found" ? 404 : failure.code === "gateway/cancelled" ? 499 : 500, headers: { "cache-control": "no-store" } });
    }
  }
  return { endpoints, tools: [captureTool], fetch, observe, summary, diff, coordinates, resolveUpload,
    async call(endpoint: string, args: unknown, signal: AbortSignal): Promise<unknown> {
      if (endpoint !== "fileUploads/upload") throw new WorkspaceRemoteError("gateway/not-found", "Unknown upload endpoint");
      const input = exact(args, ["agentId", "request"]), request = exact(input.request, ["data", "name"], ["data"]);
      return upload(text(input.agentId, "agentId"), request.data as string, request.name, signal);
    }, dispose() { starts.clear(); summaries.clear(); memoryUploads.clear(); } };
}
