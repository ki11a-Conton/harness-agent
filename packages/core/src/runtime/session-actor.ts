// PHASE 25 — SessionActor: single owner of live session state.
//
// P25-1: durable `PersistentSession` (the contracts Session shape) is
// separated from the runtime-only `LoadedSession` (active turn handle, input
// queue, resource scope, cancellation). The live fields are NEVER serialized.
//
// P25-2: `SessionActor` / `LoadedSessionManager` own the live session state.
// Hard invariant per actor: activeTurn ∈ {0,1}.
//
// P25-3: the RPC layer previously used Map<sessionId:turnId, ActiveRun> as the
// primary lifecycle authority. That map is replaced by the actor: the actor
// owns the active run, and startTurn explicitly chooses BUSY / STEER / QUEUE
// when a turn is already active (no silent parallel run).
//
// P25-4: steer semantics — input injected before the NEXT model sampling only.
// The runtime already drains `kind === "steer"` inbox prompts at that exact
// safe boundary (injectSteeringPrompts); the actor only ADMITS the prompt.
//
// P25-5: follow-up queue — a normal user message while a turn runs is queued
// as a FUTURE turn (never injected into the running one). The kind is chosen
// by the protocol operation (steer vs followup), never inferred from text.
//
// P25-6: unload/close is idempotent: interrupt the active turn, settle the
// in-flight tools (runtime handles cancellation), flush journal/fences
// (runtime finishTurn), release the resource scope, and remove the actor.

import type {
  InboxStore,
  PromptId,
  Session,
  SessionId,
  SessionStore,
  Turn,
  TurnId,
  TurnStatus,
  UserMessage,
} from "@ar/contracts";
import { errorInfo, newPromptId } from "@ar/contracts";
import type { AgentRuntime, TurnOutcome } from "./runtime.js";
import { AgentError } from "../errors.js";

/** P25-1: durable session shape — the contracts `Session` IS the persistent
 *  shape. Keep the alias so callers never confuse it with LoadedSession. */
export type PersistentSession = Session;

/** P25-1: live session state. Runtime only — none of these fields are
 *  serialized (AbortController, promises, queues, scopes are all ephemeral). */
export interface LoadedSession {
  readonly persistent: PersistentSession;
  readonly activeTurn?: ActiveTurnHandle;
  readonly inputQueue: SessionInputQueue;
  readonly resourceScope: SessionResourceScope;
  readonly cancellation: AbortController;
}

/** A turn currently executing inside an actor. */
export interface ActiveTurnHandle {
  turn: Turn;
  controller: AbortController;
  outcome: Promise<TurnOutcome>;
}

/** Handle returned by startTurn: resolves when the turn settles. For a
 *  `queue` start the outcome belongs to the FUTURE turn that drains the
 *  queued input (turnId then references the running turn that admitted it). */
export interface TurnHandle {
  turnId: TurnId;
  outcome: Promise<TurnOutcome>;
}

/** P25-4/P25-5: input queue of a loaded session. Steer is admitted to the
 *  durable inbox (the runtime drains it at the sampling boundary); followups
 *  are additionally queued in memory for the actor's post-turn drain loop. */
export interface SessionInputQueue {
  readonly sessionId: SessionId;
  readonly pendingCount: number;
  enqueueSteer(input: UserMessage): Promise<void>;
  /** P37-1: returns a stable followup id so the actor can pair the drain
   *  outcome with the caller's resolver. */
  enqueueFollowup(input: UserMessage): Promise<string>;
  /**
   * P38-1/P38-2 (INV-P38-001/002): two-phase promotion API. reserve takes the
   * next followup WITHOUT consuming the durable record; completePromotion acks
   * it only after a real turn was created; releasePromotion requeues it when
   * promotion failed so the input is never lost.
   */
  reservePendingFollowup(): Promise<{ id: string; input: UserMessage } | undefined>;
  completePromotion(id: string): Promise<void>;
  releasePromotion(id: string): Promise<void>;
}

/** P25-1: session-bound resource registry (sandbox roots, MCP refs, ...).
 *  `release()` is called on unload — idempotent. */
export interface SessionResourceScope {
  readonly sessionId: SessionId;
  readonly resources: readonly string[];
  readonly size: number;
  attach(resource: string): void;
  detach(resource: string): void;
  release(): void;
}

