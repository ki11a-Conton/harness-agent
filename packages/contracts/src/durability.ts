// P26-6 — optional atomic semantic-boundary store capability.
//
// The runtime's default write path is ORDERED WRITES + turn-end durability
// fences (P26-3): tool message, outcome event and checkpoint each commit in
// their own store operation. A store that can do better advertises this
// optional capability so a host can commit logically coupled writes in ONE
// atomic transaction. SQL is NEVER exposed to core — the capability is a
// plain typed interface; the SQL stays inside the store implementation.
// Stores that do not implement the capability fall back to ordered writes and
// advertise their weaker atomicity via their DurabilityLevel.

import type { AgentEvent } from "./event.js";
import type { Message } from "./message.js";
import type { CheckpointData } from "./checkpoint.js";

/** P26-6 — the writes a tool outcome couples together. */
export interface ToolOutcomeCommit {
  /** The rendered tool-result message appended to the session transcript. */
  toolMessage: Message;
  /** The terminal outcome event (tool.completed / tool.failed). */
  outcomeEvent: Omit<AgentEvent, "sequence">;
  /** Optional checkpoint to commit in the same transaction (policy). */
  checkpoint?: CheckpointData;
}

/** P26-6 — store capability: commit a tool outcome atomically. */
export interface AtomicToolOutcomeCommitStore {
  readonly atomicCommitSupported: true;
  commitToolOutcome(commit: ToolOutcomeCommit): Promise<{ event: AgentEvent }>;
}
