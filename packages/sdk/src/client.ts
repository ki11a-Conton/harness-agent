/**
 * P30 — TypeScript SDK (client-only path).
 *
 * The SDK is the surface a host (CLI/web) uses to drive an Agent Harness App
 * Server. It is STREAM-FIRST: the primary API is `runStreamed`, and the
 * convenience `run()` is a REDUCER over that stream (P30-3 — the same single
 * implementation, no parallel code path).
 *
 * The SDK depends ONLY on `@ar/protocol` (DTOs) and a transport client
 * (P30-1). It never imports `@ar/core` or the runtime.
 */
import type {
  InitializeServer,
  ThreadItem,
  TurnEvent,
} from "@ar/protocol";
import type { HarnessTransport } from "./transport.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type ThreadStatus = "active" | "completed" | "interrupted";

export interface RunUsage {
  inputTokens: number;
  outputTokens: number;
}

export interface RunResult {
  /** Every visible item produced during the run, in stream order. */
  items: ThreadItem[];
  finalResponse?: string;
  usage?: RunUsage;
  status: "completed" | "interrupted" | "failed";
  turnId?: string;
  error?: { code: string; message: string; retryable: boolean };
}

export interface RunStream {
  /** Consumable event stream (closes when the run settles). */
  events: AsyncIterable<TurnEvent>;
  /** Resolves when the run settles. */
  done: Promise<RunResult>;
}

export interface StartThreadOptions {
  agentName: string;
  cwd: string;
  idempotencyKey?: string;
}

export interface ThreadSummary {
  threadId: string;
  createdAt: string;
  status: ThreadStatus;
  itemCount: number;
  lastSequence: number;
}

// ---------------------------------------------------------------------------
// Single reducer (P30-3 truth). Reduces a wire TurnEvent stream → RunResult.
// Every SDK run path (Thread.run, Thread.done, reduceTurnEvents) converges on
// this exact function, so a manual reducer over the same fixture reproduces
// the identical items/finalResponse/usage/status.
// ---------------------------------------------------------------------------

export async function reduceTurnEvents(
  events: Iterable<TurnEvent> | AsyncIterable<TurnEvent>,
  signal?: AbortSignal,
): Promise<RunResult> {
  const items: ThreadItem[] = [];
  let finalResponse: string | undefined;
  let usage: RunUsage | undefined;
  let status: RunResult["status"] = "completed";
  let error: RunResult["error"];

  for await (const event of events) {
    if (event.type === "turn/failed") {
      status = "failed";
      error = event.error;
    } else if (event.type === "turn/interrupted" && status !== "failed") {
      status = "interrupted";
    }
    // Only the FINAL completion of each item enters the reduced thread; deltas
    // and started markers are streaming-only (they are not final output).
    if (event.type === "item/completed" && event.item !== undefined) {
      items.push(event.item);
      if (event.item.kind === "agent_message" && event.item.final === true) {
        finalResponse = event.item.text;
        usage = event.item.usage;
      }
    }
    if (signal?.aborted === true && status !== "failed") {
      status = "interrupted";
      break;
    }
  }

  // An EOF that arrives because the caller aborted (channel closed while the
  // server may still be winding down) must still surface as interrupted.
  if (status === "completed" && signal?.aborted === true) {
    status = "interrupted";
  }

  return { items, finalResponse, usage, status, error };
}

// ---------------------------------------------------------------------------
// EventChannel: bridge transport push events → async iterator
// ---------------------------------------------------------------------------

class EventChannel implements AsyncIterable<TurnEvent> {
  private readonly queue: TurnEvent[] = [];
  private readonly waiters: ((e: TurnEvent | undefined) => void)[] = [];
  private ended = false;
  /** A terminal event (turn/completed|failed|interrupted) has been seen. */
  private terminalSeen = false;
  /** The terminal event itself has been delivered to a consumer. */
  private terminalDelivered = false;
  private readonly unsubscribe: () => void;

  constructor(
    transport: HarnessTransport,
    threadId: string,
    turnId: string,
  ) {
    this.unsubscribe = transport.subscribe("turn", (event) => {
      if (event.threadId !== threadId || event.turnId !== turnId) return;
      this.push(event);
    });
  }

  private static isTerminal(event: TurnEvent): boolean {
    return (
      event.type === "turn/completed" ||
      event.type === "turn/failed" ||
      event.type === "turn/interrupted"
    );
  }

  private push(event: TurnEvent): void {
    if (this.ended) return;
    if (EventChannel.isTerminal(event)) this.terminalSeen = true;
    const waiter = this.waiters.shift();
    if (waiter !== undefined) {
      if (EventChannel.isTerminal(event)) this.terminalDelivered = true;
      waiter(event);
      return;
    }
    this.queue.push(event);
  }

  end(): void {
    if (this.ended) return;
    this.ended = true;
    this.unsubscribe();
    for (const w of this.waiters.splice(0)) w(undefined);
  }

  [Symbol.asyncIterator](): AsyncIterator<TurnEvent> {
    return {
      next: (): Promise<IteratorResult<TurnEvent>> => {
        if (this.queue.length > 0) {
          const event = this.queue.shift()!;
          if (EventChannel.isTerminal(event)) this.terminalDelivered = true;
          return Promise.resolve({ value: event, done: false });
        }
        // EOF: either the run settled (terminal delivered) or the channel was
        // externally closed (abort/return).
        if (this.ended || this.terminalDelivered) {
          return Promise.resolve({ value: undefined, done: true });
        }
        return new Promise<IteratorResult<TurnEvent>>((resolve) => {
          this.waiters.push((event) => {
            if (event === undefined) {
              resolve({ value: undefined, done: true });
            } else {
              if (EventChannel.isTerminal(event)) this.terminalDelivered = true;
              resolve({ value: event, done: false });
            }
          });
        });
      },
      return: () => {
        this.end();
        return Promise.resolve({ value: undefined, done: true });
      },
    };
  }
}

