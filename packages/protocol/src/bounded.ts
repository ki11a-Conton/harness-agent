/**
 * P29-7 — bounded queues and backpressure.
 *
 * The transport must never grow an array/queue unboundedly: ingress
 * requests, in-flight processing, and outbound notifications each have a
 * fixed capacity. When a queue is saturated, the server rejects the
 * offending inbound request with a retryable typed error (`SERVER_OVERLOADED`)
 * instead of letting memory accumulate: the client may retry later.
 *
 * The housekeeping rule: a rejection NEVER consumes work, so a retry is always
 * safe (P29-9 pairs with this: retried idempotent requests are the way a
 * healthy client recovers from overload without duplication).
 */
import { ProtocolError } from "./errors.js";

export interface BoundedQueueOptions {
  /** Maximum number of items held (queued + active). */
  capacity: number;
}

type QueueEntry<T> = { kind: "call"; work: () => Promise<T>; resolve: (v: T) => void; reject: (e: unknown) => void };

/**
 * A bounded FIFO worker queue. `submit()` rejects immediately with
 * SERVER_OVERLOADED when the queue is full — it never blocks and never
 * accumulates beyond capacity.
 */
export class BoundedQueue<T = unknown> {
  private readonly capacity: number;
  private readonly waiting: QueueEntry<T>[] = [];
  private active = 0;

  constructor(opts: BoundedQueueOptions) {
    this.capacity = opts.capacity;
  }

  /** Number of entries currently queued (not counting the actively-running one). */
  get pendingCount(): number {
    return this.waiting.length;
  }

  /** True when the queue is saturated (no further submit without rejection). */
  get saturated(): boolean {
    return this.waiting.length + this.active >= this.capacity;
  }

  submit(work: () => Promise<T>): Promise<T> {
    if (this.saturated) {
      return Promise.reject(ProtocolError.overloaded());
    }
    return new Promise<T>((resolve, reject) => {
      this.waiting.push({ kind: "call", work, resolve, reject });
      this.pump();
    });
  }

  private pump(): void {
    if (this.active >= this.capacity) return; // cannot start more concurrently
    const next = this.waiting.shift();
    if (next === undefined) return;
    this.active += 1;
    const finish = (value: unknown, isErr: boolean) => {
      this.active -= 1;
      if (isErr) next.reject(value as Error);
      else next.resolve(value as T);
      this.pump(); // a slot freed — start the next queued entry
    };
    Promise.resolve()
      .then(() => next.work())
      .then(
        (v) => finish(v, false),
        (e) => finish(e, true),
      );
  }
}

/**
 * Notification sink with bounded outbound buffering. When the sink is
 * saturated, `notify` returns `false` (the caller may drop/retry per policy)
 * instead of growing memory without bound.
 */
export class BoundedNotifier {
  private readonly capacity: number;
  private readonly buffer: unknown[] = [];

  constructor(capacity: number) {
    this.capacity = capacity;
  }

  get bufferedCount(): number {
    return this.buffer.length;
  }

  /** True when the outbound buffer is full; the producer should back off. */
  get saturated(): boolean {
    return this.buffer.length >= this.capacity;
  }

  /** Enqueue a notification. Returns false if the buffer was full. */
  notify(event: unknown): boolean {
    if (this.buffer.length >= this.capacity) return false;
    this.buffer.push(event);
    return true;
  }

  /** Drain the buffer (the transport's flush step). */
  drain(): unknown[] {
    const batch = this.buffer.splice(0);
    return batch;
  }
}