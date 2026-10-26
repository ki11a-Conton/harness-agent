import { isAbsolute, relative, resolve } from "node:path";
import { redactSecrets } from "@ar/security";
import type { PageProjection, JsonValue } from "./projections.js";

const record = (value: unknown): Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const text = (value: unknown) => typeof value === "string" ? value : "";
const managedStates = ["running", "succeeded", "failed", "timed_out", "cancelled", "unknown"] as const;
type CommandState = typeof managedStates[number];
interface CodingCommand {
  command: string; exitCode: number | null; failed: boolean; detail: string;
  jobId?: string; state?: CommandState;
}
export interface CodingStatus {
  sessionId: string; cursor: number;
  status: "idle" | "running" | "completed" | "failed" | "cancelled" | "waiting";
  verification: "unrun" | "passed" | "failed";
  commands: CodingCommand[];
  files: { path: string; editorUri: string }[];
  todos: JsonValue[];
  changesSeq?: number;
}
function editorUri(cwd: string, value: string): string | undefined {
  if (!value || /[\x00-\x1f]/.test(value)) return undefined;
  const absolute = resolve(cwd, value), rel = relative(resolve(cwd), absolute);
  if (isAbsolute(rel) || rel === ".." || rel.startsWith("../") || rel.startsWith("..\\")) return undefined;
  const url = new URL("vscode://file/");
  url.pathname = (absolute.startsWith("/") ? "" : "/") + absolute.replace(/\\/g, "/").replaceAll("%", "%25") + ":1";
  return url.href;
}

/** View of already authorized browser records. Tool exit zero is not a
 * verification gate; current-turn verification resets on every turn start. */
