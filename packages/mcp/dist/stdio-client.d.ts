import type { McpToolInfo } from "@ar/contracts";
/**
 * Real stdio MCP transport (the second of the two official MCP transports,
 * next to Streamable HTTP). Spawns the configured server process and speaks
 * line-delimited JSON-RPC 2.0 over its stdin/stdout:
 *
 *   - initialize   : handshake; the client is "connected" only after it passes
 *                    (same connection-state semantics as the HTTP McpClient).
 *   - tools/list   : advertised tool set.
 *   - tools/call   : invoke a tool; an optional AbortSignal aborts the pending
 *                    request (the response is discarded, USER_CANCELLED).
 *   - request cap  : a pending request without a caller signal is bounded by
 *                    `requestTimeoutMs`; a hung server surfaces as NETWORK_ERROR
 *                    and the connection is marked disconnected.
 *   - reconnect    : ensureReconnected() re-spawns the process and re-runs the
 *                    handshake (bounded by the mcpReconnect retry spec).
 *
 * The server is a trusted operator-configured child process, but its stdout is
 * still untrusted content: JSON-RPC responses are parsed defensively and every
 * error is structured (NETWORK_ERROR / USER_CANCELLED), never a raw throw.
 */
export interface StdioMcpClientOptions {
    connectTimeoutMs?: number;
    requestTimeoutMs?: number;
}
export declare class StdioMcpClient {
    readonly serverId: string;
    private readonly command;
    private readonly args;
    private readonly connectTimeoutMs;
    private readonly requestTimeoutMs;
    private child;
    private nextId;
    private pending;
    private lineBuffer;
    private connected;
    private hasConnected;
    private closed;
    constructor(serverId: string, command: string, args?: string[], opts?: StdioMcpClientOptions);
    isConnected(): boolean;
    hasConnectedAtLeastOnce(): boolean;
    initialize(): Promise<void>;
    /** Force a fresh spawn + handshake (P2-20 reconnect semantics). */
    reconnect(): Promise<void>;
    /** Re-initialize when disconnected (host-side reconnect policy). */
    ensureConnected(): Promise<void>;
    /**
     * P2-40 bounded auto-reconnect with the same contract as the HTTP client:
     * maxAttempts + backoffMs from the mcpReconnect retry-kind spec; budget
     * exhaustion surfaces the last NETWORK_ERROR family error.
     */
    ensureReconnected(opts?: {
        maxAttempts?: number;
        backoffMs?: number;
    }): Promise<boolean>;
    listTools(): Promise<McpToolInfo[]>;
    callTool(name: string, args: unknown, signal?: AbortSignal): Promise<unknown>;
    close(): Promise<void>;
    private spawnChild;
    private onStdout;
    private request;
    private rejectAll;
    private teardownChild;
}
//# sourceMappingURL=stdio-client.d.ts.map