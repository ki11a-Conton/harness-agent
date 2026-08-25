/**
 * PHASE 13 — 更激进实验（EXPERIMENT，只能最后做）。
 *
 * Every item here is a CHALLENGER: it is NOT the champion path, it must pass
 * the benchmark gate before promotion (P10), and it is explicitly marked
 * experimental. This module provides the deterministic, testable pieces;
 * wiring them into the runtime is a separate, gated change.
 */

// --- P13-1: Planner/Executor ----------------------------------------------
// Challenger idea: split each turn into an explicit PLAN phase (no tools,
// just produce a plan) and an EXECUTE phase (follow the plan). The champion
// keeps the single-prompt loop. Only promoted if the benchmark says so.
export const PLANNER_EXECUTOR_SYSTEM_PROMPT =
  "You are in planner/executor mode. FIRST produce a concise numbered plan " +
  "(no tool calls) covering the steps to achieve the goal. THEN execute the " +
  "plan step by step, adjusting only when evidence requires it. Never skip a " +
  "numbered step without stating why.";

// --- P13-2 / P13-3: Specialist profiles + router ---------------------------
// Challenger idea: route a task to a specialist agent profile (explorer /
// debugger / reviewer) instead of always using the generalist. Each profile
// is a deterministic system prompt + read/write policy shape. The reviewer
// is the Independent Reviewer challenger: a read-only subagent that audits
// the change and reports findings BEFORE the change is accepted.

export interface SpecialistProfile {
  id: "explorer" | "debugger" | "reviewer";
  systemPrompt: string;
  /** Tool names the profile may use (subset). */
  allowTools: readonly string[];
}

export const EXPLORER_PROFILE: SpecialistProfile = {
  id: "explorer",
  systemPrompt:
    "You are an explorer subagent. Map the workspace, find relevant files and " +
    "report evidence-backed answers. Read-only: never modify files.",
  allowTools: ["read_file", "search_files", "grep_search", "repo_tree", "symbol_search", "repo_map", "discover_commands", "env_snapshot"],
};

export const DEBUGGER_PROFILE: SpecialistProfile = {
  id: "debugger",
  systemPrompt:
    "You are a debugger subagent. Reproduce the failure with minimal steps, " +
    "identify the root cause with evidence, and report the fix. Prefer minimal " +
    "reproducers over broad changes.",
  allowTools: ["read_file", "search_files", "grep_search", "repo_tree", "symbol_search", "exec", "repo_map", "discover_commands"],
};

export const REVIEWER_PROFILE: SpecialistProfile = {
  id: "reviewer",
  systemPrompt:
    "You are an independent reviewer subagent. Audit the proposed change for " +
    "correctness, security and regressions. Read-only: never modify files. " +
    "Report concrete findings with evidence; explicitly flag anything you " +
    "cannot verify.",
  allowTools: ["read_file", "search_files", "grep_search", "repo_tree", "symbol_search", "repo_map", "discover_commands"],
};

const ROUTE_KEYWORDS: ReadonlyArray<{ profile: SpecialistProfile["id"]; keywords: string[] }> = [
  { profile: "debugger", keywords: ["fix", "bug", "error", "fail", "crash", "exception", "traceback", "segfault", "test fails"] },
  { profile: "reviewer", keywords: ["review", "audit", "check the change", "verify", "is it correct", "regression"] },
  { profile: "explorer", keywords: ["explore", "find", "search", "where is", "map", "understand", "locate", "list"] },
];

/** P13-3: deterministic specialist routing by goal keywords. First matching
 *  profile wins; generalist (undefined) when nothing matches. */
export function routeSpecialist(goal: string): SpecialistProfile | undefined {
  const lower = goal.toLowerCase();
  for (const rule of ROUTE_KEYWORDS) {
    if (rule.keywords.some((keyword) => lower.includes(keyword))) {
      return profileOf(rule.profile);
    }
  }
  return undefined;
}

export function profileOf(id: SpecialistProfile["id"]): SpecialistProfile {
  switch (id) {
    case "explorer":
      return EXPLORER_PROFILE;
    case "debugger":
      return DEBUGGER_PROFILE;
    case "reviewer":
      return REVIEWER_PROFILE;
  }
}

// --- P13-4: Adaptive context policy ----------------------------------------
// Challenger idea: tune memory topK / skill K / compaction threshold from
// observed token ROI (P6-4) instead of fixed constants. The suggestion is a
// pure function of the ROI ledger; the champion keeps fixed constants.

export interface TokenRoiObservation {
  roiPer1k: number;
}

/** Suggest memory topK from per-entry ROI: keep entries whose ROI is above
 *  the mean, capped at [1, 10]. Degenerate/no data → the default. */
export function suggestMemoryTopK(roi: TokenRoiObservation[], fallback = 5): number {
  if (roi.length === 0) return fallback;
  const mean = roi.reduce((s, r) => s + r.roiPer1k, 0) / roi.length;
  const aboveMean = roi.filter((r) => r.roiPer1k > mean).length;
  if (aboveMean === 0) return fallback;
  return Math.max(1, Math.min(10, aboveMean));
}

// --- P13-5: Adaptive scheduler ----------------------------------------------
// Challenger idea: the scheduler should not just raise concurrency — it should
// watch wall clock, tokens, conflict and recovery before changing concurrency.
// This module exposes the decision inputs as pure types + a conservative
// suggestion function; the champion keeps fixed concurrency.

export interface SchedulerObservation {
  activeChildren: number;
  maxConcurrent: number;
  tokenBudgetRemainingFraction: number;
  recentConflicts: number;
  recentRecoveries: number;
}

/** Conservative adaptive concurrency: only grow when there is budget headroom
 *  and no recent conflict/recovery storm; shrink under pressure. Returns the
 *  suggested maxConcurrent (integer, ≥1). */
export function suggestConcurrency(obs: SchedulerObservation): number {
  let suggested = obs.maxConcurrent;
  if (obs.recentConflicts > 0 || obs.recentRecoveries > 2) {
    suggested = Math.max(1, Math.floor(obs.maxConcurrent / 2));
  } else if (obs.tokenBudgetRemainingFraction > 0.5 && obs.activeChildren < obs.maxConcurrent) {
    suggested = Math.min(obs.maxConcurrent + 1, obs.maxConcurrent + 2);
  }
  return suggested;
}
