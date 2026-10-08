import { resolve } from "node:path";
import type { Session } from "@ar/contracts";
import type { AgentSummary } from "@ar/gateway";
import { runSessionTurn, type CommandDeps, type CommandResult } from "./commands.js";

export interface ChatArguments { cwd: string; resume?: string; verificationCommand?: string }

/** Strict flags keep a typo from changing the workspace or silently starting
 * a fresh conversation instead of resuming the requested one. */
export function parseChatArguments(args: string[], defaultCwd = process.cwd()): ChatArguments {
  let cwd: string | undefined;
  let resume: string | undefined;
  let verificationCommand: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const value = args[i]!;
    if (value === "--resume" || value === "--verify") {
      const next = args[++i];
      if (next === undefined || !next.trim() || next.startsWith("--")) throw new Error(`${value} requires a value`);
      if (value === "--resume") {
        if (resume !== undefined) throw new Error("duplicate --resume");
        resume = next;
      } else {
        if (verificationCommand !== undefined) throw new Error("duplicate --verify");
        verificationCommand = next;
      }
    } else if (value.startsWith("--")) {
      throw new Error(`unknown chat option: ${value}`);
    } else {
      if (cwd !== undefined) throw new Error("chat accepts one project directory");
      cwd = value;
    }
  }
  return { cwd: resolve(cwd ?? defaultCwd), ...(resume !== undefined ? { resume } : {}),
    ...(verificationCommand !== undefined ? { verificationCommand } : {}) };
}

export async function chatCommand(args: string[], deps: CommandDeps): Promise<CommandResult> {
  const host = deps.chatHost;
  if (host === undefined) return { exitCode: 1, lines: ["agent chat: no interactive host configured"] };
  try {
    const options = parseChatArguments(args);
    const agents = await deps.rpc.request("agent.list") as AgentSummary[];
    if (agents.length === 0) throw new Error("no agents registered");
    const create = async () => deps.rpc.request("session.create", { agentId: agents[0]!.id, cwd: options.cwd }) as Promise<Session>;
    let session: Session;
    if (options.resume !== undefined) {
      // Check the project before loading the actor. Resume then performs the
      // existing frozen-config check; it must never fork or silently replace it.
      const previous = await deps.store.getSession(options.resume as Session["id"]);
      if (previous === undefined) throw new Error(`unknown session: ${options.resume}`);
      if (resolve(previous.cwd) !== options.cwd) throw new Error(`session belongs to project ${JSON.stringify(previous.cwd)}; select that directory to resume`);
      session = await deps.rpc.request("session.resume", { sessionId: previous.id }) as Session;
      const history = await deps.store.listMessages(session.id);
      for (const message of history.filter(message => message.role === "user" || message.role === "assistant" && message.content)) {
        host.write(`${message.role === "user" ? "you" : "agent"}: ${message.content}`);
      }
    } else session = await create();
    host.write(`chat: session ${session.id}`);
    host.write(`project: ${session.cwd}`);
    host.write(`data: ${deps.doctor.dataDir ?? "in-memory (configure a persistent data directory to resume after exit)"}`);
    host.write("/help for commands; /quit exits. Ctrl-C cancels the current turn; the session is kept.");
    let exitCode = 0;
    for (;;) {
      const text = await host.readMessage();
      if (text === undefined || text.trim() === "/quit" || text.trim() === "/exit") break;
      if (!text.trim()) continue;
      if (text.trim() === "/help") {
        host.write("/help  /status  /new  /quit; approvals require exactly allow or deny for one tool call.");
        continue;
      }
      if (text.trim() === "/status") {
        host.write(`session: ${session.id}\nproject: ${session.cwd}\nmodel: ${session.model.providerId}/${session.model.modelId}`);
        continue;
      }
      if (text.trim() === "/new") {
        session = await create();
        host.write(`chat: session ${session.id}`);
        continue;
      }
      const runHost = host.beginTurn();
      try {
        const result = await runSessionTurn(session, text, { ...deps, runHost });
        exitCode = result.exitCode;
        for (const line of result.lines) host.write(line);
      } finally { host.endTurn(); }
    }
    return { exitCode, lines: [`chat closed: session ${session.id}; resume with agent chat ${JSON.stringify(session.cwd)} --resume ${session.id}`] };
  } catch (error) {
    return { exitCode: 1, lines: [`agent chat: ${error instanceof Error ? error.message : String(error)}`] };
  }
}
