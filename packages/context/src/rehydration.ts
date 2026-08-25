import type { CompactionSummary, ContextBlock } from "@ar/contracts";

/**
 * P17-7 post-compaction rehydration — after the digest folds older content
 * away, ONLY the high-value references are restored (never the full history):
 *
 *   - recent touched/read files  (bounded by maxFiles AND a token cap)
 *   - active plan (pending tasks)
 *   - selected/invoked skills
 *   - unresolved tool evidence
 *   - transcript/artifact pointers
 *
 * Every rehydrated block is compact, pointer-like, and rehydratable. The
 * caller (context pipeline) appends them right after a compaction that
 * actually dropped content; a non-compacted build never rehydrates.
 */

export interface RehydrationOptions {
  /** Max file references to rehydrate (plan: token/COUNT cap). Default 8. */
  maxFiles: number;
  /** Max token budget for ALL rehydrated blocks. Default 600. */
  maxTokens: number;
}

export const DEFAULT_REHYDRATION_OPTIONS: RehydrationOptions = {
  maxFiles: 8,
  maxTokens: 600,
};

const ESTIMATED_TOKENS = (content: string): number => Math.ceil(content.length / 4);

function block(
  id: string,
  content: string,
  priority: number,
  extra: Partial<ContextBlock> = {},
): ContextBlock {
  return {
    id,
    source: "memory", // rehydration points come from durable state
    trust: "semi-trusted",
    priority,
    tokens: ESTIMATED_TOKENS(content),
    content,
    compressible: true,
    ephemeral: false,
    category: "working-state",
    ...extra,
  };
}

/** P17-7: build the bounded rehydration block set from a compaction summary.
 *  Deterministic; the returned blocks never exceed maxFiles file references
 *  and maxTokens total. */
export function buildRehydrationBlocks(
  summary: CompactionSummary,
  opts: Partial<RehydrationOptions> = {},
): ContextBlock[] {
  const { maxFiles, maxTokens } = { ...DEFAULT_REHYDRATION_OPTIONS, ...opts };
  const out: ContextBlock[] = [];
  let usedTokens = 0;
  const push = (b: ContextBlock): void => {
    if (usedTokens + b.tokens > maxTokens) return;
    out.push(b);
    usedTokens += b.tokens;
  };

  // Recent files — bounded by maxFiles (pointer + modified state, no content).
  const recentFiles = [...summary.filesChanged, ...summary.artifactRefs];
  if (recentFiles.length > 0) {
    const files = recentFiles.slice(0, maxFiles);
    push(block("rehydrate:files", `## Files in play\n${files.map((f) => `- ${f}`).join("\n")}`, 800));
  }

  // Active plan (pending tasks) — the working set must stay visible.
  if (summary.openTasks.length > 0) {
    push(block(
      "rehydrate:plan",
      `## Active Plan\n${summary.openTasks.map((t) => `- ${t}`).join("\n")}`,
      850,
    ));
  }

  // Selected/invoked skills — the digest does not carry skill identity.
  const skills = summary.importantFacts.filter((f) => /^(?:skill|using|deploy|review)\b/i.test(f));
  if (skills.length > 0) {
    push(block("rehydrate:skills", `## Skills in Play\n${skills.map((s) => `- ${s}`).join("\n")}`, 700));
  }

  // Unresolved tool evidence — commands/tests that must be reconciled.
  if (summary.commandsRun.length > 0 || summary.tests.length > 0) {
    push(block(
      "rehydrate:unresolved",
      `## Recent Evidence\n${[...summary.commandsRun, ...summary.tests].map((c) => `- ${c}`).join("\n")}`,
      750,
    ));
  }

  // Transcript/artifact pointers — where the full history lives.
  const pointers = summary.artifactRefs.length > 0
    ? summary.artifactRefs.map((a) => `- artifact: ${a}`).join("\n")
    : "- full transcript preserved on disk";
  push(block("rehydrate:pointers", `## Refs\n${pointers}`, 600));

  return out;
}
