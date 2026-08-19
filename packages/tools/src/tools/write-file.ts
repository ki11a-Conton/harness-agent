import { z } from "zod";
import type { ToolDefinition, ToolExecutionContext, ToolResult } from "@ar/contracts";
import { errorInfo } from "@ar/contracts";
import { assessWriteSafety } from "../write-safety.js";

export interface WriteFileInput {
  path: string;
  content: string;
  append?: boolean;
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
  description: "Write or append UTF-8 content to a file.",
  inputSchema: z.object({
    path: z.string().min(1),
    content: z.string(),
    append: z.boolean().optional(),
  }),
  risk: "side_effect",
  metadata: {
    name: "write_file",
    version: "1.0.0",
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
      const { stat, writeFile, appendFile, mkdir } = await import("node:fs/promises");
      const { dirname, resolve } = await import("node:path");
      const target = resolve(context.cwd, input.path);
      const bytes = Buffer.byteLength(input.content, "utf8");

      // P2-27: measure the pre-write shape so the guard can rate the write.
      let exists = false;
      let originalBytes = 0;
      try {
        const st = await stat(target);
        exists = st.isFile();
        originalBytes = st.size;
      } catch {
        // ENOENT → brand-new file; guard will rate it safe (create).
      }
      const safety = assessWriteSafety({
        exists,
        originalBytes,
        newBytes: bytes,
        append: input.append ?? false,
        // P2-26 checkpoints are not yet wired into this tool; a destructive
        // overwrite without one is exactly what the guard must catch.
        untracked: false,
        hasCheckpoint: false,
      });

      if (safety.level === "danger") {
        return {
          status: "denied",
          error: errorInfo("WRITE_SAFETY_DENIED", `write blocked by write-safety guard (${safety.reason})`),
        };
      }

      await mkdir(dirname(target), { recursive: true });
      if (input.append) {
        await appendFile(target, input.content, "utf8");
      } else {
        await writeFile(target, input.content, "utf8");
      }
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
    } catch (err) {
      return {
        status: "failed",
        error: errorInfo("PROCESS_ERROR", err instanceof Error ? err.message : String(err)),
      };
    }
  },
};