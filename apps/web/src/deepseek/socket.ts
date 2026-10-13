import { EventEmitter } from "node:events";
import type WebSocket from "ws";
import { DeepseekTransport, remoteError, wireEncode, type DeepseekService, type TransportRequest, type TransportResponse } from "./transport.js";

export interface DeepseekSocketOptions {
  maxPending?: number;
  maxFrameBytes?: number;
  maxQueuedFrames?: number;
  maxQueuedBytes?: number;
}
const ID = /^[A-Za-z0-9_-]{16,128}$/;
type Frame = { type: "result"; id: string; status: number; value: unknown }
  | { type: "opened" | "end"; id: string }
  | { type: "frame"; id: string; value: unknown };
type Queued = { bytes: string; resolve(): void; reject(error: Error): void };

class SocketRequest extends EventEmitter implements TransportRequest {
  aborted = false;
  abort(): void { if (!this.aborted) { this.aborted = true; this.emit("aborted"); } }
}
class SocketResponse extends EventEmitter implements TransportResponse {
  destroyed = false;
  writableEnded = false;
  headersSent = false;
  private status = 200;
  private streaming = false;
  constructor(private readonly id: string, private readonly send: (frame: Frame) => Promise<void>) { super(); }
  writeHead(status: number, headers: Record<string, string>): void {
    this.headersSent = true; this.status = status;
    this.streaming = headers["Content-Type"]?.includes("application/x-ndjson") === true;
  }
  flushHeaders(): void {
    if (this.streaming) void this.send({ type: "opened", id: this.id }).catch(() => this.destroy());
  }
  write(chunk: string): boolean {
    if (this.destroyed || this.writableEnded) throw new Error("Socket response is closed");
    if (!this.streaming || !chunk.endsWith("\n")) throw new Error("Invalid socket stream framing");
    const value: unknown = JSON.parse(chunk.slice(0, -1));
    // Each stream waits for its actual socket send callback before producing
    // another frame. The shared queue also caps aggregate concurrent streams.
    void this.send({ type: "frame", id: this.id, value }).then(() => { if (!this.destroyed) this.emit("drain"); }, () => this.destroy());
    return false;
  }
  end(chunk?: string): void {
    if (this.destroyed || this.writableEnded) return;
    this.writableEnded = true;
    const frame: Frame = this.streaming ? { type: "end", id: this.id }
      : { type: "result", id: this.id, status: this.status, value: JSON.parse(chunk ?? "null") };
    void this.send(frame).then(() => this.emit("close"), () => this.destroy());
  }
  destroy(): void { if (!this.destroyed) { this.destroyed = true; this.emit("close"); } }
}

/** One authenticated upgrade carries all Remote calls and streams. Every
 * connection owns an isolated capability registry; reconnect never replays a
 * side effect. Services remain owned by the Web host, rather than by a tab. */
