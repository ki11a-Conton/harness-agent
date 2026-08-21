import { spawn } from "node:child_process";
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
    async run(opts) {
        const started = Date.now();
        const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
        const maxOutputBytes = opts.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
        // Shell default must follow the host platform, not the presence of ComSpec:
        // on win32 the default is cmd.exe (via ComSpec / fallback); everywhere
        // else /bin/sh. The previous logic fell back to "cmd.exe" on POSIX when
        // ComSpec was unset, which broke exec on non-Windows hosts.
        const shell = opts.shell ?? (process.platform === "win32" ? process.env.ComSpec || "cmd.exe" : "/bin/sh");
        const isCmd = /cmd(\.exe)?$/i.test(shell);
        // Empirically derived win32 recipe (executor.test.ts documents this):
        // cmd.exe /d /s /c "<command>" with windowsVerbatimArguments:true.
        // Node's default arg escaping mangles cmd's quote handling.
        const shellArgs = [];
        const spawnOpts = { cwd: opts.cwd, env: { ...process.env, ...opts.env }, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] };
        if (isCmd) {
            shellArgs.push("/d", "/s", "/c", `"${opts.command}"`);
            spawnOpts.windowsVerbatimArguments = true;
        }
        else {
            shellArgs.push("-c", opts.command);
        }
        const stdoutChunks = [];
        const stderrChunks = [];
        let stdoutBytes = 0;
        let stderrBytes = 0;
        let truncated = false;
        let settled = false;
        const child = spawn(shell, shellArgs, spawnOpts);
        if (process.env.EXEC_DEBUG !== undefined) {
            process.stdout.write(`EXEC_DBG ${JSON.stringify({ shell, shellArgs, verbatim: spawnOpts.windowsVerbatimArguments })}\n`);
            process.stdout.write(`EXEC_DBG_PLATFORM ${process.platform} ComSpec=${process.env.ComSpec}\n`);
        }
        const outcome = (status, exitCode, error) => ({
            status,
            exitCode,
            stdout: stdoutChunks.join(""),
            stderr: stderrChunks.join(""),
            truncated,
            durationMs: Date.now() - started,
            ...(error !== undefined ? { error } : {}),
        });
        const finish = (status, exitCode, error) => {
            if (settled)
                return outcome(status, exitCode, error);
            settled = true;
            return outcome(status, exitCode, error);
        };
        const drain = (stream, data) => {
            const text = data.toString();
            const byteLen = Buffer.byteLength(text, "utf8");
            const cap = maxOutputBytes - (stream === "stdout" ? stdoutBytes : stderrBytes);
            if (cap > 0) {
                (stream === "stdout" ? stdoutChunks : stderrChunks).push(text.slice(0, cap));
                if (byteLen > cap)
                    truncated = true;
            }
            else {
                truncated = true;
            }
            if (stream === "stdout")
                stdoutBytes += byteLen;
            else
                stderrBytes += byteLen;
            try {
                opts.onOutput?.({ stream, text });
            }
            catch {
                // Streaming observers must never break execution.
            }
        };
        const killTree = () => {
            if (!child.pid)
                return;
            if (isCmd) {
                try {
                    const killer = spawn("taskkill", ["/pid", String(child.pid), "/t", "/f"]);
                    killer.unref();
                }
                catch {
                    child.kill();
                }
            }
            else {
                child.kill("SIGKILL");
            }
        };
        const listeners = [];
        child.stdout?.on("data", (d) => drain("stdout", d));
        child.stderr?.on("data", (d) => drain("stderr", d));
        return new Promise((resolve) => {
            let forced;
            const done = (status, exitCode, error) => {
                if (forced !== undefined) {
                    const o = finish(forced.status, null, forced.error);
                    if (settled) {
                        clearTimeout(timer);
                        for (const l of listeners)
                            l();
                        resolve(o);
                    }
                    return;
                }
                const o = finish(status, exitCode, error);
                if (settled) {
                    clearTimeout(timer);
                    for (const l of listeners)
                        l();
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
                }
                else if (code !== null) {
                    done("failed", code, `exited with code ${code}${signal ? ` (${signal})` : ""}`);
                }
                else {
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
            if (opts.signal?.aborted)
                void abortHandler();
        });
    }
}
//# sourceMappingURL=executor.js.map