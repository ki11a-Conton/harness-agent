import { execSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ProcessExecutor, planArgvLaunch, resolveWindowsCommand } from "./executor.js";

let ws = "";

beforeAll(() => {
  ws = mkdtempSync(join(tmpdir(), "ar-exec-"));
});

afterAll(() => rmSync(ws, { recursive: true, force: true }));

const NODE = process.execPath;

describe("ProcessExecutor (EXEC-001)", () => {
  it("runs a command to success and captures stdout", async () => {
    const exe = new ProcessExecutor();
    const out = await exe.run({ command: `${JSON.stringify(NODE)} -e "process.stdout.write('hello')"`, cwd: ws });
    expect(out.status).toBe("success");
    expect(out.exitCode).toBe(0);
    expect(out.stdout).toBe("hello");
  });

  it("reports failed status on nonzero exit", async () => {
    const exe = new ProcessExecutor();
    const out = await exe.run({ command: `${JSON.stringify(NODE)} -e "process.exit(3)"`, cwd: ws });
    expect(out.status).toBe("failed");
    expect(out.exitCode).toBe(3);
    expect(out.error).toContain("3");
  });

  it("captures stderr separately", async () => {
    const exe = new ProcessExecutor();
    const out = await exe.run({ command: `${JSON.stringify(NODE)} -e "process.stderr.write('oops')"`, cwd: ws });
    expect(out.status).toBe("success");
    expect(out.stderr).toBe("oops");
    expect(out.stdout).toBe("");
  });

  it("streams chunks through onOutput", async () => {
    const exe = new ProcessExecutor();
    const chunks: string[] = [];
    const out = await exe.run({
      command: `${JSON.stringify(NODE)} -e "process.stdout.write('a'); process.stdout.write('b')"`,
      cwd: ws,
      onOutput: (c) => chunks.push(c.text),
    });
    expect(out.status).toBe("success");
    expect(chunks.join("")).toBe("ab");
  });

  it("times out and reports PROCESS_TIMEOUT", async () => {
    const exe = new ProcessExecutor();
    const out = await exe.run({
      command: `${JSON.stringify(NODE)} -e "setTimeout(()=>{}, 10000)"`,
      cwd: ws,
      timeoutMs: 250,
    });
    expect(out.status).toBe("timeout");
    expect(out.error).toContain("timed out");
  });

  it("kills the process tree on timeout (no orphan)", async () => {
    const exe = new ProcessExecutor();
    const out = await exe.run({
      // Spawns a child that outlives the parent; tree kill must reap it.
      command: `${JSON.stringify(NODE)} -e "const {spawn}=require('child_process'); spawn(process.execPath,['-e','setTimeout(()=>{},10000)'],{detached:true}); setTimeout(()=>{},10000)"`,
      cwd: ws,
      timeoutMs: 300,
    });
    expect(out.status).toBe("timeout");
  });

  it("returns cancelled when the signal aborts", async () => {
    const ac = new AbortController();
    const exe = new ProcessExecutor();
    const p = exe.run({
      command: `${JSON.stringify(NODE)} -e "setTimeout(()=>{}, 10000)"`,
      cwd: ws,
      signal: ac.signal,
    });
    setTimeout(() => ac.abort(), 100);
    const out = await p;
    expect(out.status).toBe("cancelled");
  });

  it("truncates oversized output", async () => {
    const exe = new ProcessExecutor();
    const out = await exe.run({
      command: `${JSON.stringify(NODE)} -e "process.stdout.write('x'.repeat(10000))"`,
      cwd: ws,
      maxOutputBytes: 100,
    });
    expect(out.status).toBe("success");
    expect(out.truncated).toBe(true);
    expect(out.stdout.length).toBeLessThanOrEqual(100);
  });

  it("honors cwd and env", async () => {
    writeFileSync(join(ws, "marker.txt"), "here");
    const exe = new ProcessExecutor();
    const out = await exe.run({
      command: `${JSON.stringify(NODE)} -e "process.stdout.write(process.cwd() + '|' + process.env.MARKER)"`,
      cwd: ws,
      env: { MARKER: "42" },
    });
    expect(out.status).toBe("success");
    expect(out.stdout).toBe(`${ws}|42`);
  });
});