/** P25-3: explicit conflict decision when a turn is already active. */
export type SessionBusyDecision = "busy" | "steer" | "queue";

/** Serializable snapshot of the actor's runtime state (safe to expose over
 *  the wire — no controllers, promises or sockets). */
export interface SessionRuntimeStatus {
  sessionId: SessionId;
  activeTurn?: { turnId: TurnId; status: "running" };
  queuedFollowups: number;
  loaded: boolean;
}

export type SessionTurnStatus = TurnStatus | "not_running";

/** P25-2: the single owner of one live session's state. */
export interface SessionActor {
  readonly sessionId: SessionId;
  readonly persistent: PersistentSession;
  readonly inputQueue: SessionInputQueue;
  readonly resourceScope: SessionResourceScope;
  readonly cancellation: AbortController;
  readonly activeTurn?: ActiveTurnHandle;
  /** P38-14: diagnostic — the current unified actor state kind. */
  readonly executionState: ActorExecutionState["kind"];

  /** Start a NEW turn. When a turn is already active the caller MUST choose
   *  the conflict policy explicitly: "busy" (default) throws SESSION_BUSY,
   *  "steer" injects the input into the running turn, "queue" queues it as a
   *  follow-up turn. No silent parallel run. */
  startTurn(input: UserMessage, opts?: { onConflict?: SessionBusyDecision }): Promise<TurnHandle>;
  /** Create a turn record WITHOUT executing it (RPC `session.send` path).
   *  Throws SESSION_BUSY while another turn is active. */
  createTurn(input: UserMessage): Promise<Turn>;
  /** Execute an already-created turn (RPC `session.run` compatibility path).
   *  Throws SESSION_BUSY while another turn is active. */
  runTurn(turnId: TurnId, signal?: AbortSignal): Promise<TurnOutcome>;
  /** Admit a steer — takes effect at the next sampling boundary only. */
  steer(input: UserMessage): Promise<void>;
  /** Queue a follow-up turn — starts AFTER the current turn settles. */
  enqueueFollowup(input: UserMessage): Promise<void>;
  /** Hard-abort the active turn (if any) and await its outcome. */
  interrupt(): Promise<TurnOutcome | undefined>;
  /** Abort the active turn only when it matches `turnId`; returns its status. */
  cancelTurn(turnId: TurnId): Promise<SessionTurnStatus>;
  status(): SessionRuntimeStatus;
  /** Idempotent P25-6 shutdown. */
  close(): Promise<void>;
}

/** P25-2: loader/unloader of live session actors. */
export interface LoadedSessionManager {
  load(id: SessionId): Promise<SessionActor>;
  unload(id: SessionId): Promise<void>;
  listLoaded(): SessionId[];
  close(): Promise<void>;
}

export interface SessionActorDeps {
  persistent: PersistentSession;
  runtime: Pick<AgentRuntime, "startTurn" | "runTurn">;
  store: SessionStore;
  inbox?: InboxStore;
  now?: () => number;
  onClosed?: (sessionId: SessionId) => void;
}

export interface LoadedSessionManagerDeps {
  runtime: Pick<AgentRuntime, "startTurn" | "runTurn">;
  store: SessionStore;
  inbox?: InboxStore;
  now?: () => number;
}

function sessionBusy(sessionId: SessionId, turnId: TurnId): AgentError {
  return new AgentError(
    errorInfo("SESSION_BUSY", `session ${sessionId} already has an active turn (${turnId})`),
  );
}

/** P36-2: SESSION_BUSY while a turn is STARTING (no turn id exists yet). */
function sessionStarting(sessionId: SessionId): AgentError {
  return new AgentError(
    errorInfo("SESSION_BUSY", `session ${sessionId} is starting a turn`),
  );
}

/** Inbox-backed input queue. Followups are tracked in memory (authoritative
 *  for the process) AND admitted to the durable inbox; hydration reloads
 *  pending followups after a crash so a rebooted host can drain them. */
export class InboxSessionInputQueue implements SessionInputQueue {
  private readonly followups: Array<{ id: string; input: UserMessage; promptId?: PromptId }> = [];
  private hydrated = false;
  private followupIdCounter = 0;
  /** P38-2: the followup reserved for promotion but NOT yet consumed. */
  private reserved: { id: string; input: UserMessage; promptId?: PromptId } | undefined;

