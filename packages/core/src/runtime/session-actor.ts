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
  enqueueFollowup(input: UserMessage): Promise<void>;
  /** Next queued followup, or undefined when empty. */
  nextPendingFollowup(): Promise<UserMessage | undefined>;
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

/** Inbox-backed input queue. Followups are tracked in memory (authoritative
 *  for the process) AND admitted to the durable inbox; hydration reloads
 *  pending followups after a crash so a rebooted host can drain them. */
export class InboxSessionInputQueue implements SessionInputQueue {
  private readonly followups: Array<{ input: UserMessage; promptId?: PromptId }> = [];
  private hydrated = false;

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

  async enqueueFollowup(input: UserMessage): Promise<void> {
    let promptId: PromptId | undefined;
    if (this.deps.inbox !== undefined) {
      promptId = await this.admit(input.text, "followup");
    }
    this.followups.push({ input, promptId });
  }

  async nextPendingFollowup(): Promise<UserMessage | undefined> {
    if (!this.hydrated) {
      this.hydrated = true;
      await this.hydrate();
    }
    const next = this.followups.shift();
    if (next === undefined) return undefined;
    if (next.promptId !== undefined && this.deps.inbox !== undefined) {
      // Durable record: the followup was promoted into a real turn.
      await this.deps.inbox.markConsumed(next.promptId);
    }
    return next.input;
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
        this.followups.push({ input: { sessionId: this.sessionId, text: p.text }, promptId: p.id });
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

/** P25-2/3: the single owner of one live session — activeTurn ∈ {0,1}. */
export class DefaultSessionActor implements SessionActor {
  private active: ActiveTurnHandle | undefined;
  /** P25-3: a run registered synchronously while its store read is in flight.
   *  Closing this race lets session.cancel abort a turn that has been
   *  submitted but not yet begun executing (no bogus not_running). */
  private pendingRun: { turnId: TurnId; controller: AbortController } | undefined;
  private closed = false;
  readonly inputQueue: SessionInputQueue;
  readonly resourceScope: SessionResourceScope;
  readonly cancellation: AbortController;
  /** Resolvers for `queue` startTurn handles — resolved when the drained
   *  follow-up turn settles. */
  private readonly followupResolvers: Array<(outcome: TurnOutcome) => void> = [];

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
    return this.active;
  }

  async startTurn(
    input: UserMessage,
    opts: { onConflict?: SessionBusyDecision } = {},
  ): Promise<TurnHandle> {
    this.assertOpen();
    const existing = this.active;
    if (existing !== undefined) {
      // P25-3: explicit conflict decision — no silent parallel run.
      const decision = opts.onConflict ?? "busy";
      if (decision === "busy") {
        throw sessionBusy(this.sessionId, existing.turn.id);
      }
      if (decision === "steer") {
        await this.steer(input);
        return { turnId: existing.turn.id, outcome: existing.outcome };
      }
      // "queue": the outcome belongs to the future drained turn.
      const outcome = new Promise<TurnOutcome>((resolve) => {
        this.followupResolvers.push(resolve);
      });
      await this.enqueueFollowup(input);
      return { turnId: existing.turn.id, outcome };
    }
    if (this.pendingRun !== undefined) {
      // A turn is being submitted right now (its store read is in flight).
      // This is a sub-millisecond window: steer/followup callers should use
      // the dedicated actor.steer / actor.enqueueFollowup methods — a start
      // that cannot own a live outcome must be refused, not faked.
      throw sessionBusy(this.sessionId, this.pendingRun.turnId);
    }
    const turn = await this.deps.runtime.startTurn(this.sessionId, input.text);
    return this.executeTurn(turn);
  }

  async createTurn(input: UserMessage): Promise<Turn> {
    this.assertOpen();
    if (this.active !== undefined) {
      throw sessionBusy(this.sessionId, this.active.turn.id);
    }
    if (this.pendingRun !== undefined) {
      throw sessionBusy(this.sessionId, this.pendingRun.turnId);
    }
    return this.deps.runtime.startTurn(this.sessionId, input.text);
  }

  async runTurn(turnId: TurnId, signal?: AbortSignal): Promise<TurnOutcome> {
    this.assertOpen();
    if (this.active !== undefined) {
      throw sessionBusy(this.sessionId, this.active.turn.id);
    }
    if (this.pendingRun !== undefined) {
      throw sessionBusy(this.sessionId, this.pendingRun.turnId);
    }
    // P25-3: register the run SYNCHRONOUSLY so a cancel arriving before the
    // store read completes can still abort it (never a silent not_running).
    const controller = new AbortController();
    this.pendingRun = { turnId, controller };
    try {
      const turn = await this.requireTurn(turnId);
      this.pendingRun = undefined;
      return this.executeTurn(turn, signal, controller).outcome;
    } catch (err) {
      this.pendingRun = undefined;
      throw err;
    }
  }

  async steer(input: UserMessage): Promise<void> {
    this.assertOpen();
    await this.inputQueue.enqueueSteer(input);
  }

  async enqueueFollowup(input: UserMessage): Promise<void> {
    this.assertOpen();
    await this.inputQueue.enqueueFollowup(input);
  }

  async interrupt(): Promise<TurnOutcome | undefined> {
    const active = this.active;
    if (active !== undefined) {
      active.controller.abort();
      return active.outcome;
    }
    if (this.pendingRun !== undefined) {
      this.pendingRun.controller.abort();
    }
    return undefined;
  }

  async cancelTurn(turnId: TurnId): Promise<SessionTurnStatus> {
    const active = this.active;
    if (active !== undefined) {
      if (active.turn.id !== turnId) return "not_running";
      active.controller.abort();
      const outcome = await active.outcome;
      return outcome.status;
    }
    const pending = this.pendingRun;
    if (pending !== undefined && pending.turnId === turnId) {
      // Cancelled before the store read finished: abort now; the runtime sees
      // the aborted signal when the turn executes and settles as cancelled.
      pending.controller.abort();
      return "cancelled";
    }
    return "not_running";
  }

  status(): SessionRuntimeStatus {
    return {
      sessionId: this.sessionId,
      ...(this.active !== undefined
        ? { activeTurn: { turnId: this.active.turn.id, status: "running" as const } }
        : {}),
      queuedFollowups: this.inputQueue.pendingCount,
      loaded: !this.closed,
    };
  }

  /** P25-6: idempotent shutdown — interrupt, settle, release, remove. */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (this.pendingRun !== undefined) {
      this.pendingRun.controller.abort();
    }
    const active = this.active;
    if (active !== undefined) {
      active.controller.abort();
      try {
        await active.outcome;
      } catch (cause) {
        // P14-6: never silent — a rejected turn outcome during shutdown is
        // surfaced on the degraded channel (the original caller already saw
        // the rejection; this is the observable audit trail).
        process.stderr.write(
          `[degraded] session ${this.sessionId} turn outcome rejected during close: ${cause instanceof Error ? cause.message : String(cause)}\n`,
        );
      }
    }
    // The actor-level cancellation aborts any linked turn controller and is a
    // no-op for already-settled turns.
    this.cancellation.abort();
    this.resourceScope.release();
    this.deps.onClosed?.(this.sessionId);
  }

