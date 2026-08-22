/**
 * P19-3 — bounded recovery taxonomy V3 (recovery of the P2-42 vocabulary).
 *
 * The runtime's recovery used to grow ad-hoc actions (compact /
 * re_discover_tools / refresh_mcp were SELECTABLE by the planner but never
 * actually applied by the runtime — a half-implementation). P19-3 closes that:
 * the action universe is now EXACTLY this closed set, and every member is
 * applied by the runtime with explicit governance:
 *
 *   retry_safe               re-execute ONLY provably-safe (retrySafety=safe)
 *                            operations; never a side-effecting re-run.
 *   change_strategy          inject a bounded "try a different approach"
 *                            observation (mechanisms such as MCP re-handshake
 *                            / tool rescan live HERE, not as separate actions).
 *   reconcile_unknown_effect a started-but-unconfirmed call (timeout / unknown
 *                            outcome) is surfaced for reconciliation — the
 *                            runtime NEVER auto-reruns it and never pretends.
 *   ask_user                 surface a prompt and wait for the user.
 *   delegate_specialist      hand the subtask to a bounded specialist turn
 *                            (only when the host wired a specialist service
 *                            AND the per-turn budget allows).
 *   fail_safe                closed, safe termination backstop (always eligible).
 *
 * Governance contract (mirrors P2-39/P2-40/P2-42):
 *   - The action universe is a CLOSED set (`RecoveryAction`) with an
 *     exhaustive `RECOVERY_ACTIONS` list, so extending it is a deliberate,
 *     reviewed change.
 *   - Each action has fixed governance here: budget, the inputs it addresses,
 *     whether side-effecting re-execution is allowed (ALWAYS false today —
 *     P19-4's "never auto-retry unsafe tools" is encoded IN the spec, not an
 *     unwritten convention), and a priority order tried within the eligible set.
 *   - The planner is PURE and DETERMINISTIC — no clocks, no I/O — so it is
 *     unit-testable and safe to run anywhere. The RUNTIME performs the action
 *     (inject a system observation, reconcile, ask) and records the use
 *     against the budget; this module only decides.
 *
 * False-positive control: an action is only eligible when its input matches
 * the observed failure/stall signal AND its budget has not been exhausted.
 * `fail_safe` is always eligible as the terminal, bounded backstop.
 *
 * String-message recovery is forbidden: consumers branch on the typed action
 * (never on `reason` text), and every decision is observable via the
 * `recovery.decided` event (P19-3).
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
 * P19-3 — the bounded recovery-action vocabulary (V3, closed). The runtime
 * applies EXACTLY one of these per budgeted use:
 *
 *   retry_safe             re-execute the same operation ONLY when retrySafety
 *                          is "safe" (read-only / idempotent). Side-effecting
 *                          or unknown tools are never auto-requeued.
 *   change_strategy        inject a bounded "try a different approach"
 *                          observation. Lower-level mechanisms (MCP reconnect,
 *                          tool rescan) are implementation details of this
 *                          action, NOT separate actions.
 *   reconcile_unknown_effect surface a started-but-unconfirmed call for
 *                          reconciliation: outcome unknown, side effects may
 *                          exist; the model/user confirms, never a blind rerun.
 *   ask_user               surface a prompt and wait for the user.
 *   delegate_specialist    hand the subtask to a bounded specialist turn
 *                          (feature-enabled + budget only).
 *   fail_safe              closed, safe termination backstop (always eligible).
 */
export type RecoveryAction =
  | "retry_safe"
  | "change_strategy"
  | "reconcile_unknown_effect"
  | "ask_user"
  | "delegate_specialist"
  | "fail_safe";

/** Exhaustive list of recovery actions. */
export const RECOVERY_ACTIONS = [
  "retry_safe",
  "change_strategy",
  "reconcile_unknown_effect",
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
  /**
   * P19-3: whether applying this action may re-execute an operation that has
   * side effects. Deliberately FALSE for every member today — P19-4's "never
   * auto-retry unsafe tools" is encoded here, so allowing a side-effecting
   * re-run is a reviewed change to the spec table, not an unwritten decision.
   */
  allowsSideEffectReexecution: boolean;
}