  constructor(private readonly deps: { sessionId: SessionId; inbox?: InboxStore; now?: () => number }) {}

  get sessionId(): SessionId {
    return this.deps.sessionId;
  }

  get pendingCount(): number {
    return this.followups.length;
  }

  async enqueueSteer(input: UserMessage): Promise<void> {
    if (this.deps.inbox !== undefined) {
      await this.admit(input.text, "steer");
    }
    // Steer is NOT queued locally: the runtime drains steer prompts at the
    // next safe sampling boundary via injectSteeringPrompts.
  }

  async enqueueFollowup(input: UserMessage): Promise<string> {
    this.followupIdCounter += 1;
    const id = `fup-${this.followupIdCounter}`;
    let promptId: PromptId | undefined;
    if (this.deps.inbox !== undefined) {
      promptId = await this.admit(input.text, "followup");
    }
    this.followups.push({ id, input, promptId });
    return id;
  }

  /** P38-1/P38-2: take the next followup WITHOUT consuming the durable
   *  record. Only one reservation at a time (single-flight drain). */
  async reservePendingFollowup(): Promise<{ id: string; input: UserMessage } | undefined> {
    if (this.reserved !== undefined) return undefined;
    if (!this.hydrated) {
      this.hydrated = true;
      await this.hydrate();
    }
    const next = this.followups.shift();
    if (next === undefined) return undefined;
    this.reserved = next;
    return { id: next.id, input: next.input };
  }

  /** P38-2 (INV-P38-002): mark the durable prompt consumed ONLY after a real
   *  turn was created (promotion succeeded). */
  async completePromotion(id: string): Promise<void> {
    if (this.reserved === undefined || this.reserved.id !== id) return;
    if (this.reserved.promptId !== undefined && this.deps.inbox !== undefined) {
      await this.deps.inbox.markConsumed(this.reserved.promptId);
    }
    this.reserved = undefined;
  }

  /** P38-2 (INV-P38-003): promotion failed — requeue the reserved input at
   *  the head so it is recoverable (never lost, never double-consumed). */
  async releasePromotion(id: string): Promise<void> {
    if (this.reserved === undefined || this.reserved.id !== id) return;
    this.followups.unshift(this.reserved);
    this.reserved = undefined;
  }

  private async admit(text: string, kind: "steer" | "followup"): Promise<PromptId> {
    const inbox = this.deps.inbox!;
    const id = newPromptId();
    await inbox.admit({
      id,
      sessionId: this.sessionId,
      text,
      kind,
      status: "pending",
      admittedAt: (this.deps.now ?? Date.now)(),
    });
    return id;
  }

  private async hydrate(): Promise<void> {
    const inbox = this.deps.inbox;
    if (inbox === undefined) return;
    const pending = await inbox.listPending(this.sessionId);
    for (const p of pending) {
      // Only status "pending": a promoted followup already started a turn
      // (crash recovery) and must not be re-queued.
      if (p.kind === "followup" && p.status === "pending") {
        this.followupIdCounter += 1;
        this.followups.push({
          id: `fup-${this.followupIdCounter}`,
          input: { sessionId: this.sessionId, text: p.text },
          promptId: p.id,
        });
      }
    }
  }
}

/** Default resource scope: a named-resource registry, released on close. */
export class DefaultSessionResourceScope implements SessionResourceScope {
  private readonly owned = new Set<string>();

  constructor(readonly sessionId: SessionId) {}

  get resources(): readonly string[] {
    return [...this.owned];
  }

  get size(): number {
    return this.owned.size;
  }

  attach(resource: string): void {
    this.owned.add(resource);
  }

  detach(resource: string): void {
    this.owned.delete(resource);
  }

  release(): void {
    this.owned.clear();
  }
}

/** P37-1: single authoritative actor execution state. */
export type ActorExecutionState =
  | { kind: "idle" }
  | {
      kind: "starting";
      source: "new_turn" | "existing_turn" | "followup";
      controller: AbortController;
      requestId: string;
      turnId?: TurnId;
    }
  | {
      kind: "running";
      turn: Turn;
      controller: AbortController;
      outcome: Promise<TurnOutcome>;
    }
  | { kind: "closing" };

