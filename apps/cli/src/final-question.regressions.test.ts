import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, expect, it } from "vitest";
import type { AskUserRequest, ModelRequest, Session } from "@ar/contracts";
import { ScriptedModelProvider } from "@ar/model";
import { createDefaultDeps } from "./main.js";
import { runCommand, runSessionTurn } from "./commands.js";
import { createTerminalChatHost } from "./terminal-chat-host.js";

const paths: string[] = [];
afterEach(async () => { await Promise.all(paths.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
async function root() { const path = await mkdtemp(join(tmpdir(), "final-cli-question-")); paths.push(path); return path; }
const ask = () => ScriptedModelProvider.toolCall("ask_user", { question: "Which target?", reason: "choice_required", options: ["blue", "green"] });
function provider(script: ConstructorParameters<typeof ScriptedModelProvider>[0], requests: ModelRequest[]) {
  const source = new ScriptedModelProvider(script);
  return { id: source.id, listModels: source.listModels.bind(source), createClient(...args: Parameters<typeof source.createClient>) {
    const client = source.createClient(...args);
    return { async *generate(request: ModelRequest, signal: AbortSignal) { requests.push(request); yield* client.generate(request, signal); } };
  } };
}
function terminal(lines: string[], questions: AskUserRequest[], answers: (string | undefined)[], controller?: AbortController) {
  const output: string[] = [];
  const runHost = { ...(controller ? { signal: controller.signal } : {}), approve: async () => "deny" as const,
    ask: async (request: AskUserRequest, _signal: AbortSignal) => { questions.push(request); return answers.shift(); } };
  return { output, readMessage: async () => lines.shift(), beginTurn: () => runHost, endTurn() {}, write: (value: string) => { output.push(value); } };
}

it("answers a CLI model question and continues the same actual turn exactly once", async () => {
  const cwd = await root(), dataDir = await root(), requests: ModelRequest[] = [], questions: AskUserRequest[] = [];
  const deps = await createDefaultDeps({ cwd, dataDir, agentPrompt: "coding-v1", provider: provider([ask(), ScriptedModelProvider.text("implemented blue")], requests) });
  try {
    deps.chatHost = terminal(["implement target", "/quit"], questions, ["blue"]);
    const result = await runCommand(["chat", cwd], deps);
    expect(result.exitCode, result.lines.join("\n")).toBe(0); expect(questions).toHaveLength(1);
    const session = (await deps.store.listSessions())[0]!;
    const turns = await deps.store.listTurns(session.id); expect(turns).toHaveLength(1); expect(turns[0]!.status).toBe("completed");
    const replies = (await deps.store.listMessages(session.id)).filter(message => message.askId !== undefined);
    expect(replies).toHaveLength(1); expect(replies[0]!.turnId).toBe(turns[0]!.id); expect(replies[0]!.content).toContain("blue");
    expect(JSON.stringify(requests[1])).toContain("[user reply to your question]");
    expect(await deps.askUserStore!.listPending(session.id)).toEqual([]);
  } finally { await deps.close?.(); }
});

it("keeps an unanswered EOF question durable and answers it after CLI restart without a new task", async () => {
  const cwd = await root(), dataDir = await root(), firstRequests: ModelRequest[] = [];
  const first = await createDefaultDeps({ cwd, dataDir, agentPrompt: "coding-v1", provider: provider([ask()], firstRequests) });
  let session: Session;
  try {
    first.chatHost = terminal(["implement target"], [], [undefined]);
    expect((await runCommand(["chat", cwd], first)).exitCode).toBe(1);
    session = (await first.store.listSessions())[0]!;
    expect((await first.store.listTurns(session.id))[0]!.status).toBe("waiting_for_user");
  } finally { await first.close?.(); }
  const requests: ModelRequest[] = [], questions: AskUserRequest[] = [];
  const second = await createDefaultDeps({ cwd, dataDir, agentPrompt: "coding-v1", provider: provider([ScriptedModelProvider.text("resumed implementation")], requests) });
  try {
    second.chatHost = terminal(["/quit"], questions, ["blue"]);
    const result = await runCommand(["chat", cwd, "--resume", session!.id], second);
    expect(result.exitCode, result.lines.join("\n")).toBe(0); expect(questions).toHaveLength(1);
    expect(await second.store.listTurns(session!.id)).toHaveLength(1);
    expect((await second.store.listTurns(session!.id))[0]!.status).toBe("completed");
    expect(JSON.stringify(requests[0])).toContain("[user reply to your question]");
  } finally { await second.close?.(); }
});

it("Ctrl-C while waiting for an answer cancels the actual parked turn without answering it", async () => {
  const cwd = await root(), dataDir = await root(), controller = new AbortController();
  const deps = await createDefaultDeps({ cwd, dataDir, provider: provider([ask()], []) });
  const host = { signal: controller.signal, approve: async () => "deny" as const,
    ask: async (_request: AskUserRequest, signal: AbortSignal) => {
      controller.abort(); expect(signal.aborted).toBe(true); return undefined;
    } };
  deps.runHost = host;
  try {
    const sessions = await deps.rpc.request("agent.list") as Array<{ id: string }>;
    const session = await deps.rpc.request("session.create", { agentId: sessions[0]!.id, cwd }) as Session;
    const result = await runSessionTurn(session, "choose target", deps);
    expect(result.exitCode).toBe(1); expect(result.lines, result.lines.join("\n")).toContain("status: cancelled");
    expect((await deps.store.listTurns(session.id))[0]!.status).toBe("cancelled");
    expect((await deps.store.listMessages(session.id)).some(message => message.askId !== undefined)).toBe(false);
  } finally { await deps.close?.(); }
});

it("one real terminal queue routes question answers and later approvals to their own owners", async () => {
  const cwd = await root(), dataDir = await root(), input = new PassThrough(), output = new PassThrough();
  const host = createTerminalChatHost({ input, output, error: output });
  const deps = await createDefaultDeps({ cwd, dataDir, provider: provider([ask(),
    ScriptedModelProvider.toolCall("write_file", { path: "must-not-exist.txt", content: "denied" }), ScriptedModelProvider.text("write denied")], []) });
  deps.chatHost = host;
  try {
    input.end("implement target\nblue\ndeny\n/quit\n");
    expect((await runCommand(["chat", cwd], deps)).exitCode).toBe(0);
    const session = (await deps.store.listSessions())[0]!;
    expect((await deps.store.listMessages(session.id)).filter(message => message.askId !== undefined).map(message => message.content)).toEqual(["[user reply to your question]\nblue"]);
    const approvals = await deps.events.list(session.id); expect(approvals.some(event => event.type === "approval.resolved" && event.payload.value === "deny")).toBe(true);
    const { access } = await import("node:fs/promises"); await expect(access(join(cwd, "must-not-exist.txt"))).rejects.toThrow();
  } finally { host.close(); await deps.close?.(); }
});

it("actual CLI restart continues a question after a committed write and retains its file and tool summary", async () => {
  const cwd = await root(), dataDir = await root();
  const first = await createDefaultDeps({ cwd, dataDir, provider: provider([
    ScriptedModelProvider.toolCall("write_file", { path: "app.txt", content: "actual edited file\n" }), ask()], []) });
  let session!: Session;
  try {
    const host = terminal(["implement target"], [], [undefined]);
    first.chatHost = { ...host, beginTurn: () => ({ approve: async () => "allow" as const, ask: async () => undefined }) };
    expect((await runCommand(["chat", cwd], first)).exitCode).toBe(1);
    session = (await first.store.listSessions())[0]!;
    expect(await readFile(join(cwd, "app.txt"), "utf8")).toBe("actual edited file\n");
  } finally { await first.close?.(); }
  const second = await createDefaultDeps({ cwd, dataDir, provider: provider([ScriptedModelProvider.text("done")], []) });
  try {
    const host = terminal(["/quit"], [], ["blue"]); second.chatHost = host;
    const result = await runCommand(["chat", cwd, "--resume", session.id], second);
    expect(result.exitCode, result.lines.join("\n")).toBe(0);
    expect(host.output.join("\n")).toContain("files changed: app.txt"); expect(host.output.join("\n")).toContain("tool calls: 1");
    expect(await second.store.listTurns(session.id)).toHaveLength(1); expect(await readFile(join(cwd, "app.txt"), "utf8")).toBe("actual edited file\n");
  } finally { await second.close?.(); }
});
