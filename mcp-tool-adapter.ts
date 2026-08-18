import type { McpClient } from "./mcp-client.js";
import { AgentError, errorInfo } from "@ar/contracts";
import { detectPromptInjection } from "@ar/security";

export interface ToolLikeHandlerContext {
  args: unknown;
  /** P1-10: caller-provided cancellation, forwarded to the MCP call. */
  signal?: AbortSignal;
}

/**
 * Adapter-shaped tool description. There is no shared ToolLike in
 * @ar/tools yet, so the shape is declared here: everything the client
 * knows about a remote tool plus a handler that invokes it.
 */
export interface ToolLike {
  name: string;
  description?: string;
  schema?: Record<string, unknown>;
  handler(ctx: ToolLikeHandlerContext): Promise<unknown>;
}

/** The client surface the adapter needs; McpClient satisfies it structurally. */
export type McpToolSource = Pick<McpClient, "listTools" | "callTool">;

/** Maps every tool exposed by the client into a ToolLike that calls it.
 *  P0-8: a remote tool whose description carries prompt-injection material
 *  is rejected (fail-closed) — MCP descriptions are low-trust content and
 *  must not smuggle instructions into the agent's context. */
export async function createMcpToolAdapter(client: McpToolSource): Promise<ToolLike[]> {
  const tools = await client.listTools();
  return tools.map((tool) => {
    if (tool.description !== undefined) {
      const report = detectPromptInjection(tool.description);
      if (report.hasInjection) {
        throw new AgentError(
          errorInfo(
            "SECURITY_DENIED",
            `mcp tool "${tool.name}" rejected: description contains prompt-injection material (${report.reasons.join(", ")})`,
          ),
        );
      }
    }
    return {
      name: tool.name,
      ...(tool.description !== undefined ? { description: tool.description } : {}),
      ...(tool.inputSchema !== undefined ? { schema: tool.inputSchema } : {}),
      handler: async (ctx: ToolLikeHandlerContext) => client.callTool(tool.name, ctx.args, ctx.signal),
    };
  });
}
