import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

/** Isolate a baseline deadlock so its actor cannot hang the Vitest teardown.
 * The checked-in fixture runs the actual built production host and HTTP stack;
 * it changes only the offline model and the explicitly tested append failure. */
async function isolated(stage: "normal" | "before" | "after") {
  const fixture = fileURLToPath(new URL("../../test-infra/terminal-observer-http-fixture.mjs", import.meta.url));
  const child = spawn(process.execPath, [fixture, stage], { stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  child.stdout.on("data", chunk => { output += String(chunk); });
  child.stderr.on("data", chunk => { output += String(chunk); });
  const stopped = new Promise<{ code: number | null; error?: Error }>(resolve => {
    child.once("error", error => { resolve({ code: null, error }); });
    child.once("close", code => { resolve({ code }); });
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const ended = await Promise.race([stopped, new Promise<never>((_done, reject) => {
      timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error(`Isolated host exceeded its owned watchdog\n${output}`)); }, 18_000);
    })]);
    if (ended.error !== undefined) throw ended.error;
    const receipt = output.split("\n").find(line => line.startsWith("TERMINAL_OBSERVER_RECEIPT "));
    expect(receipt, output).toBeDefined();
    const result = JSON.parse(receipt!.slice("TERMINAL_OBSERVER_RECEIPT ".length));
    expect(ended.code, output).toBe(0);
    expect(result, output).toMatchObject({ status: "PASS", stage, models: 3, terminals: 1, changes: 1, terminalAwaiting: false });
  } finally {
    clearTimeout(timer);
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await stopped;
  }
}

it.each(["normal", "before", "after"] as const)("production HTTP terminal observers finish after %s publication without reentering recovery", isolated, 20_000);
