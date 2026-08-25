/**
 * P30 — TypeScript SDK (client-only path).
 *
 * The SDK is the surface a host (CLI/web) uses to drive an Agent Harness App
 * Server. It is STREAM-FIRST: the primary API is `runStreamed`, and the
 * convenience `run()` is a REDUCER over that stream (P30-3 — the same single
 * implementation, no parallel code path).
 *
 * P36-4 (INV-P36-003/004): `RunEventHub` replaces the single-consumer
 * EventChannel with a broadcast hub that feeds an internal reducer AND a
 * public event queue independently. This means `events` and `done` can be
 * consumed concurrently without deadlock or event stealing.
 *
 * The SDK depends ONLY on `@ar/protocol` (DTOs) and a transport client
 * (P30-1). It never imports `@ar/core` or the runtime.
 */
import type {
  InitializeServer,
  ThreadItem,
  TurnEvent,
} from "@ar/protocol";
import type { HarnessTransport, TransportInvoke } from "./transport.js";

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
// PushChannel: a simple push-based AsyncIterable (single consumer).
// Used as the PUBLIC event queue in RunEventHub.
// ---------------------------------------------------------------------------

/** P38-8 (INV-P38-010): channel lifecycle — a stream failure after iterator
 *  creation is observable as an error, never as clean EOF. */
type ChannelState =
  | { kind: "open" }
  | { kind: "ended" }
  | { kind: "failed"; error: Error };

export class PushChannel implements AsyncIterable<TurnEvent> {
  private readonly queue: TurnEvent[] = [];
  private readonly waiters: ((e: TurnEvent | undefined) => void)[] = [];
  private state: ChannelState = { kind: "open" };

  constructor(
    private readonly maxEvents = 4096,
    /** Called when the buffer overflows. The hub uses this to fail done. */
    private readonly onOverflow?: () => void,
  ) {}

  push(event: TurnEvent): void {
    if (this.state.kind !== "open") return;
    if (this.queue.length >= this.maxEvents) {
      // P38-8: overflow is a FAILURE — channel.fail + hub settles failed.
      this.fail(new OverflowError("event stream buffer overflow"));
      this.onOverflow?.();
      return;
    }
    const waiter = this.waiters.shift();
    if (waiter !== undefined) {
      waiter(event);
      return;
    }
    this.queue.push(event);
  }

  end(): void {
    if (this.state.kind === "open") {
      this.state = { kind: "ended" };
      for (const w of this.waiters.splice(0)) w(undefined);
    }
  }

