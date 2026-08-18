import { z } from "zod";
import type { ToolDefinition, ToolExecutionContext, ToolResult } from "@ar/contracts";

/** read_file: filesystem read tool (VS-001). Enforced via orchestrator sandbox. */
export const readFileTool: ToolDefinition<{ path: string }, string> = {
  name: "read_file",
  description: "Read a text file from the workspace.",
  inputSchema: z.object({ path: z.string().min(1) }),
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
  async execute(input, context: ToolExecutionContext): Promise<ToolResult<string>> {
    if (context.signal.aborted) {
      return { status: "cancelled" };
    }
    try {
      const { readFile } = await import("node:fs/promises");
      const content = await readFile(input.path, "utf8");
      return {
        status: "success",
        output: content,
        evidence: [{ type: "file", description: "read_file executed", source: input.path, timestamp: Date.now() }],
      };
    } catch (err) {
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