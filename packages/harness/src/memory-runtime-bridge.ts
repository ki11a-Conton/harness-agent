// P2-1/P2-2/P2-4: memory runtime bridge — the only surface between the
// runtime and the memory package. Core never depends on @ar/memory; the
// harness composes this bridge and feeds it to the runtime as the
// `memoryBlocks` pre-turn retrieval provider (P2-2) and the feedback funnel
// (P2-4). Every model-visible memory is rendered as an advisory context block
// (source "memory", trust "semi-trusted") — never a raw DB row, and never
// authoritative policy.

import type {
  ContextBlock,
  MemoryEntry,
  MemoryId,
  MemoryScope,
  MemoryStore,
  SessionId,
} from "@ar/contracts";
import {
  retrieveMemories,
  recordUsefulness,
  type RankedMemoryItem,
  type SuppressedMemory,
} from "@ar/memory";
import { suggestMemoryTopK } from "@ar/learning";

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
export const MEMORY_BLOCK_PRIORITY = 400;
/** Block id prefix; the runtime strips it to recover the memory id. */
export const MEMORY_BLOCK_PREFIX = "memory:";

/** Rough token estimate (~4 bytes/token, matching the context package). */
export function estimateMemoryTokens(content: string): number {
  return Math.ceil(Buffer.byteLength(content, "utf8") / 4);
}

/** Render one ranked memory for the model (P2-2). Memories are advisory
 *  experience, never authority: the header states it explicitly, structured
 *  lessons are rendered as When/Do/Avoid, and confidence/evidence make the
 *  strength visible. */
export function renderMemoryForModel(item: RankedMemoryItem): string {
  const { memory } = item;
  const lines: string[] = ["[Prior experience — advisory, not authority]"];
  if (memory.structured !== undefined) {
    lines.push(`When: ${memory.structured.when}`);
    lines.push(`Do: ${memory.structured.do}`);
    if (memory.structured.avoid !== undefined && memory.structured.avoid !== "") {
      lines.push(`Avoid: ${memory.structured.avoid}`);
    }
  } else {
    lines.push(memory.content);
  }
  lines.push(`Confidence: ${Math.round(memory.confidence * 100)}%`);
  if (memory.evidence !== undefined) {
    lines.push(
      `Evidence count: ${memory.evidence.successCount + memory.evidence.failureCount}`,
    );
  }
  return lines.join("\n");
}

/** Convert a ranked memory item into a context block (P2-2). */
export function memoryToBlock(item: RankedMemoryItem): ContextBlock {
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
  private readonly store: MemoryStore;
  private readonly scope: MemoryScope;
  private readonly topK: number;
  private readonly now: () => number;
  // P6-4: token ROI bookkeeping — injection cost per memory entry vs task
  // success, so the retrieval self-optimization loop has real numbers.
  private readonly roi = new Map<MemoryId, { tokens: number; injected: number; succeeded: number }>();

  constructor(deps: MemoryRuntimeBridgeDeps) {
    this.store = deps.store;
    this.scope = deps.scope;
    this.topK = deps.topK ?? 5;
    this.now = deps.now ?? Date.now;
  }

  /** P2-2: pre-turn retrieval — scope-filtered, scored, deduped, topK. */
  async retrieve(input: {
    sessionId: SessionId;
    goal: string;
    cwd: string;
  }): Promise<RetrievedMemoryContext> {
    const query = input.goal.trim() === "" ? input.cwd : input.goal;
    const result = await retrieveMemories(this.store, query, this.scope, {
      k: this.suggestTopK(),
      now: this.now(),
    });
    // P2-4: retrieval is observable on the funnel (retrievedCount++).
    for (const item of result.items) {
      await this.applyFeedback(item.memory.id, { kind: "retrieved" });
      // P6-4: injection cost is a token fact (the block that entered context).
      const tokens = memoryToBlock(item).tokens;
      const entry = this.roi.get(item.memory.id) ?? { tokens: 0, injected: 0, succeeded: 0 };
      entry.tokens += tokens;
      entry.injected += 1;
      this.roi.set(item.memory.id, entry);
    }
    return {
      blocks: result.items.map(memoryToBlock),
      items: result.items,
      suppressed: result.suppressed,
    };
  }

  /** P2-4: a memory block entered the model context (injectedCount++). */
  async recordInjected(memoryIds: readonly MemoryId[]): Promise<void> {
    for (const id of memoryIds) {
      await this.applyFeedback(id, { kind: "injected" });
    }
  }

  /** P2-4: terminal outcome feedback. On a succeeded turn the memories that
   *  were injected get `used` + `taskSucceeded` (observable evidence: the
   *  surrounding task succeeded); on failure the funnel stays silent —
   *  "used" would be a guess. */
  async recordOutcome(memoryIds: readonly MemoryId[], feedback: MemoryOutcomeFeedback): Promise<void> {
    if (!feedback.succeeded) return;
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
  tokenROI(): { memoryId: MemoryId; tokens: number; injected: number; succeeded: number; roiPer1k: number }[] {
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
  suggestTopK(): number {
    const roi = this.tokenROI().map(({ roiPer1k }) => ({ roiPer1k }));
    return suggestMemoryTopK(roi, this.topK);
  }

  /** Apply one immutable usefulness update and persist it. */
  private async applyFeedback(
    id: MemoryId,
    feedback: Parameters<typeof recordUsefulness>[1],
  ): Promise<void> {
    try {
      const entry = await this.store.get(id);
      if (entry === undefined || entry.deleted) return;
      await this.store.update(recordUsefulness(entry, feedback));
    } catch (err) {
      // P14-6: feedback must never break the turn (missing/race-deleted
      // entry) — reported, never silent.
      process.stderr.write(`[degraded] memory.usefulness.update: ${err instanceof Error ? err.message : String(err)}\n`);
    }
  }

  async close(): Promise<void> {
    const closer = (this.store as { close?: () => Promise<void> }).close;
    if (typeof closer === "function") await closer();
  }
}

/** Normalize bridge entries for injection: dedupe, strip the memory: prefix. */
export function memoryIdsOfBlocks(blocks: readonly ContextBlock[]): MemoryId[] {
  const ids: MemoryId[] = [];
  for (const block of blocks) {
    const id = block.id.startsWith(MEMORY_BLOCK_PREFIX)
      ? block.id.slice(MEMORY_BLOCK_PREFIX.length)
      : block.id;
    if (id.length > 0 && !ids.includes(id as MemoryId)) ids.push(id as MemoryId);
  }
  return ids;
}

/** Fetch full entries for a set of ids (feedback targets). Missing entries
 *  are skipped silently (deleted mid-turn). */
export async function entriesForIds(
  store: MemoryStore,
  ids: readonly MemoryId[],
): Promise<MemoryEntry[]> {
  const out: MemoryEntry[] = [];
  for (const id of ids) {
    try {
      const entry = await store.get(id);
      if (entry !== undefined && !entry.deleted) out.push(entry);
    } catch (err) {
      // P14-6: best effort — reported, never silent.
      process.stderr.write(`[degraded] memory.entriesForIds.get: ${err instanceof Error ? err.message : String(err)}\n`);
    }
  }
  return out;
}
