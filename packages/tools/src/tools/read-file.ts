import { z } from "zod";
import type { ToolDefinition, ToolExecutionContext, ToolResult } from "@ar/contracts";
import { fileSha256, FileOperationCancelled, throwIfFileCancelled, withFileLock } from "../file-coordination.js";

export interface ReadFileInput { path: string; versioned?: boolean }
export interface VersionedFileOutput { path: string; content: string; sha256: string; bytes: number }

/** read_file: filesystem read tool (VS-001). Enforced via orchestrator sandbox. */
export const readFileTool: ToolDefinition<ReadFileInput, string | VersionedFileOutput> = {
  name: "read_file",
  description: "Read a text file. Set versioned=true to return content and a raw-byte sha256 for a conditional edit/write.",
  inputSchema: z.object({ path: z.string().min(1), versioned: z.boolean().optional() }),
  risk: "readonly",
  metadata: {
    name: "read_file",
    version: "1.0.0",
    sideEffect: false,
    network: false,
    filesystem: true,
    process: false,
    interactive: false,
    retry: "safe",
    concurrencySafe: true,
  },
  async execute(input, context: ToolExecutionContext): Promise<ToolResult<string | VersionedFileOutput>> {
    if (context.signal.aborted) {
      return { status: "cancelled" };
    }
    try {
      const { open } = await import("node:fs/promises");
      const { constants } = await import("node:fs");
      const { resolve } = await import("node:path");
      const target = resolve(context.cwd, input.path);
      return await withFileLock(target, context.signal, async (): Promise<ToolResult<string | VersionedFileOutput>> => {
        // Opening a FIFO must not occupy a worker while waiting for a writer.
        // Inspect the opened object, not a path stat that can race a replacement.
        throwIfFileCancelled(context.signal);
        const handle = await open(target, constants.O_RDONLY | (process.platform === "win32" ? 0 : constants.O_NONBLOCK));
        try {
          throwIfFileCancelled(context.signal);
          const stat = await handle.stat();
          throwIfFileCancelled(context.signal);
          if (!stat.isFile()) throw new Error("read_file requires a regular file");
          const bytes = await handle.readFile({ signal: context.signal });
          throwIfFileCancelled(context.signal);
          const content = bytes.toString("utf8");
          return {
            status: "success",
            output: input.versioned ? { path: target, content, sha256: fileSha256(bytes), bytes: bytes.length } : content,
            evidence: [{ type: "file", description: "read_file executed", source: target, timestamp: Date.now() }],
          };
        } finally {
          // Close before withFileLock releases coordination, on every outcome.
          await handle.close();
        }
      });
    } catch (err) {
      if (err instanceof FileOperationCancelled || context.signal.aborted) return { status: "cancelled" };
      return {
        status: "failed",
        error: {
          code: "PROCESS_ERROR",
          message: err instanceof Error ? err.message : String(err),
          retryable: false,
          safeToRetry: false,
        },
      };
    }
  },
};