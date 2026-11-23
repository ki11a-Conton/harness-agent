import { z } from "zod";
import type { ToolDefinition, ToolExecutionContext, ToolResult } from "@ar/contracts";
import { errorInfo } from "@ar/contracts";
import { assessWriteSafety } from "../write-safety.js";
import { assertWritableUtf8, InvalidUtf8Content, FileOperationCancelled, FileVersionConflict, throwIfFileCancelled, withFileLock, writeRegularFileUtf8 } from "../file-coordination.js";

class UnsafeWrite extends Error {}

export interface WriteFileInput {
  path: string;
  content: string;
  append?: boolean;
  /** Optional raw-byte read version, checked for append and overwrite. */
  expectedSha256?: string;
}

export interface WriteFileOutput {
  path: string;
  bytes: number;
  /** P2-27: present when the write-safety guard rated the write "caution". */
  safetyWarning?: string;
  /** P2-27: flags from the write-safety guard, for observability. */
  safetyFlags?: string[];
}

/**
 * write_file (VS-001). Writes/append a UTF-8 file. All policy enforcement
 * (permission + sandbox path checks) happens in the orchestrator. P2-27:
 * the write-safety guard blocks destructive overwrites (existing large file →
 * tiny replacement with no backup checkpoint) before the write happens.
 */
export const writeFileTool: ToolDefinition<WriteFileInput, WriteFileOutput> = {
  name: "write_file",
  description: "Write or append valid UTF-8 text. Unpaired Unicode surrogates fail without writing. Destructive overwrite safety is checked on the actual opened file. Supply expectedSha256 from versioned read_file to reject stale content; on conflict, reread and recalculate.",
  inputSchema: z.object({
    path: z.string().min(1),
    content: z.string(),
    append: z.boolean().optional(),
    expectedSha256: z.string().regex(/^[a-fA-F0-9]{64}$/).optional(),
  }),
  risk: "side_effect",
  metadata: {
    name: "write_file",
    version: "1.1.0",
    sideEffect: true,
    network: false,
    filesystem: true,
    process: false,
    interactive: false,
    retry: "none",
    concurrencySafe: false,
  },
  async execute(input: WriteFileInput, context: ToolExecutionContext): Promise<ToolResult<WriteFileOutput>> {
    try {
      throwIfFileCancelled(context.signal);
      assertWritableUtf8(input.content);
      const { mkdir } = await import("node:fs/promises");
      const { dirname, resolve } = await import("node:path");
      const target = resolve(context.cwd, input.path);
      const bytes = Buffer.byteLength(input.content, "utf8");
      return await withFileLock(target, context.signal, async (): Promise<ToolResult<WriteFileOutput>> => {
        throwIfFileCancelled(context.signal);

        // A missing file is safe to create; existing-file facts must come
        // from its owned descriptor, not a fallible/racing path stat.
        let safety = assessWriteSafety({ exists: false, originalBytes: 0, newBytes: bytes,
          append: input.append ?? false, untracked: false, hasCheckpoint: false });

        if (input.expectedSha256 === undefined) await mkdir(dirname(target), { recursive: true });
        throwIfFileCancelled(context.signal);
        await writeRegularFileUtf8(target, input.content, { append: input.append, signal: context.signal, expectedSha256: input.expectedSha256,
          checkExisting: stat => {
            safety = assessWriteSafety({ exists: true, originalBytes: stat.size, newBytes: bytes,
              append: input.append ?? false, untracked: false, hasCheckpoint: false });
            if (safety.level === "danger") throw new UnsafeWrite(`write blocked by write-safety guard (${safety.reason})`);
          },
        });
        const output: WriteFileOutput = { path: target, bytes };
        if (safety.level === "caution") {
          output.safetyWarning = `write-safety: ${safety.reason}; recommend a checkpoint before overwriting untracked content`;
          output.safetyFlags = safety.flags;
        }
        return {
          status: "success",
          output,
          evidence: [{ type: "file", description: `wrote ${bytes} bytes`, source: target, timestamp: Date.now() }],
        };
      });
    } catch (err) {
      if (err instanceof InvalidUtf8Content) return { status: "failed", error: errorInfo("TOOL_SCHEMA_ERROR", err.message, { retryable: false, safeToRetry: false }) };
      if (err instanceof UnsafeWrite) return { status: "denied", error: errorInfo("WRITE_SAFETY_DENIED", err.message) };
      if (err instanceof FileOperationCancelled) return { status: "cancelled" };
      if (err instanceof FileVersionConflict) return { status: "failed", error: errorInfo("PROCESS_ERROR", err.message, { retryable: false, safeToRetry: false }) };
      return {
        status: "failed",
        error: errorInfo("PROCESS_ERROR", err instanceof Error ? err.message : String(err)),
      };
    }
  },
};
