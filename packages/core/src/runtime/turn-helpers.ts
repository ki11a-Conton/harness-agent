/**
 * Q-1: stateless helpers extracted from runtime.ts. Holding these outside the
 * AgentRuntime class keeps the loop focused on orchestration and gives the
 * pure logic independent, deterministic unit coverage. None of these functions
 * read instance state — any derived value is passed in explicitly, so behavior
 * is byte-for-byte identical to when they lived as class methods / module
 * functions in runtime.ts.
 */

import { errorInfo, DEFAULT_TOOL_SEMANTICS } from "@ar/contracts";
import type {
  AgentDefinition,
  CompactionSummary,
  ContextBlock,
  EffectiveAgentConfig,
  Message,
  ModelFinalResult,
  Session,
  SessionId,
  ToolCall,
  ToolCallId,
  ToolExecutionRecord,
  ToolResult,
  ToolSemantics,
  TurnId,
  UnresolvedToolExecution,
  WorkingState,
} from "@ar/contracts";
import { estimateMessageTokens } from "@ar/context";

/**
 * Q-1: immutable per-turn context. Bundles the five values resolved once at the
 * start of `runTurn` and passed (unchanged) to every private method. Packaging
 * them as a single object reduces parameter noise and makes the dependency
 * surface explicit for the later controller extraction. None of these fields
 * are reassigned during the turn; `state` / `working` / `toolLedger` are shared
 * mutable accumulators and stay as separate parameters.
 */
export interface TurnContext {
  readonly sessionId: SessionId;
  readonly turnId: TurnId;
  readonly signal: AbortSignal;
  readonly session: Session;
  readonly agent: AgentDefinition;
}

/** Tool output rendered as a string the model can read. Non-success results
 *  become a bracketed status line; success output is the raw string, a JSON
 *  dump for structured values, or an empty string for undefined/null. */
export function renderToolResult(result: ToolResult): string {
  if (result.status !== "success") {
    return `[${result.status}] ${result.error?.message ?? "no error detail"}`;
  }
  const out = result.output;
  if (typeof out === "string") return out;
  if (out === undefined || out === null) return "";
  try {
    return JSON.stringify(out);
  } catch {
    return String(out);
  }
}

/** P0-1: shape guard for the persisted effective-agent snapshot. */
export function isEffectiveAgentConfig(v: unknown): v is EffectiveAgentConfig {
  if (typeof v !== "object" || v === null) return false;
  const c = v as Record<string, unknown>;
  return (
    typeof c.agentId === "string" &&
    typeof c.systemPrompt === "string" &&
    typeof c.tools === "object" &&
    c.tools !== null &&
    typeof c.permissions === "object" &&
    c.permissions !== null &&
    typeof c.skills === "object" &&
    c.skills !== null &&
    typeof c.limits === "object" &&
    c.limits !== null &&
    typeof c.model === "object" &&
    c.model !== null &&
    typeof (c.model as Record<string, unknown>).providerId === "string"
  );
}

/** P1-11: built-in semantics that preserve the historical behavior when the
 *  host does not inject a lookup. Real hosts pass semanticsOf(toolRegistry)
 *  instead — this registry only exists so unconfigured runtimes keep their
 *  side-effect/checkpoint boundaries. */
export const DEFAULT_RUNTIME_TOOL_SEMANTICS: Readonly<Record<string, ToolSemantics>> = {
  write_file: {
    ...DEFAULT_TOOL_SEMANTICS,
    readOnly: false,
    idempotent: false,
    retrySafety: "none",
    sideEffectScope: "filesystem",
  },
  edit_file: {
    ...DEFAULT_TOOL_SEMANTICS,
    readOnly: false,
    idempotent: false,
    retrySafety: "none",
    sideEffectScope: "filesystem",
  },
  exec: {
    ...DEFAULT_TOOL_SEMANTICS,
    readOnly: false,
    retrySafety: "unknown",
    sideEffectScope: "process",
    networkBehavior: "outbound",
  },
};

/** P1-1: tool effects recorded into the working state (the single run-state
 *  structure). Filesystem-scoped write tools become filesChanged; process
 *  tools become commandsRun (test-looking commands also testsRun);
 *  failed/timeout/denied results become failures. All scope decisions come
 *  from the tool's execution semantics — never from its name. */
