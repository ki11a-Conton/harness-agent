import type {
  BudgetPlanner,
  CompactionSummary,
  Compactor,
  ContextBlock,
  ContextBudget,
  ContextReport,
  DiscoveredInstruction,
  InstructionDiscovery,
  InstructionDiscoveryOptions,
} from "@ar/contracts";
import { BudgetPlannerImpl } from "./budget.js";
import { DefaultCompactor } from "./compaction.js";
import { HierarchicalInstructionDiscovery } from "./discovery.js";
import { detectPromptInjection } from "@ar/security";

export interface ContextPipelineDeps {
  /** Default: new HierarchicalInstructionDiscovery(). */
  discovery?: InstructionDiscovery;
  /** Default: new BudgetPlannerImpl(). */
  planner?: BudgetPlanner;
  /** Default: new DefaultCompactor(). */
  compactor?: Compactor;
}

/** P0-8: a low-trust content source rejected for prompt injection during
 *  context assembly. The runtime turns each entry into a
 *  security.injection_denied event; the content itself never becomes a block. */
export type ContextInjectionSource =
  | "project"
  | "skill"
  | "tool"
  | "memory"
  | "web"
  | "mcp"
  | "subagent";

export interface ContextInjection {
  id: string;
  source: ContextInjectionSource;
  reasons: string[];
}

export interface ContextPipelineResult {
  /** Final blocks for the runtime to splice into the system prompt. */
  blocks: ContextBlock[];
  /** Budget report for this build (used/available/dropped/compressed). */
  report: ContextReport;
  /** Whether compaction ran in this build. */
  compacted: boolean;
  /** The summary block when compacted (runtime traceability). */
  summary?: ContextBlock;
  /** Raw discovery results (debugging/recording). */
  discovered: DiscoveredInstruction[];
  /** P0-8: low-trust sources rejected for prompt injection (never became
   *  blocks). Empty when every source passed the boundary check. */
  injected: ContextInjection[];
}

export interface ContextPipelineBuildOptions {
  cwd: string;
  /** System prompt; becomes a system source block, semantically never compactable. */
  systemPrompt: string;
  /** Skill index discovered by the host (Task 3): one block per skill, wedged
   *  between the system block and the project instruction blocks. */
  skills?: readonly { name: string; description: string }[];
  /** Process blocks accumulated across loop turns (tool results etc.). */
  priorBlocks: ContextBlock[];
  budget: ContextBudget;
  /** Passed through to the discovery step. */
  instructionOpts?: InstructionDiscoveryOptions;
  /**
   * Message history of the turn (Phase 8). Its token estimate is accounted
   * into the budget report (`report.messagesTokens`) so the runtime can
   * observe and trim it — but the messages are NOT part of the system-prompt
   * blocks and never admitted/compacted here.
   */
  messages?: readonly { role: string; content: string }[];
  /** P1-2: what must survive compaction, supplied by the host's working
   *  state. The pipeline only decides *when* to compact, *which* blocks to
   *  retain and the budget — it never synthesizes summary content. When a
   *  build overflows without an override, `build` rejects (fail-closed)
   *  instead of guessing; the runtime passes the WorkingState-derived
   *  summary on every turn. */
  summaryOverride?: CompactionSummary;
}

const SYSTEM_BLOCK_ID = "system-prompt";
/** Priority for project instruction blocks (CTX-001). */
const INSTRUCTION_PRIORITY = 1000;
/** Priority for skill index blocks: below system/project, above tool blocks. */
const SKILL_PRIORITY = 500;
/** Per-message structural overhead (role/formatting), added to the content bytes. */
const MESSAGE_OVERHEAD_TOKENS = 8;

/** Rough token estimate: ~4 bytes per token, matching the compactor heuristic
 *  but measured in UTF-8 bytes like CTX-001 does for its size budget. */
function estimateTokens(content: string): number {
  return Math.ceil(Buffer.byteLength(content, "utf8") / 4);
}

/**
 * Token estimate of a message history (Phase 8): per-message overhead plus
 * the content bytes. Shared by the pipeline (accounting) and the runtime
 * (trimming) so both use the same yardstick.
 */
export function estimateMessageTokens(messages: readonly { role: string; content: string }[]): number {
  return messages.reduce(
    (sum, message) => sum + MESSAGE_OVERHEAD_TOKENS + estimateTokens(message.content),
    0,
  );
}

/**
 * LOOP-001 — full-agent-loop context pipeline (CTX-001/002/003 assembly).
 *
 * Per model call the runtime calls `build` once: discovery produces project
 * instruction blocks, the system prompt is prepended as a system block, prior
 * loop blocks are merged, the budget planner admits what fits, and when the
 * budget overflows the compressible prior blocks are folded into a single
 * summary block so the loop stays sustainable.
 *
 * I/O discipline: only side effect is the async discovery step (file reads).
 * Planner and compactor are pure; discovery errors (invalid cwd) propagate to
 * the caller untouched.
 */
export class ContextPipeline {
  private readonly discovery: InstructionDiscovery;
  private readonly planner: BudgetPlanner;
  private readonly compactor: Compactor;

  constructor(deps: ContextPipelineDeps = {}) {
    this.discovery = deps.discovery ?? new HierarchicalInstructionDiscovery();
    this.planner = deps.planner ?? new BudgetPlannerImpl();
    this.compactor = deps.compactor ?? new DefaultCompactor();
  }

