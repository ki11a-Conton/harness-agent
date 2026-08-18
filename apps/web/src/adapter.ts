import type { ChannelAdapter, ChannelMessage } from "@ar/gateway";

/** Live SSE stream owned by one recipient (a browser `from` id). */
export interface SseSink {
  writeFrame(frame: unknown): void;
  close(): void;
}

/**
 * Web ChannelAdapter (§83): binds a browser tab to the gateway through an
 * SSE stream per `from` id. The gateway only sees the ChannelAdapter surface
 * (connect/disconnect/send/onMessage); HTTP wiring lives in WebServer.
 *
 * `send(recipient, payload)` writes `data: <JSON>\n\n` to the recipient's SSE
 * stream. When no stream is connected for the recipient the push is dropped —
 * a closed browser tab must never fail the gateway's event loop.
 */
export class WebChannelAdapter implements ChannelAdapter {
  readonly id = "web";

  private readonly connections = new Map<string, SseSink>();
  private handler?: (msg: ChannelMessage) => void | Promise<void>;
  private nextMessageId = 1;

  /** No external service to dial: connections arrive over HTTP (WebServer). */
  async connect(): Promise<void> {
    /* lifecycle is managed by the HTTP server */
  }

  async disconnect(): Promise<void> {
    for (const sink of [...this.connections.values()]) sink.close();
    this.connections.clear();
  }

  async send(recipient: string, payload: unknown): Promise<void> {
    const sink = this.connections.get(recipient);
    if (sink === undefined) return; // no live stream for this recipient: drop
    sink.writeFrame({
      type: "text",
      text: typeof payload === "string" ? payload : JSON.stringify(payload),
    });
  }

  onMessage(handler: (msg: ChannelMessage) => void | Promise<void>): void {
    this.handler = handler;
  }

  /** Register the SSE stream for a `from`; replaces any previous one. */
  register(from: string, sink: SseSink): void {
    this.connections.set(from, sink);
  }

  unregister(from: string): void {
    this.connections.delete(from);
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