export function attachDeepseekSocket(socket: WebSocket, services: readonly DeepseekService[], options: DeepseekSocketOptions = {}): { close(): Promise<void> } {
  const maxPending = options.maxPending ?? 128;
  const maxFrameBytes = options.maxFrameBytes ?? 1_000_000;
  const maxQueuedFrames = options.maxQueuedFrames ?? 128;
  const maxQueuedBytes = options.maxQueuedBytes ?? 8 * 1024 * 1024;
  const transport = new DeepseekTransport(services, { closeServices: false });
  const operations = new Map<string, { request: SocketRequest; response: SocketResponse; control: boolean }>();
  const queue: Queued[] = [];
  let queuedBytes = 0, sending = false, closed = false, controlPending = 0;
  let closing: Promise<void> | undefined;
  const disconnected = new Error("DeepSeek socket disconnected");

  const close = (): Promise<void> => closing ??= (async () => {
    closed = true; clearInterval(heartbeat);
    for (const operation of operations.values()) { operation.request.abort(); operation.response.destroy(); }
    operations.clear();
    for (const item of queue.splice(0)) item.reject(disconnected);
    queuedBytes = 0;
    await transport.stop();
    if (socket.readyState === 0 || socket.readyState === 1) socket.close(1001, "Host socket closed");
    if (socket.readyState !== 3) await new Promise<void>(done => {
      const finish = () => { clearTimeout(timer); socket.off("close", finish); done(); };
      const timer = setTimeout(() => { socket.terminate(); finish(); }, 250);
      socket.once("close", finish);
      if (socket.readyState === 3) finish();
    });
  })();
  const failSocket = (reason: string, code = 1008): void => {
    if (!closed) { socket.close(code, reason); void close(); }
  };
  const pump = (): void => {
    if (sending || closed || queue.length === 0) return;
    const item = queue[0]!; sending = true;
    socket.send(item.bytes, error => {
      sending = false;
      if (closed) { item.reject(disconnected); return; }
      queue.shift(); queuedBytes -= Buffer.byteLength(item.bytes);
      if (error != null) { item.reject(error); failSocket("Socket send failed", 1011); return; }
      item.resolve(); pump();
    });
  };
  const send = (frame: Frame): Promise<void> => {
    if (closed || socket.readyState !== 1) return Promise.reject(disconnected);
    let bytes: string;
    try { bytes = wireEncode(frame); } catch (error) { return Promise.reject(error); }
    const size = Buffer.byteLength(bytes);
    if (size > maxQueuedBytes || queue.length >= maxQueuedFrames || queuedBytes + size > maxQueuedBytes) {
      failSocket("Socket output limit exceeded", 1009); return Promise.reject(new Error("Socket output limit exceeded"));
    }
    return new Promise<void>((resolve, reject) => { queue.push({ bytes, resolve, reject }); queuedBytes += size; pump(); });
  };
  socket.on("message", (raw, isBinary) => {
    if (closed) return;
    const bytes = Array.isArray(raw) ? Buffer.concat(raw) : raw instanceof ArrayBuffer ? Buffer.from(raw) : raw;
    if (isBinary || bytes.byteLength > maxFrameBytes) { failSocket("Invalid socket request size", 1009); return; }
    let frame: unknown;
    try { frame = JSON.parse(bytes.toString()); } catch { failSocket("Invalid socket JSON"); return; }
    if (frame === null || typeof frame !== "object" || Array.isArray(frame)) { failSocket("Invalid socket request"); return; }
    const value = frame as Record<string, unknown>;
    if (value.type !== "request" || Object.keys(value).some(key => !["type", "id", "route", "body"].includes(key))
      || typeof value.id !== "string" || !ID.test(value.id) || typeof value.route !== "string"
      || value.body === null || typeof value.body !== "object" || Array.isArray(value.body)) { failSocket("Invalid socket request"); return; }
    const id = value.id;
    if (operations.has(id)) { failSocket("Duplicate socket request identifier"); return; }
    const control = value.route === "cancel" || value.route === "uplink";
    if ((control && controlPending >= 32) || (!control && operations.size - controlPending >= maxPending)) {
      void send({ type: "result", id, status: 400, value: { ok: false, error: { code: "gateway/unavailable", message: "Socket request limit exceeded", details: {} } } }).catch(() => failSocket("Socket limit response failed", 1011)); return;
    }
    const request = new SocketRequest(), response = new SocketResponse(id, send);
    operations.set(id, { request, response, control }); if (control) controlPending++;
    void transport.handle(value.route, value.body as Record<string, unknown>, request, response).catch(error => {
      if (!response.headersSent && !closed) response.end(wireEncode({ ok: false, error: remoteError(error) }));
      else response.destroy();
    }).finally(() => { if (operations.delete(id) && control) controlPending--; });
  });
  socket.once("close", () => { void close(); });
  socket.once("error", () => { void close(); });
  let alive = true;
  socket.on("pong", () => { alive = true; });
  const heartbeat = setInterval(() => {
    if (closed) return;
    if (!alive) { socket.terminate(); void close(); return; }
    alive = false; socket.ping();
  }, 30_000);
  heartbeat.unref();
  return { close };
}
