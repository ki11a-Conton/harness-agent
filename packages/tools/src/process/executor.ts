import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import type { SandboxExecutionOption, SandboxExecutionProvenance } from "./sandbox-executor.js";
import { buildSandboxLaunch, policyDigestOf, SANDBOX_BACKEND_DENIED } from "./sandbox-executor.js";

export type ExecStatus = "success" | "failed" | "timeout" | "cancelled" | "error" | "denied";

export interface ExecOutcome {
  status: ExecStatus;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  truncated: boolean;
  durationMs: number;
  error?: string;
  /** E3-09: typed denial when the sandbox backend refuses the execution. */
  denial?: { code: string; reason: string };
  /** E3-09: when true, the process ran WITHOUT OS-level confinement (insecure
   *  local mode). NEVER promotion-eligible. */
  insecure?: boolean;
  /** E3-09: backend identity, policy and self-test digest for provenance. */
  provenance?: SandboxExecutionProvenance;
}

export interface ExecOptions {
  command: string;
  cwd: string;
  env?: Record<string, string>;
  timeoutMs?: number;
  maxOutputBytes?: number;
  signal?: AbortSignal;
  /** Streaming channel: every stdout/stderr chunk is delivered here (EXEC-001). */
  onOutput?: (chunk: { stream: "stdout" | "stderr"; text: string }) => void;
  /** Shell override: defaults to cmd.exe on win32, /bin/sh elsewhere. */
  shell?: string;
  /** E3-09: verified sandbox execution spec. When present, the spawn is
   *  wrapped by the OS-level sandbox (bwrap) and the env is filtered through
   *  the allowlist. A model command cannot bypass the wrapper. */
  sandboxExecution?: SandboxExecutionOption;
}

/**
 * E4-R79 (F79-2): structured argv execution options.
 *
 * `file` is spawned DIRECTLY with `shell: false`. No shell ever parses the
 * argument text, so each element of `args` reaches the child byte-for-byte and
 * a metacharacter (`&`, `;`, `|`, `$`, quotes, …) can never start a second
 * command. This is the correct contract for a STRUCTURED `command + args`
 * verification spec — see `TaskVerifier.checkCommand`.
 *
 * The legacy `ExecOptions.command` string path is unchanged: it is a full
 * shell recipe and is still handed to the platform shell verbatim.
 */
export interface ExecArgvOptions {
  file: string;
  args?: string[];
  cwd: string;
  env?: Record<string, string>;
  timeoutMs?: number;
  maxOutputBytes?: number;
  signal?: AbortSignal;
  onOutput?: (chunk: { stream: "stdout" | "stderr"; text: string }) => void;
}

/**
 * ProcessExecutor per AGENT_ARCHITECTURE_PLAN EXEC-001.
 *
 * A pure primitive: spawn → stream → bounded collect → exit code.
 * It performs NO permission checks — all authorization happens upstream in the
 * ToolOrchestrator (permission engine + sandbox allowlist). The shell is an
 * explicit, testable injection point; we never evaluate command syntax here.
 */
export const EXECUTOR_MARKER = "verbatim-recipe-v3";

/**
 * E4-R91 (H1): characters that cmd.exe re-interprets.
 *
 * MEASURED on Windows: when a `.cmd` shim is launched through cmd.exe, an
 * argument such as `a&echo PWNED>file&rem` is NOT inert. The shim's own `%*`
 * re-expansion re-parses it, and the second command runs — with `shell:false`
 * and separate argv. There is no quoting strategy that makes cmd.exe transport
 * `&`/`|`/`%`/`^`/`"` faithfully (see the R91 report's measurement table), so
 * the only safe contract is to REFUSE such an argument rather than to escape it
 * and hope.
 *
 * This is deliberately conservative: a benchmark verifier argument that needs a
 * cmd metacharacter fails closed with an actionable reason instead of silently
 * executing something else. Space and `/` are absent on purpose — they are
 * transported correctly by ordinary argv quoting.
 */
