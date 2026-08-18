import { spawn, type ChildProcess } from "node:child_process";

export type ExecStatus = "success" | "failed" | "timeout" | "cancelled" | "error";

export interface ExecOutcome {
  status: ExecStatus;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  truncated: boolean;
  durationMs: number;
  error?: string;
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
}

const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_OUTPUT_BYTES = 1_048_576;

/**
 * ProcessExecutor per AGENT_ARCHITECTURE_PLAN EXEC-001.
 *
 * A pure primitive: spawn → stream → bounded collect → exit code.
 * It performs NO permission checks — all authorization happens upstream in the
 * ToolOrchestrator (permission engine + sandbox allowlist). The shell is an
 * explicit, testable injection point; we never evaluate command syntax here.
 */
export const EXECUTOR_MARKER = "verbatim-recipe-v3";

export class ProcessExecutor {
  async run(opts: ExecOptions): Promise<ExecOutcome> {
    const started = Date.now();
    const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const maxOutputBytes = opts.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
    const shell = opts.shell ?? (process.env.ComSpec || "cmd.exe");
    const isCmd = opts.shell === undefined || /cmd(\.exe)?$/i.test(opts.shell);

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
      } catch {
        // Streaming observers must never break execution.
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
}