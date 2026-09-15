import { spawn, type ChildProcess } from "node:child_process";
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

    const child = spawn(opts.file, opts.args ?? [], {
      cwd: opts.cwd,
      env: { ...process.env, ...opts.env },
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
      // The whole point: no shell re-interprets the argument text.
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