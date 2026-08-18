import type { JsonSchema } from "./tool.js";

/**
 * MCP adapter surface (MCP-001).
 *
 * A transport-level MCP client exposes tools in a registry-agnostic shape;
 * the adapter converts them into `ToolDefinition`s so invocation flows
 * through the normal ToolOrchestrator pipeline — permission, approval,
 * sandbox and audit events all apply unchanged.
 */

export type McpServerKind = "stdio" | "http";

export interface McpServerConfig {
  id: string;
  kind: McpServerKind;
  /** stdio: command to spawn (args in commandArgs). */
  command?: string;
  commandArgs?: string[];
  /** http: base URL of the MCP endpoint. */
  url?: string;
}

export interface McpToolInfo {
  name: string;
  description?: string;
  inputSchema?: JsonSchema;
}

export interface McpCallResult {
  content: Array<{ type: string; text?: string }>;
  isError?: boolean;
}

/** Transport-level MCP client (JSON-RPC 2.0 over stdio or HTTP). */
export interface McpClient {
  readonly serverId: string;
  initialize(): Promise<void>;
  listTools(): Promise<McpToolInfo[]>;
  /** P1-10: an optional AbortSignal aborts the in-flight call (no orphan
   *  HTTP request); undefined keeps the call uncancellable. */
  callTool(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<McpCallResult>;
  close(): Promise<void>;
}

/** Adapts one MCP tool into a registrable ToolDefinition (adapter-owned wiring
 *  into the orchestrator is MCP-001's implementation, not a contract). */
export interface McpToolAdapter {
  toToolDefinition(info: McpToolInfo, serverId: string): import("./tool.js").ToolDefinition;
}