import { z } from "zod";
import { errorInfo } from "@ar/contracts";
import type { ToolDefinition, ToolExecutionContext, ToolResult } from "@ar/contracts";
import { fileSha256, FileOperationCancelled, throwIfFileCancelled, withFileLock } from "../file-coordination.js";
import { readWindowFromHandle, type ReadWindow, type ScannedReadWindow } from "../read-window.js";
import type { FileHandle } from "node:fs/promises";

export interface ReadFileInput {
  path: string;
  versioned?: boolean;
  offset?: number;
  limit?: number;
  maxBytes?: number;
  scan?: "window";
}
export interface VersionedFileOutput { path: string; content: string; sha256: string; bytes: number }
export interface PagedFileOutput extends ReadWindow { path: string; bytes: number; sha256?: string }
export type WindowedFileOutput = { path: string } & Extract<ScannedReadWindow, { scanComplete: boolean }>;
type ReadFileOutput = string | VersionedFileOutput | PagedFileOutput | WindowedFileOutput;
/** Full legacy reads retain their shape, but cannot allocate unbounded files. */
export const MAX_FULL_READ_BYTES = 16 * 1024 * 1024;

function tooLarge(): Error {
  return new Error(`READ_FILE_TOO_LARGE: full-file reads are limited to ${MAX_FULL_READ_BYTES} bytes; use offset/limit/maxBytes for bounded pagination (versioned=true still hashes the entire raw file).`);
}

/** The opened file can grow after stat (including from an external editor).
 * Enforce the limit on actual bytes, reading at most one extra byte to detect
 * overflow. Descriptor ownership and cancellation remain with the caller. */
async function readFullFile(handle: FileHandle, signal: AbortSignal): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for (;;) {
    throwIfFileCancelled(signal);
    const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, MAX_FULL_READ_BYTES + 1 - total));
    let filled = 0;
    // Short native reads must not retain one full chunk allocation per byte.
    while (filled < chunk.length) {
      throwIfFileCancelled(signal);
      const { bytesRead } = await handle.read(chunk, filled, chunk.length - filled, null);
      throwIfFileCancelled(signal);
      if (bytesRead === 0) return Buffer.concat([...chunks, chunk.subarray(0, filled)], total);
      filled += bytesRead; total += bytesRead;
      if (total > MAX_FULL_READ_BYTES) throw tooLarge();
    }
    chunks.push(chunk);
  }
}

/** read_file: filesystem read tool (VS-001). Enforced via orchestrator sandbox. */
export const readFileTool: ToolDefinition<ReadFileInput, ReadFileOutput> = {
  name: "read_file",
  description: "Read a text file. Set versioned=true to return content and a raw-byte sha256 for a conditional edit/write. Set scan=window for read-only orientation: stop after the requested page and continuation are known. Window mode omits whole-file counts when scanComplete=false, and cannot be used with versioned=true. Optional offset (1-based), limit (max 2000), or maxBytes (max 1048576) selects a complete-line page. Versioned pages hash the entire file. With no pagination or window mode, return the full file up to 16MiB. First-line byte overflow requires a larger maxBytes or an approved exec, not repeating the same offset.",
  inputSchema: z.object({ path: z.string().min(1), versioned: z.boolean().optional(),
    offset: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional(),
    limit: z.number().int().positive().max(2000).optional(),
    maxBytes: z.number().int().positive().max(1048576).optional(),
    scan: z.enum(["window"]).optional().describe("Stop once the requested lines and continuation are known. Omit for versioned=true or exact whole-file line counts."),
  }),
  risk: "readonly",
  metadata: {
    name: "read_file",
    version: "1.1.0",
    sideEffect: false,
    network: false,
    filesystem: true,
    process: false,
    interactive: false,
    retry: "safe",
    concurrencySafe: true,
  },
  async execute(input, context: ToolExecutionContext): Promise<ToolResult<ReadFileOutput>> {
    if (context.signal.aborted) {
      return { status: "cancelled" };
    }
    if (input.scan === "window" && input.versioned) {
      return { status: "failed", error: errorInfo("TOOL_SCHEMA_ERROR", "Use versioned=true without scan=window to hash the whole file.") };
    }
    try {
      const { open } = await import("node:fs/promises");
      const { constants } = await import("node:fs");
      const { resolve } = await import("node:path");
      const target = resolve(context.cwd, input.path);
      return await withFileLock(target, context.signal, async (): Promise<ToolResult<ReadFileOutput>> => {
        // Opening a FIFO must not occupy a worker while waiting for a writer.
        // Inspect the opened object, not a path stat that can race a replacement.
        throwIfFileCancelled(context.signal);
        const handle = await open(target, constants.O_RDONLY | (process.platform === "win32" ? 0 : constants.O_NONBLOCK));
        try {
          throwIfFileCancelled(context.signal);
          const stat = await handle.stat();
          throwIfFileCancelled(context.signal);
          if (!stat.isFile()) throw new Error("read_file requires a regular file");
          const paged = input.scan === "window" || input.offset !== undefined || input.limit !== undefined || input.maxBytes !== undefined;
          let output: ReadFileOutput;
          if (paged) {
            const { content: page, ...window } = await readWindowFromHandle(handle, { ...input, signal: context.signal });
            throwIfFileCancelled(context.signal);
            // Control fields precede potentially large text in the model-facing JSON.
            output = { path: target, ...window, content: page };
          } else {
            if (stat.size > MAX_FULL_READ_BYTES) throw tooLarge();
            const bytes = await readFullFile(handle, context.signal);
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
