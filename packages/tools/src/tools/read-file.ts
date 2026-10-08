import { z } from "zod";
import type { ToolDefinition, ToolExecutionContext, ToolResult } from "@ar/contracts";
import { fileSha256, FileOperationCancelled, throwIfFileCancelled, withFileLock } from "../file-coordination.js";
import { readWindowFromHandle, type ReadWindow } from "../read-window.js";

export interface ReadFileInput { path: string; versioned?: boolean; offset?: number; limit?: number; maxBytes?: number }
export interface VersionedFileOutput { path: string; content: string; sha256: string; bytes: number }
export interface PagedFileOutput extends ReadWindow { path: string; bytes: number; sha256?: string }
/** Full legacy reads retain their shape, but cannot allocate unbounded files. */
export const MAX_FULL_READ_BYTES = 16 * 1024 * 1024;

/** read_file: filesystem read tool (VS-001). Enforced via orchestrator sandbox. */
export const readFileTool: ToolDefinition<ReadFileInput, string | VersionedFileOutput | PagedFileOutput> = {
  name: "read_file",
  description: "Read a text file. Set versioned=true to return content and a raw-byte sha256 for a conditional edit/write. Optional offset (1-based), limit (max 2000), or maxBytes (max 1048576) selects a bounded complete-line page with continuation metadata. The page's sha256 still identifies the entire original file; omitted pagination retains the legacy full-file output for files up to 16MiB. Larger files require pagination. First-line byte overflow requires a larger maxBytes or an approved exec, not repeating the same offset.",
  inputSchema: z.object({ path: z.string().min(1), versioned: z.boolean().optional(),
    offset: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional(),
    limit: z.number().int().positive().max(2000).optional(),
    maxBytes: z.number().int().positive().max(1048576).optional(),
  }),
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
  async execute(input, context: ToolExecutionContext): Promise<ToolResult<string | VersionedFileOutput | PagedFileOutput>> {
    if (context.signal.aborted) {
      return { status: "cancelled" };
    }
    try {
      const { open } = await import("node:fs/promises");
      const { constants } = await import("node:fs");
      const { resolve } = await import("node:path");
      const target = resolve(context.cwd, input.path);
      return await withFileLock(target, context.signal, async (): Promise<ToolResult<string | VersionedFileOutput | PagedFileOutput>> => {
        // Opening a FIFO must not occupy a worker while waiting for a writer.
        // Inspect the opened object, not a path stat that can race a replacement.
        throwIfFileCancelled(context.signal);
        const handle = await open(target, constants.O_RDONLY | (process.platform === "win32" ? 0 : constants.O_NONBLOCK));
        try {
          throwIfFileCancelled(context.signal);
          const stat = await handle.stat();
          throwIfFileCancelled(context.signal);
          if (!stat.isFile()) throw new Error("read_file requires a regular file");
          const paged = input.offset !== undefined || input.limit !== undefined || input.maxBytes !== undefined;
          let output: string | VersionedFileOutput | PagedFileOutput;
          if (paged) {
            const { content: page, ...window } = await readWindowFromHandle(handle, { ...input, signal: context.signal });
            throwIfFileCancelled(context.signal);
            // Control fields precede potentially large text in the model-facing JSON.
            output = { path: target, ...window, content: page };
          } else {
            if (stat.size > MAX_FULL_READ_BYTES) throw new Error(
              `READ_FILE_TOO_LARGE: full-file reads are limited to ${MAX_FULL_READ_BYTES} bytes; use offset/limit/maxBytes for bounded pagination (versioned=true still hashes the entire raw file).`,
            );
            const bytes = await handle.readFile({ signal: context.signal });
            throwIfFileCancelled(context.signal);
            const content = bytes.toString("utf8");
            output = input.versioned ? { path: target, content, sha256: fileSha256(bytes), bytes: bytes.length } : content;
          }
          return {
            status: "success",
            output,
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
