import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import type { ToolDefinition, ToolResult } from "@ar/contracts";
import { ToolRegistry } from "./registry.js";

/**
 * P18-2: on-demand full-schema lookup. In deferred-advertisement mode the
 * model sees stubs for the MCP/plugin bulk; `tool_lookup` returns the FULL
 * input schema for the requested names so the model can then call the tool
 * with correct arguments. Read-only, idempotent, concurrency-safe.
 */
export function createToolLookupTool(registry: ToolRegistry): ToolDefinition<{ names: string[] }, Record<string, unknown>> {
  return {
    name: "tool_lookup",
    description:
      "Fetch the full input schema of one or more tools by name. Use it when a tool's advertised schema is a stub and you need the exact arguments before calling it.",
    inputSchema: z.object({
      names: z.array(z.string()).min(1).max(10).describe("Tool names to look up"),
    }),
    risk: "readonly",
    metadata: {
      name: "tool_lookup",
      version: "1.0.0",
      sideEffect: false,
      network: false,
      filesystem: false,
      process: false,
      interactive: false,
      retry: "safe",
      concurrencySafe: true,
    },
    async execute(input): Promise<ToolResult<Record<string, unknown>>> {
      const out: Record<string, unknown> = {};
      for (const name of input.names) {
        const tool = registry.get(name);
        out[name] =
          tool === undefined
            ? { error: `unknown tool: ${name}` }
            : {
                name: tool.name,
                description: tool.description,
                inputSchema: zodToJsonSchema(tool.inputSchema) as Record<string, unknown>,
              };
      }
      return { status: "success", output: out };
    },
  };
}
