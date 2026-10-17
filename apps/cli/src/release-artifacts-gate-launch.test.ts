import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { collectReleaseArtifacts, runGateCommand } from "./release-artifacts.js";

/**
 * CLI-001: step 9 of `agent release artifacts` declares the gate command as
 * `["pnpm","capability:audit"]` (that DECLARATION is the gate's identity and
 * must not change) but the default runner execFile()s it with shell:false,
 * which is ENOENT on Windows. The launch must be resolved per platform while
 * the recorded command stays exactly as declared.
 */

let dir = "";
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "gate-launch-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function writeShims(): Promise<string> {
  const shimDir = join(dir, "bin");
  await mkdir(shimDir, { recursive: true });
  await writeFile(join(shimDir, "pnpm.cmd"), "@echo off\r\necho CAPABILITY_AUDIT_OK\r\nexit /b 0\r\n", "utf8");
  await writeFile(join(shimDir, "pnpm"), "#!/bin/sh\necho CAPABILITY_AUDIT_OK\n", "utf8");
  await chmod(join(shimDir, "pnpm"), 0o755);
  return shimDir;
}

const winEnv = (shimDir: string): NodeJS.ProcessEnv => ({
  ComSpec: "C:\\WINDOWS\\system32\\cmd.exe",
  PATHEXT: ".com;.exe;.bat;.cmd",
  PATH: shimDir,
});

describe("runGateCommand (CLI-001)", () => {
  it("win32: spawns cmd.exe with the resolved .cmd shim as a validated, verbatim cmd envelope", async () => {
    const shimDir = await writeShims();
    const spawnFn = vi.fn(async (_file: string, _args: string[]) => ({ stdout: "CAPABILITY_AUDIT_OK\n", stderr: "" }));
    const result = await runGateCommand(["pnpm", "capability:audit"], {
      cwd: dir,
      timeoutMs: 1_000,
      platform: "win32",
      env: winEnv(shimDir),
      spawnFn,
    });
    expect(spawnFn).toHaveBeenCalledTimes(1);
    expect(spawnFn.mock.calls[0]![0]).toBe("C:\\WINDOWS\\system32\\cmd.exe");
    // PATHEXT spells the extension, so compare case-insensitively.
    expect((spawnFn.mock.calls[0]![1] as string[]).map((a) => a.toLowerCase())).toEqual([
      "/d", "/s", "/c",
      `""${join(shimDir, "pnpm.cmd").toLowerCase()}" "capability:audit""`,
    ]);
    expect(result).toMatchObject({ exitCode: 0, stdout: "CAPABILITY_AUDIT_OK\n" });
    expect(result.failure).toBeUndefined();
  });

  it("posix: spawns the command directly with the same argv", async () => {
    const shimDir = await writeShims();
    const spawnFn = vi.fn(async (_file: string, _args: string[]) => ({ stdout: "CAPABILITY_AUDIT_OK\n", stderr: "" }));
    await runGateCommand(["pnpm", "capability:audit"], {
      cwd: dir,
      timeoutMs: 1_000,
      platform: "linux",
      env: { PATH: shimDir },
      spawnFn,
    });
    expect(spawnFn.mock.calls[0]![0]).toBe("pnpm");
    expect(spawnFn.mock.calls[0]![1]).toEqual(["capability:audit"]);
  });

  it("classifies a spawn failure instead of collapsing it into a bare exit 1", async () => {
    const spawnFn = vi.fn(async (_file: string, _args: string[]) => {
      throw Object.assign(new Error("spawn pnpm ENOENT"), { code: "ENOENT" });
    });
    const result = await runGateCommand(["pnpm", "capability:audit"], {
      cwd: dir,
      timeoutMs: 1_000,
      platform: "linux",
      env: { PATH: dir },
      spawnFn,
    });
    expect(result.exitCode).toBe(1);
    expect(result.failure?.kind).toBe("spawn");
    expect(result.stderr).toContain("ENOENT");
  });

  it("records a real non-zero child exit as an exit code, never as a failure", async () => {
    const spawnFn = vi.fn(async (_file: string, _args: string[]) => {
      throw Object.assign(new Error("Command failed"), { code: 7, stdout: "partial out", stderr: "red gate" });
    });
    const result = await runGateCommand(["pnpm", "capability:audit"], {
      cwd: dir,
      timeoutMs: 1_000,
      platform: "linux",
      env: { PATH: dir },
      spawnFn,
    });
    expect(result).toMatchObject({ exitCode: 7, stdout: "partial out", stderr: "red gate" });
    expect(result.failure).toBeUndefined();
  });

  it("refuses a command whose .cmd argument cmd.exe would re-parse", async () => {
    const shimDir = await writeShims();
    const spawnFn = vi.fn(async (_file: string, _args: string[]) => ({ stdout: "", stderr: "" }));
    const result = await runGateCommand(["pnpm", "capability:audit", "a&calc.exe"], {
      cwd: dir,
      timeoutMs: 1_000,
      platform: "win32",
      env: winEnv(shimDir),
      spawnFn,
    });
    expect(spawnFn).not.toHaveBeenCalled();
    expect(result.exitCode).toBe(1);
    expect(result.failure?.kind).toBe("runner_error");
    expect(result.stderr).toMatch(/metacharacter/);
  });
});

describe("collectReleaseArtifacts gate declaration (CLI-001)", () => {
  it("declares the canonical capability:audit command and launches it through runGateCommand", async () => {
    let captured: { command: string[]; run?: unknown } | undefined;
    const gateFn = (opts: { command: string[]; run?: unknown }): Promise<never> => {
      captured = { command: [...opts.command], run: opts.run };
      // Stop the run before it writes evidence: this test asserts the
      // DECLARATION and the launch hook, not a gate result.
      throw new Error("captured-gate-options");
    };
    await expect(
      collectReleaseArtifacts({
        root: dir,
        outDir: join(dir, "out"),
        fast: true,
        execFn: async () => "[artifact step failed] fixture",
        gateFn: gateFn as never,
      }),
    ).rejects.toThrow("captured-gate-options");

    // The DECLARED command is the gate's identity: a .cmd shim or a cmd.exe
    // wrapper in the evidence would silently substitute a different command.
    expect(captured?.command).toEqual(["pnpm", "capability:audit"]);
    // ...while the launch is delegated to the platform launcher, which on win32
    // resolves the .cmd shim instead of failing with ENOENT.
    expect(typeof captured?.run).toBe("function");
  });
});