let requestIdCounter = 0;
function nextRequestId(): string {
  requestIdCounter += 1;
  return `req-${requestIdCounter}`;
}

/** P25-2/3 + P37-1: the single owner of one live session — unified state. */
export class DefaultSessionActor implements SessionActor {
  private state: ActorExecutionState = { kind: "idle" };
  private closed = false;
  readonly inputQueue: SessionInputQueue;
  readonly resourceScope: SessionResourceScope;
  readonly cancellation: AbortController;
  /** P37-1: followup resolvers keyed by stable followup id. */
  private readonly followupResolvers = new Map<string, (outcome: TurnOutcome) => void>();

  constructor(private readonly deps: SessionActorDeps) {
    this.inputQueue = new InboxSessionInputQueue({
      sessionId: deps.persistent.id,
      inbox: deps.inbox,
      now: deps.now,
    });
    this.resourceScope = new DefaultSessionResourceScope(deps.persistent.id);
    this.cancellation = new AbortController();
  }

  get sessionId(): SessionId {
    return this.deps.persistent.id;
  }

  get persistent(): PersistentSession {
    return this.deps.persistent;
  }

  get activeTurn(): ActiveTurnHandle | undefined {
    const s = this.state;
    return s.kind === "running" ? { turn: s.turn, controller: s.controller, outcome: s.outcome } : undefined;
  }

  get executionState(): ActorExecutionState["kind"] {
    return this.state.kind;
  }

  async startTurn(
    input: UserMessage,
    opts: { onConflict?: SessionBusyDecision } = {},
  ): Promise<TurnHandle> {
    this.assertOpen();
    const s = this.state;
    if (s.kind === "running") {
      const decision = opts.onConflict ?? "busy";
      if (decision === "busy") throw sessionBusy(this.sessionId, s.turn.id);
      if (decision === "steer") {
        await this.steer(input);
        return { turnId: s.turn.id, outcome: s.outcome };
      }
      // queue: outcome belongs to the future drained followup
      const followupId = await this.inputQueue.enqueueFollowup(input);
      const outcome = new Promise<TurnOutcome>((resolve) => {
        this.followupResolvers.set(followupId, resolve);
      });
      return { turnId: s.turn.id, outcome };
    }
    if (s.kind === "starting") throw sessionStarting(this.sessionId);
    if (s.kind === "closing") throw new AgentError(errorInfo("INTERNAL_ERROR", `session ${this.sessionId} is closing`));
    // idle → reserve starting
    const controller = new AbortController();
    const requestId = nextRequestId();
    this.state = { kind: "starting", source: "new_turn", controller, requestId };
    try {
      const turn = await this.deps.runtime.startTurn(this.sessionId, input.text);
      // P37-1: revalidate — if closed/cancelled during await, never promote
      if (this.state.kind !== "starting" || this.state.requestId !== requestId) {
        throw new AgentError(errorInfo("INTERNAL_ERROR", `session ${this.sessionId} closed while starting a turn`));
      }
      return this.promoteToRunning(turn, controller);
    } catch (err) {
      if (this.state.kind === "starting" && this.state.requestId === requestId) {
        this.state = { kind: "idle" };
      }
      throw err;
    }
  }

  async createTurn(input: UserMessage): Promise<Turn> {
    this.assertOpen();
    const s = this.state;
    if (s.kind === "running") throw sessionBusy(this.sessionId, s.turn.id);
    if (s.kind === "starting") throw sessionStarting(this.sessionId);
    if (s.kind === "closing") throw new AgentError(errorInfo("INTERNAL_ERROR", `session ${this.sessionId} is closing`));
    return this.deps.runtime.startTurn(this.sessionId, input.text);
  }