  /** P38-8: fail the stream with an error. Already-delivered queued events
   *  are still delivered; the NEXT iteration rejects with the stored error. */
  fail(error: Error): void {
    if (this.state.kind === "open") {
      this.state = { kind: "failed", error };
      for (const w of this.waiters.splice(0)) w(undefined);
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<TurnEvent> {
    return {
      next: (): Promise<IteratorResult<TurnEvent>> => {
        // Deliver already accepted queued events first (documented policy).
        if (this.queue.length > 0) {
          return Promise.resolve({ value: this.queue.shift()!, done: false });
        }
        const s = this.state;
        if (s.kind === "failed") {
          return Promise.reject(s.error);
        }
        if (s.kind === "ended") {
          return Promise.resolve({ value: undefined, done: true });
        }
        return new Promise<IteratorResult<TurnEvent>>((resolve, reject) => {
          this.waiters.push((event) => {
            if (event === undefined) {
              // Re-check state: an event of undefined means end/fail arrived.
              const st = this.state;
              if (st.kind === "failed") {
                reject(st.error);
              } else {
                resolve({ value: undefined, done: true });
              }
            } else {
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

export class OverflowError extends Error {
  readonly code = "STREAM_BUFFER_OVERFLOW";
  constructor(message: string) {
    super(message);
    this.name = "OverflowError";
  }
}

// ---------------------------------------------------------------------------
// RunEventHub (P36-4): broadcast hub that feeds a public event queue AND an
// internal incremental reducer independently.  `done` never consumes the
// public queue — it uses the internal reducer state.
// ---------------------------------------------------------------------------

/** Incremental reducer used by RunEventHub. */
function accumulateEvent(state: RunResult, event: TurnEvent): void {
  if (event.type === "turn/failed") {
    state.status = "failed";
    state.error = event.error;
  } else if (event.type === "turn/interrupted" && state.status !== "failed") {
    state.status = "interrupted";
  }
  if (event.type === "item/completed" && event.item !== undefined) {
    state.items.push(event.item);
    if (event.item.kind === "agent_message" && event.item.final === true) {
      state.finalResponse = event.item.text;
      state.usage = event.item.usage;
    }
  }
}

function isTerminal(event: TurnEvent): boolean {
  return (
    event.type === "turn/completed" ||
    event.type === "turn/failed" ||
    event.type === "turn/interrupted"
  );
}

class RunEventHub {
  readonly events: PushChannel;
  private readonly state: RunResult = { items: [], status: "completed" };
  private readonly _done: Promise<RunResult>;
  private resolveDone!: (r: RunResult) => void;
  private settled = false;
  // P38-7: run-scoped cleanup handles.
  private readonly unsubscribeTurn: () => void;
  private readonly unsubscribeClose: () => void;
  private readonly abortSignal?: AbortSignal;
  private readonly abortListener?: () => void;

  constructor(
    transport: HarnessTransport,
    threadId: string,
    turnId: string,
    signal?: AbortSignal,
  ) {
    // P38-8: bounded buffer — overflow is a channel FAILURE + failed done.
    this.events = new PushChannel(4096, () => {
      this.settleOnce(
        {
          status: "failed",
          items: [...this.state.items],
          error: {
            code: "STREAM_BUFFER_OVERFLOW",
            retryable: true,
            message: "event stream buffer overflow (max 4096 events)",
          },
        },
        new OverflowError("event stream buffer overflow"),
      );
    });

    this._done = new Promise<RunResult>((resolve) => {
      this.resolveDone = resolve;
    });

    // P38-6 (INV-P38-008): subscribe BEFORE the first operation that can
    // emit a run event.
    this.unsubscribeTurn = transport.subscribe("turn", (event) => {
      if (event.threadId !== threadId || event.turnId !== turnId) return;
      this.events.push(event);
      accumulateEvent(this.state, event);
      if (isTerminal(event)) {
        this.settleOnce({ ...this.state });
      }
    });

    // P38-4/P38-7 (Bug B): transport close lifecycle — if the transport
    // closes before a terminal turn event, the run terminally FAILS.
    const onClose = () => {
      this.settleOnce(
        {
          status: "failed",
          items: [...this.state.items],
          error: {
            code: "STREAM_TERMINATED_BEFORE_TURN_END",
            retryable: true,
            message: "transport closed before terminal turn event",
          },
        },
        new SdkError("transport closed before terminal turn event", { code: "STREAM_TERMINATED_BEFORE_TURN_END", retryable: true }),
      );
    };
    this.unsubscribeClose = transport.onClose?.(onClose) ?? (() => {});

    // P38-7: abort support — maps to server interrupt, but the abort listener
    // is tracked for cleanup in settleOnce.
    if (signal !== undefined) {
      this.abortSignal = signal;
      const onAbort = () => {
        // Always notify the server (even if the event stream already
        // terminated) — the local abort is authoritative.
        void transport.invoke("turn/interrupt", { threadId, turnId, reason: "aborted" });
        this.settleOnce({
          status: "interrupted",
          items: [...this.state.items],
        });
      };
      this.abortListener = onAbort;
      if (signal.aborted) {
        onAbort();
      } else {
        signal.addEventListener("abort", onAbort, { once: true });
      }
    }
  }

  /** P38-6 (INV-P38-007): attach the turn/run invocation WITHOUT blocking
   *  runStreamed() from returning. Handles resolved { error }, rejection, and
   *  success-after-terminal without double-settling. */
  attachRunInvocation(invocation: Promise<TransportInvoke<unknown>>): void {
    void invocation.then(
      (response) => {
        if (response.error !== undefined) {
          // P38-4 (INV-P37-005): a resolved { error } from turn/run is a
          // terminal failure, not a "not yet started" signal.
          this.settleOnce(
            {
              status: "failed",
              items: [...this.state.items],
              error: { code: response.error.code, message: response.error.message, retryable: response.error.retryable },
            },
            new SdkError(response.error.message, response.error),
          );
        }
        // Success after terminal: settleOnce is a no-op (already settled).
      },
      (err) => {
        // Rejected invoke Promise → terminal failure.
        this.settleOnce(
          {
            status: "failed",
            items: [...this.state.items],
            error: { code: "protocol_error", message: String(err), retryable: false },
          },
          err instanceof Error ? err : new SdkError(String(err), { code: "protocol_error", retryable: false }),
        );
      },
    );
  }

  /**
   * P38-7 (INV-P38-009): THE single terminal path. Every terminal signal goes
   * through here — turn terminal event, local abort, transport close, buffer
   * overflow, invoke error/rejection, explicit close. Settles done exactly
   * once and releases all run-scoped listeners exactly once.
   *
   * `channelError` distinguishes TRANSPORT failures (overflow, transport
   * close, invoke rejection — the stream was abnormally cut) from protocol
   * terminals (turn/completed|failed|interrupted — the stream ended normally
   * per protocol). Only transport failures fail the public event channel.
   */
  private settleOnce(result: RunResult, channelError?: Error): void {
    if (this.settled) return;
    this.settled = true;
    this.unsubscribeTurn();
    this.unsubscribeClose();
    if (this.abortSignal !== undefined && this.abortListener !== undefined) {
      this.abortSignal.removeEventListener("abort", this.abortListener);
    }
    if (channelError !== undefined) {
      this.events.fail(channelError);
    } else {
      this.events.end();
    }
    this.resolveDone(result);
  }

  get done(): Promise<RunResult> {
    return this._done;
  }

  close(): void {
    this.settleOnce({ status: "completed", items: [...this.state.items] });
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
   *
   * P36-4: `events` and `done` are now independent (RunEventHub broadcast).
   * They may be consumed concurrently without deadlock or event stealing.
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

    // P38-6 (INV-P38-007/008): subscribe FIRST (hub constructor), then start
    // turn/run, attach it to the hub, and RETURN immediately — the stream is
    // live while turn/run is still pending.
    const hub = new RunEventHub(this.transport, this.threadId, turnId, opts.signal);
    hub.attachRunInvocation(
      this.transport.invoke("turn/run", {
        threadId: this.threadId,
        turnId,
      }),
    );

    const done = hub.done.then((r) => ({ ...r, turnId }));
    return { events: hub.events, done };
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