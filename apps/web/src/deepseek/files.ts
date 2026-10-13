import { constants } from "node:fs";
import { lstat, open, readdir, realpath, stat, mkdir } from "node:fs/promises";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { z } from "zod";
import type { Session, SessionId, ToolDefinition, ToolExecutionContext, ToolResult } from "@ar/contracts";
import { detectSecrets } from "@ar/security";

/** All OS filesystem calls in this module occur inside these private tools. */
export class WorkspaceRemoteError extends Error {
  constructor(readonly code: string, message: string, readonly details: Record<string, unknown> = {}) { super(message); }
}
export interface WorkspaceFileHost {
  cwd: string;
  executeTool(sessionId: string | undefined, name: string, args: Record<string, unknown>, signal: AbortSignal): Promise<unknown>;
  harness: { store: { getSession(id: SessionId): Promise<Session | undefined> } };
  /** One bounded sample shares the owner's draft switch/admission lock. */
  withSessionLock?<T>(sessionId: string, action: () => Promise<T>): Promise<T>;
}
export function record(value: unknown, label = "arguments"): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new WorkspaceRemoteError("gateway/bad-request", `${label} must be an object`);
  return value as Record<string, unknown>;
}
export function exact(value: unknown, keys: readonly string[], required: readonly string[] = keys): Record<string, unknown> {
  const result = record(value);
  if (Object.keys(result).some(key => !keys.includes(key)) || required.some(key => result[key] === undefined)) throw new WorkspaceRemoteError("gateway/bad-request", "Unexpected or missing arguments");
  return result;
}
export function text(value: unknown, name: string, allowEmpty = false): string {
  if (typeof value !== "string" || (!allowEmpty && value.trim() === "") || value.length > 32768 || /[\x00-\x1f]/.test(value)) throw new WorkspaceRemoteError("gateway/bad-request", `${name} must be a valid string`);
  return value;
}
export function integer(value: unknown, name: string, minimum: number, maximum = Number.MAX_SAFE_INTEGER): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum || value > maximum) throw new WorkspaceRemoteError("gateway/bad-request", `${name} is out of range`);
  return value;
}
export async function toolValue(host: WorkspaceFileHost, sessionId: string | undefined, name: string, args: Record<string, unknown>, signal: AbortSignal): Promise<unknown> {
  signal.throwIfAborted();
  const raw = await host.executeTool(sessionId, name, args, signal);
  signal.throwIfAborted();
  // The host may return the already checked output, or the complete ToolResult.
  if (raw !== null && typeof raw === "object" && "status" in raw) {
    const result = raw as ToolResult;
    if (result.status !== "success") throw new WorkspaceRemoteError(typeof result.metadata?.remoteCode === "string" ? result.metadata.remoteCode : result.status === "cancelled" ? "gateway/cancelled" : result.status === "denied" ? "gateway/forbidden" : "gateway/internal", result.error?.message ?? `Tool ${name} ${result.status}`, { tool: name, status: result.status, code: result.error?.code, ...record(result.metadata?.details ?? {}) });
    if (result.metadata?.truncated === true) throw new WorkspaceRemoteError("workspace-file/too-large", "Tool output exceeded its configured cap");
    return result.output;
  }
  return raw;
}
export async function requireFileSession(host: WorkspaceFileHost, id: unknown): Promise<Session> {
  const sessionId = text(id, "sessionId");
  const session = await host.harness.store.getSession(sessionId as SessionId);
  if (!session || session.status === "failed") throw new WorkspaceRemoteError("session/not-found", "Session not found", { sessionId });
  return session;
}
export function inside(root: string, target: string): boolean {
  const delta = relative(root, target);
  return delta === "" || (!isAbsolute(delta) && delta !== ".." && !delta.startsWith(`..${sep}`));
}
function validPath(path: string): void {
  if (/\x00|[\x01-\x1f]/.test(path) || (!isAbsolute(path) && /^[a-z]:[\\/]|^[\\/]{2}/i.test(path))) throw new WorkspaceRemoteError("workspace-file/outside-workspace", "Invalid filesystem path", { path });
}
/** Canonical containment supplements, and never replaces, Orchestrator's sandbox. */
export async function confinedPath(path: string, context: ToolExecutionContext): Promise<{ root: string; absolute: string }> {
  context.signal.throwIfAborted(); validPath(path);
  const root = await realpath(context.cwd);
  const candidate = resolve(context.cwd, path);
  if (!inside(resolve(context.cwd), candidate) && !inside(root, candidate)) throw new WorkspaceRemoteError("workspace-file/outside-workspace", "Path outside workspace", { path });
  const absolute = await realpath(candidate);
  context.signal.throwIfAborted();
  if (!inside(root, absolute)) throw new WorkspaceRemoteError("workspace-file/outside-workspace", "Symlink leaves workspace", { path });
  return { root, absolute };
}
const MAX_BYTES = 2 * 1024 * 1024;
const MAX_FILE_BYTES = 32 * 1024 * 1024;
const MAX_ENTRIES = 2000;
const MAX_LINES = 5000;
const sensitiveName = /^(?:\.env(?:\..*)?|id_(?:rsa|dsa|ecdsa|ed25519)|credentials(?:\..*)?|.*\.(?:pem|key|p12|pfx))$/i;
function rejectSensitive(path: string, bytes?: Uint8Array): void {
  if (sensitiveName.test(basename(path)) || /(?:^|[\\/])(?:\.aws|\.ssh|\.gnupg)(?:[\\/]|$)/.test(path) || (bytes && detectSecrets(Buffer.from(bytes).toString("utf8")).hasSecret)) throw new WorkspaceRemoteError("gateway/forbidden", "File contains protected credentials", { path });
}
function version(s: { dev: number; ino: number; size: number; mtimeMs: number; ctimeMs: number }): string {
  return createHash("sha256").update(`${s.dev}:${s.ino}:${s.size}:${s.mtimeMs}:${s.ctimeMs}`).digest("hex");
}
function failure(error: unknown, signal: AbortSignal): ToolResult {
  if (signal.aborted) return { status: "cancelled" };
  const code = error instanceof WorkspaceRemoteError ? error.code : "gateway/internal";
  return { status: "failed", error: { code: "PROCESS_ERROR", message: error instanceof Error ? error.message : String(error), retryable: false, safeToRetry: false }, metadata: { remoteCode: code, details: error instanceof WorkspaceRemoteError ? error.details : {} } };
}
const readSchema = z.object({ path: z.string(), operation: z.enum(["stat", "read", "readBytes", "list", "tree", "directoryList", "watch"]), offset: z.number().int().nonnegative().optional(), limit: z.number().int().positive().optional(), length: z.number().int().positive().optional(), nameOnly: z.boolean().optional() }).strict();
export const workspaceReadTool: ToolDefinition<z.infer<typeof readSchema>, unknown> = {
  name: "web_workspace_read", description: "Read bounded workspace files and directories for the local web console.", inputSchema: readSchema, risk: "readonly",
  metadata: { name: "web_workspace_read", version: "1.0.0", filesystem: true, process: false, network: false, sideEffect: false, interactive: false, concurrencySafe: true, retry: "safe" },
  async execute(input, context) {
    try {
      const { root, absolute } = await confinedPath(input.path || ".", context);
      const original = await lstat(resolve(context.cwd, input.path || "."));
      context.signal.throwIfAborted();
      if (["list", "tree", "directoryList"].includes(input.operation)
        || input.operation === "watch" && (original.isDirectory() || original.isSymbolicLink() && (await stat(absolute)).isDirectory())) {
        if (!original.isDirectory() && !original.isSymbolicLink()) throw new WorkspaceRemoteError("workspace-file/not-directory", "Path is not a directory", { path: input.path });
        const observed = await stat(absolute);
        if (!observed.isDirectory()) throw new WorkspaceRemoteError("workspace-file/not-directory", "Path is not a directory", { path: input.path });
        const entries: Array<{ name: string; type: "file" | "directory" | "other"; size?: number }> = [];
        const observations: string[] = [];
        const names = (await readdir(absolute)).sort((a,b)=>a.localeCompare(b, "en"));
        for (const name of names.slice(0, MAX_ENTRIES)) {
          context.signal.throwIfAborted();
          const child = resolve(absolute, name);
          try {
            const childPath = await realpath(child);
            if (!inside(root, childPath)) continue;
            const info = await stat(childPath);
            entries.push({ name, type: info.isFile() ? "file" : info.isDirectory() ? "directory" : "other", ...(info.isFile() ? { size: info.size } : {}) });
            observations.push(`${name}:${version(info)}`);
          } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
        }
        const current = await stat(absolute);
        if (observed.dev !== current.dev || observed.ino !== current.ino || await realpath(absolute) !== absolute) throw new WorkspaceRemoteError("workspace-file/outside-workspace", "Directory changed during listing");
        if (input.operation === "watch") {
          if (names.length > MAX_ENTRIES) throw new WorkspaceRemoteError("workspace-file/watch-unsupported", "Directory exceeds the bounded observation limit", { path: input.path });
          return { status: "success", output: { absolutePath: absolute, version: createHash("sha256").update(`${version(current)}\n${observations.join("\n")}`).digest("hex") } };
        }
        const path = relative(root, absolute).split(sep).join("/");
        if (input.operation === "directoryList") {
          const crumbs = [{ name: root, path: root, hidden: false }];
          let target = root;
          for (const name of path.split("/").filter(Boolean)) { target = resolve(target, name); crumbs.push({ name, path: target, hidden: false }); }
          const home = resolve(homedir());
          return { status: "success", output: { path: absolute, home: inside(root,home) ? home : root, crumbs, entries: entries.filter(e=>e.type==="directory").map(e=>({name:e.name,path:resolve(absolute,e.name),hidden:e.name.startsWith(".")})), truncated: names.length > MAX_ENTRIES } };
        }
        return { status: "success", output: { path, entries, truncated: names.length > MAX_ENTRIES } };
      }
      rejectSensitive(absolute);
      if (original.isSymbolicLink()) throw new WorkspaceRemoteError("workspace-file/not-regular-file", "Symlinks cannot be previewed", { path: input.path, kind: "symlink" });
      const handle = await open(absolute, constants.O_RDONLY | (process.platform === "win32" ? 0 : constants.O_NOFOLLOW | constants.O_NONBLOCK));
      try {
        const info = await handle.stat(); context.signal.throwIfAborted();
        if (!info.isFile()) throw new WorkspaceRemoteError("workspace-file/not-regular-file", "Path is not a regular file", { path: input.path, kind: info.isDirectory() ? "directory" : "other" });
        if (original.dev !== info.dev || original.ino !== info.ino || await realpath(absolute) !== absolute) throw new WorkspaceRemoteError("workspace-file/outside-workspace", "File changed during resolution");
        const base = { absolutePath: absolute, version: version(info), bytes: info.size };
        if (input.operation === "stat" || input.operation === "watch") return { status: "success", output: base };
        // Credential policy applies to one complete immutable descriptor
        // snapshot. Checking only a returned range lets many small requests
        // reconstruct a protected token without any fragment matching it.
        if (info.size > MAX_FILE_BYTES) throw new WorkspaceRemoteError("workspace-file/too-large", "File exceeds the bounded preview scan", { path: input.path, limit: MAX_FILE_BYTES });
        const chunks: Buffer[] = []; let received = 0;
        while (received <= MAX_FILE_BYTES) {
          context.signal.throwIfAborted();
          const chunk = Buffer.alloc(Math.min(64 * 1024, MAX_FILE_BYTES + 1 - received));
          const next = await handle.read(chunk, 0, chunk.length, received);
          if (next.bytesRead === 0) break;
          received += next.bytesRead; chunks.push(chunk.subarray(0, next.bytesRead));
        }
        if (received > MAX_FILE_BYTES) throw new WorkspaceRemoteError("workspace-file/too-large", "File exceeds the bounded preview scan", { path: input.path, limit: MAX_FILE_BYTES });
        const snapshot = Buffer.concat(chunks, received), observed = await handle.stat();
        if (version(info) !== version(observed) || snapshot.length !== info.size || await realpath(absolute) !== absolute) throw new WorkspaceRemoteError("workspace-file/outside-workspace", "File changed during its preview scan");
        rejectSensitive(absolute, snapshot); context.signal.throwIfAborted();
        if (input.operation === "readBytes") {
          const offset = input.offset ?? 0, length = input.length ?? snapshot.length;
          const cap = input.length === undefined ? MAX_FILE_BYTES : MAX_BYTES;
          if (length > cap) throw new WorkspaceRemoteError("workspace-file/too-large", "Byte range exceeds cap", { path: input.path, limit: cap });
          const data = snapshot.subarray(offset, Math.min(snapshot.length, offset + length));
          return { status: "success", output: { ...base, offset, data: new Uint8Array(data), eof: offset + data.length >= snapshot.length } };
        }
        const offset = integer(input.offset ?? 1,"offset",1), limit = integer(input.limit ?? MAX_LINES,"limit",1,MAX_LINES);
        const decoded = new TextDecoder("utf-8", { fatal: true }).decode(snapshot);
        if (decoded.includes("\0")) throw new WorkspaceRemoteError("workspace-file/not-text", "File is not UTF-8 text", {path:input.path});
        const lines = decoded === "" ? [] : decoded.split("\n");
        if (decoded.endsWith("\n")) lines.pop();
        const page = lines.slice(offset - 1, offset - 1 + limit), content = page.join("\n");
        if (Buffer.byteLength(content) > MAX_BYTES) throw new WorkspaceRemoteError("workspace-file/too-large", "Text page exceeds cap", {path:input.path,limit:MAX_BYTES});
        return {status:"success",output:{...base,offset,text:content,lines:page.length,eof:offset - 1 + page.length >= lines.length}};
      } finally { await handle.close(); }
    } catch (error) {
      if (error instanceof TypeError && error.message.includes("encoded data")) return failure(new WorkspaceRemoteError("workspace-file/not-text","File is not UTF-8 text"),context.signal);
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return failure(new WorkspaceRemoteError("workspace-file/not-found","File does not exist",{path:input.path}),context.signal);
      return failure(error, context.signal);
    }
  },
};
const mkdirSchema = z.object({path:z.string(),name:z.string().min(1).max(255)}).strict();
export const workspaceMkdirTool: ToolDefinition<z.infer<typeof mkdirSchema>, string> = {
  name:"web_workspace_mkdir",description:"Create one child directory inside the selected workspace.",inputSchema:mkdirSchema,risk:"side_effect",
  metadata:{name:"web_workspace_mkdir",version:"1.0.0",filesystem:true,process:false,network:false,sideEffect:true,interactive:false,retry:"safe"},
  async execute(input,context) {
    try {
      if (input.name.trim()==="" || input.name==="." || input.name===".." || /[\\/\x00-\x1f]/.test(input.name)) throw new WorkspaceRemoteError("gateway/bad-request","Name must be a single path segment");
      const {absolute} = await confinedPath(input.path,context); context.signal.throwIfAborted();
      const target=resolve(absolute,input.name); await mkdir(target); context.signal.throwIfAborted();
      return {status:"success",output:target};
    } catch(error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") return failure(new WorkspaceRemoteError("directory-picker/exists","A directory or file already exists at this name",{path:resolve(context.cwd,input.path,input.name)}),context.signal) as ToolResult<string>;
      return failure(error,context.signal) as ToolResult<string>;
    }
  }
};