  async runTurn(turnId: TurnId, signal?: AbortSignal): Promise<TurnOutcome> {
    this.assertOpen();
    const s = this.state;
    if (s.kind === "running") throw sessionBusy(this.sessionId, s.turn.id);
    if (s.kind === "starting") throw sessionStarting(this.sessionId);
    if (s.kind === "closing") throw new AgentError(errorInfo("INTERNAL_ERROR", `session ${this.sessionId} is closing`));
    // P37-1: reserve SYNCHRONOUSLY before the first await
    const controller = new AbortController();
    const requestId = nextRequestId();
    this.state = { kind: "starting", source: "existing_turn", controller, requestId, turnId };
    try {
      const turn = await this.requireTurn(turnId);
      if (this.state.kind !== "starting" || this.state.requestId !== requestId) {
        throw new AgentError(errorInfo("INTERNAL_ERROR", `runTurn ${turnId} cancelled during load`));
      }
      return this.promoteToRunning(turn, controller, signal).outcome;
    } catch (err) {
      if (this.state.kind === "starting" && this.state.requestId === requestId) {
        this.state = { kind: "idle" };
      }
      throw err;
    }
  }

  async steer(input: UserMessage): Promise<void> {
    this.assertOpen();
    const s = this.state;
    if (s.kind !== "running") {
      // P37-1: steer requires an active running turn
      throw new AgentError(errorInfo("NO_ACTIVE_TURN", "steer requires a currently running turn"));
    }
    await this.inputQueue.enqueueSteer(input);
  }

  async enqueueFollowup(input: UserMessage): Promise<void> {
    this.assertOpen();
    await this.inputQueue.enqueueFollowup(input);
  }

  async interrupt(): Promise<TurnOutcome | undefined> {
    const s = this.state;
    if (s.kind === "running") {
      s.controller.abort();
      return s.outcome;
    }
    if (s.kind === "starting") {
      // P38-4 (INV-P38-005): interrupt REVOKES the reservation — abort the
      // controller AND return the state to idle so a late runtime.startTurn
      // can never promote (requestId revalidation also fails).
      s.controller.abort();
      this.state = { kind: "idle" };
    }
    return undefined;
  }

  async cancelTurn(turnId: TurnId): Promise<SessionTurnStatus> {
    const s = this.state;
    if (s.kind === "running") {
      if (s.turn.id !== turnId) return "not_running";
      s.controller.abort();
      const outcome = await s.outcome;
      return outcome.status;
    }
    if (s.kind === "starting" && s.turnId === turnId) {
      s.controller.abort();
      return "cancelled";
    }
    return "not_running";
  }

  status(): SessionRuntimeStatus {
    const s = this.state;
    return {
      sessionId: this.sessionId,
      ...(s.kind === "running" ? { activeTurn: { turnId: s.turn.id, status: "running" as const } } : {}),
      queuedFollowups: this.inputQueue.pendingCount,
      loaded: !this.closed,
    };
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    const s = this.state;
    if (s.kind === "starting") {
      s.controller.abort();
      // P37-1: prevent late promotion
      this.state = { kind: "closing" };
    } else if (s.kind === "running") {
      s.controller.abort();
      try {
        await s.outcome;
      } catch (cause) {
        process.stderr.write(
          `[degraded] session ${this.sessionId} turn outcome rejected during close: ${cause instanceof Error ? cause.message : String(cause)}\n`,
        );
      }
      this.state = { kind: "closing" };
    } else {
      this.state = { kind: "closing" };
    }
    this.cancellation.abort();
    this.resourceScope.release();
    this.deps.onClosed?.(this.sessionId);
  }

  /** P37-1: reserve → promote to running. */
  private promoteToRunning(
    turn: Turn,
    controller: AbortController,
    externalSignal?: AbortSignal,
  ): TurnHandle {
    if (this.state.kind !== "starting" || this.state.controller !== controller) {
      throw new AgentError(errorInfo("INTERNAL_ERROR", "stale reservation: cannot promote to running"));
    }
    const onExternalAbort = () => controller.abort();
    const onCloseAbort = () => controller.abort();
    if (externalSignal !== undefined) {
      if (externalSignal.aborted) {
        controller.abort();
      } else {
        externalSignal.addEventListener("abort", onExternalAbort, { once: true });
      }
    }
    this.cancellation.signal.addEventListener("abort", onCloseAbort, { once: true });

    const outcomePromise = this.deps.runtime.runTurn(this.sessionId, turn.id, controller.signal);
    const handle: ActiveTurnHandle = { turn, controller, outcome: outcomePromise };
    this.state = { kind: "running", turn, controller, outcome: outcomePromise };

    void outcomePromise.then(
      () => this.settle(handle, externalSignal, onExternalAbort, onCloseAbort),
      () => this.settle(handle, externalSignal, onExternalAbort, onCloseAbort),
    );
    return { turnId: turn.id, outcome: outcomePromise };
  }

