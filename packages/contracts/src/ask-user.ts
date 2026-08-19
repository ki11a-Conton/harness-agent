import type { AskId, SessionId, TurnId } from "./ids.js";

/**
 * P2-43 — Ask-User Gate.
 *
 * When a turn lacks critical input it must be able to ask the user. That ask is
 * a FORMAL runtime phase/outcome ("waiting_for_user"), NOT a synthesized tool
 * error. This module is the contracts boundary for that gate:
 *
 *   - AskReason is a closed taxonomy of WHY we are asking (no free strings).
 *   - AskUserRequest is the durable, identity-bearing question.
 *   - AskUserStatus transitions are governed here (pending → answered /
 *     withdrawn), so a host/UI that cannot yet do async rendering still has a
 *     crisp, typed boundary to implement against.
 *   - AskUserStore is the persistence seam (pending asks survive the runtime
 *     turn returning and, with a durable impl, a process restart — see P2-44).
 *   - resumePrompt() renders the user reply into the exact message injected
 *     back into the turn transcript on resume.
 *
 * The turn is NOT terminated while waiting: `waiting_for_user` is a paused,
 * resumable phase. The runtime returns that outcome, the host captures the
 * reply through AskUserStore, and a subsequent runTurn (seeded with the reply as
 * a user message) resumes the task.
 */
export type AskReason =
  /** The turn genuinely cannot proceed without a concrete answer. */
  | "missing_critical_input"
  /** The goal admits multiple valid readings; the user must pick. */
  | "ambiguous_goal"
  /** A required target/destination/value is unknown and not inferable. */
  | "unresolvable_context"
  /** A human decision is required before irreversible/expensive work. */
  | "choice_required";

/** Exhaustive list of the closed taxonomy, kept in lock-step with the union by
 *  `satisfies`. Adding a reason without extending the array is a compile error. */
export const ASK_REASONS = [
  "missing_critical_input",
  "ambiguous_goal",
  "unresolvable_context",
  "choice_required",
] as const satisfies readonly AskReason[];

export function isAskReason(value: unknown): value is AskReason {
  return typeof value === "string" && (ASK_REASONS as readonly string[]).includes(value);
}

export type AskUserStatus = "pending" | "answered" | "withdrawn";

export interface AskUserRequest {
  id: AskId;
  sessionId: SessionId;
  turnId?: TurnId;
  reason: AskReason;
  /** The precise question the user must answer. */
  question: string;
  /** Optional closed choices; when present the host may render them as buttons. */
  options?: readonly string[];
  status: AskUserStatus;
  createdAt: number;
  answeredAt?: number;
  /** The text the user supplied (set when status === "answered"). */
  answerText?: string;
}

export interface AskUserReply {
  requestId: AskId;
  /** The user's answer text. */
  text: string;
  answeredAt: number;
}

export interface AskUserStore {
  create(request: AskUserRequest): Promise<void>;
  get(id: AskId): Promise<AskUserRequest | undefined>;
  listPending(sessionId: SessionId): Promise<AskUserRequest[]>;
  /** Resolve a pending ask; rejects/no-ops if it is not pending. */
  markAnswered(id: AskId, reply: AskUserReply): Promise<void>;
  /** Withdraw a pending ask (e.g. the user cancelled the question). */
  markWithdrawn(id: AskId): Promise<void>;
}

/**
 * Pure lifecycle boundary — no storage or timing side effects, so it is fully
 * unit-testable and usable by both the runtime (producer) and any host/UI
 * (consumer) even before async rendering exists.
 */
export interface AskUserLifecycle<T extends AskUserRequest = AskUserRequest> {
  /** A request that is still awaiting an answer. */
  isPending(request: T): boolean;
  /** A request that already received an answer. */
  isAnswered(request: T): boolean;
  /** True when an ask for this session+turn is already pending (dedupe gate). */
  hasPending(sessionId: SessionId, turnId: TurnId): (pending: T) => boolean;
  /**
   * The exact user message injected into the turn transcript on resume, tagged
   * with the ask id so a crash between "reply persisted" and "message appended"
   * cannot double-inject the reply (same exactly-once pattern as P2-36 steer).
   */
  resumePrompt(reply: AskUserReply): { content: string; askId: AskId };
  /** A serializable fingerprint for the request (audit / dedupe key). */
  fingerprint(request: T): string;
}

/** Default pure implementation of the boundary contracts. */
export const defaultAskUserLifecycle: AskUserLifecycle = {
  isPending: (request) => request.status === "pending",
  isAnswered: (request) => request.status === "answered",
  hasPending: (sessionId, turnId) => (pending) =>
    pending.sessionId === sessionId &&
    pending.turnId === turnId &&
    pending.status === "pending",
  resumePrompt: (reply) => ({
    content: `[user reply to your question]\n${reply.text}`,
    askId: reply.requestId,
  }),
  fingerprint: (request) => `${request.sessionId}/${request.turnId ?? "-"}/${request.id}`,
};