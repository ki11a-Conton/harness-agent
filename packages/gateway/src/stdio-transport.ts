/**
 * P34-5 — StdioTransport: App Server over a JSONL stdio pipe.
 *
 * Same RpcRequestMessage/RpcResponseMessage envelope as InMemoryTransport,
 * but framed as strict JSON-lines (one object per line, id-correlated) —
 * the wire a CLI/desktop host uses over a child-process pipe, injected here
 * as an in-process pump so tests exercise the framing / error mapping / push
 * delivery without an OS pipe.
 *
 * Roles:
 *   - server: readLine() parses a request → server.invoke() → reply;
 *             notify() pushes a topic/payload frame to the client.
 *   - client: request() sends a request and resolves the id-correlated
 *             response (AgentError on transport-error); onPush() receives
 *             server-initiated frames.
 *
 * Pairing (one pipe):
 *   const serverPeer = new StdioTransport({ role: "server", server });
 *   const clientPeer = new StdioTransport({ role: "client" });
 *   serverPeer.connect(clientPeer);
 */
import { AgentError, errorInfo } from "@ar/contracts";
import { rpcErrorBody, type RpcContext } from "./rpc.js";
import type { RpcServer } from "./transport.js";

export type { RpcRequestMessage, RpcResponseMessage } from "./transport.js";

export type StdioRole = "client" | "server";

export interface StdioTransportOptions {
  role: StdioRole;
  /** Server side only: the RpcServer requests are routed to. */
  server?: RpcServer;
}

const MAX_FRAME_BYTES = 64 * 1024;

interface WireFrame {
  id: number;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code: string; message: string };
}

/** Handle pair kept per in-flight request so `close()` can settle it. */
interface PendingCall {
  resolve: (result: unknown) => void;
  reject: (err: unknown) => void;
}

/**
 * EXT-001: rejection delivered to every request that was still in flight when
 * the transport closed. Extends AgentError so callers that branch on
 * `instanceof AgentError` keep their error-surface behavior; the stable,
 * greppable marker is `info.message === "transport closed"`.
 */
export class TransportClosedError extends AgentError {
  constructor(message = "transport closed") {
    super(errorInfo("INTERNAL_ERROR", message));
    this.name = "TransportClosedError";
  }
}

/**
 * JSONL transport peer.
 *  - client role: `request` / `onPush`;
 *  - server role: `readLine` (serve) / `notify`.
 */
export class StdioTransport {
  private readonly role: StdioRole;
  private readonly serverSurface?: RpcServer;
  private peer?: StdioTransport;
  private readonly pending = new Map<number, PendingCall>();
  private nextSeq = 0;
  private pushHandler?: (topic: string, payload: unknown) => void;
  /** EXT-001: close() is terminal — no new writes, no new requests. */
  private closed = false;

  constructor(opts: StdioTransportOptions) {
    this.role = opts.role;
    this.serverSurface = opts.server;
  }

  /** Client-side pairing point: wires BOTH directions (server replies
   *  through its own peer back to us). */
  pair(server: StdioTransport): void {
    if (this.role !== "client") throw new Error("pair(): client role only");
    this.peer = server;
    server.peer = this;
  }

  /** Server-side pairing point: wires BOTH directions (client requests
   *  flow in, server replies flow back via the same pipe). */
  connect(client: StdioTransport): void {
    if (this.role !== "server") throw new Error("connect(): server role only");
    this.peer = client;
    client.peer = this;
  }

  /** Client side: send a method request; resolves with result, rejects with
   *  the transported AgentError (same surface as InMemoryTransport). */
  request(method: string, params?: unknown, _ctx?: RpcContext): Promise<unknown> {
    if (this.role !== "client") throw new Error("request(): client role only");
    // EXT-001: a request issued after close must fail fast, never hang.
    if (this.closed) return Promise.reject(new TransportClosedError());
    const seq = this.nextSeq;
    this.nextSeq += 1;
    return new Promise((resolve, reject) => {
      this.pending.set(seq, { resolve, reject });
      this.writeFrame({ id: seq, method, ...(params !== undefined ? { params } : {}) });
    });
  }

  /** Server side: push a topic/payload notification to the client. */
  notify(topic: string, payload: unknown): void {
    if (this.role !== "server") throw new Error("notify(): server role only");
    this.writeFrame({ id: 0, method: "__notify", params: { topic, payload } });
  }

  /** Client side: register a push handler (server→client events). */
  onPush(handler: (topic: string, payload: unknown) => void): void {
    if (this.role !== "client") throw new Error("onPush(): client role only");
    this.pushHandler = handler;
  }

  /** Feed one raw line from the pipe (both roles parse it). */
  readLine(line: string): void {
    let frame: WireFrame;
    try {
      if (Buffer.byteLength(line, "utf8") > MAX_FRAME_BYTES) {
        throw new Error("frame too large");
      }
      frame = JSON.parse(line) as WireFrame;
    } catch {
      process.stderr.write(`[stdio-transport] dropped malformed frame\n`);
      return;
    }
    if (typeof frame.id !== "number") return;

    if (this.role === "server") {
      if (frame.method === "__notify") return; // client-driven pushes unsupported server-side
      if (typeof frame.method !== "string") return;
      const surface = this.serverSurface;
      if (surface === undefined) {
        this.writeFrame({ id: frame.id, error: { code: "INTERNAL_ERROR", message: "no rpc server attached" } });
        return;
      }
      Promise.resolve(surface.invoke(frame.method, frame.params, undefined))
        .then((result) => this.writeFrame({ id: frame.id, result: result === undefined ? null : result }))
        .catch((err) => {
          const body = err instanceof AgentError ? err.info : rpcErrorBody(err);
          this.writeFrame({ id: frame.id, error: { code: body.code, message: body.message } });
        });
      return;
    }

    // client role
    if (frame.method === "__notify") {
      const p = frame.params as { topic?: unknown; payload?: unknown } | undefined;
      if (typeof p?.topic === "string") this.pushHandler?.(p.topic, p.payload);
      return;
    }
    const call = this.pending.get(frame.id);
    if (call === undefined) return;
    this.pending.delete(frame.id);
    if (frame.error !== undefined) {
      call.reject(new AgentError(errorInfo(frame.error.code as never, frame.error.message)));
    } else {
      call.resolve(frame.result);
    }
  }

  /** Number of in-flight requests (pending id correlations). */
  get inFlight(): number {
    return this.pending.size;
  }

  /**
   * EXT-001: close the pipe. Any request still awaiting a reply is REJECTED
   * with a `TransportClosedError` — dropping the handles (the old
   * `pending.clear()`) left those callers hanging forever, so the host process
   * could never exit. Idempotent: the second call is a no-op.
   */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    const inFlight = [...this.pending.values()];
    this.pending.clear();
    // Detach BOTH directions before settling, so nothing can be written onto a
    // closed pipe while the rejections are delivered.
    this.detachPeer();
    for (const call of inFlight) call.reject(new TransportClosedError());
  }

  private detachPeer(): void {
    const peer = this.peer;
    this.peer = undefined;
    if (peer !== undefined && peer.peer === this) peer.peer = undefined;
  }

  private writeFrame(frame: WireFrame): void {
    if (this.closed) return;
    this.peer?.readLine(JSON.stringify(frame));
  }
}