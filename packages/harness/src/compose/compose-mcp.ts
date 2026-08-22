/**
 * P22-1 — composition helper: MCP / integrations.
 *
 * Extracted from createHarness.ts verbatim (composition refactor only).
 * Each configured server connects over its REAL transport (http → JSON-RPC
 * over fetch; stdio → spawned child process); a connection/registration
 * failure ABORTS harness creation — a misconfigured server is never silently
 * dropped. Tool descriptions are injection-scanned fail-closed (P0-8).
 */
import type { AgentEvent } from "@ar/contracts";
import { connectMcpServer, type McpServerConnection } from "@ar/mcp";
import type { ToolRegistry } from "@ar/tools";
import type { HarnessConfig, HarnessFeatureFlags } from "../config.js";

export interface ComposedMcp {
  mcpToolNames: string[];
  mcpConnections: McpServerConnection[];
}

/** P22-1 — connect configured MCP servers and register their tools. */
export async function composeMcp(
  config: HarnessConfig,
  features: HarnessFeatureFlags,
  registry: ToolRegistry,
  appendHarnessEvent: (
    sessionId: string,
    type: AgentEvent["type"],
    payload: Record<string, unknown>,
    extra?: { turnId?: string; timestamp?: number },
  ) => Promise<void>,
): Promise<ComposedMcp> {
  const mcpConfigs = config.mcp ?? [];
  const mcpEnabled = features.mcp || mcpConfigs.length > 0;
  const mcpToolNames: string[] = [];
  const mcpConnections: McpServerConnection[] = [];
  if (mcpEnabled && mcpConfigs.length > 0) {
    const sink: import("@ar/contracts").EventSink = {
      async emit(sessionId, type, payload, turnId) {
        await appendHarnessEvent(sessionId, type as AgentEvent["type"], payload ?? {}, {
          ...(turnId !== undefined ? { turnId } : {}),
        });
      },
    };
    for (const server of mcpConfigs) {
      const conn = await connectMcpServer(server, {
        events: sink,
        trust: "untrusted",
        networkBoundary: server.kind === "stdio" ? "loopback" : "internet",
      });
      for (const tool of conn.tools) {
        registry.register(tool);
        mcpToolNames.push(tool.name);
      }
      mcpConnections.push(conn);
    }
  }
  return { mcpToolNames, mcpConnections };
}