/**
 * E4-R79 (F79-2): structured argv execution.
 *
 * The shell path (`command: string`) is the legacy, recipe-shaped contract. It
 * is unsuitable for STRUCTURED `command + args` because the platform shell
 * re-interprets the argument text. These tests pin the argv contract that
 * `TaskVerifier` now uses for structured verification specs: the file is
 * spawned directly with `shell: false`, so every argument reaches the child
 * byte-for-byte and no metacharacter can start a second command.
 */
describe("E4-R79: ProcessExecutor argv execution (shell:false, no re-interpretation)", () => {
  /** Echo back the argv the child actually received, as JSON. */
  const ECHO_ARGV = "process.stdout.write(JSON.stringify(process.argv.slice(1)))";

  it("delivers every argument verbatim, including shell metacharacters", async () => {
    const exe = new ProcessExecutor();
    // Each entry would change meaning (or spawn a second command) if it were
    // ever round-tripped through cmd.exe or /bin/sh.
    const payload = [
      "plain",
      "with space",
      "single'quote",
      'double"quote',
      "back\\slash",
      "paren(s)",
      "$DOLLAR",
      "amp&ersand",
      "semi;colon",
      "pipe|x",
      "glob*star",
      "angle<gt>",
      "bang!",
      "new\nline",
      "空 格 汉 字",
      "",
    ];
    const out = await exe.runArgv({
      file: NODE,
      args: ["-e", ECHO_ARGV, ...payload],
      cwd: ws,
    });
    expect(out.status).toBe("success");
    expect(JSON.parse(out.stdout)).toEqual(payload);
  });

  it("does not let a metacharacter argument run a second command", async () => {
    const exe = new ProcessExecutor();
    const out = await exe.runArgv({
      file: NODE,
      args: ["-e", ECHO_ARGV, "a&echo INJECTED", "b;echo INJECTED", "c|echo INJECTED", "d`echo x`"],
      cwd: ws,
    });
    expect(out.status).toBe("success");
    // Exactly the four args came back — nothing was split, nothing executed.
    expect(JSON.parse(out.stdout)).toEqual(["a&echo INJECTED", "b;echo INJECTED", "c|echo INJECTED", "d`echo x`"]);
    expect(out.stdout).not.toContain("INJECTED\n");
  });

  it("reports a real nonzero exit code from the argv path", async () => {
    const exe = new ProcessExecutor();
    const out = await exe.runArgv({ file: NODE, args: ["-e", "process.exit(7)"], cwd: ws });
    expect(out.status).toBe("failed");
    expect(out.exitCode).toBe(7);
  });

  it("reports error status when the executable does not exist", async () => {
    const exe = new ProcessExecutor();
    const out = await exe.runArgv({ file: join(ws, "definitely-not-here-9f3a"), args: [], cwd: ws });
    expect(out.status).toBe("error");
    expect(out.exitCode).toBeNull();
  });

  it("honors timeout, cancellation, output cap and env on the argv path", async () => {
    const exe = new ProcessExecutor();
    const timed = await exe.runArgv({
      file: NODE,
      args: ["-e", "setTimeout(()=>{}, 10000)"],
      cwd: ws,
      timeoutMs: 250,
    });
    expect(timed.status).toBe("timeout");

    const ac = new AbortController();
    const pending = exe.runArgv({ file: NODE, args: ["-e", "setTimeout(()=>{}, 10000)"], cwd: ws, signal: ac.signal });
    setTimeout(() => ac.abort(), 100);
    expect((await pending).status).toBe("cancelled");

    const capped = await exe.runArgv({
      file: NODE,
      args: ["-e", "process.stdout.write('x'.repeat(10000))"],
      cwd: ws,
      maxOutputBytes: 100,
    });
    expect(capped.truncated).toBe(true);
    expect(capped.stdout.length).toBeLessThanOrEqual(100);

    const envd = await exe.runArgv({
      file: NODE,
      args: ["-e", "process.stdout.write(String(process.env.ARGV_MARKER))"],
      cwd: ws,
      env: { ARGV_MARKER: "ok" },
    });
    expect(envd.stdout).toBe("ok");
  });

  it("rejects a run() call that provides neither a command string nor argv", async () => {
    const exe = new ProcessExecutor();
    await expect(
      exe.run({ cwd: ws } as unknown as Parameters<ProcessExecutor["run"]>[0]),
    ).rejects.toThrow(/either `command`/i);
  });
});