  private executeTurn(
    turn: Turn,
    externalSignal?: AbortSignal,
    prebuilt?: AbortController,
  ): TurnHandle {
    const controller = prebuilt ?? new AbortController();
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
    this.active = handle;

    void outcomePromise.then(
      () => {
        this.settle(handle, externalSignal, onExternalAbort, onCloseAbort);
      },
      () => {
        this.settle(handle, externalSignal, onExternalAbort, onCloseAbort);
      },
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
    if (this.active === handle) this.active = undefined;
    // P25-5: after the turn settles, drain one queued follow-up (if any) into
    // a fresh turn. The loop stops when the queue empties or a turn is active.
    void this.drainFollowups();
  }

  private async drainFollowups(): Promise<void> {
    if (this.closed || this.active !== undefined || this.pendingRun !== undefined) return;
    const followup = await this.inputQueue.nextPendingFollowup();
    if (followup === undefined) return;
    const turn = await this.deps.runtime.startTurn(this.sessionId, followup.text);
    const handle = this.executeTurn(turn);
    const resolver = this.followupResolvers.shift();
    if (resolver !== undefined) {
      void handle.outcome.then(resolver);
    }
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
export class DefaultLoadedSessionManager implements LoadedSessionManager {
  private readonly actors = new Map<SessionId, SessionActor>();

  constructor(private readonly deps: LoadedSessionManagerDeps) {}

  async load(id: SessionId): Promise<SessionActor> {
    const existing = this.actors.get(id);
    if (existing !== undefined) return existing;
    const session = await this.deps.store.getSession(id);
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
    this.actors.set(id, actor);
    return actor;
  }

  async unload(id: SessionId): Promise<void> {
    const actor = this.actors.get(id);
    if (actor === undefined) return;
    await actor.close();
    this.actors.delete(id);
  }

  listLoaded(): SessionId[] {
    return [...this.actors.keys()];
  }

  async close(): Promise<void> {
    const actors = [...this.actors.values()];
    await Promise.all(actors.map((a) => a.close()));
    this.actors.clear();
  }
}
