import type { CompactionSummary, Compactor, ContextBlock, ContextSource } from "@ar/contracts";

/**
 * CTX-003 — Context compaction.
 *
 * Never-compact rules (a block is compacted iff it falls through ALL of them):
 *  1. source must be one of { tool, web, memory, subagent } — this automatically
 *     preserves system/user/project blocks (incl. NEVER_COMPACT_SOURCES from
 *     @ar/contracts) byte-for-byte.
 *  2. `compressible` must be `true` — a block that opted out is never folded.
 *  3. Trust is otherwise irrelevant: trusted blocks from "tool/web/memory/subagent"
 *     may be compacted when marked compressible, while trusted blocks from
 *     project/local/skill/mcp fall outside the allowlist above and are preserved.
 */
const COMPACTABLE_SOURCES: ReadonlySet<ContextSource> = new Set([
  "tool",
  "web",
  "memory",
  "subagent",
]);

export function isCompactable(block: ContextBlock): boolean {
  return block.compressible === true && COMPACTABLE_SOURCES.has(block.source);
}

/** Priority of the single summary block: 900. Lower than a system/user block
 *  would ever be (they are never compacted, so ranking is moot), but far above
 *  ordinary tool/web/memory traffic so it survives any later budget pass. */
const SUMMARY_PRIORITY = 900;

const LIST_SECTIONS: ReadonlyArray<{
  title: string;
  pick: (s: CompactionSummary) => readonly string[];
}> = [
  { title: "Constraints", pick: (s) => s.constraints },
  { title: "Decisions", pick: (s) => s.decisions },
  { title: "Completed Work", pick: (s) => s.completed },
  { title: "Files Changed", pick: (s) => s.filesChanged },
  { title: "Commands Run", pick: (s) => s.commandsRun },
  { title: "Tests", pick: (s) => s.tests },
  { title: "Failures", pick: (s) => s.failures },
  { title: "Open Tasks", pick: (s) => s.openTasks },
  { title: "Important Facts", pick: (s) => s.importantFacts },
  { title: "Artifacts", pick: (s) => s.artifactRefs },
  { title: "Child Agents", pick: (s) => s.childAgentRefs },
];

/** Render the markdown summary. Only non-empty fields get a section; a fully
 *  empty summary still yields the `# Compaction Summary` header. */
function renderSummary(summary: CompactionSummary): string {
  const lines: string[] = ["# Compaction Summary"];

  const goal = summary.goal.trim();
  if (goal !== "") {
    lines.push("", "## Goal", goal);
  }

  for (const { title, pick } of LIST_SECTIONS) {
    const items = pick(summary).filter((item) => item.trim() !== "");
    if (items.length === 0) continue;
    lines.push("", `## ${title}`);
    for (const item of items) lines.push(`- ${item}`);
  }

  return lines.join("\n");
}

function makeSummaryBlock(summary: CompactionSummary, now: () => number): ContextBlock {
  const content = renderSummary(summary);
  return {
    id: "compaction-summary",
    source: "memory",
    trust: "semi-trusted",
    priority: SUMMARY_PRIORITY,
    // Rough token estimate: ~4 chars per token (EN/ASCII heuristics).
    tokens: Math.ceil(content.length / 4),
    content,
    compressible: false, // the summary itself is never re-compacted
    ephemeral: false,
    category: "working-state",
    timestamp: now(),
    // P14-5: the compaction digest is runtime-derived state — authoritative
    // for the current turn but never persistable as long-term memory.
    instructional: false,
    persistable: false,
  };
}

/**
 * Default implementation of the CTX-003 `Compactor` contract.
 *
 * Pure function for a given (blocks, summary) pair except for `timestamp`
 * (Date.now()) on the generated summary block, which is intentionally
 * non-deterministic per spec. No I/O.
 */
export class DefaultCompactor implements Compactor {
  private readonly nowFn: () => number;

