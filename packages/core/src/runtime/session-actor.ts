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
  AdmittedPrompt,
  EventSink,
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
import type { AgentRuntime, TurnOutcome, TurnOutcomeDetail } from "./runtime.js";
import { AgentError } from "../errors.js";
// E2-10: same-T bounded recovery state machine (typed ordering/budget/backoff).
// E3-10: the actor now persists the recovery record to a durable store and
// re-drives the SAME-T bounded retry from it (peek/leased head, retryable
// classification, injected scheduler / manual clock).
import {
  createRecoveryTask,
  recoveryNeedsReconcile,
  recoveryPolicy,
  retryDue,
  taskTerminal,
  transitionRecoveryTask,
  type RecoveryClock,
  type RecoveryTaskRecord,
} from "./recovery-state-machine.js";

/** P25-1: durable session shape — the contracts `Session` IS the persistent
 *  shape. Keep the alias so callers never confuse it with LoadedSession. */
export type PersistentSession = Session;

/**
 * E3-10 — durable same-T recovery record.
 *
 * Extends the pure `RecoveryTaskRecord` (recovery-state-machine.ts) with the
 * durable-store fields the actor needs to recover the SAME turn across process
 * restarts WITHOUT resetting the retry budget:
 *
 *   taskId         — the durable Turn identity being recovered (same T, no T2)
 *   lineageId      — the prompt lineage this recovery belongs to
 *   promptId       — the durable prompt bound to the turn (for terminal consume)
 *   state          — RecoveryTaskState: PENDING (initial) / RECOVERY_IN_PROGRESS
 *                    (retrying) / RETRY_SCHEDULED / RECOVERED / EXHAUSTED /
 *                    TERMINAL_FAILED.  The plan's "INITIAL | RETRYING" shorthand
 *                    maps to PENDING and RECOVERY_IN_PROGRESS/RETRY_SCHEDULED.
 *   attempt        — recovery-handler attempt counter (bounded by maxRecoveryAttempts)
 *   maxRecoveryAttempts — hard retry budget (never reset on restart)
 *   nextAttemptAt  — scheduler epoch for the next retry (exponential backoff)
 *   lastError      — last typed handler error
 *   policyVersion  — which policy produced the current record
 *   lease          — single-flight owner + expiry: only one live owner may
 *                    actively recover this T at a time (two actors / duplicate
 *                    completion never double-execute).
 */
export interface RecoveryRecord extends RecoveryTaskRecord {
  /** The durable prompt whose promoted lineage this recovery owns. */
  promptId: PromptId;
  /** Single-flight lease. `undefined` = free. A lease whose expiry has passed
   *  is stale and may be re-acquired. */
  lease?: { owner: string; expiresAt: number };
  /** E4-08 — optimistic-concurrency version. The durable store assigns + bumps
   *  it on every accepted write; a write whose version does not match the
   *  on-disk record is rejected (lost-update / double-lease prevention across
   *  processes and workers). Absent only on a not-yet-persisted fresh record. */
  version?: number;
}

/**
 * E3-10 — durable recovery-record store. Persisting the record (rather than
 * recreating it per drain) is what keeps attempt/nextAttemptAt/policyVersion
 * across process restarts, so a crash never resets the retry budget.
 *
 * E4-08 — `putRecord` is a compare-and-set: it returns the stored record with
 * its new `version`, and MUST throw when the incoming record's `version` does
 * not match the currently stored one (a concurrent owner won). Callers that
 * acquire a lease or begin an attempt MUST treat a throw as "do not proceed".
 */
export interface RecoveryStore {
  getRecord(taskId: TurnId): Promise<RecoveryRecord | undefined>;
  putRecord(record: RecoveryRecord): Promise<RecoveryRecord>;
  deleteRecord(taskId: TurnId): Promise<void>;
}

/** E3-10 — injectable scheduler used to fire the next same-T retry after the
 *  backoff window. Injected scheduler/manual clock replaces the old
 *  `void this.drainFollowups()` recursive hot loops: the actor never re-drains
 *  from inside a failure handler. */
export interface RecoveryScheduler {
  schedule(delayMs: number, cb: () => void): { cancel(): void };
}

/** E3-10 — retryable classification result. */
export type RecoveryErrorClass = "retryable" | "terminal";

/**
 * E3-10 — classify a recovery-handler failure:
 *  - infrastructure / transport / process-crash / timeout  → retryable (backoff)
 *  - business / durable-state terminal failures            → terminal (fail closed)
 *
 * The authoritative typed signal is the contracts `AgentErrorInfo.retryable`
 * (ERROR_RETRY_DEFAULTS: NETWORK_ERROR / PROCESS_TIMEOUT / MODEL_ERROR are
 * retryable; PERMISSION_DENIED / TOOL_SCHEMA_ERROR / VERIFICATION_FAILED are
 * terminal). Plain untyped errors default to retryable, because the bounded
 * maxRecoveryAttempts budget (never reset on restart) caps total attempts — a
 * wrong guess can never spin forever.
 */
export function classifyRecoveryError(err: unknown): RecoveryErrorClass {
  if (err instanceof AgentError) {
    // Contracts carry the typed retryability — never guess from message text.
    return err.info.retryable ? "retryable" : "terminal";
  }
  return "retryable";
}

/** E3-10 — in-memory RecoveryStore fallback. Used ONLY for tests or an explicit
 *  ephemeral mode; production wiring must use a durable store so a restart
 *  continues the retry budget. E4-08: it still enforces the same compare-and-set
 *  contract (a stale-version write throws) so single-process contention is
 *  exercised identically. */
export class MemoryRecoveryStore implements RecoveryStore {
  private readonly records = new Map<string, RecoveryRecord>();
  async getRecord(taskId: TurnId): Promise<RecoveryRecord | undefined> {
    const found = this.records.get(taskId);
    return found === undefined ? undefined : { ...found, lease: found.lease ? { ...found.lease } : undefined };
  }
  async putRecord(record: RecoveryRecord): Promise<RecoveryRecord> {
    const current = this.records.get(record.taskId);
    if (record.version !== undefined && (current?.version ?? 0) !== record.version) {
      throw new Error(`recovery CAS conflict for ${record.taskId}: expected version ${record.version}, stored ${String(current?.version)}`);
    }
    const next: RecoveryRecord = { ...record, version: (current?.version ?? 0) + 1, lease: record.lease ? { ...record.lease } : undefined };
    this.records.set(record.taskId, next);
    return { ...next, lease: next.lease ? { ...next.lease } : undefined };
  }
  async deleteRecord(taskId: TurnId): Promise<void> {
    this.records.delete(taskId);
  }
}

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
   * next followup WITHOUT consuming the durable record; bindReservedFollowup
   * durably establishes P→T; completeReservedFollowup acks only at terminal;
   * releaseReservedFollowup requeues it when promotion failed so the input is
   * never lost.
   *
   * P38.3-1 (INV-P38.3-001/002): split the durable bind from final consume.
   * bindReservedFollowup durably establishes P→T (promoted, promotedTurnId).
   * completeReservedFollowup transitions the already-bound prompt to consumed.
   * releaseReservedFollowup requeues a reservation that was never bound.
   * BIND != CONSUME — the two durable steps MUST remain separate.
   */
  reservePendingFollowup(): Promise<{ id: string; input: UserMessage } | undefined>;
  /** P38.3-1: durably bind the reserved prompt to the created turn identity.
   *  Called BEFORE promoteToRunning / runtime.runTurn. */
  bindReservedFollowup(reservationId: string, turnId: TurnId): Promise<void>;
  /** P38.3-1: mark the (already bound) prompt consumed. Only after the turn
   *  is terminal. The reserved slot is released after this call. */
  completeReservedFollowup(reservationId: string): Promise<void>;
  /** P38.3-1: requeue a reservation that was never bound/consumed. The prompt
   *  remains pending in the durable inbox and is recoverable. */
  releaseReservedFollowup(reservationId: string): Promise<void>;
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

/** P38.3-8: result of a cancelTurn request. The disposition signals whether
 *  the request was accepted; terminal cancellation truth is always observed
 *  through TurnOutcome / persisted Turn / terminal events — never through the
 *  request-level response alone.
 *  Documented: cancel request accepted != durable terminal cancellation confirmed. */
