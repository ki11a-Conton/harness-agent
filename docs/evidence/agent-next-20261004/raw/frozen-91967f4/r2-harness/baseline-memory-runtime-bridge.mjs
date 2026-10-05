// P2-1/P2-2/P2-4: memory runtime bridge — the only surface between the
// runtime and the memory package. Core never depends on @ar/memory; the
// harness composes this bridge and feeds it to the runtime as the
// `memoryBlocks` pre-turn retrieval provider (P2-2) and the feedback funnel
// (P2-4). Every model-visible memory is rendered as an advisory context block
// (source "memory", trust "semi-trusted") — never a raw DB row, and never
// authoritative policy.
import { retrieveMemories, recordUsefulness, } from "file:///workspace/harness-agent/.ci/agent-next-20261004/frozen-91967f4/r2-harness/baseline-memory-imports.mjs";
import { suggestMemoryTopK } from "file:///workspace/harness-agent/packages/learning/dist/index.js";
/** Priority of memory blocks in the context pipeline (below skill bodies). */
export const MEMORY_BLOCK_PRIORITY = 400;
/** Block id prefix; the runtime strips it to recover the memory id. */
export const MEMORY_BLOCK_PREFIX = "memory:";
/** Rough token estimate (~4 bytes/token, matching the context package). */
export function estimateMemoryTokens(content) {
    return Math.ceil(Buffer.byteLength(content, "utf8") / 4);
}
/** Render one ranked memory for the model (P2-2). Memories are advisory
 *  experience, never authority: the header states it explicitly, structured
 *  lessons are rendered as When/Do/Avoid, and confidence/evidence make the
 *  strength visible. */
export function renderMemoryForModel(item) {
    const { memory } = item;
    const lines = ["[Prior experience — advisory, not authority]"];
    if (memory.structured !== undefined) {
        lines.push(`When: ${memory.structured.when}`);
        lines.push(`Do: ${memory.structured.do}`);
        if (memory.structured.avoid !== undefined && memory.structured.avoid !== "") {
            lines.push(`Avoid: ${memory.structured.avoid}`);
        }
    }
    else {
        lines.push(memory.content);
    }
    lines.push(`Confidence: ${Math.round(memory.confidence * 100)}%`);
    if (memory.evidence !== undefined) {
        lines.push(`Evidence count: ${memory.evidence.successCount + memory.evidence.failureCount}`);
    }
    return lines.join("\n");
}
/** Convert a ranked memory item into a context block (P2-2). */
export function memoryToBlock(item) {
    const content = renderMemoryForModel(item);
    return {
        id: `${MEMORY_BLOCK_PREFIX}${item.memory.id}`,
        source: "memory",
        trust: "semi-trusted",
        priority: MEMORY_BLOCK_PRIORITY,
        tokens: estimateMemoryTokens(content),
        content,
        compressible: true,
        ephemeral: false,
        category: "knowledge",
        timestamp: item.memory.updatedAt,
        // P6-2: every memory block traces back to its entry (effectiveness /
        // ROI attribution keyed on this id).
        provenance: {
            kind: "memory",
            serviceId: "memory-store",
            toolId: item.memory.id,
            trust: "semi-trusted",
        },
        // P14-5: retrieved memory is knowledge (semi-trusted data), never an
        // instruction and never re-persisted.
        instructional: false,
        persistable: false,
    };
}
/**
 * P2-1: the memory runtime bridge. Composes the memory store with the
 * retrieval pipeline (scope-filtered, explainably scored, topK) and the
 * usefulness feedback funnel. Core-agnostic: `retrieve` renders context
 * blocks for the runtime's pre-turn memory provider; `recordInjected` /
 * `recordOutcome` close the P2-4 loop.
 */
