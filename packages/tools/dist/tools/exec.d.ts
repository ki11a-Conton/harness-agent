import type { ToolDefinition } from "@ar/contracts";
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
export declare const execTool: ToolDefinition<ExecInput, ExecOutput>;
//# sourceMappingURL=exec.d.ts.map