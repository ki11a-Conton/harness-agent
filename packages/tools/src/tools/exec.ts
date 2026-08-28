import { z } from "zod";
import type { ToolDefinition, ToolExecutionContext, ToolResult } from "@ar/contracts";
import { errorInfo } from "@ar/contracts";
import { ProcessExecutor } from "../process/executor.js";
import { isAbsolute, resolve, relative, sep } from "node:path";
import { realpath, stat } from "node:fs/promises";

export interface ExecInput {
  command: string;
  cwd?: string;
  env?: Record<string, string>;
  timeoutMs?: number;
}

export interface ExecOutput {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  truncated: boolean;
  durationMs: number;
}

/**
 * E1-02 — canonical workspace containment for exec `cwd`.
 *
 * All exec cwd values MUST resolve inside the session workspace. A relative
 * cwd (including `.`) is resolved against the session workspace root
 * (`context.cwd`), never the HOST `process.cwd()`. Absolute paths outside the
 * workspace, `..` escapes and symlink escapes are rejected with a stable
 * `WORKSPACE_POLICY` error. Symlink containment is enforced by realpath-ing
 * the final target and re-checking containment on the canonical path.
 *
 * Returns the normalized absolute cwd inside the workspace.
 */
export async function resolveExecCwd(
  requested: string | undefined,
  workspaceRoot: string,
): Promise<string> {
  const root = resolve(workspaceRoot);
  const candidate = requested === undefined || requested === "" || requested === "."
    ? root
    : isAbsolute(requested)
      ? resolve(requested)
      : resolve(root, requested);

  const within = (abs: string): boolean => {
    if (abs === root) return true;
    const rel = relative(root, abs);
    return rel !== "" && !rel.startsWith(".." + sep) && rel !== ".." && !isAbsolute(rel);
  };

  if (!within(candidate)) {
    throw new Error("WORKSPACE_POLICY:cwd-outside");
  }

  // Symlink escape: realpath the target; if it no longer sits inside the
  // workspace (after resolving any links), reject.
  let canonical: string;
  try {
    canonical = await realpath(candidate);
  } catch {
    // A non-existent / non-directory cwd is a policy error (fail closed),
    // never silently fallen back to the workspace root.
    throw new Error("WORKSPACE_POLICY:cwd-unresolvable");
  }
  if (!within(canonical)) {
    throw new Error("WORKSPACE_POLICY:symlink-escape");
  }
  // realpath resolves file paths too; the cwd must be a directory.
  try {
    const st = await stat(canonical);
    if (!st.isDirectory()) {
      throw new Error("WORKSPACE_POLICY:cwd-not-directory");
    }
  } catch (err) {
    if (err instanceof Error && err.message.startsWith("WORKSPACE_POLICY:")) throw err;
    throw new Error("WORKSPACE_POLICY:cwd-unresolvable");
  }
  return canonical;
}

/**
 * exec tool (EXEC-001). All policy enforcement stays in the orchestrator:
 * permission (elevated risk → ask/approval) and sandbox (process allowlist).
 * The tool itself only shells out through ProcessExecutor, with its cwd
 * confined to the session workspace (E1-02).
 */
export const execTool: ToolDefinition<ExecInput, ExecOutput> = {
  name: "exec",
  description: "Run a command in the workspace shell and capture its output.",
  inputSchema: z.object({
    command: z.string().min(1),
    cwd: z.string().optional(),
    env: z.record(z.string()).optional(),
    timeoutMs: z.number().int().positive().max(10 * 60 * 1000).optional(),
  }),
  risk: "elevated",
  metadata: {
    name: "exec",
    version: "1.0.0",
    sideEffect: true,
    network: false,
    filesystem: false,
    process: true,
    interactive: false,
    retry: "unknown",
    concurrencySafe: false,
  },
  async execute(input: ExecInput, context: ToolExecutionContext): Promise<ToolResult<ExecOutput>> {
    const proc = context.sandboxPolicy.process;
    let cwd: string;
    try {
      cwd = await resolveExecCwd(input.cwd, context.cwd);
    } catch (err) {
      const code = err instanceof Error && err.message.startsWith("WORKSPACE_POLICY:")
        ? err.message.slice("WORKSPACE_POLICY:".length)
        : "cwd-outside";
      return {
        status: "failed",
        error: errorInfo("WORKSPACE_POLICY", `exec cwd is outside the session workspace (${code})`),
      };
    }
    const outcome = await new ProcessExecutor().run({
      command: input.command,
      cwd,
      env: input.env,
      timeoutMs: input.timeoutMs ?? proc.timeoutMs,
      maxOutputBytes: proc.maxOutputBytes,
      signal: context.signal,
      onOutput: context.onOutput,
    });

    const base = {
      exitCode: outcome.exitCode,
      stdout: outcome.stdout,
      stderr: outcome.stderr,
      truncated: outcome.truncated,
      durationMs: outcome.durationMs,
    };

    switch (outcome.status) {
      case "success":
        return {
          status: "success",
          output: base,
          evidence: [
            { type: "command", description: `exec exited 0 (${outcome.durationMs}ms)`, source: input.command, timestamp: Date.now() },
          ],
        };
      case "timeout":
        return { status: "timeout", output: base, error: errorInfo("PROCESS_TIMEOUT", outcome.error) };
      case "cancelled":
        return { status: "cancelled", error: errorInfo("USER_CANCELLED", outcome.error) };
      default:
        return { status: "failed", output: base, error: errorInfo("PROCESS_ERROR", outcome.error) };
    }
  },
};