  async build(opts: ContextPipelineBuildOptions): Promise<ContextPipelineResult> {
    // 1. Discovery (async; its errors propagate).
    const discovered = await this.discovery.discover(opts.cwd, opts.instructionOpts);
    const injected: ContextInjection[] = [];

    // 2. Convert discovered instructions to blocks. The document path doubles
    //    as the block id (unique per document). Semantically never compactable.
    //    P0-8 trust boundary: repository documents are NOT verified — they are
    //    untrusted content. They enter the context as data only, and are
    //    rejected outright when they carry prompt-injection material (an
    //    untrusted file must never fake its way into authoritative policy).
    const instructionBlocks: ContextBlock[] = [];
    for (const doc of discovered) {
      const report = detectPromptInjection(doc.content);
      if (report.hasInjection) {
        injected.push({ id: doc.path, source: "project", reasons: report.reasons });
        continue;
      }
      instructionBlocks.push({
        id: doc.path,
        source: "project",
        trust: "untrusted",
        priority: INSTRUCTION_PRIORITY,
        tokens: estimateTokens(doc.content),
        content: doc.content,
        compressible: false,
        ephemeral: false,
        scope: doc.scope,
        path: doc.path,
      });
    }

    // 3. Skill index (Task 3): deduped by name (first occurrence wins), one
    //    deterministic line per skill. Marked compressible for compactors that
    //    recognize the source. P0-8: skill metadata is semi-trusted content —
    //    it is host-provided but external; descriptions that carry injection
    //    material are rejected instead of entering the index.
    const skillBlocks: ContextBlock[] = [];
    const seenSkillNames = new Set<string>();
    for (const skill of opts.skills ?? []) {
      if (seenSkillNames.has(skill.name)) continue;
      seenSkillNames.add(skill.name);
      const line =
        skill.description !== "" ? `- ${skill.name}: ${skill.description}` : `- ${skill.name}`;
      const report = detectPromptInjection(line);
      if (report.hasInjection) {
        injected.push({ id: `skill:${skill.name}`, source: "skill", reasons: report.reasons });
        continue;
      }
      skillBlocks.push({
        id: `skill:${skill.name}`,
        source: "skill",
        trust: "semi-trusted",
        priority: SKILL_PRIORITY,
        tokens: estimateTokens(line),
        content: line,
        compressible: true,
        ephemeral: false,
      });
    }

    // 4. Lead with the system prompt; never compactable, top priority.
    const systemBlock: ContextBlock = {
      id: SYSTEM_BLOCK_ID,
      source: "system",
      trust: "trusted",
      priority: Number.MAX_SAFE_INTEGER,
      tokens: estimateTokens(opts.systemPrompt),
      content: opts.systemPrompt,
      compressible: false,
      ephemeral: false,
    };

    // P0-8 trust boundary over every prior loop block (tool output, MCP /
    // subagent / memory / web content): these are semi-trusted or untrusted
    // DATA. Content that carries prompt-injection material is dropped here —
    // it can never become a block and can never fake its way into
    // authoritative policy. Only the authoritative channels (system/user,
    // both `trusted`) are exempt from scanning.
    const priorBlocks: ContextBlock[] = [];
    for (const block of opts.priorBlocks) {
      if (block.trust === "trusted") {
        priorBlocks.push(block);
        continue;
      }
      const report = detectPromptInjection(block.content);
      if (report.hasInjection) {
        injected.push({
          id: block.id,
          source: block.source as ContextInjectionSource,
          reasons: report.reasons,
        });
        continue;
      }
      priorBlocks.push(block);
    }

    // 5. Budget plan over system + skills + project + prior blocks.
    const plan = this.planner.plan(
      [systemBlock, ...skillBlocks, ...instructionBlocks, ...priorBlocks],
      opts.budget,
    );

    // Phase 8: account the message history into the budget report. It never
    // joins the selected blocks (messages are sent to the model by the
    // runtime, not spliced into the system prompt), but the runtime uses this
    // figure to trim the history before the call.
    const messagesTokens = opts.messages !== undefined ? estimateMessageTokens(opts.messages) : 0;

    // 6. Compact iff the plan could not fit everything. `plan.report.compressed`
    //    is always 0 from the planner today, but is part of the trigger for
    //    forward-compat with planners that pre-compress.
    const overflow =
      plan.dropped.length > 0 ||
      plan.report.used > opts.budget.maxTokens ||
      plan.report.compressed > 0;
    if (!overflow) {
      return {
        blocks: plan.selected,
        report: { ...plan.report, messagesTokens },
        compacted: false,
        discovered,
        injected,
      };
    }

    // P1-2: the pipeline never assembles summary content itself — what must
    // survive compaction comes from the host's working state. A build that
    // overflows without an override is a host wiring bug; reject it
    // fail-closed rather than guessing (goal = first system prompt line etc.
    // was the pre-P1-2 placeholder heuristic, removed for summary integrity).
    if (opts.summaryOverride === undefined) {
      throw new Error(
        "summaryOverride is required when the context budget overflows: the pipeline does not " +
          "synthesize placeholder summaries (P1-2); the host's working state owns what must survive",
      );
    }
    const summary = opts.summaryOverride;
    const blocks = this.compactor.compact(plan.selected, summary);

    // Report after compaction: `used` is recomputed over the final blocks and
    // `compressed` is set to 1 (one compaction happened this build). The other
    // fields are left as the planner reported them (dropped counts blocks the
    // planner dropped before compaction; `available` may be stale/negative and
    // is intentionally not patched here — the runtime can recompute if needed).
    const report: ContextReport = {
      ...plan.report,
      used: blocks.reduce((sum, block) => sum + block.tokens, 0),
      compressed: 1,
      messagesTokens,
    };

    return {
      blocks,
      report,
      compacted: true,
      summary: blocks.find((block) => block.id === "compaction-summary"),
      discovered,
      injected,
    };
  }
}
