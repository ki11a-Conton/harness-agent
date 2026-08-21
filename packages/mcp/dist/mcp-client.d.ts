import type { McpToolInfo, Timer } from "@ar/contracts";
export interface McpClientOptions {
    /** Bounds the initialize handshake (ms). Default 10_000. */
    connectTimeoutMs?: number;
    /** Bounds a request with no caller signal (ms). Default 30_000. */
    requestTimeoutMs?: number;
    /** P1-7: injectable timer for request/connect timeouts (deterministic tests). */
    timer?: Timer;
}
export declare class McpClient {
    private url;
    private token;
    private nextId;
    private readonly connectTimeoutMs;
    private readonly requestTimeoutMs;
    private readonly timer;
    private hasConnected;
    private connected;
    constructor(opts?: McpClientOptions);
    /** True after a successful initialize and until close()/a marking failure. */
    isConnected(): boolean;
    /** Whether a connect handshake ever succeeded (reconnect cycles preserve it). */
    hasConnectedAtLeastOnce(): boolean;
    connect(url: string, token?: string): Promise<void>;
    /** Force a re-initialization handshake (P2-20 reconnect). */
    reconnect(): Promise<void>;
    /** Re-initialize if currently disconnected (host-side reconnect policy). */
    ensureConnected(): Promise<void>;
    /**
     * P2-40 bounded auto-reconnect: re-handshake when disconnected, bounded by the
     * `mcpReconnect` retry-kind spec (maxAttempts + backoffMs from the governance
     * table). Returns true when a reconnection was actually performed. When the
     * budget is exhausted the last error surfaces (NETWORK_ERROR family — the call
     * is never silently dropped). `backoffMs`/`maxAttempts` overrides are for
     * callers that want a tighter budget (e.g. tests); defaults follow the spec.
     */
    ensureReconnected(opts?: {
        maxAttempts?: number;
        backoffMs?: number;
    }): Promise<boolean>;
    close(): Promise<void>;
    listTools(): Promise<McpToolInfo[]>;
    /** P1-10: an optional AbortSignal aborts the in-flight HTTP call (no orphan
     *  request). With a signal, cancellation surfaces as USER_CANCELLED. */
    callTool(name: string, args: unknown, signal?: AbortSignal): Promise<unknown>;
    private request;
}
//# sourceMappingURL=mcp-client.d.ts.map