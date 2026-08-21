import type { PromptId, SessionId } from "./ids.js";
/**
 * Session inbox (plan.md Phase 1 Issue 3 / Phase 5.3, P2-36): user input
 * arriving while a turn is running is ADMITTED first, then routed by kind.
 *
 *   input → admitted → steer / queue → promoted → consumed
 *
 * P2-36 — phase semantics (what takes effect WHERE / WHEN):
 *
 *  - steer:   injected into the RUNNING turn as a user message, ONLY at the next
 *             safe boundary (immediately before the next model call). It does
 *             NOT interrupt an in-flight tool call or a model call that already
 *             started, and it NEVER rewinds or undoes a tool side effect that
 *             already committed. The task is not over; the model is redirected
 *             for its next reasoning step.
 *  - followup: NEVER injected into the running turn. It is queued for AFTER the
 *             current turn ends — the outer loop starts a NEW turn for it.
 *  - cancel:  the ONLY hard-abort path. It takes effect immediately (aborts the
 *             running turn / tool subtree via the cancellation signal), and is
 *             NOT drained as a message. A later steer cannot be used to undo an
 *             already-started tool side effect — only cancel aborts, and even
 *             then committed side effects are surfaced for reconciliation, not
 *             erased.
 *
 * The two message kinds never share one queue: steering mutates the current
 * task, follow-ups start a new one.
 */
export type PromptKind = "steer" | "followup";
export type PromptStatus = "pending" | "promoted" | "consumed";
export interface AdmittedPrompt {
    id: PromptId;
    sessionId: SessionId;
    text: string;
    kind: PromptKind;
    status: PromptStatus;
    admittedAt: number;
    promotedAt?: number;
    consumedAt?: number;
}
export interface InboxStore {
    admit(prompt: AdmittedPrompt): Promise<void>;
    listPending(sessionId: SessionId): Promise<AdmittedPrompt[]>;
    listAll(sessionId: SessionId): Promise<AdmittedPrompt[]>;
    markPromoted(id: PromptId): Promise<void>;
    markConsumed(id: PromptId): Promise<void>;
}
/**
 * P2-36 — durable, exactly-once steer transition.
 *
 * The steer transition spans two stores (the message goes into the session
 * store, the prompt status into the inbox store), so it is NOT a single atomic
 * step. To be crash-safe and idempotent the runtime:
 *
 *   1. checks whether a message carrying `promptId === prompt.id` already
 *      exists in the session transcript;
 *   2. if it does, a prior interrupted attempt already injected this steer →
 *      mark the prompt promoted+consumed and DO NOT append again (exactly-once);
 *   3. otherwise append the message (stamping `promptId`), then promote, then
 *      consume.
 *
 * Any crash window between append and consume is therefore self-healing: the
 * existing-message check prevents double injection, and the stray prompt status
 * is reconciled to consumed.
 */
export interface SteerLifecycle {
    /** True when `history` already contains the injected message for `promptId`. */
    alreadyInjected(history: readonly {
        promptId?: PromptId;
    }[], promptId: PromptId): boolean;
}
//# sourceMappingURL=inbox.d.ts.map