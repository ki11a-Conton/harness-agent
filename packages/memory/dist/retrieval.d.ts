import type { MemoryEntry, MemoryScope, MemoryStore, MemoryType } from "@ar/contracts";
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
export declare const SCOPE_ORDER: readonly MemoryScope[];
/** scopeMatch component: exact scope = 1, each level broader = ×0.8. */
export declare const SCOPE_MATCH_DECAY = 0.8;
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
export declare const SCORE_WEIGHTS: {
    [K in keyof Omit<MemoryScore, "total">]: number;
};
/** Exponential decay half-life for recency (milliseconds). */
export declare const RECENCY_HALF_LIFE_MS: number;
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
export declare function scopeDepth(scope: MemoryScope): number;
/** True when a memory with `memoryScope` is visible to a query at `queryScope`. */
export declare function scopeVisibleForQuery(memoryScope: MemoryScope, queryScope: MemoryScope): boolean;
/** scopeMatch component for a memory at `depth` relative to the query depth. */
export declare function scopeMatchScore(memoryDepth: number, queryDepth: number): number;
/** Normalized token set for similarity/conflict detection. */
export declare function contentTokens(content: string): Set<string>;
/** Jaccard similarity of two token sets (0 = disjoint, 1 = identical). */
export declare function tokenSimilarity(a: Set<string>, b: Set<string>): number;
/** Similarity threshold above which two memories are treated as the same topic. */
export declare const CONFLICT_SIMILARITY_THRESHOLD = 0.6;
/**
 * Compute the explainable score of one entry.
 *
 * @param entry persisted entry (deleted entries are the caller's concern)
 * @param lexicalRank {index, total} position of the entry in the store's
 *   BM25 ranking (index 0 = best lexical match)
 * @param queryDepth scope depth of the query
 * @param now clock value for recency
 */
export declare function computeMemoryScore(entry: MemoryEntry, lexicalRank: {
    index: number;
    total: number;
}, queryDepth: number, now: number): MemoryScore;
/**
 * Retrieve memories for a query: scope filter → FTS/BM25 → metadata scoring
 * → dedup/conflict filter → Top-K. Never returns deleted or unsafe memory.
 */
export declare function retrieveMemories(store: MemoryStore, query: string, queryScope: MemoryScope, opts?: RetrieveOptions): Promise<RetrieveResult>;
//# sourceMappingURL=retrieval.d.ts.map