export interface CancelTurnResult {
  disposition: "cancel_requested" | "not_running";
  turnId: TurnId;
}

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
  /** Abort the active turn only when it matches `turnId`.
   *
   *  P38.3-8 semantic: this is a REQUEST acceptance API. The returned
   *  disposition says the request was accepted (or not applicable) — it does
   *  NOT claim durable terminal cancellation. Terminal truth (cancelled vs
   *  failed/cancellation_persistence_uncertain) is observed through the
   *  TurnOutcome / persisted Turn / terminal events. */
  cancelTurn(turnId: TurnId): Promise<CancelTurnResult>;
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
  /** P38.1-12/13 (INV-P38.1-004/005): when a starting existing-turn's
   *  reservation is revoked by cancel before promotion, the actor terminalizes
   *  the loaded turn itself (cancelled) WITHOUT invoking runtime.runTurn. It
   *  emits the terminal event through this seam so the stream stay complete. */
  emit?: EventSink;
  /**
   * E3-10 — durable recovery-record store. When omitted, the actor uses an
   * in-memory fallback: single-process single-flight still holds, but a
   * process restart cannot continue the retry budget from attempt/nextAttemptAt.
   * Production wiring should provide a durable store so a crash never resets
   * the budget (plan E3-10 item 5).
   */
  recoveryStore?: RecoveryStore;
  /**
   * E3-10 — injectable scheduler for the next same-T retry after backoff.
   * When omitted AND `now` is not provided (real clock), the actor schedules
   * the retry with setTimeout; when `now` is provided (manual clock / tests),
   * retries are driven by the caller (advance the clock + re-drain). The old
   * `void this.drainFollowups()` recursive hot loop is forbidden — this
   * scheduler is the ONLY re-entry path for a retryable failure.
   */
  scheduler?: RecoveryScheduler;
  /**
   * E3-10 — recovery policy overrides (maxRecoveryAttempts / backoffBaseMs /
   * exhaustedPolicy). Defaults to the state machine's defaults (3 / 1000 /
   * block-queue). Injected so tests can drive a short backoff and both
   * exhaustion policies deterministically.
   */
  recoveryPolicy?: {
    maxRecoveryAttempts?: number;
    backoffBaseMs?: number;
    exhaustedPolicy?: "block-queue" | "proceed-queue";
  };
}

/** P38.1-2 (INV-P38.1-002): a queue-mode followup caller's deferred. Must
 *  settle exactly once — the `settled` flag guards resolve/reject races
 *  between promotion success, promotion failure and actor close. */
export interface FollowupDeferred {
  settled: boolean;
  resolve: (value: TurnOutcome) => void;
  reject: (reason: unknown) => void;
}

export interface LoadedSessionManagerDeps {
  runtime: Pick<AgentRuntime, "startTurn" | "runTurn">;
  store: SessionStore;
  inbox?: InboxStore;
  now?: () => number;
  /** P38.1-12/13: forwarded to each loaded actor so a pre-promotion cancel can
   *  emit turn.cancelled while keeping runtime.runTurn uninvolved. */
  emit?: EventSink;
  /** E3-10 — forwarded to each loaded actor (see SessionActorDeps). */
  recoveryStore?: RecoveryStore;
  /** E3-10 — forwarded to each loaded actor (see SessionActorDeps). */
  scheduler?: RecoveryScheduler;
  /** E3-10 — forwarded to each loaded actor (see SessionActorDeps). */
  recoveryPolicy?: SessionActorDeps["recoveryPolicy"];
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
  private hydration: Promise<void> | undefined;
  private followupIdCounter = 0;
  /** P38-2: the followup reserved for promotion but NOT yet consumed. */
  private reserved: { id: string; input: UserMessage; promptId?: PromptId } | undefined;

