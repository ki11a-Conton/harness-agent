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
];
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
];
/**
 * P2-42 — the recovery governance table. Values describe the CURRENT runtime
 * behavior; changing one is a behavior change, not just a comment.
 */
export const RECOVERY_ACTION_SPECS = {
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
        addresses: RECOVERY_INPUTS,
        priority: 0,
    },
};
export function isRecoveryAction(value) {
    return typeof value === "string" && RECOVERY_ACTIONS.includes(value);
}
export function isRecoveryInput(value) {
    return typeof value === "string" && RECOVERY_INPUTS.includes(value);
}
/**
 * P2-42 — pure, deterministic recovery-action planner. Given a failure input
 * and the per-action usage ledger, it returns the highest-priority action that
 * addresses the input and still has budget remaining, else `fail_safe`. The
 * runtime applies the action and records its use; the caller's ledger is not
 * mutated here (decide pure; apply elsewhere).
 */
export class AdaptiveRecoveryPlanner {
    specs;
    constructor(overrides) {
        const merged = { ...RECOVERY_ACTION_SPECS };
        for (const [key, value] of Object.entries(overrides ?? {})) {
            const action = key;
            if (value !== undefined) {
                merged[action] = { ...merged[action], ...value, action };
            }
        }
        this.specs = merged;
    }
    /** True when the action has consumed fewer uses than its budget this turn. */
    hasBudget(action, used) {
        const budget = this.specs[action].budget;
        return (used[action] ?? 0) < budget;
    }
    decide(input, used = {}) {
        if (!isRecoveryInput(input)) {
            throw new TypeError(`unknown recovery input: ${String(input)}`);
        }
        const candidates = RECOVERY_ACTIONS
            .map((action) => this.specs[action])
            .filter((spec) => spec.addresses.includes(input))
            .filter((spec) => this.hasBudget(spec.action, used))
            .sort((a, b) => b.priority - a.priority);
        const chosen = candidates[0] ?? this.specs.fail_safe;
        const usedCount = used[chosen.action] ?? 0;
        return {
            action: chosen.action,
            input,
            used: usedCount,
            remaining: Math.max(0, this.specs[chosen.action].budget - usedCount - 1),
            reason: chosen.action === "fail_safe"
                ? `no budgeted recovery action addresses ${input}; failing safely`
                : `${input}: chose ${chosen.action} (${usedCount}/${this.specs[chosen.action].budget} used)`,
        };
    }
}
//# sourceMappingURL=recovery.js.map