import type { ToolStreamEvent } from "@ar/contracts";
import { utf8Prefix } from "./process/utf8-output.js";

// Live progress is best effort. The canonical result, captured prefixes and
// diagnostic tails have independent budgets and must never be truncated here.
const MAX_PENDING_EVENTS = 8;
const MAX_PENDING_BYTES = 64 * 1024;
const MAX_EVENT_BYTES = 8 * 1024;
type OutputEvent = ToolStreamEvent & Record<string, unknown>;

/** Bound raw output held across slow asynchronous event writes. A bounded
 * collector alone does not bound these promises: each unresolved emitter can
 * retain its original stdout/stderr chunk even after a host withholds text. */
export class BoundedToolOutput {
  private readonly pending = new Set<Promise<void>>();
  private pendingBytes = 0;
  private accepting = true;
  private closed = false;
  private droppedBytes = 0;
  private droppedEvents = 0;
  private finishing?: Promise<void>;
  private releaseClosed!: () => void;
  private readonly closing = new Promise<void>(resolve => { this.releaseClosed = resolve; });

  constructor(
    private readonly emit: (event: OutputEvent) => Promise<void>,
    private readonly report: (error: unknown) => void,
  ) {}

  push(event: ToolStreamEvent): void {
    if (!this.accepting || !event.text) return;
    const bytes = Buffer.byteLength(event.text, "utf8");
    const available = this.pending.size < MAX_PENDING_EVENTS
      ? Math.min(MAX_EVENT_BYTES, MAX_PENDING_BYTES - this.pendingBytes)
      : 0;
    const prefix = utf8Prefix(event.text, available);
    const admitted = Buffer.byteLength(prefix, "utf8");
    if (admitted < bytes) {
      this.droppedBytes = Math.min(Number.MAX_SAFE_INTEGER, this.droppedBytes + bytes - admitted);
      this.droppedEvents = Math.min(Number.MAX_SAFE_INTEGER, this.droppedEvents + 1);
    }
    if (!admitted) return;
    // Own the bounded string. An incoming substring may otherwise retain a
    // much larger backing string while the event sink waits on persistence.
    this.schedule({ stream: event.stream, text: Buffer.from(prefix, "utf8").toString("utf8") }, admitted);
  }

  private schedule(event: OutputEvent, bytes: number): Promise<void> {
    this.pendingBytes += bytes;
    const writing = Promise.resolve().then(async () => {
      if (!this.closed) await this.emit(event);
    }).catch(error => this.report(error)).finally(() => {
      this.pending.delete(writing);
      this.pendingBytes -= bytes;
    });
    this.pending.add(writing);
    return writing;
  }

  finish(): Promise<void> {
    if (this.closed) return Promise.resolve();
    if (this.finishing) return this.finishing;
    this.accepting = false;
    this.finishing = this.drain();
    return this.finishing;
  }

  private async drain(): Promise<void> {
    await Promise.race([Promise.all(this.pending), this.closing]);
    if (this.closed || this.droppedEvents === 0) return;
    const text = "Live output was omitted under event persistence pressure; inspect the terminal result and bounded diagnostics.";
    await Promise.race([
      this.schedule({ stream: "progress", text, incomplete: true, droppedBytes: this.droppedBytes, droppedEvents: this.droppedEvents }, Buffer.byteLength(text)),
      this.closing,
    ]);
  }

  /** Timeout/cancel uses the existing tool race. It must not wait for a stuck
   * progress sink, admit late callbacks, or enqueue an additional raw frame. */
  close(): void {
    this.accepting = false;
    this.closed = true;
    this.releaseClosed();
  }
}
