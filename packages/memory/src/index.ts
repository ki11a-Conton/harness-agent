// @ar/memory public surface.

// MEMORY-001: JSONL memory store (§65–§67) + §67 write gate.
export { JsonlMemoryStore, MEMORY_FILE_NAME, readJsonlEntries } from "./memory-store.js";
export type { JsonlMemoryStoreOptions } from "./memory-store.js";

// P0-3: SQLite + WAL memory store (schema-versioned, FTS5, soft delete) and
// the JSONL → SQLite migration (idempotent, crash-safe, dry-run capable).
export {
  MEMORY_DB_FILE_NAME,
  MEMORY_SCHEMA_VERSION,
  SqliteMemoryStore,
  migrateJsonlToSqlite,
} from "./sqlite-memory-store.js";
export type {
  MigrateResult,
  SqliteMemoryStoreOptions,
} from "./sqlite-memory-store.js";

// §67 shared security gate: identical injection/secret rejection on every
// persistence path (JSONL and SQLite).
export { checkUnsafeMemory, scanMemoryEntries } from "./security-gate.js";
export type { SecurityDeniedEvent, UnsafeMemory } from "./security-gate.js";

// P0-4: Memory Retrieval V2 — scope-filtered, explainably scored retrieval
// (lexical/recency/usefulness/confidence/successEvidence/scopeMatch →
// dedup/conflict → Top-K).
export {
  CONFLICT_SIMILARITY_THRESHOLD,
  RECENCY_HALF_LIFE_MS,
  SCOPE_MATCH_DECAY,
  SCOPE_ORDER,
  SCORE_WEIGHTS,
  computeMemoryScore,
  contentTokens,
  retrieveMemories,
  scopeDepth,
  scopeMatchScore,
  scopeVisibleForQuery,
  tokenSimilarity,
} from "./retrieval.js";
export type {
  MemoryScore,
  RankedMemoryItem,
  RetrieveOptions,
  RetrieveResult,
  SuppressedMemory,
} from "./retrieval.js";

export {
  DEFAULT_MEMORY_WRITE_POLICY,
  evaluateCandidate,
} from "./write-gate.js";
export type { MemoryWritePolicy, WriteGateResult } from "./write-gate.js";

// REFLECTION-001: deterministic rule-based reflection over the event stream (§68).
export { FAILURE_EVENT_TYPES, Reflector } from "./reflection.js";
export type { FailureRootCause, ReflectDeps } from "./reflection.js";

// P2-2: evidence ledger (source sessions/events, validation counts).
export {
  evidenceFromCandidate,
  mergeEvidence,
  recordValidation,
} from "./evidence.js";
export type { ValidationRecord } from "./evidence.js";

// P2-3: usefulness feedback funnel (retrieved/injected/used/outcome).
export {
  INITIAL_USEFULNESS_SCORE,
  hasUsefulness,
  recordUsefulness,
} from "./usefulness.js";
export type { UsefulnessFeedback } from "./usefulness.js";

// P2-4: lifecycle (decay / deprecation / supersession / conflict).
export {
  DEFAULT_CONFIDENCE_DECAY_FACTOR,
  DEFAULT_FAILURE_THRESHOLD,
  DEFAULT_MAX_IDLE_MS,
  deprecate,
  evaluateLifecycle,
  isRetrievable,
  markConflicting,
  supersede,
} from "./lifecycle.js";
export type { LifecycleOptions, LifecycleResult } from "./lifecycle.js";

export type {
  MemoryCandidate,
  MemoryEntry,
  MemoryEvidence,
  MemoryId,
  MemoryScope,
  MemoryState,
  MemoryStore,
  MemoryType,
  MemoryUsefulness,
  ReflectionOutput,
  StrategyLesson,
} from "@ar/contracts";
