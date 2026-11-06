/**
 * P30-1 — Transport client boundary.
 *
 * The SDK speaks ONLY the protocol (DTOs) over an opaque transport. This
 * interface is what a host (CLI/web) implements; the SDK never imports the
 * runtime or a transport implementation — it is a pure protocol client.
 */
import type { InitializeServer, TurnEvent } from "@ar/protocol";

export interface TransportInvoke<T = unknown> {
  result?: T;
  error?: {
    code: string;
    message: string;
    retryable: boolean;
    data?: unknown;
  };
}

/**
 * Minimal request/response + event-stream transport the SDK requires.
 * Implementations may be in-memory (tests/embedding), HTTP, WebSocket, or any
 * other wire carrier.
 */
export interface ProtocolTransport {
  /** Invoke a protocol method; never throws for protocol-level failures. */
  invoke(method: string, params: Record<string, unknown>): Promise<TransportInvoke<unknown>>;
  /** Subscribe to server-initiated turn events. Returns an unsubscribe fn. */
  subscribe(topicId: "turn", onEvent: (event: TurnEvent) => void): () => void;
  close(): Promise<void>;
}

export interface HarnessTransport extends ProtocolTransport {
  /** The initialize result (protocol version + capabilities). */
  initializeResult(): Promise<InitializeServer>;
  /** P37-4: register a close handler. Returns an unsubscribe function. */
  onClose?(handler: () => void): () => void;
}

/**
 * In-memory transport: routes invokes to an inline handler and fans out
 * turn events to subscribers. Used by tests and inner-process embedding.
 */
export class MemoryHarnessTransport implements HarnessTransport {
  private readonly handler: (method: string, params: Record<string, unknown>) => Promise<TransportInvoke<unknown>>;
  private readonly subscribers = new Set<(e: TurnEvent) => void>();
  private readonly closeHandlers = new Set<() => void>();
  private init?: InitializeServer;
  private closed = false;
  private readonly pending = new Set<() => void>();

  constructor(
    handler: (method: string, params: Record<string, unknown>) => Promise<TransportInvoke<unknown>>,
  ) {
    this.handler = handler;
  }

  async invoke(method: string, params: Record<string, unknown>): Promise<TransportInvoke<unknown>> {
    const closedResult = (): TransportInvoke<unknown> => ({ error: {
      code: "TRANSPORT_CLOSED", message: "transport closed", retryable: false,
    } });
    if (this.closed) return closedResult();
    return new Promise<TransportInvoke<unknown>>((resolve, reject) => {
      let settled = false;
      const settle = (action: () => void) => {
        if (settled) return;
        settled = true; this.pending.delete(onClose); action();
      };
      const onClose = () => settle(() => resolve(closedResult()));
      this.pending.add(onClose);
      // Keep observing the handler after a disconnect: its late failure must
      // not become an unhandled rejection or settle an already-closed call.
      try {
        void Promise.resolve(this.handler(method, params)).then(
          result => settle(() => resolve(result)),
          error => settle(() => reject(error)),
        );
      } catch (error) { settle(() => reject(error)); }
    });
  }

  subscribe(_topicId: "turn", onEvent: (event: TurnEvent) => void): () => void {
    if (this.closed) return () => {};
    this.subscribers.add(onEvent);
    return () => this.subscribers.delete(onEvent);
  }

  /** Test/embedding helper: push a server-initiated event to subscribers. */
  emit(event: TurnEvent): void {
    if (this.closed) return;
    for (const s of this.subscribers) s(event);
  }

  /** P38-7: test helper — current subscriber count (listener-leak probe). */
  subscriberCount(): number {
    return this.subscribers.size;
  }

  /** P38-7: test helper — current close-handler count. */
  closeHandlerCount(): number {
    return this.closeHandlers.size;
  }

  async initializeResult(): Promise<InitializeServer> {
    if (this.closed) throw new Error("transport closed");
    if (this.init !== undefined) return this.init;
    const res = await this.invoke("initialize", {
      clientInfo: { name: "harness-sdk", version: "0.1.0" },
    });
    if (res.error !== undefined) throw new Error(res.error.message);
    this.init = res.result as InitializeServer;
    return this.init;
  }

  /** P37-4: register a close handler. */
  onClose(handler: () => void): () => void {
    if (this.closed) { handler(); return () => {}; }
    this.closeHandlers.add(handler);
    return () => this.closeHandlers.delete(handler);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    const pending = [...this.pending], handlers = [...this.closeHandlers];
    this.pending.clear(); this.closeHandlers.clear();
    this.subscribers.clear();
    for (const settle of pending) settle();
    const errors: unknown[] = [];
    for (const handler of handlers) {
      try { handler(); } catch (error) { errors.push(error); }
    }
    if (errors.length) throw new AggregateError(errors, "transport close observers failed");
  }
}