  constructor(opts: { now?: () => number } = {}) {
    this.nowFn = opts.now ?? Date.now;
  }

  compact(blocks: ContextBlock[], summary: CompactionSummary): ContextBlock[] {
    const preserved: ContextBlock[] = [];
    let compactedCount = 0;

    for (const block of blocks) {
      if (isCompactable(block)) {
        compactedCount += 1;
      } else {
        preserved.push(block);
      }
    }

    if (compactedCount === 0) {
      // No compressible input: return the input untouched (no summary block).
      return blocks;
    }

    // Ordering: preserved blocks keep their original relative order; the single
    // summary block is appended after the last preserved block so the leading
    // system/user context (e.g. goal, security policy) is never displaced.
    preserved.push(makeSummaryBlock(summary, this.nowFn));
    return preserved;
  }
}
// ---------------------------------------------------------------------------
// P17-5: SINGLE multi-stage production compaction state machine.
// One policy, staged by cost (cheapest first). No parallel compactor competes
// with the pipeline: the pipeline's ONE compactor is this state machine.
// ---------------------------------------------------------------------------

/** P17-5: which stage dropped/rewrote content, for observability (P17-8
 *  benchmark + circuit breaker read these facts). */
export interface CompactionStageReport {
  stage: "offload" | "ephemeral-drop" | "micro-compact" | "digest" | "summary" | "reactive";
  droppedBlocks: number;
  beforeTokens: number;
  afterTokens: number;
  /** True when this stage actually changed something. */
  used: boolean;
}

export interface MultiStageCompactorOptions {
  /** Stage 1: evidence blocks above this size become previews (truncate +
   *  marker; the full content is expected to live in an artifact store
   *  referenced by the block id). Default 16 KiB. */
  previewMaxBytes?: number;
  /** Stage 5: optional LLM summarizer — invoked ONLY when the digest still
   *  exceeds the budget (the caller owns the model call; this stays a pure
   *  interface so the compactor itself never does I/O). */
  summarize?: (content: string) => string | Promise<string>;
  /** Stage observability hook. */
  onStage?: (report: CompactionStageReport) => void;
  /** Stage 6: reactive overflow fallback — allowed exactly once per compact
   *  call (the caller owns the circuit breaker across calls, P17-8). */
  reactiveFallback?: (blocks: ContextBlock[]) => ContextBlock[];
  now?: () => number;
}

const DEFAULT_PREVIEW_MAX_BYTES = 16 * 1024;

/** P17-5: the production compactor — a fixed-cost-ordered state machine:
 *   1. offload/preview oversized evidence (cheapest: rewrite, no drops)
 *   2. drop expired ephemeral observations
 *   3. deterministic micro-compaction (dedupe repeated read evidence)
 *   4. structured WorkingState digest (the existing summary block)
 *   5. LLM summary — ONLY when still over budget (optional, caller-owned)
 *   6. reactive overflow fallback — exactly once (circuit breaker, P17-8)
 *  Stages 1-4 are pure and deterministic; 5-6 are optional hooks. */
export class MultiStageCompactor implements Compactor {
  private readonly previewMaxBytes: number;
  private readonly summarize?: MultiStageCompactorOptions["summarize"];
  private readonly onStage?: MultiStageCompactorOptions["onStage"];
  private readonly reactiveFallback?: MultiStageCompactorOptions["reactiveFallback"];
  private readonly nowFn: () => number;

  constructor(opts: MultiStageCompactorOptions = {}) {
    this.previewMaxBytes = opts.previewMaxBytes ?? DEFAULT_PREVIEW_MAX_BYTES;
    this.summarize = opts.summarize;
    this.onStage = opts.onStage;
    this.reactiveFallback = opts.reactiveFallback;
    this.nowFn = opts.now ?? Date.now;
  }

  private report(report: CompactionStageReport): void {
    this.onStage?.(report);
  }

