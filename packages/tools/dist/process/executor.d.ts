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
    onOutput?: (chunk: {
        stream: "stdout" | "stderr";
        text: string;
    }) => void;
    /** Shell override: defaults to cmd.exe on win32, /bin/sh elsewhere. */
    shell?: string;
}
/**
 * ProcessExecutor per AGENT_ARCHITECTURE_PLAN EXEC-001.
 *
 * A pure primitive: spawn → stream → bounded collect → exit code.
 * It performs NO permission checks — all authorization happens upstream in the
 * ToolOrchestrator (permission engine + sandbox allowlist). The shell is an
 * explicit, testable injection point; we never evaluate command syntax here.
 */
export declare const EXECUTOR_MARKER = "verbatim-recipe-v3";
export declare class ProcessExecutor {
    run(opts: ExecOptions): Promise<ExecOutcome>;
}
//# sourceMappingURL=executor.d.ts.map