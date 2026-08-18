import type { PromptId, SessionId } from "./ids.js";

/**
 * Session inbox (plan.md Phase 1 Issue 3 / Phase 5.3): user input arriving
 * while a turn is running is ADMITTED first, then routed:
 *
 *   input → admitted → steer / queue → promoted → consumed
 *
 * - steer:    injected into the RUNNING turn at the next safe boundary
 *             (before the next model call) — the task is not over.
 * - followup: queued for AFTER the current turn ends — the outer loop starts
 *             a new turn for it.
 *
 * The two kinds never share one message queue: steering mutates the current
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