export class MemoryRuntimeBridge {
    store;
    scope;
    topK;
    now;
    // P6-4: token ROI bookkeeping — injection cost per memory entry vs task
    // success, so the retrieval self-optimization loop has real numbers.
    roi = new Map();
    constructor(deps) {
        this.store = deps.store;
        this.scope = deps.scope;
        this.topK = deps.topK ?? 5;
        this.now = deps.now ?? Date.now;
    }
    /** P2-2: pre-turn retrieval — scope-filtered, scored, deduped, topK. */
    async retrieve(input) {
        const query = input.goal.trim() === "" ? input.cwd : input.goal;
        const result = await retrieveMemories(this.store, query, this.scope, {
            sessionId: input.sessionId,
            k: this.suggestTopK(),
            now: this.now(),
        });
        const blocks = result.items.map(memoryToBlock);
        if (input.recordFeedback !== false)
            await this.recordRetrieved(blocks);
        return {
            blocks,
            items: result.items,
            suppressed: result.suppressed,
        };
    }
    /** P2-4/P6-4: feedback for blocks admitted by the runtime. Preparation can
     * stop waiting for pure retrieval; this write must be awaited to completion. */
    async recordRetrieved(blocks) {
        const tokensById = new Map();
        for (const block of blocks) {
            const id = memoryIdsOfBlocks([block])[0];
            if (id !== undefined)
                tokensById.set(id, (tokensById.get(id) ?? 0) + block.tokens);
        }
        for (const [id, tokens] of tokensById) {
            await this.applyFeedback(id, { kind: "retrieved" });
            const entry = this.roi.get(id) ?? { tokens: 0, injected: 0, succeeded: 0 };
            entry.tokens += tokens;
            entry.injected += 1;
            this.roi.set(id, entry);
        }
    }
    /** P2-4: a memory block entered the model context (injectedCount++). */
    async recordInjected(memoryIds) {
        for (const id of memoryIds) {
            await this.applyFeedback(id, { kind: "injected" });
        }
    }
    /** P2-4: terminal outcome feedback. On a succeeded turn the memories that
     *  were injected get `used` + `taskSucceeded` (observable evidence: the
     *  surrounding task succeeded); on failure the funnel stays silent —
     *  "used" would be a guess. */
    async recordOutcome(memoryIds, feedback) {
        if (!feedback.succeeded)
            return;
        for (const id of memoryIds) {
            await this.applyFeedback(id, { kind: "used" });
            await this.applyFeedback(id, { kind: "taskSucceeded" });
            const entry = this.roi.get(id) ?? { tokens: 0, injected: 0, succeeded: 0 };
            entry.succeeded += 1;
            this.roi.set(id, entry);
        }
    }
    /** P6-4: token ROI per memory entry — successes per 1k injected tokens.
     *  Pure accounting of this process's retrievals; persistence is the memory
     *  store's usefulness fields. */
    tokenROI() {
        return [...this.roi.entries()].map(([memoryId, entry]) => ({
            memoryId,
            tokens: entry.tokens,
            injected: entry.injected,
            succeeded: entry.succeeded,
            roiPer1k: entry.tokens > 0 ? (entry.succeeded / entry.tokens) * 1000 : 0,
        }));
    }
    /** P13-4 (challenger bridge): suggest memory topK from observed token ROI.
     *  Pure passthrough of suggestMemoryTopK over this bridge's ROI ledger; the
     *  harness keeps using the configured/fixed topK until a benchmark gate
     *  promotes adaptive topK (default behaviour is UNCHANGED). */
    suggestTopK() {
        const roi = this.tokenROI().map(({ roiPer1k }) => ({ roiPer1k }));
        return suggestMemoryTopK(roi, this.topK);
    }
    /** Apply one immutable usefulness update and persist it. */
    async applyFeedback(id, feedback) {
        try {
            const entry = await this.store.get(id);
            if (entry === undefined || entry.deleted)
                return;
            await this.store.update(recordUsefulness(entry, feedback));
        }
        catch (err) {
            // P14-6: feedback must never break the turn (missing/race-deleted
            // entry) — reported, never silent.
            process.stderr.write(`[degraded] memory.usefulness.update: ${err instanceof Error ? err.message : String(err)}\n`);
        }
    }
    async close() {
        const closer = this.store.close;
        if (typeof closer === "function")
            await closer();
    }
}
/** Normalize bridge entries for injection: dedupe, strip the memory: prefix. */
export function memoryIdsOfBlocks(blocks) {
    const ids = [];
    for (const block of blocks) {
        const id = block.id.startsWith(MEMORY_BLOCK_PREFIX)
            ? block.id.slice(MEMORY_BLOCK_PREFIX.length)
            : block.id;
        if (id.length > 0 && !ids.includes(id))
            ids.push(id);
    }
    return ids;
}
/** Fetch full entries for a set of ids (feedback targets). Missing entries
 *  are skipped silently (deleted mid-turn). */
export async function entriesForIds(store, ids) {
    const out = [];
    for (const id of ids) {
        try {
            const entry = await store.get(id);
            if (entry !== undefined && !entry.deleted)
                out.push(entry);
        }
        catch (err) {
            // P14-6: best effort — reported, never silent.
            process.stderr.write(`[degraded] memory.entriesForIds.get: ${err instanceof Error ? err.message : String(err)}\n`);
        }
    }
    return out;
}
//# sourceMappingURL=memory-runtime-bridge.js.map