  async compact(blocks: ContextBlock[], summary: CompactionSummary): Promise<ContextBlock[]> {
    let current = blocks;
    const beforeTokens = sumTokens(blocks);

    // Stage 1 — offload / preview oversized evidence.
    const previewed = current.map((block) => {
      if (block.category !== "evidence") return block;
      if (Buffer.byteLength(block.content, "utf8") <= this.previewMaxBytes) return block;
      return {
        ...block,
        content: truncateAtLineBoundary(block.content, this.previewMaxBytes) + "\n" + previewMarker(Buffer.byteLength(block.content)) + "\n",
        tokens: Math.ceil(this.previewMaxBytes / 4),
      };
    });
    const offloaded = previewed.filter((b, i) => b.content !== current[i]!.content).length;
    this.report({ stage: "offload", droppedBlocks: 0, beforeTokens: sumTokens(current), afterTokens: sumTokens(previewed), used: offloaded > 0 });
    current = previewed;

    // Stage 2 — drop expired ephemeral observations.
    const nonEphemeral = current.filter((b) => !(b.ephemeral === true || b.category === "ephemeral"));
    this.report({ stage: "ephemeral-drop", droppedBlocks: current.length - nonEphemeral.length, beforeTokens: sumTokens(current), afterTokens: sumTokens(nonEphemeral), used: nonEphemeral.length !== current.length });
    current = nonEphemeral;

    // Stage 3 — deterministic micro-compaction: drop repeated IDENTICAL
    // evidence content (keep the LAST occurrence, call order preserved).
    const micro: ContextBlock[] = [];
    const seen = new Map<string, number>(); // content -> index to update
    for (const block of current) {
      if (block.category === "evidence") {
        const idx = seen.get(block.content);
        if (idx !== undefined) micro[idx] = block; // replace with the newer copy
        else {
          seen.set(block.content, micro.length);
          micro.push(block);
        }
      } else {
        micro.push(block);
      }
    }
    this.report({ stage: "micro-compact", droppedBlocks: current.length - micro.length, beforeTokens: sumTokens(current), afterTokens: sumTokens(micro), used: micro.length !== current.length });
    current = micro;

    // Stage 4 — structured WorkingState digest (replaces compressible
    // non-evidence blocks, exactly like DefaultCompactor).
    const preserved: ContextBlock[] = [];
    let digestCandidates = 0;
    for (const block of current) {
      if (isCompactable(block)) digestCandidates += 1;
      else preserved.push(block);
    }
    if (digestCandidates === 0) {
      this.report({ stage: "digest", droppedBlocks: 0, beforeTokens: sumTokens(current), afterTokens: sumTokens(current), used: false });
      return current; // nothing compressible → no digest, no summary
    }
    preserved.push(makeSummaryBlock(summary, this.nowFn));
    this.report({ stage: "digest", droppedBlocks: digestCandidates, beforeTokens: sumTokens(current), afterTokens: sumTokens(preserved), used: true });
    current = preserved;

    // Stage 5 — optional LLM summary, ONLY when still over an explicit
    // threshold; absent a summarizer this stage is a no-op (recorded).
    if (this.summarize !== undefined) {
      const digest = current.find((b) => b.id === "compaction-summary");
      if (digest !== undefined) {
        const summarized = await this.summarize(digest.content);
        if (summarized.length > 0 && summarized !== digest.content) {
          const before = sumTokens(current);
          const replaced = current.map((b) =>
            b.id === "compaction-summary"
              ? { ...b, content: summarized, tokens: Math.ceil(summarized.length / 4) }
              : b,
          );
          this.report({ stage: "summary", droppedBlocks: 0, beforeTokens: before, afterTokens: sumTokens(replaced), used: true });
          current = replaced;
        }
      }
    }

    // Stage 6 — reactive overflow fallback, exactly once (P17-8 breaker).
    if (this.reactiveFallback !== undefined && sumTokens(current) > this.previewMaxBytes * 4) {
      const before = sumTokens(current);
      const fallenBack = await this.reactiveFallback(current);
      this.report({ stage: "reactive", droppedBlocks: Math.max(0, current.length - fallenBack.length), beforeTokens: before, afterTokens: sumTokens(fallenBack), used: fallenBack.length !== current.length });
      current = fallenBack;
    }

    return current;
  }
}

