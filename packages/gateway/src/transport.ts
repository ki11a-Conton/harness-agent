import type { ErrorCode } from "@ar/contracts";
import { AgentError, errorInfo } from "@ar/contracts";
import type { RpcContext } from "./rpc.js";
import { rpcErrorBody } from "./rpc.js";

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
  error?: { code: ErrorCode; message: string };
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
export class InMemoryTransport {
  private peer?: InMemoryTransport;
  private server?: RpcServer;
  private readonly pending = new Map<number, (response: RpcResponseMessage) => void>();
  private nextId = 1;

  static pair(): { client: InMemoryTransport; server: InMemoryTransport } {
    const client = new InMemoryTransport();
    const server = new InMemoryTransport();
    client.peer = server;
    server.peer = client;
    return { client, server };
  }

  /** Server side: route incoming requests to the given server. */
  connect(server: RpcServer): void {
    this.server = server;
  }

  /** Client side: send a request; resolves with the result, rejects with a
   *  structured AgentError carrying only { code, message }. */
  request(method: string, params?: unknown, ctx?: RpcContext): Promise<unknown> {
    const id = this.nextId;
    this.nextId += 1;
    return new Promise((resolve, reject) => {
      this.pending.set(id, (response) => {
        if (response.error !== undefined) {
          reject(new AgentError(errorInfo(response.error.code, response.error.message)));
        } else {
          resolve(response.result);
        }
      });
      this.peer?.deliver(
        { id, method, ...(params !== undefined ? { params } : {}) },
        ctx,
      );
    });
  }

  /** Server side: process one request and reply to the peer. */
  private async deliver(request: RpcRequestMessage, ctx?: RpcContext): Promise<void> {
    await Promise.resolve();
    let response: RpcResponseMessage;
    if (this.server === undefined) {
      response = {
        id: request.id,
        error: { code: "INTERNAL_ERROR", message: "no rpc server connected" },
      };
    } else {
      try {
        const result = await this.server.invoke(request.method, request.params, ctx);
        response = { id: request.id, result };
      } catch (err) {
        response = { id: request.id, error: rpcErrorBody(err) };
      }
    }
    this.peer?.settle(response);
  }

  private settle(response: RpcResponseMessage): void {
    const resolve = this.pending.get(response.id);
    if (resolve !== undefined) {
      this.pending.delete(response.id);
      resolve(response);
    }
  }
}
