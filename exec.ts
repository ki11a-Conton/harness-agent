import { z } from "zod";
import type { ToolDefinition, ToolExecutionContext, ToolResult } from "@ar/contracts";
import { errorInfo } from "@ar/contracts";
import { ProcessExecutor } from "../process/executor.js";

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
 * exec tool (EXEC-001). All policy enforcement stays in the orchestrator:
 * permission (elevated risk → ask/approval) and sandbox (process allowlist).
 * The tool itself only shells out through ProcessExecutor.
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
    const outcome = await new ProcessExecutor().run({
      command: input.command,
      cwd: input.cwd ?? context.cwd,
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