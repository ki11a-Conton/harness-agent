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
export declare class WebChannelAdapter implements ChannelAdapter {
    readonly id = "web";
    private readonly connections;
    private handler?;
    private nextMessageId;
    /** No external service to dial: connections arrive over HTTP (WebServer). */
    connect(): Promise<void>;
    disconnect(): Promise<void>;
    send(recipient: string, payload: unknown): Promise<void>;
    onMessage(handler: (msg: ChannelMessage) => void | Promise<void>): void;
    /** Register the SSE stream for a `from`; replaces any previous one. */
    register(from: string, sink: SseSink): void;
    unregister(from: string): void;
    hasConnection(from: string): boolean;
    /** Route one inbound HTTP message into the gateway (its handler is bound
     *  by Gateway.start() via onMessage). */
    deliver(msg: ChannelMessage): Promise<void>;
}
//# sourceMappingURL=adapter.d.ts.map