/**
 * P2-42 — adaptive recovery. The runtime's recovery used to be a one-shot
 * "retry or ask or fail" decision (RECOVERY-001). P2-42 widens it into a
 * BOUNDED vocabulary of recovery actions, each with its own hard per-turn
 * budget, plus a pure planner that picks the best still-budgeted action for
 * the failure at hand — falling through to `fail_safe` only when nothing
 * budgeted remains eligible.
 *
 * Design contract (mirrors P2-39/P2-40):
 *   - The action universe is a CLOSED set (`RecoveryAction`) with an exhaustive
 *     `RECOVERY_ACTIONS` list, so extending it is a deliberate, reviewed change.
 *   - Each action has fixed governance here: budget, the inputs it addresses,
 *     and a priority order tried within the eligible set.
 *   - The planner is PURE and DETERMINISTIC — no clocks, no I/O — so it is
 *     unit-testable and safe to run anywhere. The RUNTIME performs the action
 *     (inject a system observation, trigger compaction, re-handshake MCP, ...)
 *     and records the use against the budget; this module only decides.
 *
 * False-positive control: an action is only eligible when its input matches
 * the observed failure/stall signal AND its budget has not been exhausted.
 * `fail_safe` is always eligible as the terminal, bounded backstop.
 */
import type { StallPattern } from "./stall.js";

/** The recoverable failure signals the planner can respond to. Derived strictly
 *  from observable events (a failed tool, a stall pattern, a budget hit) —
 *  never from model wording. */
export type RecoveryInput =
  | "tool_failure"
  | "timeout"
  | "context_overflow"
  | "model_error"
  | "test_failure"
  | "stall_pattern"
  | "mcp_disconnected"
  | "tool_unavailable";

/** Exhaustive list of recovery inputs. */
export const RECOVERY_INPUTS = [
  "tool_failure",
  "timeout",
  "context_overflow",
  "model_error",
  "test_failure",
  "stall_pattern",
  "mcp_disconnected",
  "tool_unavailable",
] as const satisfies readonly RecoveryInput[];

/**
 * The bounded recovery-action vocabulary (P2-42). The runtime can perform one
 * of these per budgeted use instead of only "retry or fail":
 *
 *   retry             re-execute the same operation (only when safe).
 *   change_strategy   inject a bounded "try a different approach" observation.
 *   compact           trigger a context compaction.
 *   re_discover_tools re-scan the tool registry for the platform's tools.
 *   refresh_mcp       re-handshake / reconnect an MCP client.
 *   ask_user          surface a prompt and wait for the user.
 *   delegate_specialist hand the subtask to a bounded specialist turn.
 *   fail_safe         closed, safe termination backstop (always eligible).
 */
export type RecoveryAction =
  | "retry"
  | "change_strategy"
  | "compact"
  | "re_discover_tools"
  | "refresh_mcp"
  | "ask_user"
  | "delegate_specialist"
  | "fail_safe";

/** Exhaustive list of recovery actions. */
export const RECOVERY_ACTIONS = [
  "retry",
  "change_strategy",
  "compact",
  "re_discover_tools",
  "refresh_mcp",
  "ask_user",
  "delegate_specialist",
  "fail_safe",
] as const satisfies readonly RecoveryAction[];

export interface RecoveryActionSpec {
  action: RecoveryAction;
  /** Hard per-turn budget (how many times the action may run). 0 = disabled. */
  budget: number;
  /** Which inputs this action can address. `fail_safe` addresses everything. */
  addresses: readonly RecoveryInput[];
  /** Higher = tried first among eligible, still-budgeted actions. */
  priority: number;
}

/**
 * P2-42 — the recovery governance table. Values describe the CURRENT runtime
 * behavior; changing one is a behavior change, not just a comment.
 */
