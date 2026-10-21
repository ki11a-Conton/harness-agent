import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { ProcessExecutor, type ExecOptions, type ExecOutcome } from "./executor.js";
import type { SandboxExecutionOption } from "./sandbox-executor.js";

const delay = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
type Pids = { parent: number; child: number };

async function ready(path: string): Promise<Pids> {
  const deadline = Date.now() + 1_500;
  while (Date.now() < deadline) {
    try { return JSON.parse(await readFile(path, "utf8")) as Pids; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT" && !(error instanceof SyntaxError)) throw error;
      await delay(10);
    }
  }
  throw new Error("real descendant did not become ready before the process deadline");
}

function cleanupPids(pids: Pids | undefined) {
  // A red regression must not leave its deliberately long-lived fixtures alive.
  for (const pid of [pids?.parent, pids?.child]) if (pid !== undefined) {
    try { process.kill(pid, "SIGKILL"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
  }
}

async function disposeFixture(root: string, pidPath: string, pids: Pids | undefined, abort: AbortController, pending: Promise<ExecOutcome>) {
  abort.abort();
  try { await pending; }
  finally {
    try {
      // The parent records spawn PIDs independently of the child's ready gate.
      // A failed readiness assertion must still clean an escaped child.
      if (pids === undefined) {
        try { pids = JSON.parse(await readFile(pidPath, "utf8")) as Pids; }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT" && !(error instanceof SyntaxError)) throw error;
        }
      }
      cleanupPids(pids);
    } finally { await rm(root, { recursive: true, force: true }); }
  }
}

function parentSource(child: string, pidPath: string, detached = false, inheritPipes = false): string {
  // Self-expiry also bounds the narrow spawn-before-PID-record failure window.
  const boundedChild = `setTimeout(()=>process.exit(0),10_000);${child}`;
  return `const fs=require('fs');setTimeout(()=>process.exit(0),10_000);const c=require('child_process').spawn(process.execPath,['-e',${JSON.stringify(boundedChild)}],{detached:${detached},stdio:${inheritPipes ? "['ignore','inherit','inherit']" : "'ignore'"}});fs.writeFileSync(${JSON.stringify(pidPath)},JSON.stringify({parent:process.pid,child:c.pid}));`;
}

function controlledSandbox(cwd: string): SandboxExecutionOption {
  // Exercise the prepared-wrapper route; this fixture claims no OS isolation.
  const selfTest = { ok: false, backendId: "lifecycle-wrapper", schemaVersion: "1.0.0", digest: "fixture-only", attempted: [], failures: [], probes: [] };
  return {
    backend: { id: selfTest.backendId, platform: process.platform, strongIsolation: false, schemaVersion: "1.0.0", wrapperArgv: () => ["/bin/sh", "-c", 'shift; exec "$@"', "lifecycle-wrapper"], selfTest: async () => selfTest },
    policy: { schemaVersion: "1.0.0", writableDirs: [cwd], readonlyDirs: [], envAllowlist: [], network: false, pidNamespace: false, maxOutputBytes: 1_024, timeoutMs: 2_000 },
    selfTest, allowInsecureLocal: true,
  };
}

function run(route: "shell" | "argv" | "sandbox", script: string, options: Omit<ExecOptions, "command">) {
  const executor = new ProcessExecutor();
  return route === "argv"
    ? executor.runArgv({ ...options, file: process.execPath, args: [script] })
    : executor.run({ ...options, command: `${JSON.stringify(process.execPath)} ${JSON.stringify(script)}`, ...(route === "sandbox" ? { sandboxExecution: controlledSandbox(options.cwd) } : {}) });
}

describe.runIf(process.platform !== "win32")("POSIX process lifecycle", () => {
  it("preserves a root exit when cancellation arrives during its cleanup", async () => {
    const abort = new AbortController();
    const realKill = process.kill.bind(process);
    const kill = vi.spyOn(process, "kill").mockImplementation((pid, signal) => {
      try { return realKill(pid, signal); }
      finally {
        // The executor can only clean this group after observing root exit.
        if (pid < 0 && signal === "SIGKILL") abort.abort();
      }
    });
    try {
      const outcome = await new ProcessExecutor().runArgv({
        file: process.execPath,
        args: ["-e", "process.stdout.write('finished 中文🙂');process.exit(7)"],
        cwd: tmpdir(), signal: abort.signal, timeoutMs: 2_000,
      });
      expect(abort.signal.aborted).toBe(true);
      expect(outcome.status).toBe("failed");
      expect(outcome.exitCode).toBe(7);
      expect(outcome.stdout).toBe("finished 中文🙂");
    } finally { kill.mockRestore(); }
  });

  it("reports a failed group signal as an error with bounded output draining", { timeout: 5_000 }, async () => {
    const abort = new AbortController();
    const realKill = process.kill.bind(process);
    let pid: number | undefined;
    let stdout = "";
    const kill = vi.spyOn(process, "kill").mockImplementation((target, signal) => {
      if (target < 0 && signal === "SIGKILL") throw Object.assign(new Error("fixture group signal denied"), { code: "EPERM" });
      return realKill(target, signal);
    });
    const pending = new ProcessExecutor().runArgv({
      file: process.execPath,
      args: ["-e", "setTimeout(()=>process.exit(0),10_000);process.stderr.write('stderr 中文🙂');process.stdout.write(JSON.stringify({pid:process.pid,text:'stdout 中文🙂'}));setInterval(()=>{},1000)"],
      cwd: tmpdir(), signal: abort.signal, timeoutMs: 2_000,
      onOutput: event => {
        if (event.stream !== "stdout") return;
        stdout += event.text;
        try { pid = (JSON.parse(stdout) as { pid: number }).pid; }
        catch { return; }
        abort.abort();
      },
    });
    try {
      const outcome = await pending;
      expect(pid).toBeDefined();
      expect(outcome.status).toBe("error");
      expect(outcome.error).toContain("process-tree termination failed: fixture group signal denied");
      expect(outcome.exitCode).toBeNull();
      expect(JSON.parse(outcome.stdout)).toEqual({ pid, text: "stdout 中文🙂" });
      expect(outcome.stderr).toBe("stderr 中文🙂");
      expect(outcome.durationMs).toBeLessThan(3_500);
      expect(() => realKill(pid!, 0)).not.toThrow();
      expect(kill).toHaveBeenCalledWith(-pid!, "SIGKILL");
    } finally {
      kill.mockRestore();
      abort.abort();
      if (pid !== undefined) {
        try { realKill(pid, "SIGKILL"); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
      }
      await pending;
    }
  });

  it.each([["shell", "timeout"], ["shell", "cancel"], ["argv", "timeout"], ["argv", "cancel"], ["sandbox", "timeout"], ["sandbox", "cancel"]] as const)(
    "%s %s cannot leave an ordinary descendant writing after the returned boundary",
    { timeout: 8_000 },
    async (route, mode) => {
      const root = await mkdtemp(join(tmpdir(), "ar-posix-terminal-"));
      const readyPath = join(root, "ready.json"), pidPath = join(root, "pids.json"), release = join(root, "release"), marker = join(root, "escaped");
      const script = join(root, "parent.cjs"), abort = new AbortController();
      const child = `const fs=require('fs');fs.writeFileSync(${JSON.stringify(readyPath)},JSON.stringify({parent:process.ppid,child:process.pid}));setInterval(()=>{if(fs.existsSync(${JSON.stringify(release)})){fs.writeFileSync(${JSON.stringify(marker)},'wrote after terminal');process.exit(0)}},10)`;
      await writeFile(script, parentSource(child, pidPath));
      const pending = run(route, script, { cwd: root, signal: abort.signal, timeoutMs: mode === "timeout" ? 2_000 : 5_000 });
      let pids: Pids | undefined;
      try {
        pids = await ready(readyPath);
        if (mode === "cancel") abort.abort();
        const outcome = await pending;
        expect(outcome.status).toBe(mode === "cancel" ? "cancelled" : "timeout");
        expect(outcome.exitCode).toBeNull();
        await writeFile(release, "only released after the command returned");
        await delay(120);
        await expect(readFile(marker)).rejects.toMatchObject({ code: "ENOENT" });
      } finally {
        await disposeFixture(root, pidPath, pids, abort, pending);
      }
    },
  );

  it.each([["shell", 0], ["shell", 7], ["argv", 0], ["argv", 7], ["sandbox", 0], ["sandbox", 7]] as const)(
    "%s preserves root exit %i when an ordinary descendant inherits both output pipes",
    { timeout: 5_000 },
    async (route, exitCode) => {
      const root = await mkdtemp(join(tmpdir(), "ar-posix-pipes-"));
      const readyPath = join(root, "ready.json"), pidPath = join(root, "pids.json"), script = join(root, "parent.cjs");
      const release = join(root, "release"), marker = join(root, "escaped"), abort = new AbortController();
      const child = `const fs=require('fs');fs.writeFileSync(${JSON.stringify(readyPath)},JSON.stringify({parent:process.ppid,child:process.pid}));setInterval(()=>{if(fs.existsSync(${JSON.stringify(release)})){fs.writeFileSync(${JSON.stringify(marker)},'wrote after root exit');process.exit(0)}},10)`;
      await writeFile(script, parentSource(child, pidPath, false, true) + `const poll=setInterval(()=>{if(fs.existsSync(${JSON.stringify(readyPath)})){clearInterval(poll);process.stdout.write('root stdout 中文🙂');process.stderr.write('root stderr 中文🙂');process.exit(${exitCode})}},5)`);
      const pending = run(route, script, { cwd: root, signal: abort.signal, timeoutMs: 2_000 });
      let pids: Pids | undefined;
      try {
        pids = await ready(readyPath);
        const outcome = await pending;
        expect(outcome.status).toBe(exitCode === 0 ? "success" : "failed");
        expect(outcome.exitCode).toBe(exitCode);
        expect(outcome.durationMs).toBeLessThan(2_000);
        expect(outcome.stdout).toBe("root stdout 中文🙂");
        expect(outcome.stderr).toBe("root stderr 中文🙂");
        await writeFile(release, "released after natural exit returned");
        await delay(120);
        await expect(readFile(marker)).rejects.toMatchObject({ code: "ENOENT" });
      } finally {
        await disposeFixture(root, pidPath, pids, abort, pending);
      }
    },
  );

  it("bounds pipe draining when a descendant deliberately escapes the owned process group", { timeout: 5_000 }, async () => {
    const root = await mkdtemp(join(tmpdir(), "ar-posix-escaped-pipe-"));
    const readyPath = join(root, "ready.json"), pidPath = join(root, "pids.json"), script = join(root, "parent.cjs"), abort = new AbortController();
    const child = `require('fs').writeFileSync(${JSON.stringify(readyPath)},JSON.stringify({parent:process.ppid,child:process.pid}));setInterval(()=>{},1000)`;
    await writeFile(script, parentSource(child, pidPath, true, true) + `const poll=setInterval(()=>{if(fs.existsSync(${JSON.stringify(readyPath)})){clearInterval(poll);process.stdout.write('completed root');process.exit(0)}},5)`);
    const pending = run("argv", script, { cwd: root, signal: abort.signal, timeoutMs: 2_000 });
    let pids: Pids | undefined;
    try {
      pids = await ready(readyPath);
      const outcome = await pending;
      expect(outcome.status).toBe("success"); expect(outcome.exitCode).toBe(0);
      expect(outcome.stdout).toBe("completed root"); expect(outcome.durationMs).toBeLessThan(2_000);
      // Process groups are lifecycle ownership, not a sandbox against daemons.
      expect(() => process.kill(pids!.child, 0)).not.toThrow();
    } finally {
      await disposeFixture(root, pidPath, pids, abort, pending);
    }
  });
});
