import { z } from "zod";
import type { ErrorCode, ToolDefinition, ToolExecutionContext, ToolResult } from "@ar/contracts";
import { errorInfo } from "@ar/contracts";
import { ProcessExecutor } from "../process/executor.js";
import { prepareSandboxedExec } from "../process/sandbox-executor.js";
import type { SandboxExecutionProvenance } from "../process/sandbox-executor.js";
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
  /** E3-09: sandbox backend identity, policy and self-test digest when the
   *  exec ran under a confinement policy (benchmark mode). */
  provenance?: SandboxExecutionProvenance;
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

  const inside = (base: string, abs: string): boolean => {
    if (abs === base) return true;
    const rel = relative(base, abs);
    return rel !== "" && !rel.startsWith(".." + sep) && rel !== ".." && !isAbsolute(rel);
  };

  // E4-R07: the containment basis must be consistent. `workspaceRoot` may itself
  // be an ALIAS of the real directory (POSIX symlink; Windows junction, 8.3
  // short name, case-folded volume root — what the Windows CI runner hits).
  // realpath-ing the candidate and comparing it to the UN-canonical root made
  // every legitimate alias read as a symlink escape, so the root is canonicalized
  // too and the post-realpath check compares canonical against canonical.
  let canonicalRoot = root;
  try {
    canonicalRoot = await realpath(root);
  } catch (rootErr) {
    // An unusable root keeps the LEXICAL basis (so the checks below still run
    // and stay fail-closed), but that is never silent: an alias we cannot
    // resolve is exactly the condition worth surfacing.
    process.stderr.write(
      `[degraded] exec-workspace: cannot canonicalize workspace root, using lexical path (${rootErr instanceof Error ? rootErr.message : String(rootErr)})\n`,
    );
  }

  // Lexical pre-check rejects the obvious escapes without touching the fs. A
  // candidate written in the ROOT'S canonical form is legitimate too, so either
  // basis is accepted here; containment is enforced canonically below.
  const lexicallyInside = inside(root, candidate) || inside(canonicalRoot, candidate);
  if (!lexicallyInside) {
    throw new Error("WORKSPACE_POLICY:cwd-outside");
  }

  // Symlink escape: realpath the target; if it no longer sits inside the
  // CANONICAL workspace root (after resolving any links), reject. A link inside
  // the workspace that points out still fails here.
  let canonical: string;
  try {
    canonical = await realpath(candidate);
  } catch {
    // A non-existent / non-directory cwd is a policy error (fail closed),
    // never silently fallen back to the workspace root.
    throw new Error("WORKSPACE_POLICY:cwd-unresolvable");
  }
  if (!inside(canonicalRoot, canonical)) {
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

    // ---- E3-09: OS-level execution confinement (benchmark mode) ----
    // The confinement decision lives on the sandbox policy; the CLI benchmark
    // wiring sets process.confinement = "strong" (or "insecure-local" with the
    // explicit flag). When set, the spawn MUST go through the verified
    // sandbox execution spec — a model command cannot bypass the wrapper. If
    // no strong backend is available (or its self-test fails), exec is DENIED
    // before any process runs (fail-closed).
    const confinement = proc.confinement;
    let sandboxPrepared: Awaited<ReturnType<typeof prepareSandboxedExec>> | undefined;
    if (confinement !== undefined) {
      sandboxPrepared = await prepareSandboxedExec({
        confinement,
        workspaceRoot: context.cwd,
        command: input.command,
        cwd,
        env: input.env,
        timeoutMs: input.timeoutMs ?? proc.timeoutMs ?? 60_000,
        maxOutputBytes: proc.maxOutputBytes ?? 1_048_576,
      });
      if (!sandboxPrepared.ok) {
        return {
          status: "failed",
          error: errorInfo(sandboxPrepared.denial.code as ErrorCode, sandboxPrepared.denial.reason),
        };
      }
    }

    const outcome = await new ProcessExecutor().run({
      command: input.command,
      cwd,
      env: input.env,
      timeoutMs: input.timeoutMs ?? proc.timeoutMs,
      maxOutputBytes: proc.maxOutputBytes,
      signal: context.signal,
      onOutput: context.onOutput,
      ...(sandboxPrepared?.ok === true
        ? { sandboxExecution: sandboxPrepared.sandboxExecution }
        : {}),
    });

    const base = {
      exitCode: outcome.exitCode,
      stdout: outcome.stdout,
      stderr: outcome.stderr,
      truncated: outcome.truncated,
      durationMs: outcome.durationMs,
      ...(outcome.provenance !== undefined ? { provenance: outcome.provenance } : {}),
    };

    switch (outcome.status) {
      case "success":
        return {
          status: "success",
          output: base,
          evidence: [
            { type: "command", description: `exec exited 0 (${outcome.durationMs}ms)`, source: input.command, timestamp: Date.now() },
            ...(outcome.provenance !== undefined
              ? [{ type: "command" as const, description: `execution sandbox: ${outcome.provenance.backendId} strong=${outcome.provenance.strongIsolation} selfTest=${outcome.provenance.selfTestDigest?.slice(0, 12) ?? "none"}`, source: "sandbox-executor", timestamp: Date.now() }]
              : []),
          ],
        };
      case "timeout":
        return { status: "timeout", output: base, error: errorInfo("PROCESS_TIMEOUT", outcome.error) };
      case "cancelled":
        return { status: "cancelled", error: errorInfo("USER_CANCELLED", outcome.error) };
      case "denied":
        return {
          status: "failed",
          output: base,
          error: errorInfo((outcome.denial?.code ?? "SANDBOX_BACKEND_DENIED") as ErrorCode, outcome.denial?.reason ?? outcome.error ?? "execution denied by sandbox backend"),
        };
      default:
        return { status: "failed", output: base, error: errorInfo("PROCESS_ERROR", outcome.error) };
    }
  },
};