export const RECOVERY_ACTION_SPECS: Readonly<Record<RecoveryAction, RecoveryActionSpec>> = {
  retry: {
    action: "retry",
    budget: 3,
    addresses: ["tool_failure", "timeout", "model_error"],
    priority: 100,
  },
  change_strategy: {
    action: "change_strategy",
    budget: 2,
    // A stall, a failing check, or a stuck tool failure is best met by nudging
    // the model to a different approach (a bounded prompt, not blind retry).
    addresses: ["stall_pattern", "test_failure", "tool_failure"],
    priority: 80,
  },
  compact: {
    action: "compact",
    budget: 2,
    // Context overflow cannot be self-healed by retry; compaction is the fix.
    addresses: ["context_overflow"],
    priority: 70,
  },
  re_discover_tools: {
    action: "re_discover_tools",
    budget: 2,
    addresses: ["tool_unavailable"],
    priority: 60,
  },
  refresh_mcp: {
    action: "refresh_mcp",
    budget: 3,
    addresses: ["mcp_disconnected", "tool_unavailable"],
    priority: 50,
  },
  delegate_specialist: {
    action: "delegate_specialist",
    budget: 1,
    // A failing check or recurring tool trouble may warrant a bounded specialist
    // attempt before giving up or asking the user.
    addresses: ["test_failure", "tool_failure"],
    priority: 40,
  },
  ask_user: {
    action: "ask_user",
    budget: 1,
    // Genuinely ambiguous cases (overflow needs a human decision on compaction,
    // a model error that can't self-heal) escalate to the user.
    addresses: ["context_overflow", "model_error", "tool_unavailable"],
    priority: 30,
  },
  fail_safe: {
    action: "fail_safe",
    // Unlimited by design: it is the closed backstop when every budgeted action
    // is spent or ineligible. Represented as Number.MAX_SAFE_INTEGER.
    budget: Number.MAX_SAFE_INTEGER,
    addresses: (RECOVERY_INPUTS as readonly RecoveryInput[]),
    priority: 0,
  },
};

export function isRecoveryAction(value: unknown): value is RecoveryAction {
  return typeof value === "string" && (RECOVERY_ACTIONS as readonly string[]).includes(value);
}

export function isRecoveryInput(value: unknown): value is RecoveryInput {
  return typeof value === "string" && (RECOVERY_INPUTS as readonly string[]).includes(value);
}

export interface RecoveryDecision {
  action: RecoveryAction;
  input: RecoveryInput;
  /** How many times this action has already been used this turn. */
  used: number;
  /** Budget uses still remaining after this decision. */
  remaining: number;
  reason: string;
}

export type RecoveryUsage = Partial<Record<RecoveryAction, number>>;

/**
 * P2-42 — pure, deterministic recovery-action planner. Given a failure input
 * and the per-action usage ledger, it returns the highest-priority action that
 * addresses the input and still has budget remaining, else `fail_safe`. The
 * runtime applies the action and records its use; the caller's ledger is not
 * mutated here (decide pure; apply elsewhere).
 */
export class AdaptiveRecoveryPlanner {
  private readonly specs: Readonly<Record<RecoveryAction, RecoveryActionSpec>>;

  constructor(overrides?: Partial<Record<RecoveryAction, Partial<RecoveryActionSpec>>>) {
    const merged = { ...RECOVERY_ACTION_SPECS };
    for (const [key, value] of Object.entries(overrides ?? {})) {
      const action = key as RecoveryAction;
      if (value !== undefined) {
        merged[action] = { ...merged[action]!, ...value, action };
      }
    }
    this.specs = merged;
  }

  /** True when the action has consumed fewer uses than its budget this turn. */
  hasBudget(action: RecoveryAction, used: RecoveryUsage): boolean {
    const budget = this.specs[action]!.budget;
    return (used[action] ?? 0) < budget;
  }

  decide(input: RecoveryInput, used: RecoveryUsage = {}): RecoveryDecision {
    if (!isRecoveryInput(input)) {
      throw new TypeError(`unknown recovery input: ${String(input)}`);
    }
    const candidates = (RECOVERY_ACTIONS as readonly RecoveryAction[])
      .map((action) => this.specs[action]!)
      .filter((spec) => spec.addresses.includes(input))
      .filter((spec) => this.hasBudget(spec.action, used))
      .sort((a, b) => b.priority - a.priority);

    const chosen = candidates[0] ?? this.specs.fail_safe!;
    const usedCount = used[chosen.action] ?? 0;
    return {
      action: chosen.action,
      input,
      used: usedCount,
      remaining: Math.max(0, this.specs[chosen.action]!.budget - usedCount - 1),
      reason:
        chosen.action === "fail_safe"
          ? `no budgeted recovery action addresses ${input}; failing safely`
          : `${input}: chose ${chosen.action} (${usedCount}/${this.specs[chosen.action]!.budget} used)`,
    };
  }
}