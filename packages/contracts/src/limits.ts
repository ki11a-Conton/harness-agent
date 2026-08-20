import type { RunId } from "./ids.js";

export interface RunLimits {
  maxTurns?: number;
  maxToolCalls?: number;
  maxDurationMs?: number;
  maxOutputChars?: number;
  maxRetries?: number;
  maxSubagents?: number;
  maxEstimatedCostUsd?: number;
}

export interface ContextBudget {
  maxTokens: number;
  reserved: {
    system: number;
    task: number;
    output: number;
  };
  dynamic: number;
}

export interface ContextReport {
  used: number;
  available: number;
  dropped: number;
  compressed: number;
  /** Token estimate of the message history accounted into the budget
   *  (Phase 8). Optional for backward compatibility; 0/absent when the
   *  pipeline ran without messages. */
  messagesTokens?: number;
}

export interface DelegationLimits {
  maxDepth: number;
  /** @deprecated P3-3 — kept as the backward-compatible alias of
   *  `maxChildrenTotal` (historical total children a parent may spawn).
   *  Prefer maxChildrenTotal / maxActiveChildren. */
  maxChildren: number;
  /** P3-3: total children a parent may ever spawn (historical count, all
   *  completed included). Absent → falls back to the deprecated maxChildren. */
  maxChildrenTotal?: number;
  /** P3-3: concurrent ACTIVE children of one parent (running / waiting
   *  turns). Completed children never occupy an active slot. Absent → no
   *  active cap (only maxConcurrent and the scheduler gate concurrency). */
  maxActiveChildren?: number;
  maxConcurrent: number;
  timeoutMs: number;
  /** P1-7: tool-call budget allocated to this delegation. The scheduler
   *  pre-reserves it from the root tree budget and returns the unused part on
   *  release — a child can never spend outside its allocation, and unused
   *  budget flows back to the tree pool. Absent → the child draws from the
   *  tree pool without a fixed allocation. */
  maxToolCalls?: number;
}

export const DEFAULT_DELEGATION_LIMITS: DelegationLimits = {
  maxDepth: 2,
  maxChildren: 3,
  maxConcurrent: 3,
  timeoutMs: 10 * 60 * 1000,
};

/** P3-3: resolve the child-count caps from delegation limits. `total` always
 *  has a concrete value (maxChildrenTotal, else the deprecated maxChildren
 *  alias, else 0 = no cap); `active` is undefined when no active cap was set.
 */
export function resolveChildLimits(limits: Pick<DelegationLimits, "maxChildren" | "maxChildrenTotal" | "maxActiveChildren">): {
  total: number;
  active?: number;
} {
  const total = limits.maxChildrenTotal ?? limits.maxChildren;
  return { total: total ?? 0, active: limits.maxActiveChildren };
}

/** P1-7: tree-wide budget for a root session and everything spawned under it.
 *  The scheduler accounts tool-call usage and tree wall-clock; token
 *  accounting needs runtime-side usage reporting (checkpoint budget usage /
 *  P1-8 observability) and is DECLARED here for forward compatibility —
 *  consumption accounting for tokens is not implemented yet. */
export interface TreeBudget {
  /** Whole-tree wall-clock budget from the root's first scheduled agent. */
  maxDurationMs?: number;
  /** Whole-tree tool-call budget. A configurable share (default 20%) is
   *  reserved for the root's own completion/verification (headroom); child
   *  delegations draw from the remaining pool. */
  maxToolCalls?: number;
  /** Declared token budget (accounting pending runtime usage reporting). */
  maxTokens?: number;
}

/** Default share of the tree tool budget held back for the root agent (its
 *  own execution, completion and verification gate). */
export const TREE_BUDGET_HEADROOM_RATIO = 0.2;

export interface SchedulerLimits {
  /** Agents running anywhere in the tree at once. */
  maxGlobalAgents: number;
  /** Agents running under one root subtree at once. */
  maxAgentsPerRoot: number;
  /** Maximum delegation depth across the tree (defense against fan-out
   *  blowups: root→4 children→each 4 grandchildren would be 1+4+16). */
  maxDepth: number;
  /** Wall-clock budget per scheduled agent; 0 disables. When exceeded the
   *  agent is cancelled (its subtree signal aborts). */
  maxDurationMs: number;
  /** P1-7: default tree budget applied to every root. A per-root override via
   *  `AgentExecutionScheduler.setRootBudget` takes precedence. */
  treeBudget?: TreeBudget;
}

export const DEFAULT_SCHEDULER_LIMITS: SchedulerLimits = {
  maxGlobalAgents: 8,
  maxAgentsPerRoot: 4,
  maxDepth: 3,
  maxDurationMs: 10 * 60 * 1000,
};

export interface RunBudget {
  runId: RunId;
  limits: RunLimits;
  usedTurns: number;
  usedToolCalls: number;
  startedAt: number;
  durationMs: number;
  outputChars: number;
  retries: number;
  subagentsSpawned: number;
  estimatedCostUsd: number;
}

/**
 * Which invariant was breached and whether the run was stopped safely.
 * Exceeding any limit must result in a safe stop with the session preserved.
 */
export interface LimitBreach {
  limit: keyof RunLimits;
  used: number;
  allowed: number | undefined;
}