  private settle(
    handle: ActiveTurnHandle,
    externalSignal: AbortSignal | undefined,
    onExternalAbort: () => void,
    onCloseAbort: () => void,
  ): void {
    if (externalSignal !== undefined) {
      externalSignal.removeEventListener("abort", onExternalAbort);
    }
    this.cancellation.signal.removeEventListener("abort", onCloseAbort);
    if (this.state.kind === "running" && (this.state as { outcome: Promise<unknown> }).outcome === handle.outcome) {
      this.state = { kind: "idle" };
    }
    // P37-1: drain followups with proper reservation (no bypass)
    void this.drainFollowups();
  }

  private async drainFollowups(queue: SessionInputQueue = this.inputQueue): Promise<void> {
    if (this.closed) return;
    if (this.state.kind !== "idle") return;
    // P38-1 (INV-P38-001): RESERVE the actor slot BEFORE the awaited dequeue.
    // A concurrent startTurn will see "starting" and be refused — no
    // reservation overwrite.
    const controller = new AbortController();
    const requestId = nextRequestId();
    this.state = { kind: "starting", source: "followup", controller, requestId };
    let reservedId: string | undefined;
    try {
      // P38-2 (INV-P38-002): reserve the followup entry WITHOUT consuming the
      // durable inbox record. The inbox is marked consumed only after a real
      // turn is created (completePromotion).
      const entry = await queue.reservePendingFollowup();
      if (entry === undefined) {
        // No pending followup — release the reservation.
        if (this.state.kind === "starting" && this.state.requestId === requestId) {
          this.state = { kind: "idle" };
        }
        return;
      }
      reservedId = entry.id;
      const turn = await this.deps.runtime.startTurn(this.sessionId, entry.input.text);
      // P38-4: cancelled/aborted reservation cannot promote.
      if (this.state.kind !== "starting" || this.state.requestId !== requestId || controller.signal.aborted) {
        // Release the reserved followup back to the queue head so it can
        // be retried on a later drain.
        await queue.releasePromotion(entry.id);
        reservedId = undefined;
        return;
      }
      // Promotion succeeded — mark the durable prompt consumed.
      await queue.completePromotion(entry.id);
      reservedId = undefined;
      const handle = this.promoteToRunning(turn, controller);
      const resolver = this.followupResolvers.get(entry.id);
      if (resolver !== undefined) {
        this.followupResolvers.delete(entry.id);
        void handle.outcome.then(resolver);
      }
    } catch (err) {
      // P38-2 (INV-P38-003): promotion failure — release the reservation and
      // requeue the reserved input (never consumed, never lost).
      if (this.state.kind === "starting" && this.state.requestId === requestId) {
        this.state = { kind: "idle" };
      }
      if (reservedId !== undefined) {
        try {
          await queue.releasePromotion(reservedId);
        } catch (releaseErr) {
          // The queue is best-effort here; the durable inbox record is still
          // pending so hydration on restart recovers it. Surface the loss so
          // it is never silent (P14-6).
          process.stderr.write(
            `[degraded] session ${this.sessionId} failed to release reserved followup ${reservedId}: ${releaseErr instanceof Error ? releaseErr.message : String(releaseErr)}\n`,
          );
        }
      }
    }
  }

  /** @internal P38 test seam: run the followup drain against a (possibly
   *  gated) queue override. */
  drainFollowupsForTest(queue?: SessionInputQueue): Promise<void> {
    return this.drainFollowups(queue);
  }

  private async requireTurn(turnId: TurnId): Promise<Turn> {
    const turn = await this.deps.store.getTurn(turnId);
    if (turn === undefined || turn.sessionId !== this.sessionId) {
      throw new AgentError(
        errorInfo("INTERNAL_ERROR", `unknown turn ${turnId} for session ${this.sessionId}`),
      );
    }
    return turn;
  }

  private assertOpen(): void {
    if (this.closed) {
      throw new AgentError(errorInfo("INTERNAL_ERROR", `session ${this.sessionId} is not loaded`));
    }
  }
}

