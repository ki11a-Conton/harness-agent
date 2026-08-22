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
  /** P14-4: the host's conferred tool allow-list for THIS server. The
   *  server's advertised tools are the DECLARED capability and may only
   *  narrow this bound — a tool outside `allowedTools` is denied at
   *  registration (fail-closed, typed denial). Absent = all advertised tools
   *  are conferred (backward compatible). */
  allowedTools?: string[];
  /** P24-1: connect eagerly at harness creation (opt-in; default false). */
  eager?: boolean;
  /** P24-3: resolve as needed even without an explicit mention. */
  requiredByDefault?: boolean;
  /** P24-8: per-server lifecycle policy. */
  policy?: import("./mcp.js").McpRuntimePolicy;
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

/**
 * P24-1 — MCP runtime V2: a catalog descriptor is DECLARATION ONLY.
 * Constructing a descriptor never connects; the connection manager connects
 * lazily when a step's dependency resolution actually needs the server.
 */
export interface McpServerDescriptor {
  readonly id: string;
  readonly config: McpServerConfig;
  readonly trust: "trusted" | "untrusted";
  readonly networkBoundary: import("./context.js").NetworkBoundary;
  readonly enabled: boolean;
  /** Connect eagerly at harness creation (opt-in; default false). */
  readonly eager?: boolean;
  /** Always resolve as needed even without an explicit mention. */
  readonly requiredByDefault?: boolean;
  /** P24-8 runtime policy applied per connection. */
  readonly policy?: McpRuntimePolicy;
}

/** P24-8 — bounded MCP connection lifecycle policy. */
export interface McpRuntimePolicy {
  /** Close idle connections after this long (undefined = never idle-close). */
  idleTtlMs?: number;
  /** Max simultaneously connected servers (undefined = unbounded). */
  maxConnectedServers?: number;
  /** Per-connect timeout. */
  connectTimeoutMs?: number;
}

/**
 * P24-4 — one frozen MCP tool binding inside an McpBindingSnapshot. A call
 * generated against generation G1 must never silently execute against G2.
 */
export interface McpFrozenToolBinding {
  readonly serverId: string;
  readonly generation: string;
  readonly toolName: string;
  readonly schemaHash: string;
  /** The exact adapter/executor reference frozen at snapshot build. */
  readonly definition: import("./tool.js").ToolDefinition;
  readonly trust: "trusted" | "untrusted";
}

/** P24-4 — immutable MCP world bound into one step snapshot. */
export interface McpBindingSnapshot {
  readonly id: string;
  readonly fingerprint: string;
  /** serverId → connection generation (the G that produced these bindings). */
  readonly generations: ReadonlyMap<string, string>;
  readonly tools: readonly McpFrozenToolBinding[];
  readonly createdAt: number;
}