export function createFilesService(host: WorkspaceFileHost) {
  const endpoints = ["workspaceFiles/read","workspaceFiles/readBytes","workspaceFiles/stat","workspaceFiles/list","workspaceFiles/changes","fileReferences/list","directoryPicker/list","directoryPicker/createDirectory","directoryPicker/pick"];
  async function readTool(id:string|undefined,args:Record<string,unknown>,signal:AbortSignal) {
    const raw=await host.executeTool(id,workspaceReadTool.name,args,signal);
    if (raw && typeof raw==="object" && "status" in raw && (raw as ToolResult).status!=="success") {
      const result=raw as ToolResult; const meta=result.metadata;
      throw new WorkspaceRemoteError(String(meta?.remoteCode ?? (result.status==="denied" ? "gateway/forbidden":"gateway/internal")),result.error?.message ?? "File operation failed",record(meta?.details ?? {}));
    }
    // Accept the host's checked output and preserve its typed failures.
    return raw && typeof raw==="object" && "status" in raw ? (raw as ToolResult).output : raw;
  }
  async function callUnlocked(endpoint:string,args:unknown,signal:AbortSignal):Promise<unknown> {
    signal.throwIfAborted();
    if(endpoint==="directoryPicker/pick") { exact(args,[]); throw new WorkspaceRemoteError("directory-picker/unavailable","This host serves the directory browser",{capability:"browse"}); }
    if(endpoint==="directoryPicker/list") { const a=exact(args,["path"],[]); return readTool(undefined,{operation:"directoryList",path:a.path===undefined ? host.cwd:text(a.path,"path")},signal); }
    if(endpoint==="directoryPicker/createDirectory") { const a=exact(args,["path","name"]); return toolValue(host,undefined,workspaceMkdirTool.name,{path:text(a.path,"path"),name:text(a.name,"name")},signal); }
    if(endpoint==="fileReferences/list") {
      const a=exact(args,["agentId","query"]); const session=await requireFileSession(host,a.agentId); const query=text(a.query,"query",true).replaceAll("\\","/");
      if(query.startsWith("/") || query.split("/").includes("..")) throw new WorkspaceRemoteError("workspace-file/outside-workspace","File references must stay in workspace");
      const directory=query.includes("/")?query.slice(0,query.lastIndexOf("/")):""; const prefix=query.slice(directory ? directory.length+1 : 0).toLowerCase();
      const listing=record(await readTool(session.id,{operation:"list",path:directory || "."},signal));
      return (listing.entries as Array<{name:string;type:string}>).filter(e=>e.type!=="other" && e.name.toLowerCase().startsWith(prefix)).slice(0,100).map(e=>({path:[directory,e.name].filter(Boolean).join("/")+(e.type==="directory"?"/":""),kind:e.type}));
    }
    const operation=endpoint.split("/")[1];
    if(!["read","readBytes","stat","list"].includes(operation ?? "")) throw new WorkspaceRemoteError("gateway/not-found","Unknown file endpoint");
    const keys=operation==="read"?["workspaceFileScopeId","path","range"]:operation==="readBytes"?["workspaceFileScopeId","path","options"]:["workspaceFileScopeId","path"];
    const a=exact(args,keys); const session=await requireFileSession(host,a.workspaceFileScopeId); let path=text(a.path,"path",operation==="list");
    const request:Record<string,unknown>={operation,path:path||"."};
    if(operation==="read") { const range=exact(a.range,["offset","limit"],[]); request.offset=integer(range.offset ?? 1,"offset",1); request.limit=integer(range.limit ?? MAX_LINES,"limit",1,MAX_LINES); }
    if(operation==="readBytes") {
      const options=exact(a.options,["range","baseFile"],[]);
      if(options.baseFile!==undefined) { const base=text(options.baseFile,"baseFile"); validPath(path); if(isAbsolute(path)) throw new WorkspaceRemoteError("gateway/bad-request","path must be relative with baseFile"); path=resolve(dirname(resolve(session.cwd,base)),path); request.path=path; }
      if(options.range!==undefined) { const range=exact(options.range,["offset","length"],[]); request.offset=integer(range.offset ?? 0,"offset",0); request.length=integer(range.length ?? MAX_BYTES,"length",1,MAX_BYTES); }
    }
    return readTool(session.id,request,signal);
  }
  async function call(endpoint:string,args:unknown,signal:AbortSignal):Promise<unknown> {
    if(host.withSessionLock!==undefined && (endpoint.startsWith("workspaceFiles/") || endpoint==="fileReferences/list")) {
      const input=record(args),id=text(endpoint==="fileReferences/list"?input.agentId:input.workspaceFileScopeId,"sessionId");
      return host.withSessionLock(id,()=>callUnlocked(endpoint,args,signal));
    }
    return callUnlocked(endpoint,args,signal);
  }
  async function* stream(endpoint:string,args:unknown,signal:AbortSignal):AsyncIterable<unknown> {
    if(endpoint!=="workspaceFiles/changes") throw new WorkspaceRemoteError("gateway/not-found","Unknown file stream");
    const a=exact(args,["workspaceFileScopeId","path"]);
    const id=text(a.workspaceFileScopeId,"sessionId");
    const sample=async()=>{const session=await requireFileSession(host,id);return record(await readTool(session.id,{operation:"watch",path:text(a.path,"path",true) || "."},signal));};
    const observe=()=>host.withSessionLock===undefined?sample():host.withSessionLock(id,sample);
    let current=await observe(), absent=false; yield {kind:"ready"};
    while(!signal.aborted) {
      await new Promise<void>(resolve=>{const timer=setTimeout(done,750);function done(){clearTimeout(timer);signal.removeEventListener("abort",done);resolve();}signal.addEventListener("abort",done,{once:true});});
      if(signal.aborted)return;
      try { const next=await observe(); if(absent || next.version!==current.version){current=next;absent=false;yield {kind:"change",change:{absolutePath:next.absolutePath,version:next.version}};} }
      catch(error){if(signal.aborted)return;if(error instanceof WorkspaceRemoteError&&error.code==="workspace-file/not-found"){if(!absent){absent=true;yield{kind:"change",change:{absolutePath:current.absolutePath,absent:true}};}continue;}throw error;}
    }
  }
  return {endpoints,call,stream};
}
