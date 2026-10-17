import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { resolveLaunchTarget, runResolvedCommand } from "./argv-launch.js";

/**
 * CLI-001: `execFile("pnpm", …)` with shell:false is ENOENT on Windows (only
 * `pnpm.cmd` exists) and spawning the `.cmd` directly is EINVAL (Node refuses
 * to spawn batch files without a shell). The launch target must therefore be
 * resolved per platform and, on win32, routed through cmd.exe with SEPARATE
 * argv — never by joining the command into a shell string.
 */

let dir = "";
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "argv-launch-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** A pnpm shim that prints a marker, for both hosts. */
async function writeShims(): Promise<string> {
  const shimDir = join(dir, "bin");
  await mkdir(shimDir, { recursive: true });
  await writeFile(join(shimDir, "pnpm.cmd"), "@echo off\r\necho CAPABILITY_AUDIT_OK\r\nexit /b 0\r\n", "utf8");
  await writeFile(join(shimDir, "pnpm"), "#!/bin/sh\necho CAPABILITY_AUDIT_OK\n", "utf8");
  await chmod(join(shimDir, "pnpm"), 0o755);
  return shimDir;
}

function winEnv(shimDir: string): NodeJS.ProcessEnv {
  return { ComSpec: "C:\\WINDOWS\\system32\\cmd.exe", PATHEXT: ".COM;.EXE;.BAT;.CMD", PATH: shimDir };
}

describe("resolveLaunchTarget (CLI-001 / CLI-003)", () => {
  it("win32: a bare `pnpm` resolves to its .cmd shim and is routed through cmd.exe with SEPARATE argv", async () => {
    const shimDir = await writeShims();
    const target = resolveLaunchTarget(["pnpm", "capability:audit"], {
      cwd: dir,
      env: winEnv(shimDir),
      platform: "win32",
    });
    expect(target.file).toBe("C:\\WINDOWS\\system32\\cmd.exe");
    // The extension is spelled by PATHEXT, so compare case-insensitively.
    expect(target.args.map((a) => a.toLowerCase())).toEqual([
      "/d",
      "/c",
      join(shimDir, "pnpm.cmd").toLowerCase(),
      "capability:audit",
    ]);
    // The command is never joined into one shell string.
    expect(target.args.join("\u0000")).not.toContain("capability:audit pnpm");
    expect(target.via).toBe("cmd");
  });

  it("posix: the command is spawned directly (shebang handles the shim)", async () => {
    const shimDir = await writeShims();
    const target = resolveLaunchTarget(["pnpm", "capability:audit"], {
      cwd: dir,
      env: { PATH: shimDir },
      platform: "linux",
    });
    expect(target).toMatchObject({ file: "pnpm", args: ["capability:audit"], via: "direct" });
  });

  it("win32: an unresolvable name is still spawned directly so the real ENOENT surfaces", () => {
    const target = resolveLaunchTarget(["definitely-not-installed-4101"], {
      cwd: dir,
      env: winEnv(join(dir, "nowhere")),
      platform: "win32",
    });
    expect(target).toMatchObject({ file: "definitely-not-installed-4101", args: [], via: "direct" });
  });

  it("fails CLOSED when a .cmd argument would be re-parsed by cmd.exe", async () => {
    const shimDir = await writeShims();
    expect(() =>
      resolveLaunchTarget(["pnpm", "capability:audit", "a&calc.exe"], {
        cwd: dir,
        env: winEnv(shimDir),
        platform: "win32",
      }),
    ).toThrow(/metacharacter/);
  });

  it("rejects an empty command instead of spawning something arbitrary", () => {
    expect(() => resolveLaunchTarget([], { cwd: dir, platform: "linux" })).toThrow(/empty command/);
  });
});

describe("runResolvedCommand (CLI-001 real launch)", () => {
  it("launches pnpm through the resolved target on the real host without ENOENT/EINVAL", async () => {
    const shimDir = await writeShims();
    const out = await runResolvedCommand(["pnpm", "capability:audit"], {
      cwd: dir,
      timeoutMs: 30_000,
      env: { ...process.env, PATH: `${shimDir}${delimiter}${process.env["PATH"] ?? ""}` },
    });
    expect(out.stdout).toContain("CAPABILITY_AUDIT_OK");
  });

  it("lets a genuinely missing binary fail with the platform's own error", async () => {
    await expect(
      runResolvedCommand(["definitely-not-installed-4102"], { cwd: dir, timeoutMs: 30_000, env: { ...process.env, PATH: dir } }),
    ).rejects.toThrow();
  });
});