export const CMD_METACHARACTERS = /[&|<>^%!"()\r\n]/;

/** A resolved launch plan: exactly what to hand to `spawn` with `shell:false`. */
export type ArgvLaunch =
  | { ok: true; file: string; args: string[]; via: "direct" | "cmd" | "powershell" }
  | { ok: false; reason: string };

/** PATHEXT extensions that are real executable images CreateProcess accepts. */
const DIRECT_EXTENSIONS = new Set(["", ".exe", ".com"]);
/** Script extensions we can launch deterministically. */
const CMD_SCRIPT_EXTENSIONS = new Set([".cmd", ".bat"]);
/** Script extensions we deliberately do NOT launch, with the reason. */
const UNSUPPORTED_SCRIPT_EXTENSIONS = new Set([".ps1", ".vbs", ".vbe", ".js", ".jse", ".wsf", ".wsh", ".msc", ".cpl"]);

function extensionOf(file: string): string {
  const base = file.slice(file.lastIndexOf("\\") + 1).slice(file.lastIndexOf("/") + 1);
  const dot = base.lastIndexOf(".");
  return dot <= 0 ? "" : base.slice(dot).toLowerCase();
}

/**
 * Absolute in the WINDOWS sense, independent of the host running the test.
 *
 * `path.isAbsolute` is host-specific: on Linux `C:\x` is NOT absolute, so a
 * win32-parameterised test would resolve it against a POSIX cwd and produce a
 * nonsense path. The decision table is asserted on every platform (that is what
 * makes it CI-coverable), so the check has to be platform-independent.
 */
function isAbsolutePath(p: string): boolean {
  return isAbsolute(p) || /^[A-Za-z]:[\\/]/.test(p) || /^\\\\/.test(p);
}

/**
 * Read an environment variable case-insensitively.
 *
 * Windows stores ONE variable whose name may be reported in any casing:
 * `process.env.PATH` is a getter for the real `Path` entry, so `{ ...process.env }`
 * copies `Path` and the literal key `PATH` disappears. Looking up only
 * `env.PATH` therefore fails on a spread environment — which is exactly how the
 * first version of this fix passed its unit tests while still producing
 * `spawn npx ENOENT` end-to-end.
 */
function envValue(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const direct = env[name];
  if (direct !== undefined) return direct;
  const upper = name.toUpperCase();
  for (const key of Object.keys(env)) {
    if (key.toUpperCase() === upper) return env[key];
  }
  return undefined;
}

/**
 * Characters that cmd.exe re-interprets, for the SCRIPT PATH.
 *
 * MEASURED on Windows (harmless temp fixtures, `cmd.exe /d /c <path>`,
 * `shell:false`, this machine):
 *
 *   path contains   result
 *   -------------   -------------------------------------------------------
 *   space, CJK      ran the script (exit 0) — SAFE, accepted below
 *   `(` `)`         'C:\…\par' is not recognized — the path was TRUNCATED
 *   `&`             'C:\…\am' is not recognized
 *   `^`             the system cannot find the path
 *   `;` `=`         'C:\…\semi' / 'C:\…\eq' is not recognized
 *   `%`             ran ONLY because no variable named `cent` existed: with
 *                   `cent=XXX` defined, `per%cent%` failed. Environment-
 *                   dependent, so refused.
 *   `!`             ran only because delayed expansion is off by default; that
 *                   is a cmd.exe option, not a property of the path. Refused.
 *
 * Space and non-ASCII are deliberately ABSENT: they are transported correctly,
 * and refusing them would break the ordinary Windows path with a space in it.
 *
 * SCOPE OF TRUST. This check constrains the SCRIPT PATH only, and only for the
 * cmd.exe route. It is not a sandbox:
 *   - `PATH` and `ComSpec` come from the caller's environment and are TRUSTED as
 *     given. An attacker who can set either can already choose what runs, so
 *     re-validating them here would add no protection — the boundary that matters
 *     is the one that decides which environment reaches this call.
 *   - the interpreter search (`pwsh`, then `powershell`) is likewise a PATH
 *     lookup and inherits that same trust.
 *   - a `.ps1` path is NOT restricted: MEASURED, `-File` transports `& % ! ^ ( )`
 *     in a path correctly, because PowerShell is not cmd.exe. Copying the cmd
 *     rule to a route that does not need it would be an unjustified restriction.
 * The check exists because cmd.exe re-parses `/c <path>`, which turns an
 * ordinary-looking path into a different command.
 */
export const CMD_PATH_METACHARACTERS = /[&|<>^%!()\r\n;=,]/;

/**
 * Resolve a bare command name the way a shell would: search `PATH` and try each
 * `PATHEXT` extension in order. Node's `spawn` does NOT do this — it appends
 * only `.exe` — which is exactly why `npx`/`bash` (`.cmd` shims on Windows)
 * failed with ENOENT. A name that already contains a separator is a path and is
 * returned as-is.
 *
 * `cwd` is the directory the process will ACTUALLY run in (`opts.cwd`), and it
 * is the base for every RELATIVE resolution here:
 *   - a relative script path (`./tool.cmd`, `.\tool.cmd`) is resolved against it;
 *   - a relative `PATH` entry (`.`) is resolved against it.
 *
 * This must be the SAME cwd the caller passes to `spawn`. Deciding existence
 * against the parent process's cwd instead is finding G: with a different
 * execution cwd the resolver either misses the real script — so a `.cmd` is NOT
 * routed through cmd.exe and the spawn fails with EINVAL/ENOENT — or, worse,
 * finds a SAME-NAMED script under the parent's cwd and hands THAT path to
 * cmd.exe, silently running the wrong file.
 *
 * A BARE name is still a pure PATH lookup: no implicit current-directory search
 * is added, because that would let an unrelated file in the working directory
 * hijack a resolved command.
 */
export function resolveWindowsCommand(file: string, env: NodeJS.ProcessEnv, cwd?: string): string | null {
  const base = cwd !== undefined && cwd.length > 0 ? cwd : process.cwd();

  if (file.includes("\\") || file.includes("/")) {
    // Normalize the separator to `/` before resolving, and always route the
    // result through `resolve` so the HOST re-spells it in its own convention
    // (`resolve("C:\\a", "b/c")` → `C:\a\b\c`; POSIX → `/a/b/c`). Two reasons:
    //
    //   - This is a WINDOWS resolver, so `.\tool.cmd` must mean what cmd.exe
    //     means, and must not depend on the host path module — POSIX treats `\`
    //     as an ordinary character, which would make the decision table
    //     uncoverable by the Linux CI job.
    //   - Passing the normalized form straight to cmd.exe is NOT safe: cmd.exe
    //     reads `/` as a switch character. The host spelling is what production
    //     sees, so the spelling is preserved rather than hand-built.
    const candidate = resolve(base, file.replace(/\\/g, "/"));
    return existsSync(candidate) ? candidate : null;
  }

  const pathExt = (envValue(env, "PATHEXT") ?? ".COM;.EXE;.BAT;.CMD").split(";").map((e) => e.trim()).filter(Boolean);
  const dirs = (envValue(env, "PATH") ?? "").split(";").map((d) => d.trim()).filter(Boolean);
  const hasKnownExt = pathExt.some((ext) => file.toUpperCase().endsWith(ext.toUpperCase()));

  for (const dir of dirs) {
    // A relative PATH entry is relative to the EXECUTION cwd, not the parent's.
    const absDir = isAbsolutePath(dir) ? dir : resolve(base, dir);
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
 * Decide HOW to launch `file` with `args` under `shell:false`.
 *
 * Pure and platform-parameterised so the decision table is testable on Linux
 * too; only the `.cmd`/`.ps1` executions themselves are Windows-specific.
 */
export function planArgvLaunch(
  file: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform,
  cwd?: string,
): ArgvLaunch {
  if (platform !== "win32") {
    // POSIX: the kernel executes scripts via their shebang. `shell:false` is
    // already correct and nothing needs resolving.
    return { ok: true, file, args, via: "direct" };
  }

  const resolved = resolveWindowsCommand(file, env, cwd);
  // Unresolvable: fall through to a direct spawn so the platform's own ENOENT
  // is reported rather than a guessed reason.
  if (resolved === null) return { ok: true, file, args, via: "direct" };

  const ext = extensionOf(resolved);

  if (CMD_SCRIPT_EXTENSIONS.has(ext)) {
    // The SCRIPT PATH is inside the execution boundary too. cmd.exe re-parses
    // `/c <path>`, so a metacharacter in the path can truncate or redirect what
    // actually runs — MEASURED above. This is checked BEFORE the arguments,
    // because an unexpressible path is not fixable by removing an argument.
    if (CMD_PATH_METACHARACTERS.test(resolved)) {
      return {
        ok: false,
        reason:
          `refused to launch a .cmd/.bat script whose PATH contains a cmd metacharacter: ` +
          `${JSON.stringify(resolved)}. cmd.exe re-parses the path and would run a different ` +
          `command or a truncated path. Move the script to a path without & | < > ^ % ! ( ) ; = , ` +
          `(a space or non-ASCII characters are fine) and declare it again.`,
      };
    }
    for (let i = 0; i < args.length; i++) {
      const arg = args[i] ?? "";
      if (CMD_METACHARACTERS.test(arg)) {
        // The offending VALUE is deliberately NOT echoed: a verifier argument
        // can carry a credential, and plan §R96 line 181 forbids any secret
        // value in a returned error, event or log. The INDEX and the reason are
        // what an operator needs to fix the declaration.
        return {
          ok: false,
          reason:
            `refused to launch ${resolved} via cmd.exe: argument ${i} contains a cmd metacharacter. ` +
            `cmd.exe re-parses such arguments and could run a second command. ` +
            `Declare the verifier as a real executable (e.g. node + script argument) or remove the metacharacter.`,
        };
      }
    }
    const comspec = envValue(env, "ComSpec") ?? "cmd.exe";
    // `/d` skips AutoRun, `/c` runs the command. Arguments stay SEPARATE argv
    // entries; only benign arguments ever reach this point.
    return { ok: true, file: comspec, args: ["/d", "/c", resolved, ...args], via: "cmd" };
  }

  if (ext === ".ps1") {
    // `-File` with SEPARATE argv is faithful: `$args` receives every argument
    // literally, including dash-leading ones such as `--noEmit`, and the PATH is
    // not re-parsed. MEASURED: `& % ! ^ ( )` in a `.ps1` path all execute the
    // right script through this route, so no path restriction is imposed here —
    // the cmd.exe path rule above must not be copied to a route that does not
    // need it.
    //
    // `-ExecutionPolicy Bypass` relaxes the PowerShell execution policy for THIS
    // process only. It does NOT override an OS or organisational control
    // (AppLocker, WDAC, group policy) that forbids the script: such a refusal
    // surfaces as a non-zero exit and is reported, never worked around.
    const shell = resolveWindowsCommand("pwsh", env, cwd) ?? resolveWindowsCommand("powershell", env, cwd) ?? "powershell.exe";
    return {
      ok: true,
      file: shell,
      args: ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", resolved, ...args],
      via: "powershell",
    };
  }

  if (DIRECT_EXTENSIONS.has(ext)) return { ok: true, file: resolved, args, via: "direct" };

  if (UNSUPPORTED_SCRIPT_EXTENSIONS.has(ext)) {
    return {
      ok: false,
      reason:
        `cannot launch ${resolved} deterministically: ${ext} scripts need a host interpreter that ` +
        `would re-parse the arguments. Declare the verifier with an explicit executable plus arguments ` +
        `(e.g. \`node script.js\`) instead of relying on a ${ext} shim.`,
    };
  }

  return {
    ok: false,
    reason: `cannot launch ${resolved}: unsupported executable type ${ext || "(none)"} on win32`,
  };
}

/** E4-R79: shared bounded-collect + timeout + cancel + tree-kill lifecycle.
 *  Both the legacy shell path and the argv path use EXACTLY this machinery, so
 *  the argv path cannot drift from the shell path on the semantics the verifier
 *  depends on (timeout, cancellation, output truncation, orphan cleanup). */
interface CollectedExec {
  timeoutMs: number;
  maxOutputBytes: number;
  cwd: string;
  signal?: AbortSignal;
  onOutput?: ExecOptions["onOutput"];
}

function collect(
  child: ChildProcess,
  opts: CollectedExec,
  killTree: () => void,
  started: number,
): Promise<ExecOutcome> {
  const stdoutChunks: string[] = [];
  const stderrChunks: string[] = [];
  let stdoutBytes = 0;
  let stderrBytes = 0;
  let truncated = false;
  let settled = false;

  const outcome = (status: ExecStatus, exitCode: number | null, error?: string): ExecOutcome => ({
    status,
    exitCode,
    stdout: stdoutChunks.join(""),
    stderr: stderrChunks.join(""),
    truncated,
    durationMs: Date.now() - started,
    ...(error !== undefined ? { error } : {}),
  });

  const finish = (status: ExecStatus, exitCode: number | null, error?: string): ExecOutcome => {
    if (settled) return outcome(status, exitCode, error);
    settled = true;
    return outcome(status, exitCode, error);
  };

  const drain = (stream: "stdout" | "stderr", data: Buffer) => {
    const text = data.toString();
    const byteLen = Buffer.byteLength(text, "utf8");
    const cap = opts.maxOutputBytes - (stream === "stdout" ? stdoutBytes : stderrBytes);
    if (cap > 0) {
      (stream === "stdout" ? stdoutChunks : stderrChunks).push(text.slice(0, cap));
      if (byteLen > cap) truncated = true;
    } else {
      truncated = true;
    }
    if (stream === "stdout") stdoutBytes += byteLen;
    else stderrBytes += byteLen;
    try {
      opts.onOutput?.({ stream, text });
    } catch (err) {
      process.stderr.write(`[degraded] executor.onOutput: ${err instanceof Error ? err.message : String(err)}\n`);
    }
  };

  const listeners: Array<() => void> = [];

  child.stdout?.on("data", (d: Buffer) => drain("stdout", d));
  child.stderr?.on("data", (d: Buffer) => drain("stderr", d));

  return new Promise<ExecOutcome>((resolve) => {
    let forced: { status: "timeout" | "cancelled"; error: string } | undefined;

    const done = (status: ExecStatus, exitCode: number | null, error?: string) => {
      if (forced !== undefined) {
        const o = finish(forced.status, null, forced.error);
        if (settled) {
          clearTimeout(timer);
          for (const l of listeners) l();
          resolve(o);
        }
        return;
      }
      const o = finish(status, exitCode, error);
      if (settled) {
        clearTimeout(timer);
        for (const l of listeners) l();
        resolve(o);
      }
    };

    const timer =
      opts.timeoutMs > 0
        ? setTimeout(() => {
            killTree();
            forced = { status: "timeout", error: `timed out after ${opts.timeoutMs}ms` };
            done("timeout", null);
          }, opts.timeoutMs)
        : undefined;

    child.on("error", (err) => {
      done("error", null, err instanceof Error ? err.message : String(err));
    });

    child.on("close", (code, signal) => {
      if (code === 0) {
        done("success", 0);
      } else if (code !== null) {
        done("failed", code, `exited with code ${code}${signal ? ` (${signal})` : ""}`);
      } else {
        done("error", null, `process closed without exit code${signal ? ` (${signal})` : ""}`);
      }
    });

    const abortHandler = () => {
      killTree();
      forced = { status: "cancelled", error: "cancelled by caller" };
      done("cancelled", null);
    };
    opts.signal?.addEventListener("abort", abortHandler, { once: true });
    listeners.push(() => opts.signal?.removeEventListener("abort", abortHandler));

    if (opts.signal?.aborted) void abortHandler();
  });
}

const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_OUTPUT_BYTES = 1_048_576;

/** Kill a directly-spawned (shell-less) child and its descendants. */
function killDirectTree(child: ChildProcess): void {
  if (!child.pid) return;
  if (process.platform === "win32") {
    try {
      const killer = spawn("taskkill", ["/pid", String(child.pid), "/t", "/f"]);
      killer.unref();
    } catch {
      child.kill();
    }
  } else {
    child.kill("SIGKILL");
  }
}

export class ProcessExecutor {
  async run(opts: ExecOptions): Promise<ExecOutcome> {
    const started = Date.now();
    const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const maxOutputBytes = opts.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;

    // ---- E3-09: sandbox execution spec ----
    if (opts.sandboxExecution !== undefined) {
      const { backend, policy, selfTest, allowInsecureLocal } = opts.sandboxExecution;
      if (!backend.strongIsolation && !allowInsecureLocal) {
        return {
          status: "denied",
          exitCode: null,
          stdout: "",
          stderr: "",
          truncated: false,
          durationMs: Date.now() - started,
          denial: { code: SANDBOX_BACKEND_DENIED, reason: "no strong sandbox backend available — benchmark exec is refused" },
        };
      }
      // Build the launch config (wrapper or plain).
      const shell = opts.shell ?? (process.platform === "win32" ? process.env.ComSpec || "cmd.exe" : "/bin/sh");
      const isCmd = /cmd(\.exe)?$/i.test(shell);
      const shellArgs: string[] = [];
      const spawnOpts: Parameters<typeof spawn>[2] = {
        cwd: opts.cwd,
        env: { ...process.env, ...opts.env },
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      };
      if (isCmd) {
        shellArgs.push("/d", "/s", "/c", `"${opts.command}"`);
        spawnOpts.windowsVerbatimArguments = true;
      } else {
        shellArgs.push("-c", opts.command);
      }

      // Build launch (env filtered by the backend).
      const launch = buildSandboxLaunch(backend, policy, shell, shellArgs, spawnOpts.env as Record<string, string>, opts.cwd);
      spawnOpts.env = launch.env;

      // Build provenance.
      const provenance: SandboxExecutionProvenance = {
        schemaVersion: "1.0.0",
        backendId: backend.id,
        platform: backend.platform,
        strongIsolation: backend.strongIsolation,
        policyDigest: policyDigestOf(policy),
        selfTestDigest: selfTest.digest,
        insecureLocal: !backend.strongIsolation && allowInsecureLocal === true,
      };

      // Spawn the sandboxed process.
      const child = spawn(launch.file, launch.args, spawnOpts);

      const stdoutChunks: string[] = [];
      const stderrChunks: string[] = [];
      let stdoutBytes = 0;
      let stderrBytes = 0;
      let truncated = false;
      let settled = false;

      const outcome = (status: ExecStatus, exitCode: number | null, error?: string): ExecOutcome => ({
        status,
        exitCode,
        stdout: stdoutChunks.join(""),
        stderr: stderrChunks.join(""),
        truncated,
        durationMs: Date.now() - started,
        ...(error !== undefined ? { error } : {}),
        denial: undefined,
        insecure: provenance.insecureLocal,
        provenance,
      });

      const finish = (status: ExecStatus, exitCode: number | null, error?: string): ExecOutcome => {
        if (settled) return outcome(status, exitCode, error);
        settled = true;
        return outcome(status, exitCode, error);
      };

      const drain = (stream: "stdout" | "stderr", data: Buffer) => {
        const text = data.toString();
        const byteLen = Buffer.byteLength(text, "utf8");
        const cap = maxOutputBytes - (stream === "stdout" ? stdoutBytes : stderrBytes);
        if (cap > 0) {
          (stream === "stdout" ? stdoutChunks : stderrChunks).push(text.slice(0, cap));
          if (byteLen > cap) truncated = true;
        } else {
          truncated = true;
        }
        if (stream === "stdout") stdoutBytes += byteLen;
        else stderrBytes += byteLen;
        try {
          opts.onOutput?.({ stream, text });
        } catch (err) {
          process.stderr.write(`[degraded] executor.onOutput: ${err instanceof Error ? err.message : String(err)}\n`);
        }
      };

      const killTree = () => {
        if (!child.pid) return;
        if (isCmd) {
          try {
            const killer = spawn("taskkill", ["/pid", String(child.pid), "/t", "/f"]);
            killer.unref();
          } catch {
            child.kill();
          }
        } else {
          child.kill("SIGKILL");
        }
      };

      const listeners: Array<() => void> = [];

      child.stdout?.on("data", (d: Buffer) => drain("stdout", d));
      child.stderr?.on("data", (d: Buffer) => drain("stderr", d));

      return new Promise<ExecOutcome>((resolve) => {
        let forced: { status: "timeout" | "cancelled"; error: string } | undefined;

        const done = (status: ExecStatus, exitCode: number | null, error?: string) => {
          if (forced !== undefined) {
            const o = finish(forced.status, null, forced.error);
            if (settled) {
              clearTimeout(timer);
              for (const l of listeners) l();
              resolve(o);
            }
            return;
          }
          const o = finish(status, exitCode, error);
          if (settled) {
            clearTimeout(timer);
            for (const l of listeners) l();
            resolve(o);
          }
        };

        const timer = timeoutMs > 0
          ? setTimeout(() => {
              killTree();
              forced = { status: "timeout", error: `timed out after ${timeoutMs}ms` };
              done("timeout", null);
            }, timeoutMs)
          : undefined;

        child.on("error", (err) => {
          done("error", null, err instanceof Error ? err.message : String(err));
        });

        child.on("close", (code, signal) => {
          if (code === 0) {
            done("success", 0);
          } else if (code !== null) {
            done("failed", code, `exited with code ${code}${signal ? ` (${signal})` : ""}`);
          } else {
            done("error", null, `process closed without exit code${signal ? ` (${signal})` : ""}`);
          }
        });

        const abortHandler = () => {
          killTree();
          forced = { status: "cancelled", error: "cancelled by caller" };
          done("cancelled", null);
        };
        opts.signal?.addEventListener("abort", abortHandler, { once: true });
        listeners.push(() => opts.signal?.removeEventListener("abort", abortHandler));

        if (opts.signal?.aborted) void abortHandler();
      });
    }

    // ---- Original (non-sandboxed) path ----
    // E4-R79: fail closed on a call that provides neither contract. Without a
    // command string there is nothing to hand the shell, and silently spawning
    // an empty recipe would look like a green verification — refuse instead.
    if (typeof opts.command !== "string") {
      throw new TypeError("ProcessExecutor.run requires either `command` (shell recipe) or `runArgv({ file, args })` (structured argv)");
    }
    // Shell default must follow the host platform, not the presence of ComSpec:
    // on win32 the default is cmd.exe (via ComSpec / fallback); everywhere
    // else /bin/sh. The previous logic fell back to "cmd.exe" on POSIX when
    // ComSpec was unset, which broke exec on non-Windows hosts.
    const shell =
      opts.shell ?? (process.platform === "win32" ? process.env.ComSpec || "cmd.exe" : "/bin/sh");
    const isCmd = /cmd(\.exe)?$/i.test(shell);

    // Empirically derived win32 recipe (executor.test.ts documents this):
    // cmd.exe /d /s /c "<command>" with windowsVerbatimArguments:true.
    // Node's default arg escaping mangles cmd's quote handling.
    const shellArgs: string[] = [];
    const spawnOpts: Parameters<typeof spawn>[2] = { cwd: opts.cwd, env: { ...process.env, ...opts.env }, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] };
    if (isCmd) {
      shellArgs.push("/d", "/s", "/c", `"${opts.command}"`);
      spawnOpts.windowsVerbatimArguments = true;
    } else {
      shellArgs.push("-c", opts.command);
    }

    const stdoutChunks: string[] = [];
    const stderrChunks: string[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let truncated = false;
    let settled = false;

    const child: ChildProcess = spawn(shell, shellArgs, spawnOpts);
    if (process.env.EXEC_DEBUG !== undefined) {
      process.stdout.write(`EXEC_DBG ${JSON.stringify({ shell, shellArgs, verbatim: spawnOpts.windowsVerbatimArguments })}\n`);
      process.stdout.write(`EXEC_DBG_PLATFORM ${process.platform} ComSpec=${process.env.ComSpec}\n`);
    }

    const killTree = () => {
      if (!child.pid) return;
      if (isCmd) {
        try {
          const killer = spawn("taskkill", ["/pid", String(child.pid), "/t", "/f"]);
          killer.unref();
        } catch {
          child.kill();
        }
      } else {
        child.kill("SIGKILL");
      }
    };

    return collect(child, { timeoutMs, maxOutputBytes, cwd: opts.cwd, signal: opts.signal, ...(opts.onOutput !== undefined ? { onOutput: opts.onOutput } : {}) }, killTree, started);
  }

  /**
   * E4-R79 (F79-2): run a STRUCTURED executable + argv with `shell: false`.
   *
   * Use this whenever the caller has a real argument VECTOR (a program plus its
   * separate arguments). The legacy `run({command})` path intentionally hands a
   * full shell recipe to the platform shell; that is the wrong contract for
   * structured data because the shell re-parses it. Here nothing is parsed:
   * every `args` element is passed to `spawn` as its own argv entry.
   *
   * Timeout, cancellation, output truncation, stdout/stderr separation and
   * process-tree cleanup are shared verbatim with the shell path (see
   * `collect`), so no semantics are lost by choosing this path.
   */
  async runArgv(opts: ExecArgvOptions): Promise<ExecOutcome> {
    const started = Date.now();
    const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const maxOutputBytes = opts.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;

    // E4-R91 (H1): decide HOW to launch before spawning. On win32 a `.cmd`/`.bat`
    // shim cannot be executed by CreateProcess at all (EINVAL/ENOENT), so it is
    // routed through cmd.exe — but ONLY when no argument contains a cmd
    // metacharacter, because cmd.exe re-parses and could run a second command.
    // `.ps1` is routed through PowerShell with separate argv. Unsupported script
    // types fail closed. See `planArgvLaunch`.
    const env = { ...process.env, ...opts.env };
    // `opts.cwd` is passed to BOTH the planner and `spawn`, so the script that
    // is resolved is the script that is executed (finding G).
    const plan = planArgvLaunch(opts.file, opts.args ?? [], env, process.platform, opts.cwd);
    if (!plan.ok) {
      return {
        status: "error",
        exitCode: null,
        stdout: "",
        stderr: "",
        truncated: false,
        durationMs: Date.now() - started,
        error: plan.reason,
      };
    }

    const child = spawn(plan.file, plan.args, {
      cwd: opts.cwd,
      env,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
      // The whole point: no shell re-interprets the argument text. For the
      // `.cmd` route cmd.exe IS the launched program, but it is still spawned
      // with `shell:false` and a real argv vector — Node never concatenates a
      // command string.
      shell: false,
    });

    return await collect(
      child,
      { timeoutMs, maxOutputBytes, cwd: opts.cwd, signal: opts.signal, ...(opts.onOutput !== undefined ? { onOutput: opts.onOutput } : {}) },
      () => killDirectTree(child),
      started,
    );
  }
}