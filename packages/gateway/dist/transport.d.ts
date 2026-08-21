import type { ErrorCode } from "@ar/contracts";
import type { RpcContext } from "./rpc.js";
/** Minimal JSON-RPC-style request envelope (transport agnostic). */
export interface RpcRequestMessage {
    id: number;
    method: string;
    params?: unknown;
}
/** Minimal JSON-RPC-style response envelope: exactly one of result/error. */
export interface RpcResponseMessage {
    id: number;
    result?: unknown;
    error?: {
        code: ErrorCode;
        message: string;
    };
}
/** Server surface transports deliver requests to (a RpcMethodRegistry fits). */
export interface RpcServer {
    invoke(method: string, params: unknown, ctx?: RpcContext): Promise<unknown>;
}
/**
 * Minimal in-memory transport adapter: a client/server pair exchanging
 * RpcRequestMessage/RpcResponseMessage asynchronously (microtask delivery).
 * Serves tests today and is the template for future HTTP/WS adapters
 * (GATEWAY-001); context (incl. AbortSignal) travels with each request so
 * cancellation works end-to-end (plan §156).
 */
export declare class InMemoryTransport {
    private peer?;
    private server?;
    private readonly pending;
    private nextId;
    static pair(): {
        client: InMemoryTransport;
        server: InMemoryTransport;
    };
    /** Server side: route incoming requests to the given server. */
    connect(server: RpcServer): void;
    /** Client side: send a request; resolves with the result, rejects with a
     *  structured AgentError carrying only { code, message }. */
    request(method: string, params?: unknown, ctx?: RpcContext): Promise<unknown>;
    /** Server side: process one request and reply to the peer. */
    private deliver;
    private settle;
}
//# sourceMappingURL=transport.d.ts.map