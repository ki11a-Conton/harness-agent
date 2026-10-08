import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, expect, it } from "vitest";
import type { ModelRequest, Session } from "@ar/contracts";
import { ScriptedModelProvider } from "@ar/model";
import { createDefaultDeps, extractDataDirFlag } from "./main.js";
import { parseChatArguments } from "./chat-command.js";
import { runCommand, runSessionTurn, type CommandDeps } from "./commands.js";
import { createTerminalChatHost } from "./terminal-chat-host.js";

const paths: string[] = [];
afterEach(async () => { await Promise.all(paths.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
async function root() { const path = await mkdtemp(join(tmpdir(), "gen1-chat-")); paths.push(path); return path; }
function stableProvider(scripted: ScriptedModelProvider, requests: ModelRequest[]) {
  return { id: scripted.id, listModels: scripted.listModels.bind(scripted), createClient(...args: Parameters<typeof scripted.createClient>) {
    const client = scripted.createClient(...args);
    return { async *generate(request: ModelRequest, signal: AbortSignal) { requests.push(request); yield* client.generate(request, signal); } };
  } };
}
function scriptedHost(lines: string[]): NonNullable<CommandDeps["chatHost"]> & { output: string[] } {
  const output: string[] = [];
  return { output, async readMessage() { return lines.shift(); }, beginTurn() { return { async approve() { return "allow"; } }; },
    endTurn() {}, write(line) { output.push(line); } };
}

it("rejects missing, empty and duplicate persistent data-directory options", () => {
  for (const args of [["--data-dir"], ["--data-dir="], ["--data-dir", "--verify", "node check.js"], ["--data-dir", "a", "--data-dir=b"]]) {
    expect(() => extractDataDirFlag(args)).toThrow(/data-dir/);
  }
  expect(extractDataDirFlag(["chat", ".", "--data-dir", "persistent data"])).toEqual({ args: ["chat", "."], dataDir: "persistent data" });
  expect(() => parseChatArguments([".", "--resume"])).toThrow(/requires/);
  expect(() => parseChatArguments([".", "--typo"])).toThrow(/unknown/);
});

it("runs two chat turns on one actual runtime session and resumes that same id after restart", async () => {
  const cwd = await root(); const dataDir = await root();
  const initialScript = new ScriptedModelProvider([ScriptedModelProvider.text("first reply"), ScriptedModelProvider.text("second reply")]);
  const provider = stableProvider(initialScript, []);
  const first = await createDefaultDeps({ cwd, dataDir, agentPrompt: "coding-v1", provider });
  let id: Session["id"];
  try {
    first.chatHost = scriptedHost(["first task", "second task", "/quit"]);
    expect((await runCommand(["chat", cwd], first)).exitCode).toBe(0);
    const sessions = await first.store.listSessions();
    expect(sessions).toHaveLength(1); id = sessions[0]!.id;
    expect((await first.store.listTurns(id)).map(turn => turn.status)).toEqual(["completed", "completed"]);
    expect((await first.store.listMessages(id)).filter(message => message.role === "user").map(message => message.content)).toEqual(["first task", "second task"]);
  } finally { await first.close?.(); }
  const requests: ModelRequest[] = [];
  const scripted = new ScriptedModelProvider([ScriptedModelProvider.text("third reply")]);
  const resumedProvider = stableProvider(scripted, requests);
  const second = await createDefaultDeps({ cwd, dataDir, agentPrompt: "coding-v1", provider: resumedProvider });
  try {
    second.chatHost = scriptedHost(["third task", "/quit"]);
    const result = await runCommand(["chat", cwd, "--resume", id!], second);
    expect(result.exitCode, result.lines.join("\n")).toBe(0);
    expect(await second.store.listSessions()).toHaveLength(1);
    expect(await second.store.listTurns(id!)).toHaveLength(3);
    expect(JSON.stringify(requests[0])).toContain("first task");
    expect(JSON.stringify(requests[0])).toContain("second reply");
  } finally { await second.close?.(); }
});

it("refuses another project and incompatible prompt policy instead of silently forking", async () => {
  const cwd = await root(); const otherCwd = await root(); const dataDir = await root();
  const deps = await createDefaultDeps({ cwd, dataDir, agentPrompt: "coding-v1", provider: new ScriptedModelProvider([ScriptedModelProvider.text("initial reply")]) });
  let id: Session["id"];
  try {
    deps.chatHost = scriptedHost(["initial task", "/quit"]);
    await runCommand(["chat", cwd], deps);
    id = (await deps.store.listSessions())[0]!.id;
    expect((await runCommand(["chat", otherCwd, "--resume", id], deps)).lines.join("\n")).toContain("belongs to project");
  } finally { await deps.close?.(); }
  const legacy = await createDefaultDeps({ cwd, dataDir, agentPrompt: "legacy", provider: new ScriptedModelProvider([]) });
  try {
    legacy.chatHost = scriptedHost(["/quit"]);
    expect((await runCommand(["chat", cwd, "--resume", id!], legacy)).exitCode).toBe(1);
    expect(await legacy.store.listSessions()).toHaveLength(1);
  } finally { await legacy.close?.(); }
});

it("routes message and approval input through one queue; EOF denies and the next turn gets a fresh signal", async () => {
  const input = new PassThrough(); const output = new PassThrough(); const error = new PassThrough();
  const host = createTerminalChatHost({ input, output, error });
  try {
    input.write("first task\nallow\nsecond task\n");
    expect(await host.readMessage()).toBe("first task");
    const first = host.beginTurn();
    expect(await first.approve({ id: "test", action: "exec", target: "check", reason: "test" } as never, new AbortController().signal)).toBe("allow");
    host.endTurn();
    expect(await host.readMessage()).toBe("second task");
    const second = host.beginTurn();
    expect(second.signal).not.toBe(first.signal);
    input.end();
    expect(await second.approve({ id: "test", action: "edit", target: "file", reason: "test" } as never, new AbortController().signal)).toBe("deny");
    host.endTurn(); expect(await host.readMessage()).toBeUndefined();
  } finally { host.close(); }
});

it("idle Ctrl-C and explicit close discard queued work, while active Ctrl-C permits a new turn", async () => {
  for (const close of ["interrupt", "close"] as const) {
    const input = new PassThrough(); const output = new PassThrough();
    const host = createTerminalChatHost({ input, output, error: output });
    try {
      input.write("must not execute after closing\n");
      if (close === "interrupt") process.emit("SIGINT"); else host.close();
      expect(await host.readMessage()).toBeUndefined();
      expect(() => host.beginTurn()).toThrow(/closed/);
    } finally { host.close(); input.destroy(); }
  }
  const input = new PassThrough(); const output = new PassThrough();
  const host = createTerminalChatHost({ input, output, error: output });
  try {
    const first = host.beginTurn();
    process.emit("SIGINT");
    expect(first.signal?.aborted).toBe(true);
    host.endTurn();
    input.write("next task\n");
    expect(await host.readMessage()).toBe("next task");
    expect(host.beginTurn().signal?.aborted).toBe(false);
  } finally { host.close(); input.destroy(); }
});

it("a signal already cancelled before execution terminalizes the created turn without calling the model", async () => {
  const cwd = await root();
  const requests: ModelRequest[] = [];
  const deps = await createDefaultDeps({ cwd, agentPrompt: "coding-v1", provider: stableProvider(new ScriptedModelProvider([]), requests) });
  const controller = new AbortController(); controller.abort();
  deps.runHost = { signal: controller.signal, async approve() { throw new Error("cancelled turn must not request approval"); } };
  try {
    const result = await runCommand(["run", cwd, "must not execute"], deps);
    expect(result.exitCode).toBe(1);
    const sessions = await deps.store.listSessions();
    const turns = await deps.store.listTurns(sessions[0]!.id);
    expect(turns).toHaveLength(1);
    expect(turns[0]!.status).toBe("cancelled");
    expect(requests).toHaveLength(0);
  } finally { await deps.close?.(); }
});

it("a cancelled later turn never reports a previous turn's reply or successful verification", async () => {
  const cwd = await root();
  const deps = await createDefaultDeps({ cwd, agentPrompt: "coding-v1", provider: new ScriptedModelProvider([ScriptedModelProvider.text("first task reply")]),
    task: { id: "chat-truth", goal: "verify", verification: [{ kind: "command", command: process.execPath, args: ["-e", "process.exit(0)"] }] } });
  deps.runHost = { async approve() { return "allow"; } };
  try {
    expect((await runCommand(["run", cwd, "first task"], deps)).exitCode).toBe(0);
    const session = (await deps.store.listSessions())[0]!;
    const controller = new AbortController(); controller.abort();
    deps.runHost = { signal: controller.signal, async approve() { throw new Error("cancelled turn must not approve"); } };
    const second = await runSessionTurn(session, "cancelled second task", deps);
    expect(second.lines.join("\n")).toContain("summary: (no assistant text)");
    expect(second.lines.join("\n")).toContain("verification: not run");
    expect(second.lines.join("\n")).not.toContain("verification: passed");
  } finally { await deps.close?.(); }
});
