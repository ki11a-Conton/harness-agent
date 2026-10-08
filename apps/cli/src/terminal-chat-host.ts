import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";
import type { CommandDeps } from "./commands.js";

/** A single input owner routes lines to either the composer or one approval.
 * There are never two readline interfaces competing for stdin. */
export function createTerminalChatHost(options: { input?: Readable; output?: Writable; error?: Writable } = {}):
  NonNullable<CommandDeps["chatHost"]> & { close(): void } {
  const input = options.input ?? process.stdin;
  const output = options.output ?? process.stdout;
  const error = options.error ?? process.stderr;
  const rl = createInterface({ input, terminal: false });
  const queue: string[] = [];
  let ended = false;
  let hardClosed = false;
  let wake: (() => void) | undefined;
  let active: AbortController | undefined;
  rl.on("line", line => { queue.push(line); wake?.(); });
  rl.on("close", () => { ended = true; wake?.(); });
  const interrupt = () => {
    if (active !== undefined) { active.abort(); error.write("\nCancelling current turn; conversation kept.\n"); }
    else { hardClosed = true; ended = true; queue.length = 0; wake?.(); }
  };
  process.on("SIGINT", interrupt);
  const read = async (signal?: AbortSignal): Promise<string | undefined> => {
    while (!ended && !signal?.aborted && queue.length === 0) {
      await new Promise<void>(resolve => {
        wake = () => resolve();
        signal?.addEventListener("abort", wake, { once: true });
      });
      if (wake !== undefined) signal?.removeEventListener("abort", wake);
      wake = undefined;
    }
    return hardClosed || signal?.aborted ? undefined : queue.shift();
  };
  return {
    write(line) { output.write(`${line}\n`); },
    async readMessage() { output.write("you> "); return read(); },
    beginTurn() {
      if (hardClosed) throw new Error("chat input is closed");
      active = new AbortController();
      return {
        signal: active.signal,
        started(sessionId, turnId) { output.write(`run started: session ${sessionId} turn ${turnId}\n`); },
        event(event) {
          if (event.type === "model.started") output.write("[thinking]\n");
          else if (event.type === "tool.requested") output.write(`[tool] ${JSON.stringify(event.payload.name ?? "tool")}\n`);
          else if (event.type === "verification.started") output.write("[verification] running configured check\n");
          else if (event.type === "run.limit_reached") output.write(`[limit] ${JSON.stringify(event.payload.limit)}\n`);
        },
        async approve(request, signal) {
          error.write(`approval ${request.id}: ${JSON.stringify(request.action)} ${JSON.stringify(request.target)}\nreason: ${JSON.stringify(request.reason)}\n`);
          if (request.capability !== undefined) error.write(`capability: ${JSON.stringify(request.capability)}\n`);
          error.write("allow/deny> ");
          const value = (await read(signal))?.trim().toLowerCase();
          const allowed = value === "allow" && !signal.aborted;
          error.write(allowed ? "allowed for this call\n" : "denied (enter exactly allow to authorize one call)\n");
          return allowed ? "allow" : "deny";
        },
      };
    },
    endTurn() { active = undefined; },
    close() { process.off("SIGINT", interrupt); hardClosed = true; ended = true; queue.length = 0; active?.abort(); wake?.(); rl.close(); },
  };
}
