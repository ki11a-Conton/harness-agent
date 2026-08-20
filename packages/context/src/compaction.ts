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
    timestamp: now(),
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