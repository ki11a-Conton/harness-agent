import type { MemoryEntry, MemoryScope, MemoryStore, MemoryType } from "@ar/contracts";
import { checkUnsafeMemory } from "./security-gate.js";

/**
 * P0-4 Memory Retrieval V2.
 *
 * Pipeline (each stage observable and deterministic):
 *
 *   query
 *    ↓
 *   scope filter (hierarchy: global ⊃ workspace ⊃ repository ⊃ agent
 *                 ⊃ task-family ⊃ session; broader memories qualify for
 *                 narrower queries, never the reverse)
 *    ↓
 *   FTS/BM25 (store.search ranking; fallback LIKE inside the store)
 *    ↓
 *   metadata scoring → explainable components (never a single opaque score)
 *    ↓
 *   recency/usefulness/confidence/successEvidence/scopeMatch
 *    ↓
 *   dedup/conflict filter (token-similarity groups: one survivor per topic,
 *   the rest are reported as `suppressed`, never silently dropped)
 *    ↓
 *   Top-K
 *
 * Safety (P0-4 spec): deleted memory never matches (store enforces it) and
 * hostile content that somehow reached the database (bypassing the write
 * gate) is dropped with reason "unsafe" — defense in depth on the read path.
 */

/** Broadest-first scope hierarchy; index = specificity depth. */
export const SCOPE_ORDER: readonly MemoryScope[] = [
  "global",
  "workspace",
  "repository",
  "agent",
  "task-family",
  "session",
];

const SCOPE_DEPTH = new Map<MemoryScope, number>(
  SCOPE_ORDER.map((s, i) => [s, i]),
);

/** scopeMatch component: exact scope = 1, each level broader = ×0.8. */
export const SCOPE_MATCH_DECAY = 0.8;

/** Explainable score components (P0-4: never one opaque score). */
export interface MemoryScore {
  /** BM25/rank-based lexical match, 0..1. */
  lexical: number;
  /** Recency: exponential decay on updatedAt (half-life ≈ 21 days), 0..1. */
  recency: number;
  /** entry.usefulness.score when feedback exists (P2-3), else importance proxy. */
  usefulness: number;
  /** entry.confidence, 0..1. */
  confidence: number;
  /** Proxy: entry.stability (Reflection stores stability as the persistence
   *  of a validated outcome). */
  successEvidence: number;
  /** Scope hierarchy match, 0..1. */
  scopeMatch: number;
  /** Weighted combination of the components above (weights sum to 1). */
  total: number;
}

/** Weight of each component in `total` (documented, sums to 1). */
export const SCORE_WEIGHTS: { [K in keyof Omit<MemoryScore, "total">]: number } = {
  lexical: 0.35,
  recency: 0.15,
  usefulness: 0.15,
  confidence: 0.15,
  successEvidence: 0.1,
  scopeMatch: 0.1,
};

/** Exponential decay half-life for recency (milliseconds). */
export const RECENCY_HALF_LIFE_MS = 21 * 24 * 3600 * 1000;

export interface RankedMemoryItem {
  memory: MemoryEntry;
  score: MemoryScore;
}

export interface SuppressedMemory {
  memory: MemoryEntry;
  reason: "unsafe" | "conflict" | "duplicate";
}

export interface RetrieveOptions {
  /** Result cap (default 5). */
  k?: number;
  /** Optional memory-type filter forwarded to the store. */
  type?: MemoryType;
  /** Minimum total score for an item to be returned (default 0). */
  minScore?: number;
  /** Clock injection for deterministic recency in tests. */
  now?: number;
}

export interface RetrieveResult {
  items: RankedMemoryItem[];
  /** Items dropped by the dedup/conflict filter or the safety gate. */
  suppressed: SuppressedMemory[];
}

/** Return the scope specificity depth (0 = global … 5 = session). */
export function scopeDepth(scope: MemoryScope): number {
  return SCOPE_DEPTH.get(scope)!;
}

/** True when a memory with `memoryScope` is visible to a query at `queryScope`. */
export function scopeVisibleForQuery(memoryScope: MemoryScope, queryScope: MemoryScope): boolean {
  return scopeDepth(memoryScope) <= scopeDepth(queryScope);
}

/** scopeMatch component for a memory at `depth` relative to the query depth. */
export function scopeMatchScore(memoryDepth: number, queryDepth: number): number {
  return memoryDepth >= queryDepth ? 1 : SCOPE_MATCH_DECAY ** (queryDepth - memoryDepth);
}

