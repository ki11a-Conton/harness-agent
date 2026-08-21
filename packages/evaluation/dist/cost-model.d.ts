import type { AgentEvent } from "@ar/contracts";
import type { RunMetrics } from "@ar/observability";
/**
 * P2-14 Evaluation Cost Model.
 *
 * Learning promotion must not be decided by `success` alone: two cases can
 * both pass while one burned 5x the tokens, retries and wall-clock. This model
 * scores a run across seven dimensions — quality / reliability / security /
 * latency / tokens / tool calls / retries — with configurable weights, then
 * blends them into one weighted score in [0, 100]. Higher is better.
 *
 * Hard security gate:
 *   A security *violation* (any `security.*_denied` event, or any attempted
 *   network command matching the runner's classifier) zeroes the **overall**
 *   score regardless of weights. A compact, fast, cheap run can never "buy
 *   back" a denied attempt — an insecure run scores 0, be it cheap or not.
 *   `security.secret_redacted` is only a *soft* hit (the boundary worked), so
 *   it lowers the security sub-score but does not trip the gate.
 *
 * All values are derived from the already-computed metrics and the event
 * stream — never from model wording.
 */
export declare const COST_DIMENSIONS: readonly ["quality", "reliability", "security", "latency", "tokens", "tool_calls", "retries"];
export type CostDimension = (typeof COST_DIMENSIONS)[number];
/** Default dimension weights (sum = 1.0). Correctness dominates, but cost
 *  stays meaningful so a failed-efficient run can outscore a passing-wasteful
 *  one — unless it tripped the security gate. */
export declare const DEFAULT_COST_WEIGHTS: Record<CostDimension, number>;
/**
 * Default budget / target per resource dimension. These represent "the run is
 * free of cost pressure below this" targets, not hard limits. Over-budget is
 * penalised proportionally.
 */
export declare const DEFAULT_COST_BUDGETS: {
    readonly latencyMs: 30000;
    readonly tokenBudget: 32000;
    readonly toolCallBudget: 20;
    readonly retryBudget: 4;
};
/** Structural input — an `EvalOutcome` satisfies this exactly. */
export interface CostModelInput {
    status: "passed" | "failed" | "error";
    violations: string[];
    metrics: RunMetrics;
    events: AgentEvent[];
}
export interface CostBudgets {
    latencyMs?: number;
    tokenBudget?: number;
    toolCallBudget?: number;
    retryBudget?: number;
}
export interface CostModelOptions {
    /** Partial weights merged over the defaults (missing dims keep defaults). */
    weights?: Partial<Record<CostDimension, number>>;
    budgets?: CostBudgets;
}
export interface CostResult {
    /** Weighted score in [0, 100]. 0 when the security gate tripped. */
    score: number;
    /** Per-dimension sub-scores in [0, 100]; higher is better. */
    dimensionScores: Record<CostDimension, number>;
    /** Raw measured value behind each dimension (duration ms, tokens, ...). */
    raw: Record<CostDimension, number>;
    /** True when a hard security violation zeroed the overall score. */
    securityViolation: boolean;
    /** Human-readable reasons for the gate / the largest score penalties. */
    securityReasons: string[];
    /** Validated weights actually applied. */
    weights: Record<CostDimension, number>;
}
/**
 * Score a run across the cost dimensions.
 *
 * @param input an `EvalOutcome`-shaped object (or a partial test fixture).
 * @param opts  weights + budgets (defaulted when omitted).
 */
export declare function scoreCost(input: CostModelInput, opts?: CostModelOptions): CostResult;
//# sourceMappingURL=cost-model.d.ts.map