/**
 * E4-R91 (H1): Windows script-shim determinism.
 *
 * MEASURED on Windows before this fix (raw `spawn(..., {shell:false})`, the
 * exact contract `runArgv` used):
 *
 *   node.exe + script arg            -> exit 0            (works)
 *   bare `node`                      -> exit 0            (CreateProcess appends .exe)
 *   C:\...\x.cmd  (full path)        -> EINVAL            (cannot execute)
 *   bare `npm` / `npx` -> *.cmd      -> ENOENT            (CreateProcess does not
 *                                                          try .cmd, only .exe)
 *   C:\...\x.ps1  (full path)        -> EFTYPE            (not an executable image)
 *
 * So every benchmark command verifier declared as `npx` (reg-27) or `bash`
 * (reg-25) was UNSPAWNABLE on Windows, while the same case passed elsewhere —
 * a platform-dependent false failure, which is what H1 reports.
 *
 * The contract these tests pin:
 *   - a bare name is resolved through PATH + PATHEXT (as the shell would);
 *   - `.exe`/`.com`/no-extension still spawn DIRECTLY with `shell:false`;
 *   - `.cmd`/`.bat` run via `cmd.exe /d /c <script> <args…>` — still with
 *     `shell:false`, and ONLY when no argument contains a cmd metacharacter,
 *     because cmd.exe re-parses and would otherwise run a SECOND command;
 *   - `.ps1` runs via `powershell -File <script> <args…>` with separate argv,
 *     which transports every argument literally;
 *   - anything else that cannot be launched safely FAILS CLOSED with an
 *     actionable reason instead of silently mis-executing.
 *
 * The R79 security boundary is unchanged and re-asserted here: nothing is ever
 * handed to a shell as one string, and no metacharacter argument may start a
 * second command.
 */
const isWindows = process.platform === "win32";

