import { z } from "zod";
import type { ToolDefinition, ToolExecutionContext, ToolResult } from "@ar/contracts";
import { errorInfo } from "@ar/contracts";

export interface WriteFileInput {
  path: string;
  content: string;
  append?: boolean;
}

/**
 * write_file (VS-001). Writes/append a UTF-8 file. All policy enforcement
 * (permission + sandbox path checks) happens in the orchestrator.
 */
export const writeFileTool: ToolDefinition<WriteFileInput, { path: string; bytes: number }> = {
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
  async execute(input: WriteFileInput, context: ToolExecutionContext): Promise<ToolResult<{ path: string; bytes: number }>> {
    try {
      const { writeFile, appendFile, mkdir } = await import("node:fs/promises");
      const { dirname, resolve } = await import("node:path");
      const target = resolve(context.cwd, input.path);
      await mkdir(dirname(target), { recursive: true });
      if (input.append) {
        await appendFile(target, input.content, "utf8");
      } else {
        await writeFile(target, input.content, "utf8");
      }
      return {
        status: "success",
        output: { path: target, bytes: Buffer.byteLength(input.content, "utf8") },
        evidence: [{ type: "file", description: `wrote ${Buffer.byteLength(input.content, "utf8")} bytes`, source: target, timestamp: Date.now() }],
      };
    } catch (err) {
      return {
        status: "failed",
        error: errorInfo("PROCESS_ERROR", err instanceof Error ? err.message : String(err)),
      };
    }
  },
};