/**
 * P19-3 — the recovery governance table (V3, closed). Values describe the
 * CURRENT runtime behavior; changing one is a behavior change, not just a
 * comment. In particular `allowsSideEffectReexecution` is false everywhere —
 * no recovery action may auto-rerun a side-effecting call.
 */
export const RECOVERY_ACTION_SPECS: Readonly<Record<RecoveryAction, RecoveryActionSpec>> = {
  retry_safe: {
    action: "retry_safe",
    budget: 3,
    addresses: ["tool_failure", "timeout", "model_error"],
    priority: 100,
    // Only provably-safe (read-only/idempotent) calls are re-executed; a call
    // that can produce side effects is never re-run by this action.
    allowsSideEffectReexecution: false,
  },
  change_strategy: {
    action: "change_strategy",
    budget: 2,
    // A stall, a failing check, a stuck tool failure, or a platform hiccup
    // (MCP disconnect / missing tool) is best met by nudging the model to a
    // different approach — a bounded prompt, not blind retry. Reconnect /
    // rescan mechanics are implementation details of this action.
    addresses: ["stall_pattern", "test_failure", "tool_failure", "mcp_disconnected", "tool_unavailable"],
    priority: 80,
    allowsSideEffectReexecution: false,
  },
  reconcile_unknown_effect: {
    action: "reconcile_unknown_effect",
    budget: 1,
    // A call that STARTED but whose outcome is unknown (timeout, ambiguous
    // failure) may have committed side effects. The runtime surfaces it for
    // reconciliation instead of guessing — and NEVER re-executes it.
    addresses: ["timeout", "tool_failure"],
    priority: 70,
    allowsSideEffectReexecution: false,
  },
  delegate_specialist: {
    action: "delegate_specialist",
    budget: 1,
    // A failing check or recurring tool trouble may warrant a bounded specialist
    // attempt before giving up or asking the user. Only applies when the host
    // wired a specialist service (feature enabled) AND budget allows.
    addresses: ["test_failure", "tool_failure"],
    priority: 40,
    allowsSideEffectReexecution: false,
  },
  ask_user: {
    action: "ask_user",
    budget: 1,
    // Genuinely ambiguous cases (overflow needs a human decision, a model error
    // that can't self-heal, a missing tool) escalate to the user.
    addresses: ["context_overflow", "model_error", "tool_unavailable"],
    priority: 30,
    allowsSideEffectReexecution: false,
  },
  fail_safe: {
    action: "fail_safe",
    // Unlimited by design: it is the closed backstop when every budgeted action
    // is spent or ineligible. Represented as Number.MAX_SAFE_INTEGER.
    budget: Number.MAX_SAFE_INTEGER,
    addresses: (RECOVERY_INPUTS as readonly RecoveryInput[]),
    priority: 0,
    allowsSideEffectReexecution: false,
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
 * P15-1 — per-turn execution state. Everything here is created FRESH when a
 * turn starts and discarded when the turn ends; nothing on this object may be
 * shared across turns or sessions. The runtime creates one instance per
 * `runTurn` and threads it through the controllers by value — it is never a
 * module or runtime-instance field, so turn A's recovery/budget usage can
 * never leak into turn B or into a concurrent session.
 */
export interface TurnExecutionState {
  /** Per-turn recovery-action budget ledger (decide()/hasBudget() inputs). */
  recoveryUsage: RecoveryUsage;
}

/** Create a fresh, empty per-turn execution state. */
export function newTurnExecutionState(): TurnExecutionState {
  return { recoveryUsage: {} };
}

/**
 * P19-3 — pure, deterministic recovery-action planner (V3). Given a failure
 * input and the per-action usage ledger, it returns the highest-priority
 * action that addresses the input and still has budget remaining, else
 * `fail_safe`. The runtime applies the action and records its use; the
 * caller's ledger is not mutated here (decide pure; apply elsewhere).
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
