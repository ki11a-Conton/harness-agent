import type { EventSink, McpServerConfig, NetworkBoundary, ToolDefinition, TrustLevel } from "@ar/contracts";
/**
 * P0-3 MCP transport wiring: connects an McpServerConfig (http or stdio) over
 * the REAL transport (fetch-based JSON-RPC for http, spawned child process with
 * line-delimited JSON-RPC for stdio), adapts the advertised tools into
 * registrable ToolDefinitions, and returns a closeable connection.
 *
 * The tools flow through the normal ToolOrchestrator pipeline — permission,
 * approval, sandbox and audit events all apply unchanged. Tool descriptions
 * are scanned for prompt injection at registration (fail-closed, P0-8); a
 * rejected server surfaces the rejection on the event stream when an EventSink
 * is wired (security.mcp_denied) and the harness registration aborts.
 */
export interface McpTransportOptions {
    /** Event sink for security.mcp_denied / retry.mcpReconnect observability. */
    events?: EventSink;
    /**
     * Local-only provenance trust for the server (operator configuration, never
     * remote content). Default "untrusted" — MCP tool output is low-trust data.
     */
    trust?: TrustLevel;
    /** Network boundary override. Defaults: stdio → "loopback", http → "internet". */
    networkBoundary?: NetworkBoundary;
    /**
     * Tool risk for the adapted tools. MCP tools are remote/opaque; the host
     * declares the risk from its knowledge of the server. Default "readonly" —
     * an operator connecting a mutating server MUST raise this (elevated /
     * critical), otherwise the orchestrator's permission model under-classifies.
     */
    risk?: "readonly" | "side_effect" | "elevated" | "critical";
}
export interface McpServerConnection {
    serverId: string;
    /** Advertised tools as registrable ToolDefinitions. */
    tools: ToolDefinition[];
    /** Closes the transport (HTTP: disconnects; stdio: kills the child). */
    close(): Promise<void>;
}
export declare function connectMcpServer(config: McpServerConfig, opts?: McpTransportOptions): Promise<McpServerConnection>;
//# sourceMappingURL=mcp-transport.d.ts.map