describe.skipIf(!isWindows)("E4-R91: Windows script shims run deterministically (H1)", () => {
  let shimDir = "";

  beforeAll(() => {
    shimDir = mkdtempSync(join(tmpdir(), "ar-r91-"));
  });

  afterAll(() => rmSync(shimDir, { recursive: true, force: true }));

  /** A .cmd shim that echoes its arguments and exits 0. */
  function writeCmd(name: string, body: string): string {
    const p = join(shimDir, name);
    writeFileSync(p, body, "utf8");
    return p;
  }

  it("runs a .cmd shim by FULL PATH and delivers its arguments", async () => {
    const exe = new ProcessExecutor();
    const shim = writeCmd("args.cmd", ["@echo off", "echo GOT %1 %2 %3", "exit /b 0", ""].join("\r\n"));

    const out = await exe.runArgv({ file: shim, args: ["tsc", "--noEmit", "src/ann.ts"], cwd: ws });

    expect(out.status).toBe("success");
    expect(out.exitCode).toBe(0);
    expect(out.stdout).toContain("GOT tsc --noEmit src/ann.ts");
  });

  it("resolves a BARE command name through PATH+PATHEXT (the reg-27 `npx` shape)", async () => {
    const exe = new ProcessExecutor();
    writeCmd("r91tool.cmd", ["@echo off", "echo TOOL %1", "exit /b 0", ""].join("\r\n"));

    // The shim is reachable only by bare name, exactly like `npx` on a real box.
    const out = await exe.runArgv({
      file: "r91tool",
      args: ["ran"],
      cwd: ws,
      env: { PATH: `${shimDir};${process.env.PATH ?? ""}` },
    });

    expect(out.status).toBe("success");
    expect(out.stdout).toContain("TOOL ran");
  });

  it("runs a .ps1 script and transports a dash-leading argument literally", async () => {
    const exe = new ProcessExecutor();
    const ps1 = join(shimDir, "args.ps1");
    // `$args` receives everything that is not bound to a declared parameter,
    // which is what makes `-File` faithful for dash-leading arguments.
    writeFileSync(
      ps1,
      ["$o = ($args | ForEach-Object { \"[$_]\" }) -join ''", "Write-Output $o", "exit 0", ""].join("\n"),
      "utf8",
    );

    const out = await exe.runArgv({ file: ps1, args: ["tsc", "--noEmit", "src/ann.ts"], cwd: ws });

    expect(out.status).toBe("success");
    expect(out.stdout.trim()).toBe("[tsc][--noEmit][src/ann.ts]");
  });

  it("REFUSES a .cmd argument containing a cmd metacharacter, so no second command can run", async () => {
    const exe = new ProcessExecutor();
    const shim = writeCmd("noop.cmd", ["@echo off", "echo RAN", "exit /b 0", ""].join("\r\n"));
    const sentinel = join(shimDir, "PWNED-r91.txt");

    // Measured: handed to cmd.exe, this payload DOES create the sentinel —
    // `&…&rem` survives the shim's `%*` re-expansion. It must never be launched.
    const out = await exe.runArgv({
      file: shim,
      args: [`a&echo PWNED>${sentinel}&rem`],
      cwd: ws,
    });

    expect(out.status).toBe("error");
    expect(out.error ?? "").toMatch(/metacharacter|refus/i);
    expect(existsSync(sentinel)).toBe(false);
  });

  it("still honors cwd, timeout and cancellation through the shim path", async () => {
    const exe = new ProcessExecutor();
    const cwdProbe = join(shimDir, "cwd.cmd");
    writeFileSync(cwdProbe, ["@echo off", "cd", "exit /b 0", ""].join("\r\n"), "utf8");

    const inDir = await exe.runArgv({ file: cwdProbe, args: [], cwd: ws });
    expect(inDir.status).toBe("success");
    expect(inDir.stdout.toLowerCase()).toContain(ws.toLowerCase());

    // A long-running shim with a UNIQUE marker so the survivors can be counted
    // afterwards. `ping` keeps a real grandchild (PING.EXE) alive, which is what
    // makes this a tree-kill test rather than a single-process test.
    const marker = `r91slow${Date.now()}`;
    const slow = writeCmd(
      "slow.cmd",
      ["@echo off", `title ${marker}`, "ping -n 30 127.0.0.1 >nul", "exit /b 0", ""].join("\r\n"),
    );
    const survivors = () => {
      try {
        const listing = execSync('wmic process get processid,commandline /format:csv', {
          encoding: "utf8",
          windowsHide: true,
          stdio: ["ignore", "pipe", "ignore"],
        });
        return listing.split("\n").filter((l) => l.includes(marker) || l.includes(slow)).length;
      } catch {
        return 0;
      }
    };

    const timed = await exe.runArgv({ file: slow, args: [], cwd: ws, timeoutMs: 400 });
    expect(timed.status).toBe("timeout");
    expect(timed.error ?? "").toMatch(/timed out/i);

    const ac = new AbortController();
    const pending = exe.runArgv({ file: slow, args: [], cwd: ws, signal: ac.signal });
    setTimeout(() => ac.abort(), 150);
    const cancelled = await pending;
    expect(cancelled.status).toBe("cancelled");

    // R91 acceptance: timeout and cancellation must actually TERMINATE the child
    // (and its descendants), not merely report a failure status. `taskkill` is
    // fire-and-forget, so give the tree a bounded moment to settle, then assert
    // no marked process survives.
    let remaining = survivors();
    for (let i = 0; i < 20 && remaining > 0; i++) {
      await new Promise((r) => setTimeout(r, 100));
      remaining = survivors();
    }
    expect(remaining).toBe(0);
  });

  it("propagates a real nonzero exit code from a .cmd shim", async () => {
    const exe = new ProcessExecutor();
    const fail = writeCmd("fail.cmd", ["@echo off", "exit /b 7", ""].join("\r\n"));

    const out = await exe.runArgv({ file: fail, args: [], cwd: ws });
    expect(out.status).toBe("failed");
    expect(out.exitCode).toBe(7);
  });
});