/** P25-2: manager of live session actors — load on demand, unload on close. */
/** P38-5 (INV-P38-006): identity-bearing loading entry — an older load
 *  generation can never delete/replace the entry owned by a newer one. */
interface LoadingEntry {
  generation: number;
  controller: AbortController;
  promise: Promise<SessionActor>;
}

export class DefaultLoadedSessionManager implements LoadedSessionManager {
  private readonly actors = new Map<SessionId, SessionActor>();
  /** P36-3 (INV-P36-002): single-flight loading table. Stored BEFORE the
   *  first await so concurrent load(id) calls resolve to the SAME actor. */
  private readonly loading = new Map<SessionId, LoadingEntry>();
  /** P37-2 (INV-P37-002): generation fencing — unload/close bumps the
   *  generation so an older in-flight load cannot install an actor after
   *  unload/close has won. */
  private readonly generations = new Map<SessionId, number>();
  private closed = false;

  constructor(private readonly deps: LoadedSessionManagerDeps) {}

  async load(id: SessionId): Promise<SessionActor> {
    const existing = this.actors.get(id);
    if (existing !== undefined) return existing;
    const inflight = this.loading.get(id);
    if (inflight !== undefined) return inflight.promise;
    // P37-2: capture the generation BEFORE the first await.
    const generation = this.generations.get(id) ?? 0;
    const controller = new AbortController();
    const entry: LoadingEntry = { generation, controller, promise: undefined! };
    entry.promise = this.doLoad(id, entry);
    this.loading.set(id, entry);
    return entry.promise;
  }

  private async doLoad(id: SessionId, entry: LoadingEntry): Promise<SessionActor> {
    try {
      const session = await this.deps.store.getSession(id);
      // P37-2/P38-5: unload/close may have won while getSession() was in flight.
      if (this.closed || (this.generations.get(id) ?? 0) !== entry.generation || entry.controller.signal.aborted) {
        throw new AgentError(errorInfo("LOAD_CANCELLED", `session load ${id} was cancelled`));
      }
      if (session === undefined) {
        throw new AgentError(errorInfo("INTERNAL_ERROR", `unknown session ${id}`));
      }
      const actor = new DefaultSessionActor({
        persistent: session,
        runtime: this.deps.runtime,
        store: this.deps.store,
        inbox: this.deps.inbox,
        now: this.deps.now,
        onClosed: (sid) => {
          this.actors.delete(sid);
        },
      });
      // Re-check under the same fence: nothing may install after unload/close.
      if (this.closed || (this.generations.get(id) ?? 0) !== entry.generation || entry.controller.signal.aborted) {
        await actor.close();
        throw new AgentError(errorInfo("LOAD_CANCELLED", `session load ${id} was cancelled`));
      }
      this.actors.set(id, actor);
      return actor;
    } finally {
      // P38-5 (INV-P38-006): never delete an entry we do not own. A stale
      // finally from an older generation must not remove a newer entry.
      if (this.loading.get(id) === entry) {
        this.loading.delete(id);
      }
    }
  }

  async unload(id: SessionId): Promise<void> {
    // P38-5: fence out any in-flight load AND abort its controller (delete is
    // not cancellation — the in-flight getSession must be aborted too).
    this.generations.set(id, (this.generations.get(id) ?? 0) + 1);
    const entry = this.loading.get(id);
    if (entry !== undefined) {
      entry.controller.abort();
      this.loading.delete(id);
    }
    const actor = this.actors.get(id);
    if (actor === undefined) return;
    await actor.close();
    this.actors.delete(id);
  }

  listLoaded(): SessionId[] {
    return [...this.actors.keys()];
  }

  async close(): Promise<void> {
    this.closed = true;
    // P37-2: invalidate every generation so no in-flight load can install.
    for (const id of this.generations.keys()) {
      this.generations.set(id, (this.generations.get(id) ?? 0) + 1);
    }
    // P38-5: abort in-flight load controllers too (delete is not cancellation).
    for (const entry of this.loading.values()) {
      entry.controller.abort();
    }
    const actors = [...this.actors.values()];
    await Promise.all(actors.map((a) => a.close()));
    this.actors.clear();
    this.loading.clear();
  }
}