// ---------------------------------------------------------------------------
// Thread: stream-first run API
// ---------------------------------------------------------------------------

export class Thread {
  readonly threadId: string;
  private readonly transport: HarnessTransport;

  constructor(threadId: string, transport: HarnessTransport) {
    this.threadId = threadId;
    this.transport = transport;
  }

  /**
   * P30-2 — run a turn, STREAM-first. Returns an async iterable of wire
   * TurnEvents plus a `done` promise with the reduced RunResult.
   */
  async runStreamed(
    prompt: string,
    opts: { signal?: AbortSignal; idempotencyKey?: string } = {},
  ): Promise<RunStream> {
    const params = {
      threadId: this.threadId,
      prompt,
      ...(opts.idempotencyKey !== undefined ? { idempotencyKey: opts.idempotencyKey } : {}),
    };
    const started = await this.transport.invoke("turn/start", params);
    if (started.error !== undefined) {
      throw new SdkError(started.error.message, {
        code: started.error.code,
        retryable: started.error.retryable,
      });
    }
    const { turnId } = started.result as { turnId: string };

    const channel = new EventChannel(this.transport, this.threadId, turnId);

    // P30-4 — abort maps to turn/interrupt on the SERVER, not just stopping
    // local reads. We also end the local channel so the reducer unblocks even
    // if the server never emits a terminal event (already-aborted case).
    const abort = opts.signal;
    const interrupt = () => {
      void this.transport.invoke("turn/interrupt", {
        threadId: this.threadId,
        turnId,
        reason: "aborted",
      });
      channel.end();
    };
    if (abort !== undefined) {
      if (abort.aborted) interrupt();
      else abort.addEventListener("abort", interrupt, { once: true });
    }
    const all = async (): Promise<RunResult> => {
      try {
        await this.transport.invoke("turn/run", { threadId: this.threadId, turnId });
        const result = await reduceTurnEvents(channel, abort);
        return { ...result, turnId };
      } finally {
        channel.end();
      }
    };
    const done = all();
    return { events: channel, done };
  }

  /**
   * P30-2/3 — convenience: `run()` is a REDUCER over `runStreamed()`. No
   * separate implementation.
   */
  async run(
    prompt: string,
    opts: { signal?: AbortSignal; idempotencyKey?: string } = {},
  ): Promise<RunResult> {
    const { done } = await this.runStreamed(prompt, opts);
    return done;
  }

  /** Read a past range of the thread (replay/resume, P29-8). */
  async read(opts: { afterSequence?: number; limit?: number } = {}): Promise<ThreadItem[]> {
    const res = await this.transport.invoke("thread/read", {
      threadId: this.threadId,
      ...(opts.afterSequence !== undefined ? { afterSequence: opts.afterSequence } : {}),
      ...(opts.limit !== undefined ? { limit: opts.limit } : {}),
    });
    if (res.error !== undefined) throw new SdkError(res.error.message);
    return (res.result as { items: ThreadItem[] }).items;
  }

  /** Interrupt the current turn (P30-4 server-side). */
  async interrupt(turnId?: string): Promise<void> {
    await this.transport.invoke("turn/interrupt", {
      threadId: this.threadId,
      ...(turnId !== undefined ? { turnId } : {}),
    });
  }
}

// ---------------------------------------------------------------------------
// HarnessClient: entry point
// ---------------------------------------------------------------------------

export class HarnessClient {
  private readonly transport: HarnessTransport;
  private readonly server: InitializeServer;

  private constructor(transport: HarnessTransport, server: InitializeServer) {
    this.transport = transport;
    this.server = server;
  }

  static async connect(transport: HarnessTransport): Promise<HarnessClient> {
    const server = await transport.initializeResult();
    return new HarnessClient(transport, server);
  }

  get serverInfo() {
    return this.server.serverInfo;
  }

  get capabilities() {
    return this.server.capabilities;
  }

  /** Start a new thread (P30-2). */
  async startThread(opts: StartThreadOptions): Promise<Thread> {
    const res = await this.invokeOrThrow("thread/start", {
      agentName: opts.agentName,
      cwd: opts.cwd,
      ...(opts.idempotencyKey !== undefined ? { idempotencyKey: opts.idempotencyKey } : {}),
    });
    const { id } = res as { id: string };
    return new Thread(id, this.transport);
  }

  /** List running/loaded threads. */
  async listThreads(): Promise<ThreadSummary[]> {
    const res = await this.invokeOrThrow("thread/loaded/list", {});
    return (res as { threads: ThreadSummary[] }).threads;
  }

  async close(): Promise<void> {
    await this.transport.close();
  }

  private async invokeOrThrow(method: string, params: Record<string, unknown>): Promise<unknown> {
    const res = await this.transport.invoke(method, params);
    if (res.error !== undefined) {
      throw new SdkError(res.error.message, {
        code: res.error.code,
        retryable: res.error.retryable,
      });
    }
    return res.result;
  }
}

export class SdkError extends Error {
  readonly code?: string;
  readonly retryable?: boolean;
  constructor(message: string, opts: { code?: string; retryable?: boolean } = {}) {
    super(message);
    this.name = "SdkError";
    this.code = opts.code;
    this.retryable = opts.retryable;
  }
}