/** Normalized token set for similarity/conflict detection. */
export function contentTokens(content: string): Set<string> {
  return new Set(content.toLowerCase().split(/[^a-z0-9]+/).filter((t) => t !== ""));
}

/** Jaccard similarity of two token sets (0 = disjoint, 1 = identical). */
export function tokenSimilarity(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter += 1;
  return inter / (a.size + b.size - inter);
}

/** Similarity threshold above which two memories are treated as the same topic. */
export const CONFLICT_SIMILARITY_THRESHOLD = 0.6;

/**
 * Compute the explainable score of one entry.
 *
 * @param entry persisted entry (deleted entries are the caller's concern)
 * @param lexicalRank {index, total} position of the entry in the store's
 *   BM25 ranking (index 0 = best lexical match)
 * @param queryDepth scope depth of the query
 * @param now clock value for recency
 */
export function computeMemoryScore(
  entry: MemoryEntry,
  lexicalRank: { index: number; total: number },
  queryDepth: number,
  now: number,
): MemoryScore {
  const lexical = lexicalRank.total <= 1 ? 1 : Math.max(0, 1 - lexicalRank.index / (lexicalRank.total - 1));
  const ageMs = Math.max(0, now - entry.updatedAt);
  const recency = Math.min(1, Math.exp(-ageMs / RECENCY_HALF_LIFE_MS));
  const usefulness =
    entry.usefulness !== undefined
      ? Math.min(1, Math.max(0, entry.usefulness.score))
      : Math.min(1, Math.max(0, entry.importance));
  const confidence = Math.min(1, Math.max(0, entry.confidence));
  const successEvidence = Math.min(1, Math.max(0, entry.stability));
  const scopeMatch = scopeMatchScore(scopeDepth(entry.scope), queryDepth);
  const total =
    SCORE_WEIGHTS.lexical * lexical +
    SCORE_WEIGHTS.recency * recency +
    SCORE_WEIGHTS.usefulness * usefulness +
    SCORE_WEIGHTS.confidence * confidence +
    SCORE_WEIGHTS.successEvidence * successEvidence +
    SCORE_WEIGHTS.scopeMatch * scopeMatch;
  return { lexical, recency, usefulness, confidence, successEvidence, scopeMatch, total };
}

/**
 * Retrieve memories for a query: scope filter → FTS/BM25 → metadata scoring
 * → dedup/conflict filter → Top-K. Never returns deleted or unsafe memory.
 */
export async function retrieveMemories(
  store: MemoryStore,
  query: string,
  queryScope: MemoryScope,
  opts: RetrieveOptions = {},
): Promise<RetrieveResult> {
  const k = opts.k ?? 5;
  const now = opts.now ?? Date.now();
  const queryDepth = scopeDepth(queryScope);
  const minScore = opts.minScore ?? 0;

  const hits = await store.search(query, { type: opts.type });
  const total = hits.length;

  const scored: Array<{ memory: MemoryEntry; score: MemoryScore }> = [];
  const suppressed: SuppressedMemory[] = [];

  for (let i = 0; i < hits.length; i += 1) {
    const memory = hits[i]!;
    if (memory.deleted) {
      suppressed.push({ memory, reason: "duplicate" });
      continue;
    }
    if (!scopeVisibleForQuery(memory.scope, queryScope)) continue;
    const unsafe = checkUnsafeMemory(memory.content, "retrieval");
    if (unsafe !== null) {
      suppressed.push({ memory, reason: "unsafe" });
      continue;
    }
    const score = computeMemoryScore(memory, { index: i, total }, queryDepth, now);
    if (score.total < minScore) continue;
    scored.push({ memory, score });
  }

  // Dedup/conflict: group by token similarity, keep the best item per topic.
  scored.sort((a, b) => b.score.total - a.score.total);
  const kept: RankedMemoryItem[] = [];
  for (const item of scored) {
    const tokens = contentTokens(item.memory.content);
    const conflict = kept.find(
      (other) =>
        tokenSimilarity(tokens, contentTokens(other.memory.content)) >= CONFLICT_SIMILARITY_THRESHOLD,
    );
    if (conflict !== undefined) {
      suppressed.push({ memory: item.memory, reason: "conflict" });
      continue;
    }
    kept.push(item);
  }

  return { items: kept.slice(0, k), suppressed };
}
