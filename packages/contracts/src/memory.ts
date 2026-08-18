import type { MemoryId, SessionId } from "./ids.js";

export type MemoryType = "explicit" | "episodic" | "procedural";

/**
 * Visibility scope of a persisted memory (P0-4). Narrower scopes are more
 * specific: a memory written at `session` scope is only retrievable by that
 * session's queries, `global` applies everywhere. The hierarchy used by
 * retrieval is (broadest first): global > workspace > repository > agent >
 * task-family > session.
 */
export type MemoryScope =
  | "global"
  | "workspace"
  | "repository"
  | "agent"
  | "task-family"
  | "session";

/** P2-1: structured strategy lesson (When/Do/Avoid + evidence). Rule-extracted
 *  deterministically; LLM enrichment is an optional extension point. */
export interface StrategyLesson {
  /** Applicability conditions: the situation where this lesson applies. */
  when: string;
  /** Recovery strategy: what to do instead. */
  do: string;
  /** Avoided behavior: what not to repeat. */
  avoid: string;
  /** Failed strategy the agent actually attempted. */
  failedStrategy?: string;
  /** Root cause class (§164 attribution). */
  rootCause: string;
  /** Observed outcome: "failure" | "partial". */
  outcome: string;
  /** Supporting event ids (evidence refs, never fabricated). */
  evidenceRefs: string[];
}

export interface MemoryCandidate {
  content: string;
  type: MemoryType;
  sourceSession: SessionId;
  importance: number;
  confidence: number;
  novelty: number;
  stability: number;
  /** P2-1: structured strategy lesson when the candidate is procedural. */
  structured?: StrategyLesson;
}

/** P2-2: evidence ledger attached to a persisted memory. Memory is not
 *  absolute knowledge (§P2-2): every entry records where it came from and
 *  how often it has been validated in the wild. */
export interface MemoryEvidence {
  /** Sessions that produced this memory (merged on promotion). */
  sourceSessions: SessionId[];
  /** Supporting event ids (evidence refs, never fabricated). */
  sourceEvents: string[];
  /** Times this memory was confirmed useful. */
  successCount: number;
  /** Times this memory was found wrong or unhelpful. */
  failureCount: number;
  /** Last timestamp a validation was recorded. */
  lastValidated?: number;
}

/** P2-3: usage feedback funnel for one memory. `score` is the rolling
 *  usefulness (0..1) updated by retrieval/injection/use/outcome signals;
 *  absent feedback keeps the scoring proxy (entry.importance). */
export interface MemoryUsefulness {
  /** Times retrieved by a query. */
  retrievedCount: number;
  /** Times injected into the model context. */
  injectedCount: number;
  /** Times used (or likely used) by the agent. */
  usedCount: number;
  /** Times the surrounding task succeeded after use. */
  taskSuccessCount: number;
  /** Times the surrounding verification passed after use. */
  verificationPassedCount: number;
  /** Rolling usefulness score, 0..1. */
  score: number;
}

/** P2-4: lifecycle state of a persisted memory. Everything is soft — history
 *  (evidence ledger, content) is never physically deleted (§P2-4). */
export type MemoryState =
  | { kind: "active" }
  | { kind: "superseded"; byId: MemoryId; at: number; reason?: string }
  | { kind: "deprecated"; at: number; reason?: string }
  | { kind: "conflicting"; withId: MemoryId; at: number }
  | { kind: "stale"; at: number };

export interface MemoryEntry extends MemoryCandidate {
  id: MemoryId;
  createdAt: number;
  updatedAt: number;
  deleted: boolean;
  /**
   * Visibility scope (P0-4). Assigned at persist time; entries written
   * before scope existed default to "session" (the narrowest, safest scope).
   */
  scope: MemoryScope;
  /** P2-2: evidence ledger (source sessions/events + validation counts). */
  evidence?: MemoryEvidence;
  /** P2-3: usage feedback funnel (retrieved/injected/used/outcome). */
  usefulness?: MemoryUsefulness;
  /** P2-4: lifecycle state; absent means active. */
  state?: MemoryState;
}

export interface MemoryStore {
  write(entry: MemoryEntry): Promise<void>;
  get(id: MemoryId): Promise<MemoryEntry | undefined>;
  search(query: string, opts?: { type?: MemoryType; scope?: MemoryScope }): Promise<MemoryEntry[]>;
  list(opts?: { deleted?: boolean; scope?: MemoryScope }): Promise<MemoryEntry[]>;
  update(entry: MemoryEntry): Promise<void>;
  remove(id: MemoryId): Promise<void>;
}

export type ReflectionOutput = {
  outcome: "success" | "partial" | "failure";
  rootCause: string;
  evidence: string;
  lesson: string;
  generalizable: boolean;
  candidate?: MemoryCandidate;
};