  constructor(private readonly deps: { sessionId: SessionId; inbox?: InboxStore; store?: SessionStore; now?: () => number }) {}

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
    await this.ensureHydrated();
    const next = this.followups.shift();
    if (next === undefined) return undefined;
    this.reserved = next;
    return { id: next.id, input: next.input };
  }

  /** P38.3-1 (INV-P38.3-001/002): durably bind the reserved prompt to the
   *  created turn identity. This MUST happen before the turn starts executing
   *  (P38.3-2). It does NOT consume the prompt. */
  async bindReservedFollowup(id: string, turnId: TurnId): Promise<void> {
    if (this.reserved === undefined || this.reserved.id !== id) return;
    if (this.reserved.promptId !== undefined && this.deps.inbox !== undefined) {
      await this.deps.inbox.bindPromotion(this.reserved.promptId, turnId);
    }
  }

  /** P38.3-1: mark the (already bound) reserved prompt consumed. Only called
   *  once the turn is terminal — the prompt's promotedTurnId is retained. The
   *  reservation slot is cleared after the durable consume succeeds. */
  async completeReservedFollowup(id: string): Promise<void> {
    if (this.reserved === undefined || this.reserved.id !== id) return;
    if (this.reserved.promptId !== undefined && this.deps.inbox !== undefined) {
      await this.deps.inbox.markConsumed(this.reserved.promptId);
    }
    this.reserved = undefined;
  }

  /** P38.3-1: promotion could not bind — requeue the reserved input at the
   *  head so it is recoverable (never lost, never double-consumed). */
  async releaseReservedFollowup(id: string): Promise<void> {
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

  /** P38.1-1 (INV-P38.1-001): all durable prompt identities the queue already
   *  knows about — local followups plus the single in-flight reservation.
   *  Hydration skips these so `enqueue before first hydrate` can never create
   *  a duplicate local entry for the same durable prompt. */
  private collectKnownPromptIds(): Set<PromptId> {
    const ids = new Set<PromptId>();
    for (const f of this.followups) {
      if (f.promptId !== undefined) ids.add(f.promptId);
    }
    if (this.reserved?.promptId !== undefined) {
      ids.add(this.reserved.promptId);
    }
    return ids;
  }

  /** P38.2-3 (INV-P38.2-003): single-flight hydration — failed hydration is
   *  retryable (never permanently latched). */
  private async ensureHydrated(): Promise<void> {
    if (this.hydrated) return;
    if (this.hydration !== undefined) {
      await this.hydration;
      return;
    }
    const p = this.hydrate();
    this.hydration = p;
    try {
      await p;
      this.hydrated = true;
    } finally {
      if (this.hydration === p) {
        this.hydration = undefined;
      }
    }
  }

  /**
   * P38.4-1 (INV-P38.4-001/003/004) — same-T recovery contract.
   *
   * For every durable followup prompt P observed by listRecoverable:
   *
   * | Prompt state | Bound turn | Required action |
   * |---|---|---|
   * | pending | none | enqueue for normal followup reservation |
   * | promoted | missing TurnId | fail closed (PROMOTION_IDENTITY_MISSING), no T2 |
   * | promoted | turn not found | fail closed (BOUND_TURN_MISSING), no T2 |
   * | promoted | T completed   | consume P |
   * | promoted | T failed      | consume P |
   * | promoted | T cancelled   | consume P |
   * | promoted | T pending/created | recover SAME T under existing runtime |
   * | promoted | T running (no live owner) | recover SAME T under restart semantics |
   * | consumed | any | never replay |
   *
   * "Recover SAME T" means: use the existing durable Turn identity T.
   * NEVER call startTurn() — that creates a new identity and violates
   * INV-P38.4-001 (one prompt, one turn lineage).
   *
   * Preferred recovery mechanism: call runtime.runTurn(T, ...) against the
   * already-created durable Turn, which is restart-safe for a nonterminal
   * Turn. This produces a TurnHandle whose outcome drives terminal
   * reconciliation (P38.4-2).
   *
   * If recovery execution is cancelled/closed before terminal, do NOT create
   * T2 — either terminalize T or leave it durably recoverable for the next
   * runtime owner.
   */
  private async hydrate(): Promise<void> {
    const inbox = this.deps.inbox;
    const store = this.deps.store;
    if (inbox === undefined) return;
    // P38.3-3 (INV-P38.3-003): use the RECOVERY query (pending + promoted),
    // NOT listPending (pending only) — otherwise the promoted-reconciliation
    // branch below would be structurally unreachable in production.
    const recoverable = await inbox.listRecoverable(this.sessionId);
    const known = this.collectKnownPromptIds();
    for (const p of recoverable) {
      if (p.kind !== "followup") continue;
      // P38.2-2 (INV-P38.2-002) + P38.3-3 (INV-P38.3-002): promoted prompts are
      // reconciled against their bound turn — never replayed, never T2.
      if (p.status === "promoted") {
        if (p.promotedTurnId === undefined) {
          // P38.3-3: malformed durable state — promoted without turn identity.
          // Fail closed: do NOT requeue as a fresh prompt (that would risk T2).
          // Surface the diagnostic so recovery is on record.
          process.stderr.write(
            `[degraded] inbox.promotion-identity-missing: session ${this.sessionId} prompt ${p.id} is promoted but has no promotedTurnId — recovery-required, not replayed\n`,
          );
          continue;
        }
        if (store !== undefined) {
          const turn = await store.getTurn(p.promotedTurnId);
          if (turn === undefined) {
            process.stderr.write(
              `[degraded] inbox.bound-turn-missing: session ${this.sessionId} prompt ${p.id} bound to unknown turn ${p.promotedTurnId} — recovery-required, not replayed\n`,
            );
            continue;
          }
          if (turn.status === "completed" || turn.status === "failed" || turn.status === "cancelled") {
            // Turn is terminal — mark the prompt consumed.
            try {
              await inbox.markConsumed(p.id);
            } catch (consumeErr) {
              process.stderr.write(
                `[degraded] session ${this.sessionId} failed to consume promoted prompt ${p.id} after terminal bound turn: ${consumeErr instanceof Error ? consumeErr.message : String(consumeErr)}\n`,
              );
            }
          }
          // Nonterminal bound turn: recovery owns lineage T. Never enqueue P as
          // a fresh followup (INV-P38.3-002) — no T2. The actual same-T resume
          // is performed by DefaultSessionActor.discoverRecoverableTurns +
          // drainFollowups (P38.4-2/3), which record T and run it under the
          // SAME Turn identity on this process's next idle slot.
        }
        continue;
      }
      if (p.status !== "pending") continue;
      // P38.1-1: dedup by prompt identity — the same durable prompt may exist
      // in the inbox AND the local queue (enqueued before first hydration).
      // Skip it here; identical TEXT with a different promptId is kept.
      if (known.has(p.id)) continue;
      this.followupIdCounter += 1;
      this.followups.push({
        id: `fup-${this.followupIdCounter}`,
        input: { sessionId: this.sessionId, text: p.text },
        promptId: p.id,
      });
      known.add(p.id);
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
      source: "new_turn" | "existing_turn" | "followup" | "create_only";
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

/** E3-10 — lease TTL for single-flight recovery (60 seconds). If the
 *  recovering process crashes, another owner may acquire the lease after
 *  this duration. */
const RECOVERY_LEASE_TTL_MS = 60_000;
/** E4-R17 (N13): bounded re-check window for a pending-commit (reconcile) task. */
const RECOVERY_RECONCILE_RETRY_MS = 5_000;
/** E4-R30 (G04): bounded lower-bound re-check after a TRANSIENT recovery-store
 *  failure — a refused lease/intent write, or a CAS conflict with another
 *  owner. Fail-closed is preserved (the recovery ACTION never runs), but the
 *  actor must self-heal once the store recovers WITHOUT waiting for a new user
 *  message or an explicit drain. The delay escalates (base × 2ⁿ, capped) so a
 *  long outage backs off instead of hot-looping; the counter resets as soon as
 *  a durable write succeeds. */
const RECOVERY_STORE_RECHECK_BASE_MS = 1_000;
const RECOVERY_STORE_RECHECK_MAX_MS = 30_000;

/** P25-2/3 + P37-1: the single owner of one live session — unified state. */
export class DefaultSessionActor implements SessionActor {
  private state: ActorExecutionState = { kind: "idle" };
  private closed = false;
  readonly inputQueue: SessionInputQueue;
  readonly resourceScope: SessionResourceScope;
  readonly cancellation: AbortController;
  /** P37-1: followup resolvers keyed by stable followup id. P38.1-2: upgraded
   *  to full deferreds (resolve + reject) so a caller can NEVER hang forever —
   *  promotion failure / cancellation / actor close all settle terminally. */
  private readonly followupDeferred = new Map<string, FollowupDeferred>();
  /** P38.4-2 (INV-P38.4-003/004): recoverable nonterminal bound turns discovered
   *  during hydration. Each entry is a durable Turn that was promoted to a
   *  prompt P but never reached terminal state before the previous process died.
   *  drainFollowups recovers them by calling `runTurn(t.id)` — same T, no T2,
   *  no startTurn. The promptId is tracked so that after recovery the prompt
   *  can be durably consumed (INV-P38.4-004: recovery must converge the
   *  lineage, not leave dangling promoted records).
   *
   *  E3-10: this array uses a peek/leased-head pattern. The head is NEVER
   *  shift()ed before the recovery record's terminal transition is durable.
   *  Only RECOVERED (happy-path) and EXHAUSTED/proceed-queue (policy) remove
   *  the head; EXHAUSTED/block-queue and TERMINAL_FAILED freeze the queue at
   *  the dead-lettered head. */
  private readonly _recoverableTurns: Array<{ turn: Turn; promptId: PromptId }> = [];
  /** Guard: recoverable turns are queried at most once per actor lifetime. */
  private _recoverableChecked = false;

  /** E3-10 — single-flight guard: while a drain pass is in progress, re-entrant
   *  calls (from settle, which fires when the runtime turn completes) return
   *  immediately. This prevents the outer recovery loop from racing with the
   *  settle-triggered drain when `await this.runTurn(...)` is in a `while`
   *  loop inside the same drain. */
  private _draining = false;

  /** E3-10 — the recovery record store. Defaults to an in-memory fallback when
   *  `deps.recoveryStore` is not provided. */
  private readonly _recoveryStore: RecoveryStore;

  /** E3-10 — per-instance owner identity for lease acquisition. Stable across
   *  the actor lifetime; used for single-flight so two live actors cannot
   *  concurrently recover the same T. */
  private readonly _ownerId: string;

  /** E3-10 — pending retry timer handle. Cancelled on close. */
  private _retryTimer: { cancel(): void } | undefined;

  /** E4-R30 (G04) — consecutive transient-store-failure re-checks, used to
   *  escalate the bounded re-check delay. Reset to 0 as soon as a durable
   *  recovery write succeeds (the store is healthy again). */
  private _storeRecheckCount = 0;

  constructor(private readonly deps: SessionActorDeps) {
    this.inputQueue = new InboxSessionInputQueue({
      sessionId: deps.persistent.id,
      inbox: deps.inbox,
      store: deps.store,
      now: deps.now,
    });
    this.resourceScope = new DefaultSessionResourceScope(deps.persistent.id);
    this.cancellation = new AbortController();
    this._recoveryStore = deps.recoveryStore ?? new MemoryRecoveryStore();
    this._ownerId = `recovery-owner-${deps.persistent.id}-${nextRequestId()}`;
  }

  get sessionId(): SessionId {
    return this.deps.persistent.id;
  }

  /** E2-10: injectable recovery clock (deps.now or Date.now). */
  private recoveryClock(): { now: () => number } {
    return this.deps.now !== undefined ? { now: this.deps.now } : { now: Date.now };
  }

  /** E3-10: effective recovery policy (deps overrides or state-machine defaults). */
  private recoveryPolicy(): ReturnType<typeof recoveryPolicy> {
    return recoveryPolicy(this.deps.recoveryPolicy);
  }

  /** E3-10: load the durable recovery record for `taskId`, or create + persist
   *  a fresh PENDING record (attempt 0, nextAttemptAt = now) on first sight.
   *  A restart never re-creates from scratch if the record already exists —
   *  the attempt/nextAttemptAt budget survives the process. */
  private async loadOrCreateRecoveryRecord(taskId: TurnId, promptId: PromptId): Promise<RecoveryRecord> {
    const existing = await this._recoveryStore.getRecord(taskId);
    if (existing !== undefined) return existing;
    const base = createRecoveryTask(taskId, promptId, this.recoveryPolicy(), this.recoveryClock());
    const fresh: RecoveryRecord = { ...base, promptId };
    return this.persistRecoveryRecord(fresh);
  }

  /** E3-10: persist a recovery record, returning the STORED record (with the
   *  version the durable layer assigned). A write failure is surfaced on the
   *  degraded channel (never silent) and the input record is returned so a
   *  best-effort terminal write cannot undo an action that already happened. */
  private async persistRecoveryRecord(record: RecoveryRecord): Promise<RecoveryRecord> {
    try {
      return await this._recoveryStore.putRecord(record);
    } catch (persistErr) {
      process.stderr.write(
        `[degraded] session ${this.sessionId} failed to persist recovery record for ${record.taskId}: ${persistErr instanceof Error ? persistErr.message : String(persistErr)}\n`,
      );
    }
    return record;
  }

  /** E4-08 #3/#4: a STRICT persist used for the intent/lease writes that MUST
   *  be durable BEFORE any recoverable external action runs. A store failure or
   *  a CAS conflict THROWS so the caller aborts the attempt instead of running
   *  an action it cannot account for (no unrecoverable external side effect). */
  private async persistRecoveryIntent(record: RecoveryRecord): Promise<RecoveryRecord> {
    return this._recoveryStore.putRecord(record);
  }

  /** E3-10: is this record leased to a DIFFERENT live owner? Stale leases
   *  (expired) are free. */
  private leaseHeldByOther(record: RecoveryRecord): boolean {
    if (record.lease === undefined) return false;
    if (record.lease.expiresAt <= this.recoveryClock().now()) return false;
    return record.lease.owner !== this._ownerId;
  }

  /** E3-10: acquire the single-flight lease (owner + expiry) and persist it.
   *  E4-08: the write is STRICT — a concurrent owner that won the CAS makes this
   *  throw, so exactly one actor proceeds to run the recovery action. */
  private async acquireLease(record: RecoveryRecord): Promise<RecoveryRecord> {
    const leased: RecoveryRecord = {
      ...record,
      lease: { owner: this._ownerId, expiresAt: this.recoveryClock().now() + RECOVERY_LEASE_TTL_MS },
    };
    return this.persistRecoveryIntent(leased);
  }

  /** E3-10: release OUR lease (never another owner's).
   *  E4-R32 (H01): this is a BEST-EFFORT cleanup on the recovery re-entry
   *  paths. A transient store READ failure here used to escape the failure
   *  handler, aborting the caller's bounded re-check scheduling and surfacing as
   *  an unhandled drain rejection (T1 parked, action=0, timer=0). The error is
   *  now surfaced on the degraded channel and the caller KEEPS its finite
   *  wake-up path. A lease owned by a different live owner is never touched. */
  private async releaseLease(taskId: TurnId): Promise<void> {
    try {
      const record = await this._recoveryStore.getRecord(taskId);
      if (record === undefined || record.lease === undefined) return;
      if (record.lease.owner !== this._ownerId) return;
      await this.persistRecoveryRecord({ ...record, lease: undefined });
    } catch (releaseErr) {
      process.stderr.write(
        `[degraded] session ${this.sessionId} release lease read failed for ${taskId}: ${releaseErr instanceof Error ? releaseErr.message : String(releaseErr)}\n`,
      );
    }
  }

  /** E3-10: default retry scheduler. With a manual clock (`deps.now` injected,
   *  tests) retries are caller-driven — no real timers — so tests advance the
   *  clock and re-drain deterministically. With the real clock, a setTimeout
   *  fires the next drain after `nextAttemptAt` (exponential backoff). */
  private defaultRecoveryScheduler(): RecoveryScheduler {
    if (this.deps.now !== undefined) {
      return { schedule: () => ({ cancel: () => {} }) };
    }
    return {
      schedule: (delayMs, cb) => {
        const t = setTimeout(cb, Math.max(0, delayMs));
        return { cancel: () => clearTimeout(t) };
      },
    };
  }

  /** E3-10: schedule the next same-T retry after the backoff window. The ONLY
   *  re-entry path for a retryable failure — never `void this.drainFollowups()`
   *  from inside a failure handler (no recursive hot loops). */
  private scheduleRecoveryRetry(record: RecoveryRecord): void {
    const delay = record.nextAttemptAt - this.recoveryClock().now();
    if (delay <= 0) return; // already due — next drain picks it up
    this._retryTimer?.cancel();
    const scheduler = this.deps.scheduler ?? this.defaultRecoveryScheduler();
    this._retryTimer = scheduler.schedule(delay, () => {
      this._retryTimer = undefined;
      void this.drainFollowups();
    });
  }

  /** E4-R17 (N13): schedule a BOUNDED re-check of a pending-commit task — the
   *  terminal write is re-attempted (never the action) so a transient store
   *  failure self-heals without user input. */
  private scheduleReconcileRetry(record: RecoveryRecord): void {
    const delay = Math.max(RECOVERY_RECONCILE_RETRY_MS, 1);
    this._retryTimer?.cancel();
    const scheduler = this.deps.scheduler ?? this.defaultRecoveryScheduler();
    this._retryTimer = scheduler.schedule(delay, () => {
      this._retryTimer = undefined;
      void this.drainFollowups();
    });
  }

  /** E4-R17 (N14): when the head is leased to another LIVE owner, arrange a
   *  finite wake at the lease's expiry so this actor re-checks WITHOUT user
   *  input (never waits forever). */
  private scheduleLeaseWake(record: RecoveryRecord): void {
    const lease = record.lease;
    if (lease === undefined) return;
    const delay = lease.expiresAt - this.recoveryClock().now();
    if (delay <= 0) return; // already expired — next drain picks it up
    this._retryTimer?.cancel();
    const scheduler = this.deps.scheduler ?? this.defaultRecoveryScheduler();
    this._retryTimer = scheduler.schedule(delay, () => {
      this._retryTimer = undefined;
      void this.drainFollowups();
    });
  }

  /** E4-R30 (G04): a TRANSIENT recovery-store failure (a refused lease/intent
   *  write, or a lost CAS race with another owner) is fail-closed — the
   *  recovery ACTION never runs — but it must NOT park the actor forever: with
   *  no scheduler callback the actor would only resume on a new user message or
   *  an explicit drain. Schedule ONE bounded re-check (at most one live retry
   *  timer per actor) with an escalating delay. The callback re-enters through
   *  `drainFollowups` → `loadOrCreateRecoveryRecord`, so it re-reads DURABLE
   *  state and never acts on a stale record; it performs no `begin` transition,
   *  so a store outage consumes NO model-action attempt budget. Fail-closed is
   *  preserved: the lease/intent write is still required before any action. */
  private scheduleStoreRecheck(): void {
    const delay = Math.min(
      RECOVERY_STORE_RECHECK_BASE_MS * 2 ** this._storeRecheckCount,
      RECOVERY_STORE_RECHECK_MAX_MS,
    );
    this._storeRecheckCount += 1;
    this._retryTimer?.cancel(); // at most one live retry timer per actor
    const scheduler = this.deps.scheduler ?? this.defaultRecoveryScheduler();
    this._retryTimer = scheduler.schedule(Math.max(delay, 1), () => {
      this._retryTimer = undefined;
      if (this.closed) return; // an old callback never revives a closed actor
      // E4-R32 (H01): a BACKGROUND re-check must never surface as an unhandled
      // rejection. The re-check is NOT re-entered synchronously (no recursive
      // drain): the error is recorded and the finite wake-up path is preserved.
      void this.drainFollowups().catch((drainErr) => {
        process.stderr.write(
          `[degraded] session ${this.sessionId} recovery re-check drain failed: ${drainErr instanceof Error ? drainErr.message : String(drainErr)}\n`,
        );
        if (!this.closed) this.scheduleStoreRecheck();
      });
    });
  }

  /** E4-R25 (V01): TRUE when the durable TURN (main store) is terminal — the
   *  recovery handler's runTurn already finished WITHOUT throwing, so only the
   *  terminal write/consume remains and the action must NEVER re-run. This is
   *  the authoritative pending-commit evidence even when the needsReconcile
   *  marker could not be persisted (compound write outage).
   *
   *  E4-R30 (G04): returns the tri-state `boolean | "unknown"`. A store READ
   *  error yields "unknown" (not `false`): an unreadable durable state is not a
   *  confirmed-nonterminal turn, and treating it as one would re-run a possibly
   *  completed recovery action. */
  private async durableTurnIsTerminal(turnId: TurnId): Promise<boolean | "unknown"> {
    // E4-R30 (G04): a READ FAILURE is NOT evidence that the turn is
    // nonterminal. Returning `false` here would authorise a retry of an action
    // that may already have completed — a dangerous duplicate side effect. The
    // tri-state makes "cannot determine" explicit so the caller waits for
    // reconciliation instead of blindly re-running. (`store` is a required dep;
    // a missing store is likewise "cannot determine".)
    if (this.deps.store === undefined) return "unknown";
    try {
      const turn = await this.deps.store.getTurn(turnId);
      if (turn === undefined) return false; // no durable turn → definitely not terminal
      return turn.status === "completed" || turn.status === "failed" || turn.status === "cancelled";
    } catch {
      return "unknown";
    }
  }

  /**
   * E3-10 — recover ONE head turn under the same-T bounded retry state
   * machine. Returns the signal for the drain loop:
   *   "shifted"      — head reached a durable terminal transition and was
   *                    dequeued (RECOVERED, or EXHAUSTED + proceed-queue).
   *   "wait-backoff" — RETRY_SCHEDULED and backoff not elapsed (or a
   *                    retryable failure just scheduled the retry); T2 stays
   *                    blocked, no hot loop.
   *   "wait-lease"   — another live owner holds the single-flight lease.
   *   "block"        — EXHAUSTED (block-queue) or TERMINAL_FAILED: dead-letter;
   *                    the queue freezes at the head (T2 never overtakes).
   *
   * The head is NEVER removed from `_recoverableTurns` before a terminal
   * transition is persisted (plan E3-10 item 2).
   */
  private async recoverHead(): Promise<"shifted" | "wait-backoff" | "wait-lease" | "block"> {
    const head = this._recoverableTurns[0]!;
    const policy = this.recoveryPolicy();
    const clock = this.recoveryClock();
    // E4-R32 (H01): the recovery-store READ on the re-check entry can fail while
    // the store is degraded. The durable state is then UNKNOWN, so NO action may
    // run — but the read error must not escape as an unhandled drain rejection
    // and park the actor with no timer. Fail closed and keep a finite wake-up
    // path (the same self-healing schedule as a refused write).
    let record: RecoveryRecord;
    try {
      record = await this.loadOrCreateRecoveryRecord(head.turn.id, head.promptId);
    } catch (loadErr) {
      process.stderr.write(
        `[degraded] session ${this.sessionId} recovery record load failed for ${head.turn.id}: ${loadErr instanceof Error ? loadErr.message : String(loadErr)}\n`,
      );
      this.scheduleStoreRecheck();
      return "wait-backoff";
    }

    // A prior attempt crashed mid-flight: the durable record is stuck in
    // RECOVERY_IN_PROGRESS with a stale/absent lease. Record the interruption
    // as a RETRYABLE failure at the CURRENT attempt (begin already counted it —
    // no extra increment), then fall through to the normal budget/backoff
    // logic. This is what lets a restarted actor continue from attempt/
    // nextAttemptAt instead of resetting the budget (plan E3-10 item 5).
    if (record.state === "RECOVERY_IN_PROGRESS") {
      // E4-R17/N13 + E4-R25 (V01): pending-commit — the recovery ACTION
      // completed once but its durable TERMINAL transition could not be
      // persisted (or, in the compound outage, the durable needsReconcile
      // marker itself never landed). The durable TURN being terminal IS the
      // authoritative evidence of a finished action: NEVER re-run the action;
      // only re-attempt the terminal write (reconcile). On success the prompt
      // is consumed and the queue advances; on failure the queue stays frozen
      // at the head (T2 never overtakes an uncommitted T1).
      const needsReconcile = recoveryNeedsReconcile(record);
      const terminal: boolean | "unknown" = needsReconcile
        ? true
        : await this.durableTurnIsTerminal(head.turn.id);
      if (terminal === "unknown") {
        // E4-R30 (G04): the durable turn could not be READ — we cannot tell
        // whether the prior action finished. Re-running could duplicate an
        // external side effect, so park (no action, no attempt consumed) and
        // re-check on a bounded timer until the store recovers.
        this.scheduleStoreRecheck();
        return "wait-backoff";
      }
      if (terminal) {
        try {
          await this._recoveryStore.putRecord({
            ...record,
            state: "RECOVERED",
            needsReconcile: undefined,
            lease: undefined,
            lastError: null,
          });
          void this.consumeRecoveredPrompt(head.turn.id, head.promptId, {} as TurnOutcome);
          this._recoverableTurns.shift();
          return "shifted";
        } catch (reconcileErr) {
          // Terminal write still failing — stay frozen, re-check after a bounded
          // window (the action is NOT re-run).
          this.scheduleReconcileRetry(record);
          return "wait-backoff";
        }
      }
      if (this.leaseHeldByOther(record)) {
        this.scheduleLeaseWake(record);
        return "wait-lease";
      }
      try {
        record = { ...transitionRecoveryTask(
          record,
          {
            type: "handler_failed",
            error: "recovery interrupted: process restart / lease expired while recovery in progress",
            retryable: true,
          },
          policy,
          clock,
        ), promptId: record.promptId, lease: undefined };
        record = await this.persistRecoveryRecord(record);
      } catch (interruptedErr) {
        process.stderr.write(
          `[degraded] session ${this.sessionId} recovery interrupted-transition error for ${head.turn.id}: ${interruptedErr instanceof Error ? interruptedErr.message : String(interruptedErr)}\n`,
        );
        return "wait-lease";
      }
    }

    // Durable terminal states.
    if (record.state === "RECOVERED") {
      this._recoverableTurns.shift();
      return "shifted";
    }
    if (record.state === "EXHAUSTED" || record.state === "TERMINAL_FAILED") {
      if (record.state === "EXHAUSTED" && policy.exhaustedPolicy === "proceed-queue") {
        this._recoverableTurns.shift(); // dead-letter, T2 may proceed
        return "shifted";
      }
      // EXHAUSTED (block-queue) or TERMINAL_FAILED → freeze the queue.
      return "block";
    }

    // Backoff not yet elapsed → wait. T2 does NOT run, and nothing re-drains
    // until the injected scheduler / caller re-enters (no hot loop).
    if (record.state === "RETRY_SCHEDULED" && !retryDue(record, clock)) {
      this.scheduleRecoveryRetry(record);
      return "wait-backoff";
    }

    // Single-flight: a different live owner is actively recovering this T.
    if (this.leaseHeldByOther(record)) {
      // E4-R17 (N14): finite wake at lease expiry — never wait forever.
      this.scheduleLeaseWake(record);
      return "wait-lease";
    }

    // Acquire the lease and begin the attempt. E4-08 #3/#4: BOTH the lease
    // acquisition and the attempt-intent write are durable BEFORE runTurn. If
    // either throws (a concurrent owner won the CAS, or the store is down) we
    // MUST NOT run the recovery action — otherwise an external side effect could
    // happen with no durable record of who owns it. Fail closed to wait-lease.
    try {
      record = await this.acquireLease(record);
    } catch (leaseErr) {
      process.stderr.write(
        `[degraded] session ${this.sessionId} recovery lease failed for ${head.turn.id}: ${leaseErr instanceof Error ? leaseErr.message : String(leaseErr)}\n`,
      );
      // E4-R30 (G04): fail-closed (no action) but self-healing — a transient
      // store outage or a lost CAS race must not park the actor forever.
      this.scheduleStoreRecheck();
      return "wait-lease";
    }
    let attempt: RecoveryRecord;
    try {
      const attemptBase = transitionRecoveryTask(record, { type: "begin" }, policy, clock);
      attempt = { ...attemptBase, promptId: record.promptId };
    } catch (beginErr) {
      process.stderr.write(
        `[degraded] session ${this.sessionId} recovery begin failed for ${head.turn.id}: ${beginErr instanceof Error ? beginErr.message : String(beginErr)}\n`,
      );
      await this.releaseLease(head.turn.id);
      return "wait-lease";
    }
    try {
      attempt = await this.persistRecoveryIntent(attempt);
      // E4-R32 (H02): the FULL strict write path for this round (lease +
      // attempt-intent) is now durable — the store is healthy again, so restart
      // the re-check backoff. Resetting on the LEASE write alone masked a
      // persistent intent-write outage: every re-check acquired the lease,
      // reset the counter, then failed the intent and re-checked at the 1s floor
      // forever (no escalation). The reset point is "this round's necessary
      // persistence succeeded", not "any single write succeeded".
      this._storeRecheckCount = 0;
    } catch (persistErr) {
      process.stderr.write(
        `[degraded] session ${this.sessionId} recovery attempt-intent persist failed for ${head.turn.id} — NOT running the action: ${persistErr instanceof Error ? persistErr.message : String(persistErr)}\n`,
      );
      await this.releaseLease(head.turn.id);
      // E4-R30 (G04): the intent could not be made durable, so the action is
      // correctly NOT run — schedule a bounded re-check so the actor converges
      // once the store recovers, without a new user message.
      this.scheduleStoreRecheck();
      return "wait-lease";
    }

    // Same-T recovery: `runTurn` reserves the starting slot, loads the existing
    // durable Turn and promotes it — the runtime's single-turn-per-session
    // guard applies. A rejection is a recovery-handler failure and is
    // classified retryable-vs-terminal before being recorded.
    try {
      const outcome = await this.runTurn(head.turn.id);
      const successBase = transitionRecoveryTask(attempt, { type: "handler_succeeded" }, policy, clock);
      const success: RecoveryRecord = { ...successBase, promptId: attempt.promptId };
      // E4-R17 (N13): the TERMINAL write is STRICT — a failure must NOT be
      // swallowed into a fake ACK. If the RECOVERED transition cannot be
      // persisted, the task enters pending-commit (needsReconcile): the queue
      // does NOT advance, the prompt is NOT consumed, and the action is never
      // re-run (only the terminal write is re-attempted later).
      try {
        await this._recoveryStore.putRecord(success);
      } catch (ackErr) {
        const message = ackErr instanceof Error ? ackErr.message : String(ackErr);
        process.stderr.write(
          `[degraded] session ${this.sessionId} terminal recovery ACK failed for ${head.turn.id}: ${message} — entering pending-commit (reconcile), queue frozen\n`,
        );
        await this.persistRecoveryRecord({
          ...attempt,
          needsReconcile: true,
          lease: undefined,
          lastError: `terminal ACK failed: ${message}`,
        });
        this.scheduleReconcileRetry(attempt);
        return "wait-backoff";
      }
      await this.releaseLease(head.turn.id);
      // INV-P38.4-004: converged — durably consume the bound prompt
      // (best-effort; consumeRecoveredPrompt re-checks the store).
      void this.consumeRecoveredPrompt(head.turn.id, head.promptId, outcome);
      this._recoverableTurns.shift(); // RECOVERED transition is durable
      return "shifted";
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const retryable = classifyRecoveryError(err) === "retryable";
      let failed: RecoveryTaskRecord;
      try {
        failed = transitionRecoveryTask(
          attempt,
          { type: "handler_failed", error: message, retryable },
          policy,
          clock,
        );
      } catch (transitionErr) {
        process.stderr.write(
          `[degraded] session ${this.sessionId} recovery failure transition error for ${head.turn.id}: ${transitionErr instanceof Error ? transitionErr.message : String(transitionErr)}\n`,
        );
        await this.releaseLease(head.turn.id);
        return "wait-backoff";
      }
      const failedRecord: RecoveryRecord = { ...failed, promptId: attempt.promptId };
      // E4-R17 (N13): the failure-state write is STRICT before any queue
      // advancement — a swallowed write must not let the queue proceed over an
      // unpersisted terminal state.
      try {
        await this._recoveryStore.putRecord(failedRecord);
      } catch (failPersistErr) {
        const message = failPersistErr instanceof Error ? failPersistErr.message : String(failPersistErr);
        process.stderr.write(
          `[degraded] session ${this.sessionId} recovery failure-state persist failed for ${head.turn.id}: ${message} — queue stays frozen\n`,
        );
        await this.releaseLease(head.turn.id);
        this.scheduleReconcileRetry(attempt);
        return "wait-backoff";
      }
      await this.releaseLease(head.turn.id);
      if (failed.state === "RETRY_SCHEDULED") {
        // Retryable failure — same T is retried after exponential backoff.
        this.scheduleRecoveryRetry(failedRecord);
        return "wait-backoff";
      }
      if (failed.state === "EXHAUSTED" && policy.exhaustedPolicy === "proceed-queue") {
        this._recoverableTurns.shift(); // durable EXHAUSTED write succeeded above
        return "shifted";
      }
      // EXHAUSTED (block-queue) or TERMINAL_FAILED → dead-letter + freeze.
      return "block";
    }
  }

  /** E3-10: drain the recoverable head queue. Stops on the first wait/block
   *  signal — the followup drain must not proceed while T1 is unresolved or
   *  the queue is frozen at a dead-lettered head. */
  private async drainRecoverable(): Promise<void> {
    while (this._recoverableTurns.length > 0) {
      const result = await this.recoverHead();
      if (result === "shifted") continue;
      return; // wait-backoff / wait-lease / block
    }
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
      const outcome = this.createFollowupOutcome(followupId);
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
    // P38-3 (INV-P38-004, Contract A): turn CREATION is session-exclusive.
    // Reserve the actor slot before the await so a concurrent createTurn or
    // startTurn cannot cross the boundary; release after the durable turn
    // record exists (creation never executes the turn).
    const controller = new AbortController();
    const requestId = nextRequestId();
    this.state = { kind: "starting", source: "create_only", controller, requestId };
    try {
      const turn = await this.deps.runtime.startTurn(this.sessionId, input.text);
      if (this.state.kind !== "starting" || this.state.requestId !== requestId || controller.signal.aborted) {
        throw new AgentError(errorInfo("INTERNAL_ERROR", `createTurn ${this.sessionId} cancelled`));
      }
      this.state = { kind: "idle" };
      return turn;
    } catch (err) {
      if (this.state.kind === "starting" && this.state.requestId === requestId) {
        this.state = { kind: "idle" };
      }
      throw err;
    }
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
      if (this.state.kind !== "starting" || this.state.requestId !== requestId || controller.signal.aborted) {
        // INV-P38.1-004/005: the starting reservation was revoked (cancel /
        // interrupt / close) before promotion. It must NEVER reach
        // runtime.runTurn; instead the actor terminalizes the loaded turn
        // itself — persist cancelled, emit the terminal event through the
        // emit seam (the runtime is uninvolved), and resolve the caller with a
        // cancelled outcome so no side (caller / store / event stream) hangs.
        const outcome = await this.terminalizeRevokedTurn(turn);
        if (this.state.kind === "starting" && this.state.requestId === requestId) {
          this.state = { kind: "idle" };
        }
        return outcome;
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

  async cancelTurn(turnId: TurnId): Promise<CancelTurnResult> {
    const s = this.state;
    if (s.kind === "running") {
      if (s.turn.id !== turnId) {
        return { disposition: "not_running", turnId };
      }
      // P38.3-8: abort is requested; the terminal outcome (cancelled vs
      // failed/cancellation_persistence_uncertain) is observed through the
      // run outcome / persisted turn — never claimed by this return value.
      s.controller.abort();
      return { disposition: "cancel_requested", turnId };
    }
    if (s.kind === "starting" && s.turnId === turnId) {
      // P38.1-4 (INV-P38.1-004/005): cancel of a starting existing-turn is
      // abort + reservation REVOCATION. Returning while the actor stays in
      // "starting" would let a late requireTurn promote to running.
      s.controller.abort();
      this.state = this.closed ? { kind: "closing" } : { kind: "idle" };
      // P38.3-8: the durable persistence of the cancellation is NOT yet known
      // (updateTurn may fail → failed/cancellation_persistence_uncertain), so
      // the request result never claims "cancelled" as durable truth.
      return { disposition: "cancel_requested", turnId };
    }
    return { disposition: "not_running", turnId };
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
    // E3-10: cancel any pending retry timer so a closed actor never re-drains.
    this._retryTimer?.cancel();
    this._retryTimer = undefined;
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
    // P38.1-2 (INV-P38.1-002): terminally settle any queued followup callers
    // still waiting for promotion — they must never hang forever on close.
    for (const id of [...this.followupDeferred.keys()]) {
      this.settleFollowup(id, {
        kind: "err",
        err: new AgentError(
          errorInfo("ACTOR_CLOSED", `session ${this.sessionId} closed before followup promotion`),
        ),
      });
    }
    this.resourceScope.release();
    this.deps.onClosed?.(this.sessionId);
  }

  /** P38.1-2 (INV-P38.1-002): a queue-mode startTurn caller's promise, tracked
   *  by stable followup id so the drain loop can resolve/reject it. The wrapped
   *  resolve/reject settle exactly once — the `settled` flag guards races
   *  between promotion success, promotion failure and actor close. */
  private createFollowupOutcome(followupId: string): Promise<TurnOutcome> {
    const deferred: FollowupDeferred = { settled: false, resolve: undefined!, reject: undefined! };
    const outcome = new Promise<TurnOutcome>((resolve, reject) => {
      deferred.resolve = (value) => {
        if (deferred.settled) return;
        deferred.settled = true;
        resolve(value);
      };
      deferred.reject = (reason) => {
        if (deferred.settled) return;
        deferred.settled = true;
        reject(reason);
      };
    });
    this.followupDeferred.set(followupId, deferred);
    return outcome;
  }

  /** P38.1-2 (INV-P38.1-002): terminally settle a queued followup caller once.
   *  Deletes from the map on first settle so a later duplicate (e.g. actor
   *  close racing promotion) is a no-op. The exactly-once guard is the map
   *  delete (synchronous) plus the settled flag honored by the createOnce
   *  resolve/reject wrappers in createFollowupOutcome. */
  private settleFollowup(
    id: string,
    result: { kind: "ok"; outcome: TurnOutcome } | { kind: "err"; err: unknown },
  ): void {
    const deferred = this.followupDeferred.get(id);
    if (deferred === undefined) return;
    this.followupDeferred.delete(id);
    if (deferred.settled) return;
    // NOTE: do NOT set deferred.settled=true here — the createFollowupOutcome
    // resolve/reject wrapper does so AND performs the actual resolve/reject.
    // Pre-setting it would make the wrapper's `if (deferred.settled) return`
    // swallow the settlement and permanently hang the caller.
    if (result.kind === "ok") {
      deferred.resolve(result.outcome);
    } else {
      deferred.reject(result.err);
    }
  }

  /** INV-P38.1-004/005: a starting reservation revoked before promotion (cancel
   *  / interrupt / close) must never reach runtime.runTurn. Because the runtime
   *  is uninvolved, the actor itself makes the terminalization complete:
   *   • persist the durable turn as `cancelled` (the store is the source the
   *     caller / observers read),
   *   • emit `turn.cancelled` through the optional emit seam so the event
   *     stream stays complete (P38.1-12/13),
   *   • return a cancelled TurnOutcome so the caller never hangs.
   *
   *  INV-P38.2-009: if the durable updateTurn(cancelled) FAILS, the caller must
   *  not receive a clean `cancelled` outcome — the store may still hold old
   *  nonterminal state. We return a typed `failed` outcome whose statusDetail is
   *  `cancellation_persistence_uncertain`, and the emit payload carries the
   *  same uncertainty so no observer claims a clean cancellation. */
  private async terminalizeRevokedTurn(turn: Turn): Promise<TurnOutcome> {
    const cancelledTurn: Turn = { ...turn, status: "cancelled" };
    let persistFailed = false;
    try {
      await this.deps.store.updateTurn(cancelledTurn);
    } catch (persistErr) {
      persistFailed = true;
      process.stderr.write(
        `[degraded] session ${this.sessionId} failed to persist turn ${turn.id} as cancelled: ${persistErr instanceof Error ? persistErr.message : String(persistErr)}\n`,
      );
    }
    const statusDetail: TurnOutcomeDetail = persistFailed
      ? "cancellation_persistence_uncertain"
      : "cancelled_no_effect";
    if (this.deps.emit !== undefined) {
      try {
        await this.deps.emit.emit(
          this.sessionId,
          "turn.cancelled",
          { status: persistFailed ? "failed" : "cancelled", statusDetail },
          turn.id,
        );
      } catch (emitErr) {
        process.stderr.write(
          `[degraded] session ${this.sessionId} failed to emit turn.cancelled for ${turn.id}: ${emitErr instanceof Error ? emitErr.message : String(emitErr)}\n`,
        );
      }
    }
    return {
      status: persistFailed ? "failed" : "cancelled",
      statusDetail,
      turn: cancelledTurn,
      toolCalls: 0,
      iterations: 0,
      ...(persistFailed
        ? {
            error: errorInfo(
              "INTERNAL_ERROR",
              `failed to persist cancelled turn ${turn.id} — durable status is uncertain`,
            ),
          }
        : {}),
    };
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

  /** E3-10: single-flight drain. Any re-entrant call (from `settle` when a
   *  runtime turn completes) returns immediately while a drain pass is in
   *  flight, so the recovery loop can `await` each runTurn without racing a
   *  settle-triggered re-drain. */
  private async drainFollowups(queue: SessionInputQueue = this.inputQueue): Promise<void> {
    if (this.closed) return;
    if (this.state.kind !== "idle") return;
    if (this._draining) return;
    this._draining = true;
    try {
      await this.drainFollowupsInner(queue);
    } finally {
      this._draining = false;
    }
  }

  private async drainFollowupsInner(queue: SessionInputQueue): Promise<void> {
    // P38.4-2/3 (INV-P38.4-003/004): discover same-T recoverable bound
    // nonterminal turns once per lifetime (never startTurn, no T2).
    if (!this._recoverableChecked) {
      // E4-R36 (J01): `_recoverableChecked` means "a recovery discovery pass
      // COMPLETED", not "a pass was STARTED". Committing it before the await let
      // one transient read failure during the very first scan mark discovery done
      // forever — no re-scan, no timer, and a promoted prompt leaked onto an
      // unowned nonterminal turn. A failed pass leaves the actor re-scannable and
      // stops THIS pass BEFORE any new followup can be promoted: an undiscovered
      // old turn must never be overtaken by T2.
      const discovered = await this.discoverRecoverableTurns();
      if (!discovered) {
        this.scheduleStoreRecheck(); // fail closed + a bounded, self-healing wake-up
        return;
      }
      this._recoverableChecked = true;
    }
    // E3-10: recover same-T BEFORE draining new followups. The head is a
    // PEEK — it is never shift()ed before its recovery record reaches a
    // durable terminal transition (plan E3-10 item 2). If the head is
    // unresolved (backoff pending / lease held / dead-lettered block), the
    // followup drain does NOT proceed — T2 never overtakes T1.
    if (this._recoverableTurns.length > 0) {
      await this.drainRecoverable();
      if (this._recoverableTurns.length > 0) {
        return; // head unresolved or the queue is frozen at a dead-letter
      }
    }
    // P38-1 (INV-P38-001): RESERVE the actor slot BEFORE the awaited dequeue.
    // A concurrent startTurn will see "starting" and be refused — no
    // reservation overwrite.
    const controller = new AbortController();
    const requestId = nextRequestId();
    this.state = { kind: "starting", source: "followup", controller, requestId };
    let reservedId: string | undefined;
    let boundTurnId: TurnId | undefined;

    /** P38.1-3: a promotion that cannot produce a running owner. Reset the
     *  starting slot, requeue the durable prompt (it was never consumed), and
     *  terminally settle the waiting caller exactly once. */
    const failPromotion = async (entryId: string, reason: string): Promise<void> => {
      if (this.state.kind === "starting" && this.state.requestId === requestId) {
        this.state = { kind: "idle" };
      }
      if (reservedId === entryId) reservedId = undefined;
      // P38.3-2: only requeue when the prompt was NEVER bound. Once P→T is
      // durable, requeueing would double-execute — the reconcile path handles
      // the bound lineage instead.
      if (boundTurnId === undefined) {
        try {
          await queue.releaseReservedFollowup(entryId);
        } catch (releaseErr) {
          // Best-effort requeue; the durable inbox record is still pending so
          // hydration on restart recovers it. Surface the loss (P14-6) — never
          // silent.
          process.stderr.write(
            `[degraded] session ${this.sessionId} failed to release reserved followup ${entryId}: ${releaseErr instanceof Error ? releaseErr.message : String(releaseErr)}\n`,
          );
        }
      }
      this.settleFollowup(entryId, {
        kind: "err",
        err: new AgentError(errorInfo("FOLLOWUP_PROMOTION_FAILED", `session ${this.sessionId} ${reason}`)),
      });
    };

    try {
      // P38-2 (INV-P38-002): reserve the followup entry WITHOUT consuming the
      // durable inbox record. The inbox is marked consumed only after a real
      // turn is created and completes (completeReservedFollowup).
      const entry = await queue.reservePendingFollowup();
      if (entry === undefined) {
        // No pending followup — release the reservation.
        if (this.state.kind === "starting" && this.state.requestId === requestId) {
          this.state = { kind: "idle" };
        }
        return;
      }
      reservedId = entry.id;

      let turn: Turn;
      try {
        turn = await this.deps.runtime.startTurn(this.sessionId, entry.input.text);
      } catch (err) {
        // startTurn threw before any durable mutation: the prompt is still
        // pending (recoverable), the caller is settled terminally.
        await failPromotion(entry.id, `followup promotion failed: ${err instanceof Error ? err.message : String(err)}`);
        return;
      }

      // P38.3-2 step 4: revalidate the actor reservation before the durable
      // bind. If the reservation was revoked, the prompt is still unbound and
      // recoverable.
      if (this.state.kind !== "starting" || this.state.requestId !== requestId || controller.signal.aborted) {
        await failPromotion(entry.id, "followup promotion cancelled before bind");
        return;
      }

      // P38.3-2 step 5 (INV-P38.3-001): durably bind P → T BEFORE any
      // execution begins. If the bind fails, T exists but MUST NOT execute.
      try {
        await queue.bindReservedFollowup(entry.id, turn.id);
        boundTurnId = turn.id;
      } catch (bindErr) {
        // Bind failed — T exists but must not run. The prompt remains pending
        // or uncertain per the store result. Never silently create another
        // turn in the same attempt; the created-but-unbound turn is an orphan
        // surfaced via diagnostics. No runtime.runTurn(T).
        process.stderr.write(
          `[degraded] session ${this.sessionId} durable followup bind failed for ${entry.id} (created turn ${turn.id} will not execute): ${bindErr instanceof Error ? bindErr.message : String(bindErr)}\n`,
        );
        await failPromotion(entry.id, `followup durable bind failed: ${bindErr instanceof Error ? bindErr.message : String(bindErr)}`);
        return;
      }

      // P38.3-2 step 6: revalidate the actor reservation AFTER the bind. If it
      // was revoked between bind and promotion, P is durably promoted → T; we
      // must NOT requeue (no T2) and must NOT execute T — terminalize it
      // consistently so the lineage stays one-to-one.
      if (this.state.kind !== "starting" || this.state.requestId !== requestId || controller.signal.aborted) {
        try {
          await this.terminalizeRevokedTurn(turn);
        } catch (terminalizeErr) {
          process.stderr.write(
            `[degraded] session ${this.sessionId} failed to terminalize revoked bound turn ${turn.id}: ${terminalizeErr instanceof Error ? terminalizeErr.message : String(terminalizeErr)}\n`,
          );
        }
        if (this.state.kind === "starting" && this.state.requestId === requestId) {
          this.state = { kind: "idle" };
        }
        this.settleFollowup(entry.id, {
          kind: "err",
          err: new AgentError(errorInfo("FOLLOWUP_PROMOTION_FAILED", `session ${this.sessionId} followup cancelled after bind (turn ${turn.id} terminalized)`)),
        });
        return;
      }

      // P38.3-2 step 7: establish the running OWNER synchronously BEFORE the
      // durable ack. The prompt is already durably bound to T — the running
      // turn is the single owner of that lineage.
      let handle: TurnHandle;
      try {
        handle = this.promoteToRunning(turn, controller);
      } catch (promoteErr) {
        // promoteToRunning failed at the final instant. The prompt is ALREADY
        // durably bound to T (P38.3-2). Do NOT requeue (no T2). Terminalize T
        // consistently so recovery follows the bound lineage.
        process.stderr.write(
          `[degraded] session ${this.sessionId} promote-to-running failed after bind for turn ${turn.id}: ${promoteErr instanceof Error ? promoteErr.message : String(promoteErr)}\n`,
        );
        try {
          await this.terminalizeRevokedTurn(turn);
        } catch (terminalizeErr) {
          process.stderr.write(
            `[degraded] session ${this.sessionId} failed to terminalize bound turn ${turn.id} after promote failure: ${terminalizeErr instanceof Error ? terminalizeErr.message : String(terminalizeErr)}\n`,
          );
        }
        if (this.state.kind === "starting" && this.state.requestId === requestId) {
          this.state = { kind: "idle" };
        }
        this.settleFollowup(entry.id, {
          kind: "err",
          err: new AgentError(errorInfo("FOLLOWUP_PROMOTION_FAILED", `session ${this.sessionId} followup promotion to running failed (turn ${turn.id} terminalized)`)),
        });
        return;
      }
      reservedId = undefined;

      // P38.3-2 step 8-9: when the turn is TERMINAL, mark P consumed (P is
      // already durably bound, so the consume only flips promoted → consumed)
      // and settle the waiting caller exactly once. A consume failure here must
      // NOT requeue — the bound lineage owns the prompt (INV-P38.3-004):
      // surface the loss so reconciliation is on record.
      void handle.outcome.then(
        (outcome) => {
          void queue
            .completeReservedFollowup(entry.id)
            .catch((ackErr) => {
              process.stderr.write(
                `[degraded] session ${this.sessionId} durable followup consume failed for ${entry.id} (prompt remains bound to turn ${turn.id}): ${ackErr instanceof Error ? ackErr.message : String(ackErr)}\n`,
              );
            })
            .then(() => this.settleFollowup(entry.id, { kind: "ok", outcome }));
        },
        (err) => {
          void queue
            .completeReservedFollowup(entry.id)
            .catch((ackErr) => {
              process.stderr.write(
                `[degraded] session ${this.sessionId} durable followup consume failed for ${entry.id} after terminal error (prompt remains bound to turn ${turn.id}): ${ackErr instanceof Error ? ackErr.message : String(ackErr)}\n`,
              );
            })
            .then(() => this.settleFollowup(entry.id, { kind: "err", err }));
        },
      );
    } catch (err) {
      // reservePendingFollowup (or an unexpected throw) — defensive. Release
      // the reservation if we still hold it and it was never bound (never
      // consumed, never lost).
      if (this.state.kind === "starting" && this.state.requestId === requestId) {
        this.state = { kind: "idle" };
      }
      if (reservedId !== undefined && boundTurnId === undefined) {
        await failPromotion(reservedId, `followup promotion failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  /** @internal P38 test seam: run the followup drain against a (possibly
   *  gated) queue override. */
  drainFollowupsForTest(queue?: SessionInputQueue): Promise<void> {
    return this.drainFollowups(queue);
  }

  /**
   * P38.4-2 (INV-P38.4-003/004) — discover bound nonterminal turns that need
   * same-T recovery after a process restart.
   *
   * For every durable followup prompt P observed by listRecoverable with
   * status "promoted" and a bound nonterminal turn T, record T as recoverable.
   * Terminal bound turns are reconciled to consumed during hydrate; nonterminal
   * bound turns must be RESUME-able under the SAME Turn identity.
   *
   * Recovery semantics decision (P38.4-1 §20.3):
   * - stored `running` has no live in-memory owner after restart → recoverable
   * - stored `pending/created` (durably created, never executed) → recoverable
   * - stored `completed/failed/cancelled` → NOT recoverable (terminal, consumed
   *   by hydrate)
   *
   * This query is intentionally idempotent and side-effect free: it only
   * populates `_recoverableTurns`. Execution happens in drainFollowups, which
   * runs exactly one turn at a time through the actor's normal reservation
   * path (single-flight, single live turn per session).
   *
   * E4-R36 (J01): returns whether the scan COMPLETED. The scan is committed
   * ATOMICALLY — candidates are collected into a local buffer and only appended
   * once every durable read succeeded. A partial scan (T1 readable, T2's read
   * throws) therefore commits NOTHING: the retry re-scans from scratch, so T1 is
   * never double-enqueued and T2 is never silently skipped. Errors are recorded
   * and reported as `false` rather than thrown, so a background re-check never
   * becomes an unhandled rejection and the caller keeps a bounded wake-up.
   */
  private async discoverRecoverableTurns(): Promise<boolean> {
    const inbox = this.deps.inbox;
    const store = this.deps.store;
    if (inbox === undefined || store === undefined) return true; // nothing to discover
    let recoverable: AdmittedPrompt[];
    try {
      recoverable = await inbox.listRecoverable(this.sessionId);
    } catch (listErr) {
      process.stderr.write(
        `[degraded] session ${this.sessionId} recovery discovery: inbox listing failed — ${listErr instanceof Error ? listErr.message : String(listErr)}\n`,
      );
      return false;
    }
    // Local buffer: nothing reaches `_recoverableTurns` until the whole scan reads.
    const candidates: Array<{ turn: Turn; promptId: PromptId }> = [];
    const seen = new Set<TurnId>(this._recoverableTurns.map((r) => r.turn.id));
    try {
      for (const p of recoverable) {
        if (p.kind !== "followup" || p.status !== "promoted") continue;
        if (p.promotedTurnId === undefined) continue; // fail-closed in hydrate
        if (seen.has(p.promotedTurnId)) continue;
        const turn = await store.getTurn(p.promotedTurnId);
        if (turn === undefined) continue; // fail-closed in hydrate
        if (turn.status === "completed" || turn.status === "failed" || turn.status === "cancelled") {
          // E4-R17 (N13) + E4-R25 (V01): a terminal turn is normally consumed by
          // hydrate — but a PENDING-COMMIT recovery record (action done, terminal
          // ACK unpersisted) must still be visible to a restarted actor so it can
          // COMMIT the terminal and consume the prompt without re-running the
          // action. A crash after the action but before the ACK is otherwise
          // unrecoverable. The marker-loss compound outage leaves the record in
          // RECOVERY_IN_PROGRESS with NO needsReconcile — the terminal TURN is
          // then the authoritative evidence that the action finished, and the
          // task is still recoverable for reconcile (never re-run).
          const rec = await this._recoveryStore.getRecord(p.promotedTurnId);
          if (rec !== undefined && (recoveryNeedsReconcile(rec) || rec.state === "RECOVERY_IN_PROGRESS")) {
            seen.add(p.promotedTurnId);
            candidates.push({ turn, promptId: p.id });
          }
          continue;
        }
        seen.add(p.promotedTurnId);
        candidates.push({ turn, promptId: p.id });
      }
    } catch (scanErr) {
      process.stderr.write(
        `[degraded] session ${this.sessionId} recovery discovery: durable read failed — ${scanErr instanceof Error ? scanErr.message : String(scanErr)}\n`,
      );
      return false; // commit nothing; the next pass re-scans from the durable state
    }
    this._recoverableTurns.push(...candidates);
    return true;
  }

  /**
   * P38.4-2 (INV-P38.4-004) — durable consume of a prompt whose bound turn has
   * been recovered to a terminal state. This closes the promoted lineage after
   * same-T recovery so the inbox record never dangles. Idempotent: a prompt
   * already consumed (or already pending) is left untouched by the store.
   * Failure is surfaced, never silently swallowed — the durable record is the
   * source of truth and remains recoverable for the next runtime owner.
   */
  private async consumeRecoveredPrompt(
    turnId: TurnId,
    promptId: PromptId,
    _outcome: TurnOutcome,
  ): Promise<void> {
    const inbox = this.deps.inbox;
    if (inbox === undefined) return;
    try {
      // Guard: only consume if the recovered turn really is terminal in the
      // store (runTurn may have been cancelled before terminal persistence).
      const turn = await this.deps.store.getTurn(turnId);
      if (turn === undefined) return; // never consume for an unknown turn
      if (turn.status !== "completed" && turn.status !== "failed" && turn.status !== "cancelled") {
        return; // not terminal — do not consume (still recoverable)
      }
      await inbox.markConsumed(promptId);
    } catch (consumeErr) {
      process.stderr.write(
        `[degraded] session ${this.sessionId} failed to consume recovered prompt ${promptId} after turn ${turnId}: ${consumeErr instanceof Error ? consumeErr.message : String(consumeErr)}\n`,
      );
    }
  }

  /** @internal P38.1-3 test seam: register a queue-mode caller's deferred for
   *  `followupId` (as startTurn's queue path would) so a test can assert the
   *  caller terminally settles across an interrupted durable ack. */
  registerFollowupCallerForTest(followupId: string): Promise<TurnOutcome> {
    return this.createFollowupOutcome(followupId);
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
        emit: this.deps.emit,
        recoveryStore: this.deps.recoveryStore,
        scheduler: this.deps.scheduler,
        recoveryPolicy: this.deps.recoveryPolicy,
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
