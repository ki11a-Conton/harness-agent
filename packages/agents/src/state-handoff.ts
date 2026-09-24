import type { ContextBlock, WorkingState } from "@ar/contracts";
import type { DelegationResult, SubagentFinding, TestRunRef } from "./delegation.js";

/**
 * P1-9 Parent / Child State Handoff.
 *
 * Two pure helpers that make the handoff explicit:
 *
 *   Parent WorkingState
 *        ↓ scopedContextFromWorkingState   (selected scoped context)
 *   Child WorkingState
 *        ↓ structured completion           (P1-8 DelegationResult)
 *   Parent merge                            (mergeChildCompletion)
 *
 * Forbidden: forking the entire parent transcript. The scoped context is
 * derived only from the parent's working state — never from messages.
 */

export interface ConflictRecord {
  path: string;
  detail: string;
}

export type MergeSkipReason = "failed" | "partial" | "duplicate" | "stale";

export interface MergeSkip {
  reason: MergeSkipReason;
  detail: string;
}

export interface MergeReport {
  /** Paths adopted from the child into the parent's filesChanged/artifactRefs. */
  mergedPaths: string[];
  adoptedFindings: SubagentFinding[];
  adoptedTestsRun: TestRunRef[];
  adoptedOpenQuestions: string[];
  adoptedNextActions: string[];
  /** Paths both parent and child modified — child's version is NOT applied. */
  conflicts: ConflictRecord[];
  skipped: MergeSkip[];
}

const MAX_CONTEXT_BLOCK_CHARS = 4000;
const MAX_SCOPED_ENTRIES = 20;
const DEFAULT_SCOPE = ["goal", "constraints", "plan", "decisions"] as const;

export interface ScopedContextOptions {
  /** Working-state sections to carry into the child. Defaults to
   *  goal/constraints/plan/decisions — the minimal necessary context. */
  include?: ReadonlySet<string>;
  maxBlockChars?: number;
  maxEntries?: number;
}

/** Minimal necessary context from the parent's working state. Never forks
 *  the parent transcript: only state sections are projected, each as a
 *  trusted system block. */
export function scopedContextFromWorkingState(
  state: WorkingState,
  opts: ScopedContextOptions = {},
): ContextBlock[] {
  const include = opts.include ?? new Set(DEFAULT_SCOPE);
  const maxChars = opts.maxBlockChars ?? MAX_CONTEXT_BLOCK_CHARS;
  const maxEntries = opts.maxEntries ?? MAX_SCOPED_ENTRIES;
  const blocks: ContextBlock[] = [];
  let used = 0;
  const push = (title: string, entries: string[]): void => {
    if (used >= maxEntries || entries.length === 0) return;
    const taken = entries.slice(0, maxEntries - used);
    let content = `# ${title}\n${taken.join("\n")}`;
    if (content.length > maxChars) content = content.slice(0, maxChars);
    blocks.push({
      id: `scoped:${blocks.length}`,
      source: "system",
      trust: "trusted",
      priority: 100,
      tokens: Math.ceil(content.length / 4),
      content,
      compressible: true,
      ephemeral: false,
      category: "working-state",
      // P14-5: runtime-owned working state (goal/constraints/decisions) is
      // authoritative instruction, not external data.
      instructional: true,
      persistable: false,
    });
    used += 1;
  };
  if (include.has("goal") && state.goal !== "") push("Goal", [state.goal]);
  if (include.has("constraints")) push("Constraints", state.constraints);
  if (include.has("plan")) push("Plan", state.plan);
  if (include.has("decisions")) push("Decisions", state.decisions);
  if (include.has("importantFacts")) push("Important facts", state.importantFacts);
  return blocks;
}

function pushUnique(list: string[], value: string): boolean {
  if (list.includes(value)) return false;
  list.push(value);
  return true;
}

/** Merge a child's structured completion into the parent's working state.
 *  Mutates `parent` and returns a report of what was adopted/skipped.
 *
 *  - failed child: nothing is adopted; the failure is recorded.
 *  - partial child (cancelled/timeout): nothing ref-backed exists to merge
 *    (P1-8 emits no fabricated artifacts), recorded as partial.
 *  - artifact ownership: child-modified paths become the child's; a path the
 *    parent also modified is a conflict — the child version is recorded but
 *    not applied, and the conflict is reported as stale.
 *  - duplicate findings: deduplicated by claim.
 */
export function mergeChildCompletion(
  parent: WorkingState,
  child: DelegationResult,
): MergeReport {
  const report: MergeReport = {
    mergedPaths: [],
    adoptedFindings: [],
    adoptedTestsRun: [],
    adoptedOpenQuestions: [],
    adoptedNextActions: [],
    conflicts: [],
    skipped: [],
  };

  if (child.status === "failed") {
    const detail = child.error ?? child.summary;
    report.skipped.push({ reason: "failed", detail });
    pushUnique(parent.failures, `child ${child.childSessionId}: ${detail}`);
    pushUnique(
      parent.decisions,
      `delegated to child ${child.childSessionId} failed; its changes were not merged`,
    );
    return report;
  }

  if (child.status !== "success") {
    report.skipped.push({
      reason: "partial",
      detail: `child ${child.childSessionId} ended with status ${child.status}; no ref-backed changes to merge`,
    });
    return report;
  }

  for (const artifact of child.changedArtifacts) {
    if (parent.filesChanged.includes(artifact.path)) {
      report.conflicts.push({
        path: artifact.path,
        detail: "both parent and child modified the path; the child version was not applied",
      });
      report.skipped.push({ reason: "stale", detail: artifact.path });
      continue;
    }
    pushUnique(parent.filesChanged, artifact.path);
    pushUnique(parent.artifactRefs, artifact.path);
    report.mergedPaths.push(artifact.path);
  }

  for (const finding of child.findings) {
    if (parent.decisions.some((d) => d.includes(finding.claim))) {
      report.skipped.push({ reason: "duplicate", detail: finding.claim });
      continue;
    }
    report.adoptedFindings.push(finding);
    pushUnique(
      parent.decisions,
      `[child ${child.childSessionId}] ${finding.claim} (confidence ${finding.confidence}, refs ${finding.evidenceRefs.join(", ")})`,
    );
  }

  for (const run of child.testsRun) {
    if (parent.testsRun.includes(run.description)) continue;
    parent.testsRun.push(run.description);
    report.adoptedTestsRun.push(run);
  }

  for (const question of child.openQuestions) {
    if (pushUnique(parent.openQuestions, question)) report.adoptedOpenQuestions.push(question);
  }
  for (const action of child.suggestedNextActions) {
    if (pushUnique(parent.pending, action)) report.adoptedNextActions.push(action);
  }

  pushUnique(parent.childAgentRefs, child.childSessionId);
  pushUnique(
    parent.decisions,
    `merged completion from child ${child.childSessionId}: ${child.answer.slice(0, 200)}`,
  );

  return report;
}