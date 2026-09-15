import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ProcessExecutor } from "./executor.js";

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