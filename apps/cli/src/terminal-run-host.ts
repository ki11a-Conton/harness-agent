import { createInterface } from "node:readline";
import type { CommandDeps } from "./commands.js";

/** One persistent input queue also supports piped approval answers. EOF denies
 * pending operations; Ctrl-C cancels the live turn through the runtime RPC. */
export function createTerminalRunHost(): NonNullable<CommandDeps["runHost"]> & { close(): void } {
  const rl = createInterface({ input: process.stdin, terminal: false });
  const controller = new AbortController();
  const lines: string[] = [];
  let ended = false;
  let waiter: (() => void) | undefined;
  rl.on("line", line => { lines.push(line); waiter?.(); });
  rl.on("close", () => { ended = true; waiter?.(); });
  const interrupt = () => controller.abort();
  process.on("SIGINT", interrupt);
  return {
    signal: controller.signal,
    started(sessionId, turnId) { process.stdout.write(`run started: session ${sessionId} turn ${turnId}\n`); },
    async approve(request, signal) {
      process.stderr.write(`approval ${request.id}: ${JSON.stringify(request.action)} ${JSON.stringify(request.target)}\nreason: ${JSON.stringify(request.reason)}\nallow/deny> `);
      if (request.capability !== undefined) process.stderr.write(`\ncapability: ${JSON.stringify(request.capability)}\nallow/deny> `);
      while (!ended && !signal.aborted && lines.length === 0) {
        await new Promise<void>(resolve => {
          waiter = () => resolve();
          signal.addEventListener("abort", waiter, { once: true });
        });
        signal.removeEventListener("abort", waiter!);
        waiter = undefined;
      }
      const value = signal.aborted ? "deny" : lines.shift()?.trim().toLowerCase();
      if (value !== "allow") {
        process.stderr.write("denied (enter exactly allow to authorize one call)\n");
        return "deny";
      }
      process.stderr.write("allowed for this call\n");
      return "allow";
    },
    close() { process.off("SIGINT", interrupt); rl.close(); },
  };
}