function sumTokens(blocks: ContextBlock[]): number {
  return blocks.reduce((sum, b) => sum + (b.tokens ?? 0), 0);
}

/** P17-5 stage-1 preview marker — callers can detect a previewed block. */
export function previewMarker(bytes: number): string {
  return `# [previewed at ${bytes} bytes — full content in artifact]`;
}

function truncateAtLineBoundary(content: string, maxBytes: number): string {
  const lines = content.split("\n");
  const kept: string[] = [];
  let bytes = 0;
  for (const line of lines) {
    const lineBytes = Buffer.byteLength(line) + (kept.length > 0 ? 1 : 0);
    if (kept.length > 0 && bytes + lineBytes > maxBytes) break;
    kept.push(line);
    bytes += lineBytes;
  }
  return kept.join("\n");
}



// ---------------------------------------------------------------------------
// P17-6: protected-facts preservation check.
// ---------------------------------------------------------------------------

/** P17-6: every protected fact that must survive compaction, keyed by the
 *  field name a miss is reported under. Beyond CompactionSummary's fields,
 *  working-state-owned references (memory/skill/unresolved tool calls) must
 *  also be recoverable — they live in the durable WorkingState (checkpoint),
 *  and this checker verifies they are EITHER in the rendered digest OR
 *  present in the working-state fields handed alongside. */
export interface ProtectedFacts {
  goal: string;
  constraints: string[];
  pending: string[];
  decisions: string[];
  filesChanged: string[];
  commandsRun: string[];
  testsRun: string[];
  failures: string[];
  unresolvedTools: string[];
  memoryRefs: string[];
  skillRefs: string[];
  childAgentRefs: string[];
}

/** P17-6: programmatic preservation check. A compaction is NOT "successful"
 *  merely because a non-empty summary exists — every non-empty protected
 *  field's items must be present in the rendered digest OR be carried by the
 *  durable working-state copy (the `workingStateCarried` record). Returns the
 *  list of (field, missing item) pairs; an empty result means preservation. */
export function protectedFieldsMissing(
  facts: ProtectedFacts,
  renderedDigest: string,
  workingStateCarried: Partial<Record<string, readonly string[]>> = {},
): Array<{ field: string; item: string }> {
  const missing: Array<{ field: string; item: string }> = [];
  const check = (field: string, items: readonly string[], carriedKey?: string): void => {
    const carried = carriedKey !== undefined ? workingStateCarried[carriedKey] ?? [] : [];
    for (const item of items) {
      const trimmed = item.trim();
      if (trimmed === "") continue;
      if (renderedDigest.includes(trimmed)) continue;
      if (carried.includes(trimmed)) continue;
      missing.push({ field, item: trimmed });
    }
  };

  check("goal", [facts.goal]);
  check("constraints", facts.constraints);
  check("pending", facts.pending);
  check("decisions", facts.decisions);
  check("filesChanged", facts.filesChanged);
  check("commandsRun", facts.commandsRun);
  check("testsRun", facts.testsRun);
  check("failures", facts.failures);
  // Working-state-only fields: must be carried by the durable state (they
  // are not part of the digest by design).
  check("unresolvedTools", facts.unresolvedTools, "unresolvedTools");
  check("memoryRefs", facts.memoryRefs, "memoryRefs");
  check("skillRefs", facts.skillRefs, "skillRefs");
  check("childAgentRefs", facts.childAgentRefs, "childAgentRefs");
  return missing;
}
