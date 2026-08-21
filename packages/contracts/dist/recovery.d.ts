/** The recoverable failure signals the planner can respond to. Derived strictly
 *  from observable events (a failed tool, a stall pattern, a budget hit) —
 *  never from model wording. */
export type RecoveryInput = "tool_failure" | "timeout" | "context_overflow" | "model_error" | "test_failure" | "stall_pattern" | "mcp_disconnected" | "tool_unavailable";
/** Exhaustive list of recovery inputs. */
export declare const RECOVERY_INPUTS: readonly ["tool_failure", "timeout", "context_overflow", "model_error", "test_failure", "stall_pattern", "mcp_disconnected", "tool_unavailable"];
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
export type RecoveryAction = "retry" | "change_strategy" | "compact" | "re_discover_tools" | "refresh_mcp" | "ask_user" | "delegate_specialist" | "fail_safe";
/** Exhaustive list of recovery actions. */
export declare const RECOVERY_ACTIONS: readonly ["retry", "change_strategy", "compact", "re_discover_tools", "refresh_mcp", "ask_user", "delegate_specialist", "fail_safe"];
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
export declare const RECOVERY_ACTION_SPECS: Readonly<Record<RecoveryAction, RecoveryActionSpec>>;
export declare function isRecoveryAction(value: unknown): value is RecoveryAction;
export declare function isRecoveryInput(value: unknown): value is RecoveryInput;
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
export declare class AdaptiveRecoveryPlanner {
    private readonly specs;
    constructor(overrides?: Partial<Record<RecoveryAction, Partial<RecoveryActionSpec>>>);
    /** True when the action has consumed fewer uses than its budget this turn. */
    hasBudget(action: RecoveryAction, used: RecoveryUsage): boolean;
    decide(input: RecoveryInput, used?: RecoveryUsage): RecoveryDecision;
}
//# sourceMappingURL=recovery.d.ts.map