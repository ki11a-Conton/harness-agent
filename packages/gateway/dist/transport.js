import { AgentError, errorInfo } from "@ar/contracts";
import { rpcErrorBody } from "./rpc.js";
/**
 * Minimal in-memory transport adapter: a client/server pair exchanging
 * RpcRequestMessage/RpcResponseMessage asynchronously (microtask delivery).
 * Serves tests today and is the template for future HTTP/WS adapters
 * (GATEWAY-001); context (incl. AbortSignal) travels with each request so
 * cancellation works end-to-end (plan §156).
 */
export class InMemoryTransport {
    peer;
    server;
    pending = new Map();
    nextId = 1;
    static pair() {
        const client = new InMemoryTransport();
        const server = new InMemoryTransport();
        client.peer = server;
        server.peer = client;
        return { client, server };
    }
    /** Server side: route incoming requests to the given server. */
    connect(server) {
        this.server = server;
    }
    /** Client side: send a request; resolves with the result, rejects with a
     *  structured AgentError carrying only { code, message }. */
    request(method, params, ctx) {
        const id = this.nextId;
        this.nextId += 1;
        return new Promise((resolve, reject) => {
            this.pending.set(id, (response) => {
                if (response.error !== undefined) {
                    reject(new AgentError(errorInfo(response.error.code, response.error.message)));
                }
                else {
                    resolve(response.result);
                }
            });
            this.peer?.deliver({ id, method, ...(params !== undefined ? { params } : {}) }, ctx);
        });
    }
    /** Server side: process one request and reply to the peer. */
    async deliver(request, ctx) {
        await Promise.resolve();
        let response;
        if (this.server === undefined) {
            response = {
                id: request.id,
                error: { code: "INTERNAL_ERROR", message: "no rpc server connected" },
            };
        }
        else {
            try {
                const result = await this.server.invoke(request.method, request.params, ctx);
                response = { id: request.id, result };
            }
            catch (err) {
                response = { id: request.id, error: rpcErrorBody(err) };
            }
        }
        this.peer?.settle(response);
    }
    settle(response) {
        const resolve = this.pending.get(response.id);
        if (resolve !== undefined) {
            this.pending.delete(response.id);
            resolve(response);
        }
    }
}
//# sourceMappingURL=transport.js.map