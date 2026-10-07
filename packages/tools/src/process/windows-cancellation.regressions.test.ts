import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ProcessExecutor } from "./executor.js";

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
    throw error;
  }
}

describe.runIf(process.platform === "win32")("Windows native process-tree completion boundary", () => {
  it.each(["cancel", "timeout"] as const)("%s waits for both the child and its real grandchild to terminate", { timeout: 30_000 }, async (mode) => {
    const root = await mkdtemp(join(tmpdir(), "ar-windows-reap-"));
    const ready = join(root, "ready.json"); const release = join(root, "release"); const escaped = join(root, "escaped");
    const abort = new AbortController();
    const descendant = `const fs=require('fs');fs.writeFileSync(${JSON.stringify(ready)},JSON.stringify({parentPid:process.ppid,childPid:process.pid}));setInterval(()=>{if(fs.existsSync(${JSON.stringify(release)})){fs.writeFileSync(${JSON.stringify(escaped)},'bad');process.exit(0)}},10)`;
    const parent = `require('child_process').spawn(process.execPath,['-e',${JSON.stringify(descendant)}],{stdio:'ignore'});setInterval(()=>{},1000)`;
    const pending = new ProcessExecutor().runArgv({ file: process.execPath, args: ["-e", parent], cwd: root, signal: abort.signal, timeoutMs: mode === "timeout" ? 8_000 : 20_000 });
    try {
      let pids: { parentPid: number; childPid: number } | undefined;
      const deadline = Date.now() + 7_000;
      while (Date.now() < deadline) {
        try { pids = JSON.parse(await readFile(ready, "utf8")); break; }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT" && !(error instanceof SyntaxError)) throw error;
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
      }
      expect(pids, "a real grandchild must start before termination is exercised").toBeDefined();
      expect(alive(pids!.parentPid)).toBe(true); expect(alive(pids!.childPid)).toBe(true);
      if (mode === "cancel") abort.abort();
      expect((await pending).status).toBe(mode === "cancel" ? "cancelled" : "timeout");
      // Inspect the actual PIDs immediately at the returned boundary. Missing
      // WMIC or an inspection error must never be translated into zero survivors.
      expect(alive(pids!.parentPid)).toBe(false); expect(alive(pids!.childPid)).toBe(false);
      await writeFile(release, "released after completion");
      await new Promise((resolve) => setTimeout(resolve, 100));
      await expect(readFile(escaped)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      abort.abort(); await pending;
      await rm(root, { recursive: true, force: true });
    }
  });
});
