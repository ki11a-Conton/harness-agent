/** Native executable launch stays argv-based. Windows batch files require a
 * cmd.exe command line: validate its inputs, quote each argument, and pass the
 * explicit /d /s /c envelope verbatim. The caller's declared argv is retained
 * unchanged in gate evidence. */
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { extname, isAbsolute, join, resolve } from "node:path";
import { promisify } from "node:util";
import type { GateRunFailureKind, GateV2RunnerResult } from "@ar/evaluation";

const execFileAsync = promisify(execFile);

/** cmd.exe re-parses `/c <path>` and `/c <script> <args>`: these characters
 *  can truncate a path or start a second command, so they are refused rather
 *  than escaped (quoting is NOT a reliable defence in a re-parsed context). */
const CMD_PATH_METACHARACTERS = /[&|<>^%!()\r\n;=,]/;
const CMD_ARGUMENT_METACHARACTERS = /[&|<>^%!"()\r\n]/;
const CMD_SCRIPT_EXTENSIONS = new Set([".cmd", ".bat"]);

export interface LaunchTarget {
  /** Executable that is actually spawned. */
  file: string;
  /** Arguments for the actual executable, including the cmd.exe envelope. */
  args: string[];
  /** Required only for the explicitly quoted cmd.exe /s /c envelope. */
  windowsVerbatimArguments?: true;
  /** `direct` = spawn as declared; `cmd` = routed through cmd.exe. */
  via: "direct" | "cmd";
}

export interface LaunchOptions {
  cwd: string;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
}

function envValue(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const direct = env[name];
  if (direct !== undefined) return direct;
  const upper = name.toUpperCase();
  for (const [key, value] of Object.entries(env)) {
    if (key.toUpperCase() === upper) return value;
  }
  return undefined;
}

/**
 * Resolve a bare command name the way a shell would: walk `PATH` and try each
 * `PATHEXT` extension. Node's `spawn` does NOT do this (it only appends `.exe`),
 * which is exactly why `pnpm`/`npx` failed with ENOENT.
 *
 * A name containing a separator is a path: it is resolved against the
 * EXECUTION cwd (the cwd the child will run in), never the parent's.
 */
export function resolveWindowsCommand(file: string, env: NodeJS.ProcessEnv, cwd: string): string | null {
  if (file.includes("\\") || file.includes("/")) {
    const candidate = resolve(cwd, file.replace(/\\/g, "/"));
    return existsSync(candidate) ? candidate : null;
  }
  const pathExt = (envValue(env, "PATHEXT") ?? ".COM;.EXE;.BAT;.CMD")
    .split(";")
    .map((e) => e.trim())
    .filter(Boolean);
  const dirs = (envValue(env, "PATH") ?? "")
    .split(";")
    .map((d) => d.trim())
    .filter(Boolean);
  const hasKnownExt = pathExt.some((ext) => file.toUpperCase().endsWith(ext.toUpperCase()));
  for (const dir of dirs) {
    const absDir = isAbsolute(dir) ? dir : resolve(cwd, dir);
    if (hasKnownExt) {
      const candidate = join(absDir, file);
      if (existsSync(candidate)) return candidate;
      continue;
    }
    for (const ext of pathExt) {
      const candidate = join(absDir, file + ext);
      if (existsSync(candidate)) return candidate;
    }
  }
  return null;
}

/**
 * Decide HOW to launch `command` under `shell:false`. Pure and
 * platform-parameterised, so the decision table is testable off-Windows.
 *
 * Reject shell control characters before building a quoted `.cmd` envelope.
 * A refused launch must surface as an error, never as a different command.
 */
export function resolveLaunchTarget(command: readonly string[], opts: LaunchOptions): LaunchTarget {
  if (command.length === 0 || command[0] === undefined || command[0].length === 0) {
    throw new Error("refused to launch an empty command");
  }
  const [file, ...rest] = command;
  const env = opts.env ?? process.env;
  const platform = opts.platform ?? process.platform;

  // POSIX: the kernel honours the shebang, so a direct spawn is already right.
  if (platform !== "win32") return { file, args: rest, via: "direct" };

  const resolved = resolveWindowsCommand(file, env, opts.cwd);
  // Unresolvable: spawn the declared name so the platform's own ENOENT is
  // reported instead of a guessed reason.
  if (resolved === null) return { file, args: rest, via: "direct" };

  const ext = extname(resolved).toLowerCase();
  if (CMD_SCRIPT_EXTENSIONS.has(ext)) {
    if (CMD_PATH_METACHARACTERS.test(resolved)) {
      throw new Error(
        `refused to launch ${JSON.stringify(resolved)}: the path contains a cmd.exe metacharacter ` +
          `(& | < > ^ % ! ( ) ; = ,) which cmd.exe would re-parse and could run a different command. ` +
          `Move the script to a plain path (spaces and non-ASCII are fine).`,
      );
    }
    rest.forEach((arg, index) => {
      if (CMD_ARGUMENT_METACHARACTERS.test(arg)) {
        // The value is deliberately not echoed: gate arguments can carry
        // credentials, and no secret may reach an error message or log.
        throw new Error(
          `refused to launch ${resolved} via cmd.exe: argument ${String(index)} contains a cmd metacharacter ` +
            `(& | < > ^ % ! " ( ) or a newline), which cmd.exe would re-parse. ` +
            `Declare a real executable (e.g. node + script path) instead.`,
        );
      }
    });
    const comspec = envValue(env, "ComSpec") ?? "cmd.exe";
    // libuv's ordinary executable quoting uses backslash-escaped quotes;
    // cmd.exe has different parsing rules. /s removes the outer envelope,
    // leaving a quoted script path plus individually quoted arguments. Escape
    // trailing backslashes for the native Node process pnpm.cmd forwards to.
    const quote = (arg: string) => `"${arg.replace(/(\\+)$/, "$1$1")}"`;
    const line = `"${[resolved, ...rest].map(quote).join(" ")}"`;
    return { file: comspec, args: ["/d", "/s", "/c", line], via: "cmd", windowsVerbatimArguments: true };
  }
  return { file: resolved, args: rest, via: "direct" };
}

export interface SpawnResult {
  stdout: string;
  stderr: string;
}

/** Minimal spawn seam so tests can observe the REAL launch target. */
export type GateSpawn = (
  file: string,
  args: string[],
  opts: { cwd: string; timeoutMs: number; maxBuffer?: number; env?: NodeJS.ProcessEnv; windowsVerbatimArguments?: true },
) => Promise<SpawnResult>;

const defaultSpawn: GateSpawn = async (file, args, opts) => {
  const { stdout, stderr } = await execFileAsync(file, args, {
    cwd: opts.cwd,
    timeout: opts.timeoutMs,
    maxBuffer: opts.maxBuffer ?? 128 * 1024 * 1024,
    windowsHide: true,
    ...(opts.windowsVerbatimArguments === true ? { windowsVerbatimArguments: true } : {}),
    encoding: "utf8",
    ...(opts.env !== undefined ? { env: opts.env } : {}),
  });
  return { stdout: String(stdout), stderr: String(stderr) };
};

/** Launch a declared command through the platform-appropriate target. */
export async function runResolvedCommand(
  command: readonly string[],
  opts: {
    cwd: string;
    timeoutMs: number;
    maxBuffer?: number;
    env?: NodeJS.ProcessEnv;
    platform?: NodeJS.Platform;
    spawnFn?: GateSpawn;
  },
): Promise<SpawnResult> {
  const target = resolveLaunchTarget(command, {
    cwd: opts.cwd,
    ...(opts.env !== undefined ? { env: opts.env } : {}),
    ...(opts.platform !== undefined ? { platform: opts.platform } : {}),
  });
  const spawnFn = opts.spawnFn ?? defaultSpawn;
  return spawnFn(target.file, target.args, {
    ...(target.windowsVerbatimArguments === true ? { windowsVerbatimArguments: true } : {}),
    cwd: opts.cwd,
    timeoutMs: opts.timeoutMs,
    ...(opts.maxBuffer !== undefined ? { maxBuffer: opts.maxBuffer } : {}),
    ...(opts.env !== undefined ? { env: opts.env } : {}),
  });
}

function classifyGateFailure(err: unknown): GateRunFailureKind {
  const e = err as { code?: unknown; killed?: boolean; signal?: unknown; message?: unknown };
  const message = typeof e.message === "string" ? e.message : "";
  if (e.killed === true) return "timeout";
  if (e.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" || /maxBuffer/i.test(message)) return "maxBuffer";
  if (typeof e.code === "string") return "spawn";
  if (e.signal !== undefined && e.signal !== null) return "signal";
  return "runner_error";
}

function textOf(value: unknown): string {
  if (typeof value === "string") return value;
  if (Buffer.isBuffer(value)) return value.toString("utf8");
  return "";
}

/**
 * The `run` hook for `runGateV2`: launch the DECLARED argv through the
 * platform launcher, keep the real child exit code, and classify spawn/
 * timeout/maxBuffer failures instead of collapsing them into a bare exit 1.
 */
export async function runGateCommand(
  command: readonly string[],
  opts: {
    cwd: string;
    timeoutMs: number;
    maxBuffer?: number;
    env?: NodeJS.ProcessEnv;
    platform?: NodeJS.Platform;
    spawnFn?: GateSpawn;
  },
): Promise<GateV2RunnerResult> {
  let target: LaunchTarget;
  try {
    target = resolveLaunchTarget(command, {
      cwd: opts.cwd,
      ...(opts.env !== undefined ? { env: opts.env } : {}),
      ...(opts.platform !== undefined ? { platform: opts.platform } : {}),
    });
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return { exitCode: 1, stdout: "", stderr: detail, failure: { kind: "runner_error", detail } };
  }
  const spawnFn = opts.spawnFn ?? defaultSpawn;
  try {
    const out = await spawnFn(target.file, target.args, {
      ...(target.windowsVerbatimArguments === true ? { windowsVerbatimArguments: true } : {}),
      cwd: opts.cwd,
      timeoutMs: opts.timeoutMs,
      ...(opts.maxBuffer !== undefined ? { maxBuffer: opts.maxBuffer } : {}),
      ...(opts.env !== undefined ? { env: opts.env } : {}),
    });
    return { exitCode: 0, stdout: out.stdout, stderr: out.stderr };
  } catch (err) {
    const e = err as { code?: unknown; status?: unknown; stdout?: unknown; stderr?: unknown; message?: unknown };
    const code = typeof e.status === "number" ? e.status : e.code;
    const stderr = textOf(e.stderr);
    const message = typeof e.message === "string" ? e.message : String(err);
    // A real child exit carries a NUMERIC code — record it as the exit code,
    // never as a failure. Everything else is a launch/supervision failure.
    if (typeof code === "number") {
      return { exitCode: code, stdout: textOf(e.stdout), stderr };
    }
    return {
      exitCode: 1,
      stdout: textOf(e.stdout),
      stderr: stderr === "" ? message : stderr,
      failure: { kind: classifyGateFailure(err), detail: message.slice(0, 500) },
    };
  }
}