/**
 * E4-R91: the launch decision table, tested on EVERY platform.
 *
 * `planArgvLaunch` is pure and takes the platform as a parameter, so the
 * Windows routing rules are asserted on Ubuntu too — otherwise a Linux-only CI
 * would never exercise the branch that decides how `npx`/`bash` are launched,
 * and the Windows-specific execution tests above would be the only coverage.
 */
describe("E4-R91: argv launch planning (platform-parameterised)", () => {
  const winEnv: NodeJS.ProcessEnv = { PATHEXT: ".COM;.EXE;.BAT;.CMD", ComSpec: "C:\\Windows\\system32\\cmd.exe" };

  it("POSIX passes the file through untouched (the kernel handles shebangs)", () => {
    const plan = planArgvLaunch("bash", ["-c", "true"], winEnv, "linux");
    expect(plan).toEqual({ ok: true, file: "bash", args: ["-c", "true"], via: "direct" });
  });

  it("win32 routes a .cmd/.bat shim through cmd.exe with SEPARATE argv", () => {
    const dir = mkdtempSync(join(tmpdir(), "ar-r91-plan-"));
    try {
      const shim = join(dir, "tool.cmd");
      writeFileSync(shim, "@echo off\r\n", "utf8");
      const plan = planArgvLaunch(shim, ["--version"], winEnv, "win32");
      expect(plan).toEqual({
        ok: true,
        file: winEnv.ComSpec,
        args: ["/d", "/c", shim, "--version"],
        via: "cmd",
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("win32 resolves a BARE name through PATH+PATHEXT and prefers .exe order", () => {
    const dir = mkdtempSync(join(tmpdir(), "ar-r91-path-"));
    try {
      // PATHEXT order is .COM;.EXE;.BAT;.CMD — with no .exe present, .cmd wins.
      const shim = join(dir, "toolname.cmd");
      writeFileSync(shim, "@echo off\r\n", "utf8");
      const env = { ...winEnv, PATH: dir };
      // The resolved spelling takes the extension from PATHEXT (`.CMD`), which
      // Windows treats as the same file as the on-disk lowercase name — so
      // compare case-insensitively rather than asserting a spelling.
      const eq = (a: string | null, b: string) => a !== null && a.toLowerCase() === b.toLowerCase();
      expect(eq(resolveWindowsCommand("toolname", env), shim)).toBe(true);
      expect(eq(resolveWindowsCommand("toolname.cmd", env), shim)).toBe(true);
      expect(resolveWindowsCommand("toolname.exe", env)).toBeNull();
      expect(resolveWindowsCommand("no-such-tool-91", env)).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("win32 FAILS CLOSED when a .cmd argument carries a cmd metacharacter", () => {
    const dir = mkdtempSync(join(tmpdir(), "ar-r91-refuse-"));
    try {
      const shim = join(dir, "tool.cmd");
      writeFileSync(shim, "@echo off\r\n", "utf8");
      // Every one of these was measured to be mis-transported by cmd.exe; `&…&rem`
      // actually created a sentinel file. None may be launched.
      for (const bad of ["a&b", "a|b", "a>b", "a<b", "a^b", "a%b%", 'a"b', "a!b", "a(b)", "a\nb"]) {
        const plan = planArgvLaunch(shim, [bad], winEnv, "win32");
        expect(plan.ok, `must refuse ${JSON.stringify(bad)}`).toBe(false);
        if (!plan.ok) expect(plan.reason).toMatch(/cmd metacharacter/i);
      }
      // Benign arguments — the real benchmark shapes — are still allowed.
      const ok = planArgvLaunch(shim, ["tsc", "--noEmit", "src/ann.ts"], winEnv, "win32");
      expect(ok.ok).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("win32 FAILS CLOSED for an unsupported script type instead of guessing", () => {
    const dir = mkdtempSync(join(tmpdir(), "ar-r91-unsup-"));
    try {
      const weird = join(dir, "tool.wsf");
      writeFileSync(weird, "x", "utf8");
      const plan = planArgvLaunch(weird, [], winEnv, "win32");
      expect(plan.ok).toBe(false);
      if (!plan.ok) expect(plan.reason).toMatch(/deterministically/i);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("win32 routes .ps1 through PowerShell with -File and separate argv", () => {
    const dir = mkdtempSync(join(tmpdir(), "ar-r91-ps-"));
    try {
      const script = join(dir, "tool.ps1");
      writeFileSync(script, "exit 0\n", "utf8");
      const plan = planArgvLaunch(script, ["--noEmit", "a b"], winEnv, "win32");
      expect(plan.ok).toBe(true);
      if (plan.ok) {
        expect(plan.via).toBe("powershell");
        expect(plan.args.slice(0, 4)).toEqual(["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass"]);
        expect(plan.args.slice(4, 6)).toEqual(["-File", script]);
        // Dash-leading and space-bearing arguments survive as single argv entries.
        expect(plan.args.slice(6)).toEqual(["--noEmit", "a b"]);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("an unresolvable win32 name is still spawned directly, so the real ENOENT surfaces", () => {
    const plan = planArgvLaunch("definitely-not-here-91", [], { ...winEnv, PATH: "C:\\nope" }, "win32");
    expect(plan).toEqual({ ok: true, file: "definitely-not-here-91", args: [], via: "direct" });
  });

  /**
   * Windows stores `Path` and `PATH` as ONE environment variable with a
   * case-insensitive name: `process.env.PATH` is a getter that reads the real
   * `Path` entry, and `{ ...process.env }` copies only the key that physically
   * exists (`Path`). A spread therefore LOSES `PATH`, and PATH lookup silently
   * finds nothing — which is how the first version of this fix passed its unit
   * tests while still returning `spawn npx ENOENT` end-to-end.
   */
  it("resolves PATH case-insensitively, so an env SPREAD does not lose it", () => {
    const dir = mkdtempSync(join(tmpdir(), "ar-r91-case-"));
    try {
      const shim = join(dir, "casetool.cmd");
      writeFileSync(shim, "@echo off\r\n", "utf8");
      const eq = (a: string | null) => a !== null && a.toLowerCase() === shim.toLowerCase();
      // Every casing Windows itself may report for the same variable.
      for (const key of ["PATH", "Path", "path", "pAtH"]) {
        expect(eq(resolveWindowsCommand("casetool", { PATHEXT: ".CMD", [key]: dir })), `key ${key}`).toBe(true);
      }
      // The spread shape is the one that actually broke: emulate it exactly.
      const spreadLike = Object.fromEntries(
        Object.entries({ Path: dir, PATHEXT: ".CMD" }),
      ) as NodeJS.ProcessEnv;
      expect(eq(resolveWindowsCommand("casetool", spreadLike))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // E4-R92 fix: this test SPAWNS a `.cmd` shim, so it is Windows-only.
  //
  // It previously sat in an unguarded describe block and ran on Linux too,
  // where it failed: `planArgvLaunch` correctly passes the bare name straight to
  // POSIX spawn, and POSIX has no PATHEXT, so a file that exists only as
  // `r91endtoend.cmd` is not found (`spawn r91endtoend ENOENT`). The defect was
  // invisible locally because the author's box is Windows, and it surfaced only
  // as a red `offline cold-start (ubuntu)` job — the one job that runs these
  // executor tests on Linux. `skipIf` rather than an early `return`, so a POSIX
  // run reports SKIPPED and cannot be mistaken for a real pass. The POSIX
  // DECISION is still covered above by "POSIX passes the file through
  // untouched", which is pure and needs no spawn.
  it.skipIf(!isWindows)("runs a real .cmd shim resolved by BARE NAME through runArgv end-to-end", async () => {
    // The unit-level plan test above cannot catch a PATH that the executor
    // itself dropped, so this asserts the whole path: runArgv must resolve the
    // bare name from the ambient environment and actually execute it.
    const exe = new ProcessExecutor();
    const dir = mkdtempSync(join(tmpdir(), "ar-r91-e2e-"));
    try {
      const shim = join(dir, "r91endtoend.cmd");
      writeFileSync(shim, ["@echo off", "echo E2E_OK %1", "exit /b 0", ""].join("\r\n"), "utf8");
      const out = await exe.runArgv({
        file: "r91endtoend",
        args: ["arg"],
        cwd: ws,
        env: { PATH: `${dir};${process.env.PATH ?? ""}` },
      });
      expect(out.status).toBe("success");
      expect(out.stdout).toContain("E2E_OK arg");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});