export function updateWorkingState(
  call: ToolCall,
  result: ToolResult,
  working: WorkingState,
  semantics: ToolSemantics,
): void {
  if (semantics.sideEffectScope === "filesystem" && typeof call.args.path === "string") {
    if (result.status === "success") {
      working.filesChanged.push(call.args.path);
      working.completed.push(`modified ${call.args.path}`);
    }
  } else if (semantics.sideEffectScope === "process" && typeof call.args.command === "string") {
    working.commandsRun.push(call.args.command);
    if (/test/i.test(call.args.command)) working.testsRun.push(call.args.command);
  }
  if (result.status === "failed" || result.status === "timeout" || result.status === "denied") {
    working.failures.push(`${call.name}: ${result.error?.message ?? result.status}`);
  }
}

/** P1-1/P1-2: derive the compaction view (CompactionSummary) from the working
 *  state. The pipeline consumes this instead of synthesizing a summary;
 *  P1-2 completes the mapping with the fields that must survive compaction
 *  (completed work, artifact refs, child-agent refs). Empty lists stay empty
 *  (the compactor omits empty sections, so a sparse state yields a sparse
 *  summary). */
export function workingStateToCompactionSummary(working: WorkingState): CompactionSummary {
  return {
    goal: working.goal,
    constraints: working.constraints,
    decisions: working.decisions,
    completed: working.completed,
    filesChanged: working.filesChanged,
    commandsRun: working.commandsRun,
    tests: working.testsRun,
    failures: working.failures,
    openTasks: working.pending,
    importantFacts: working.importantFacts,
    artifactRefs: working.artifactRefs,
    childAgentRefs: working.childAgentRefs,
  };
}

/** P1-4: the resume prompt handed to the model. Resume is deliberately NOT a
 *  full-transcript replay (plan §1258): the model gets the restored working
 *  state, the side effects that already happened (must not be redone) and the
 *  started-but-unconfirmed tools (must be reconciled, never blindly rerun). */
export function buildResumePrompt(
  working: WorkingState,
  committedSideEffects: ToolExecutionRecord[],
  unresolvedTools: UnresolvedToolExecution[],
): string {
  const list = (items: readonly string[], empty: string): string =>
    items.length > 0 ? items.map((item) => `- ${item}`).join("\n") : empty;

  const lines: string[] = [
    "[Session resumed after an interruption — durable checkpoint recovered]",
    "The task below was interrupted mid-run. The state listed here is authoritative;",
    "continue from it. Do NOT re-run anything listed under Committed side effects.",
    "## Goal",
    working.goal,
    "## Completed Work",
    list(working.completed, "- (none)"),
    "## Pending Work",
    list(working.pending, "- (none)"),
  ];
  if (working.filesChanged.length > 0) {
    lines.push("## Files Changed", list(working.filesChanged, "-"));
  }
  if (working.commandsRun.length > 0) {
    lines.push("## Commands Run", list(working.commandsRun, "-"));
  }
  if (working.failures.length > 0) {
    lines.push("## Failures", list(working.failures, "-"));
  }
  if (working.importantFacts.length > 0) {
    lines.push("## Important Facts", list(working.importantFacts, "-"));
  }
  if (working.decisions.length > 0) {
    lines.push("## Decisions", list(working.decisions, "-"));
  }
  lines.push(
    "## Committed side effects (already applied — do NOT redo)",
    committedSideEffects.length > 0
      ? committedSideEffects
          .map((e) => `- ${e.tool}${e.status === "failed" ? " [failed]" : ""}`)
          .join("\n")
      : "- (none)",
    "## Unresolved tool executions (started; outcome unknown — reconcile, do not blindly re-execute)",
    unresolvedTools.length > 0
      ? unresolvedTools
          .map((e) => `- ${e.tool}${e.sideEffect ? " [may have side effect]" : ""}`)
          .join("\n")
      : "- (none)",
    ...(working.openQuestions.length > 0 ? ["## Open Questions", list(working.openQuestions, "-")] : []),
    "",
    "Continue the task.",
  );
  return lines.join("\n");
}

/** Context-length model errors (API 413 / "maximum context length") — the
 *  signal for reactive compact, never blind retries. */
export function isContextOverflowError(info: ReturnType<typeof errorInfo>): boolean {
  const haystack = `${info.code} ${info.message}`;
  return /context|token|maximum|too (long|large)|413|prompt is too|length/i.test(haystack);
}

/** LOOP-001: tool result rendered as a compressible context block so the
 *  context pipeline can budget and compact it on overflow. `contentOverride`
 *  carries the output-budgeted rendering when one applies. */
