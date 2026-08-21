import type { ContextBlock, MemoryEntry, MemoryId, MemoryScope, MemoryStore, SessionId } from "@ar/contracts";
import { type RankedMemoryItem, type SuppressedMemory } from "@ar/memory";
/** Result of a pre-turn retrieval (P2-2): ready context blocks plus the
 *  ranked items they were rendered from (for feedback) and the suppressed
 *  items (for observability — never silently dropped). */
export interface RetrievedMemoryContext {
    blocks: ContextBlock[];
    items: RankedMemoryItem[];
    suppressed: SuppressedMemory[];
}
/** Feedback a turn outcome provides to the injected memories (P2-4). `used`
 *  is only asserted on observable evidence (a succeeded terminal outcome);
 *  when unknown the funnel stays silent — we never fabricate `used=true`. */
export interface MemoryOutcomeFeedback {
    sessionId: SessionId;
    succeeded: boolean;
}
export interface MemoryRuntimeBridgeDeps {
    store: MemoryStore;
    scope: MemoryScope;
    /** Retrieval cap per turn (default 5, matches RetrieveOptions.k). */
    topK?: number;
    now?: () => number;
}
/** Priority of memory blocks in the context pipeline (below skill bodies). */
export declare const MEMORY_BLOCK_PRIORITY = 400;
/** Block id prefix; the runtime strips it to recover the memory id. */
export declare const MEMORY_BLOCK_PREFIX = "memory:";
/** Rough token estimate (~4 bytes/token, matching the context package). */
export declare function estimateMemoryTokens(content: string): number;
/** Render one ranked memory for the model (P2-2). Memories are advisory
 *  experience, never authority: the header states it explicitly, structured
 *  lessons are rendered as When/Do/Avoid, and confidence/evidence make the
 *  strength visible. */
export declare function renderMemoryForModel(item: RankedMemoryItem): string;
/** Convert a ranked memory item into a context block (P2-2). */
export declare function memoryToBlock(item: RankedMemoryItem): ContextBlock;
/**
 * P2-1: the memory runtime bridge. Composes the memory store with the
 * retrieval pipeline (scope-filtered, explainably scored, topK) and the
 * usefulness feedback funnel. Core-agnostic: `retrieve` renders context
 * blocks for the runtime's pre-turn memory provider; `recordInjected` /
 * `recordOutcome` close the P2-4 loop.
 */
export declare class MemoryRuntimeBridge {
    private readonly store;
    private readonly scope;
    private readonly topK;
    private readonly now;
    private readonly roi;
    constructor(deps: MemoryRuntimeBridgeDeps);
    /** P2-2: pre-turn retrieval — scope-filtered, scored, deduped, topK. */
    retrieve(input: {
        sessionId: SessionId;
        goal: string;
        cwd: string;
    }): Promise<RetrievedMemoryContext>;
    /** P2-4: a memory block entered the model context (injectedCount++). */
    recordInjected(memoryIds: readonly MemoryId[]): Promise<void>;
    /** P2-4: terminal outcome feedback. On a succeeded turn the memories that
     *  were injected get `used` + `taskSucceeded` (observable evidence: the
     *  surrounding task succeeded); on failure the funnel stays silent —
     *  "used" would be a guess. */
    recordOutcome(memoryIds: readonly MemoryId[], feedback: MemoryOutcomeFeedback): Promise<void>;
    /** P6-4: token ROI per memory entry — successes per 1k injected tokens.
     *  Pure accounting of this process's retrievals; persistence is the memory
     *  store's usefulness fields. */
    tokenROI(): {
        memoryId: MemoryId;
        tokens: number;
        injected: number;
        succeeded: number;
        roiPer1k: number;
    }[];
    /** P13-4 (challenger bridge): suggest memory topK from observed token ROI.
     *  Pure passthrough of suggestMemoryTopK over this bridge's ROI ledger; the
     *  harness keeps using the configured/fixed topK until a benchmark gate
     *  promotes adaptive topK (default behaviour is UNCHANGED). */
    suggestTopK(): number;
    /** Apply one immutable usefulness update and persist it. */
    private applyFeedback;
    close(): Promise<void>;
}
/** Normalize bridge entries for injection: dedupe, strip the memory: prefix. */
export declare function memoryIdsOfBlocks(blocks: readonly ContextBlock[]): MemoryId[];
/** Fetch full entries for a set of ids (feedback targets). Missing entries
 *  are skipped silently (deleted mid-turn). */
export declare function entriesForIds(store: MemoryStore, ids: readonly MemoryId[]): Promise<MemoryEntry[]>;
//# sourceMappingURL=memory-runtime-bridge.d.ts.map