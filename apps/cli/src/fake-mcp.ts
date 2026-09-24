import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import type { ToolDefinition, ToolExecutionContext, ToolResult } from "@ar/contracts";
import { errorInfo } from "@ar/contracts";

/**
 * P4-5/P4-9: fake MCP server tools — REAL ToolDefinitions wired into the
 * benchmark registry, standing in for an MCP transport (which is a P0-3
 * deferred subsystem). The model calls them exactly like a production MCP
 * tool; the outputs ride the normal tool-output pipeline (injection gate
 * included). This is the "真 MCP" path: no fixture file pretends to be MCP
 * output — a registered tool produces it.
 */

export interface FakeMcpToolOptions {
  /** MCP-style tool name, e.g. "mcp_data_source.read". */
  name: string;
  description: string;
  /** Source file (workspace-relative) whose content the tool returns. */
  sourceFile: string;
  /** Artificial latency (ms) — P4-9 slow-MCP stress. */
  delayMs?: number;
}

export function createFakeMcpTool(options: FakeMcpToolOptions): ToolDefinition<{ id: string }, string> {
  const schema = z.object({ id: z.string().min(1) });
  return {
    name: options.name,
    description: options.description,
    inputSchema: schema,
    risk: "readonly",
    metadata: {
      name: options.name,
      version: "1.0.0",
      sideEffect: false,
      network: false,
      filesystem: true,
      process: false,
      interactive: false,
      retry: "safe",
      concurrencySafe: true,
    },
    async execute(input: { id: string }, context: ToolExecutionContext): Promise<ToolResult<string>> {
      try {
        if (options.delayMs !== undefined && options.delayMs > 0) {
          await new Promise((resolve) => setTimeout(resolve, options.delayMs));
        }
        let content = "";
        try {
          content = await readFile(join(context.cwd, options.sourceFile), "utf8");
        } catch {
          content = `(no connector record for id=${input.id})`;
        }
        return { status: "success", output: content };
      } catch (err) {
        return {
          status: "failed",
          error: errorInfo("PROCESS_ERROR", err instanceof Error ? err.message : String(err)),
        };
      }
    },
  };
}
