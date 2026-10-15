import { isAbsolute, relative, resolve } from "node:path";
import { redactSecrets } from "@ar/security";
import type { PageProjection, JsonValue } from "./projections.js";

const record = (value: unknown): Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const text = (value: unknown) => typeof value === "string" ? value : "";
export interface CodingStatus {
  sessionId: string; cursor: number;
  status: "idle" | "running" | "completed" | "failed" | "cancelled" | "waiting";
  verification: "unrun" | "passed" | "failed";
  commands: { command: string; exitCode: number | null; failed: boolean; detail: string }[];
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
  const files = new Set<string>();
  for (const { event } of projection.records) {
    const data = record(event.data);
    if (event.type === "turn/start") { result.status = "running"; result.verification = "unrun"; result.commands = []; result.todos = []; calls.clear(); }
    else if (event.type === "turn/end") {
      const kind = record(data.reason).kind;
      result.status = kind === "aborted" ? "cancelled" : kind === "error" || kind === "max-tokens" ? "failed" : "completed";
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
        const args = Array.isArray(call.args.args) ? call.args.args.filter(arg => typeof arg === "string").map(arg => JSON.stringify(arg)).join(" ") : "";
        result.commands.push({ command: redactSecrets([text(call.args.command), args].filter(Boolean).join(" ")).content.slice(0, 1000),
          exitCode: code, failed: message.isError === true || (code !== null && code !== 0), detail: redactSecrets(content).content.slice(0, 2000) });
        result.commands = result.commands.slice(-20);
      } else if (["write_file", "edit_file"].includes(call.name) && message.isError !== true) {
        const path = text(call.args.path), uri = editorUri(projection.header.cwd, path);
        if (uri && !files.has(path) && result.files.length < 50) { files.add(path); result.files.push({ path, editorUri: uri }); }
      }
    }
  }
  return result;
}