export function toContextBlock(toolCallId: string, result: ToolResult, contentOverride?: string): ContextBlock {
  const content = contentOverride ?? renderToolResult(result);
  return {
    id: `tool:${toolCallId}`,
    source: "tool",
    trust: "semi-trusted",
    priority: 0,
    tokens: Math.ceil(Buffer.byteLength(content, "utf8") / 4),
    content,
    compressible: true,
    ephemeral: true,
  };
}

/** Structured state digest for compaction (plan.md Phase 4.4): what the
 *  model must remember after older tool outputs are folded away. Rendered
 *  from the single working state (P1-1) — no parallel journal. */
export function buildStateDigest(working: WorkingState, reason: string): string {
  const lines: string[] = [
    `[${reason} — the full transcript is preserved on disk; retrieve details with read_file/search_files as needed]`,
    "## User Goal / Exact User Requirements",
    working.goal,
    "## Completed Work",
    working.filesChanged.length > 0
      ? working.filesChanged.map((f) => `- modified ${f}`).join("\n")
      : "- (none yet)",
    "## Commands / Tests Run",
    working.commandsRun.length > 0
      ? working.commandsRun.map((c) => `- ${c}`).join("\n")
      : "- (none)",
    "## Errors Encountered",
    working.failures.length > 0
      ? working.failures.map((f) => `- ${f}`).join("\n")
      : "- (none)",
  ];
  return lines.join("\n");
}

/**
 * Phase 8 message-history trim: drop the OLDEST messages until the history
 * fits `headroomTokens`, always keeping the most recent tail (the digest
 * message, the current turn's context and the latest tool results). The
 * store keeps the full transcript — this only bounds what the model sees.
 */
export function trimMessageHistory(
  history: readonly Message[],
  headroomTokens: number,
): Message[] {
  const MIN_KEEP = 4;
  let kept = [...history];
  while (kept.length > MIN_KEEP && estimateMessageTokens(kept) > headroomTokens) {
    kept = kept.slice(1);
  }
  return kept;
}

// ── Q-1: model-call retry decision (pure) ─────────────────────────

/** Q-1: what the model-call retry loop should do after a model attempt. The
 *  decision is pure; the caller performs side effects (emit, checkpoint, sleep)
 *  based on the returned action. */
export type ModelRetryAction =
  | { action: "success" }
  | { action: "compact-and-retry" }
  | { action: "retry"; retryDelayMs: number }
  | { action: "fail"; maxAttempts: number; reason: string; suppressLimitEvent?: boolean };

/** Q-1: pure decision extracted from the model-call retry loop. Given the model
 *  error (or undefined for success), whether reactive compact already happened,
 *  and the recovery policy's decision (or undefined if no policy), returns the
 *  action the loop should take. Side effects stay in the caller.
 *
 *  Structurally compatible with RecoveryPolicy.decide() output — accepts any
 *  object with the relevant fields, keeping turn-helpers decoupled from the
 *  recovery module. */
export function decideModelRetry(
  modelFailed: ReturnType<typeof errorInfo> | undefined,
  reactiveCompacted: boolean,
  recovery: { action: string; retryDelayMs?: number; maxAttempts: number; reason: string } | undefined,
  attempt: number,
): ModelRetryAction {
  if (modelFailed === undefined) return { action: "success" };

  if (isContextOverflowError(modelFailed)) {
    if (!reactiveCompacted) return { action: "compact-and-retry" };
    return { action: "fail", maxAttempts: 1, reason: "context overflow after reactive compact", suppressLimitEvent: true };
  }

  if (recovery !== undefined && recovery.action === "retry") {
    return { action: "retry", retryDelayMs: recovery.retryDelayMs ?? 0 };
  }

  return {
    action: "fail",
    maxAttempts: recovery?.maxAttempts ?? 1,
    reason: recovery?.reason ?? `model_error on attempt ${attempt}; no recovery policy configured`,
  };
}

/** Q-1: result of the model-call retry loop. The caller handles finishTurn for
 *  cancelled/failed; on completed it runs post-completion processing (append
 *  message, model.completed event, verification gate). */
export type ModelCallResult =
  | {
      status: "completed";
      assistantText: string;
      calls: ToolCall[];
      final: ModelFinalResult | undefined;
      callStartedAt: number;
      timeToFirstTokenMs: number | undefined;
      reactiveCompacted: boolean;
    }
  | { status: "cancelled" }
  | { status: "failed"; error: ReturnType<typeof errorInfo> };