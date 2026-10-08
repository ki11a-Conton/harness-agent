import type { ChannelAdapter, ChannelMessage } from "@ar/gateway";

/** Live SSE stream owned by one recipient (a browser `from` id). */
export interface SseSink {
  writeFrame(frame: unknown): void;
  close(): void;
}

/**
 * Web ChannelAdapter (§83): binds a browser tab to the gateway through an
 * SSE streams per `from` id. The gateway only sees the ChannelAdapter surface
 * (connect/disconnect/send/onMessage); HTTP wiring lives in WebServer.
 *
 * `send(recipient, payload)` writes `data: <JSON>\n\n` to the recipient's SSE
 * stream. When no stream is connected for the recipient the push is dropped —
 * a closed browser tab must never fail the gateway's event loop.
 */
export class WebChannelAdapter implements ChannelAdapter {
  readonly id = "web";

  private readonly connections = new Map<string, Set<SseSink>>();
  private handler?: (msg: ChannelMessage) => void | Promise<void>;
  private nextMessageId = 1;

  /** No external service to dial: connections arrive over HTTP (WebServer). */
  async connect(): Promise<void> {
    /* lifecycle is managed by the HTTP server */
  }

  async disconnect(): Promise<void> {
    for (const sinks of [...this.connections.values()]) for (const sink of [...sinks]) sink.close();
    this.connections.clear();
  }

  async send(recipient: string, payload: unknown): Promise<void> {
    const sinks = this.connections.get(recipient);
    if (sinks === undefined) return; // no live stream for this recipient: drop
    const frame = {
      type: "text",
      text: typeof payload === "string" ? payload : JSON.stringify(payload),
    };
    for (const sink of [...sinks]) sink.writeFrame(frame);
  }

  onMessage(handler: (msg: ChannelMessage) => void | Promise<void>): void {
    this.handler = handler;
  }

  /** Every tab owns its subscription; opening one never closes another. */
  register(from: string, sink: SseSink): void {
    let sinks = this.connections.get(from);
    if (sinks === undefined) this.connections.set(from, sinks = new Set());
    sinks.add(sink);
  }

  unregister(from: string, sink?: SseSink): void {
    if (sink === undefined) { this.connections.delete(from); return; }
    const sinks = this.connections.get(from);
    sinks?.delete(sink);
    if (sinks?.size === 0) this.connections.delete(from);
  }

  hasConnection(from: string): boolean {
    return this.connections.has(from);
  }

  /** Route one inbound HTTP message into the gateway (its handler is bound
   *  by Gateway.start() via onMessage). */
  deliver(msg: ChannelMessage): Promise<void> {
    const handler = this.handler;
    if (handler === undefined) {
      throw new Error("web channel has no message handler (gateway not started)");
    }
    return Promise.resolve(handler(msg));
  }
}