export function codingStatusOf(projection: PageProjection): CodingStatus {
  const result: CodingStatus = { sessionId: projection.header.id, cursor: projection.cursor,
    status: "idle", verification: "unrun", commands: [], files: [], todos: [] };
  const calls = new Map<string, { name: string; args: Record<string, unknown> }>();
  const managed = new Map<string, { row: CodingCommand; cursor: number; detail: string }>();
  const append = (row: CodingCommand) => { result.commands.push(row); result.commands = result.commands.slice(-20); };
  const commandOf = (args: Record<string, unknown>) => redactSecrets([text(args.command),
    Array.isArray(args.args) ? args.args.filter(arg => typeof arg === "string").map(arg => JSON.stringify(arg)).join(" ") : "",
  ].filter(Boolean).join(" ")).content.slice(0, 1000);
  const detailOf = (value: string) => redactSecrets(value).content.slice(-2000);
  const stateOf = (value: unknown): CommandState | undefined => managedStates.includes(value as CommandState) ? value as CommandState : undefined;
  const observe = (job: { row: CodingCommand; cursor: number; detail: string }, output: Record<string, unknown>, fallback = "") => {
    const state = stateOf(output.state);
    if (state !== undefined && !(state === "running" && job.row.state !== "running" && job.row.state !== "unknown")) {
      job.row.state = state;
      job.row.failed = !["running", "succeeded"].includes(state);
      if (state === "running") job.row.exitCode = null;
      else if (typeof output.exitCode === "number" && Number.isSafeInteger(output.exitCode)) job.row.exitCode = output.exitCode;
    }
    let next = output.incomplete === true ? `[Output incomplete; ${typeof output.lostBytes === "number" ? output.lostBytes : "unknown"} bytes unavailable]\n` : "";
    for (const raw of Array.isArray(output.chunks) ? output.chunks : []) {
      const chunk = record(raw), content = text(chunk.text), offset = chunk.offset;
      if (typeof offset !== "number" || !Number.isSafeInteger(offset) || offset < 0) continue;
      const bytes = Buffer.from(content), end = offset + bytes.length;
      if (end <= job.cursor) continue;
      let skip = Math.max(0, job.cursor - offset);
      while (skip < bytes.length && (bytes[skip]! & 0xc0) === 0x80) skip++;
      next += bytes.subarray(skip).toString("utf8"); job.cursor = end;
    }
    const error = text(record(output.error).message) || fallback;
    if (error) next += `\n${error}`;
    job.detail = (job.detail + next).slice(-4000);
    job.row.detail = detailOf(job.detail);
  };
  const files = new Set<string>();
  for (const { event } of projection.records) {
    const data = record(event.data);
    if (event.type === "turn/start") { result.status = "running"; result.verification = "unrun"; result.commands = []; result.todos = []; calls.clear(); managed.clear(); }
    else if (event.type === "turn/end") {
      const kind = record(data.reason).kind;
      result.status = kind === "aborted" ? "cancelled" : kind === "error" || kind === "max-tokens" ? "failed" : "completed";
      for (const job of managed.values()) if (job.row.state === "running") observe(job, { state: "unknown" }, "Turn ended without a confirmed command outcome.");
    } else if (event.type === "harness/ask.turn_waiting") result.status = "waiting";
    else if (event.type === "harness/verification.completed" && record(data.payload).passed === true) result.verification = "passed";
    else if (event.type === "harness/verification.failed") result.verification = "failed";
    else if (event.type === "todo/write" && Array.isArray(data.todos)) result.todos = data.todos.slice(0, 100) as JsonValue[];
    else if (event.type === "workspace/changes") result.changesSeq = event.seq;
    else if (event.type === "tool/call") {
      try { calls.set(text(data.callId), { name: text(data.name), args: record(JSON.parse(text(data.arguments))) }); } catch { continue; /* Unparseable arguments cannot establish file/command provenance. */ }
    } else if (event.type === "tool/result") {
      const message = record(data.message), call = calls.get(text(message.toolCallId));
      if (!call) continue;
      const content = Array.isArray(message.content) ? message.content.map(part => text(record(part).text)).join("\n") : "";
      if (call.name === "exec") {
        let output: Record<string, unknown> = {};
        try { const envelope = record(JSON.parse(content.replace(/^\[(?:failed|denied|cancelled)\]\s*/, ""))); output = record(envelope.output ?? envelope); } catch { output = {}; /* Textual errors cannot establish an exit code. */ }
        const code = typeof output.exitCode === "number" && Number.isSafeInteger(output.exitCode) ? output.exitCode : null;
        append({ command: commandOf(call.args),
          exitCode: code, failed: message.isError === true || (code !== null && code !== 0), detail: redactSecrets(content).content.slice(0, 2000) });
      } else if (["exec_start", "exec_poll", "exec_cancel", "exec_jobs"].includes(call.name)) {
        let output: Record<string, unknown> = {};
        try { const envelope = record(JSON.parse(content.replace(/^\[(?:failed|denied|cancelled)\]\s*/, ""))); output = record(envelope.output ?? envelope); } catch { output = {}; /* An unparseable observation cannot prove process completion. */ }
        const jobId = text(output.jobId);
        if (call.name === "exec_start") {
          const row: CodingCommand = { command: commandOf(call.args), exitCode: null, failed: true, detail: "", state: message.isError === true ? "failed" : "unknown", ...(jobId ? { jobId } : {}) };
          const job = { row, cursor: 0, detail: "" };
          append(row);
          if (jobId) managed.set(jobId, job);
          observe(job, output, message.isError === true ? content : "");
        } else if (call.name === "exec_jobs") {
          for (const raw of [...(Array.isArray(output.jobs) ? output.jobs : []), ...(Array.isArray(output.interrupted) ? output.interrupted : [])]) {
            const entry = record(raw), job = managed.get(text(entry.jobId));
            if (job) observe(job, entry);
          }
        } else {
          const job = managed.get(text(call.args.jobId));
          // A failed poll/cancel without a matching owner receipt must not
          // turn the existing process into a fabricated failure or success.
          if (job && jobId === call.args.jobId) observe(job, output);
          else if (job && message.isError === true) observe(job, {}, content);
        }
      } else if (["write_file", "edit_file"].includes(call.name) && message.isError !== true) {
        const path = text(call.args.path), uri = editorUri(projection.header.cwd, path);
        if (uri && !files.has(path) && result.files.length < 50) { files.add(path); result.files.push({ path, editorUri: uri }); }
      }
    }
  }
  return result;
}
