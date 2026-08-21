import type { AgentEvent } from "@ar/contracts";
/**
 * Run metrics, per AGENT_ARCHITECTURE_PLAN v2.0 §78.
 *
 * All metrics are derived purely from the event stream (never from the
 * session record). Values that the stream cannot express are 0 — honest
 * "not recorded", never fabricated.
 *
 * Payload conventions this implementation reads (documented contract,
 * aligned with packages/core runtime.ts and packages/tools orchestrator.ts):
 * - tokens: `payload.usage.inputTokens / outputTokens / contextTokens` on
 *   `model.*` events (flat fallbacks: `inputTokens`, `outputTokens`,
 *   `contextTokens`, snake_case variants). `context_tokens` additionally
 *   sums a numeric `payload.tokens` on `context.built` events.
 * - retries: `run.limit_reached` with `payload.limit === "maxRetries"`, or
 *   `tool.failed` with `payload.retried === true`. The runtime currently has
 *   no dedicated retry event; recovery re-executions that emit no event stay
 *   invisible by design.
 * - cost: explicit `payload.usage.cost` / `payload.cost` on `model.*` events
 *   wins; otherwise a documented default-rate estimate is applied.
 */
export interface RunMetrics {
    turn_count: number;
    tool_call_count: number;
    tokens_input: number;
    tokens_output: number;
    context_tokens: number;
    compaction_count: number;
    duration_ms: number;
    retry_count: number;
    verification_failures: number;
    human_interventions: number;
    estimated_cost: number;
}
/** Default price assumption (USD per token) used only when no explicit cost is recorded. */
export declare const DEFAULT_COST_PER_INPUT_TOKEN: number;
/** Default price assumption (USD per token) used only when no explicit cost is recorded. */
export declare const DEFAULT_COST_PER_OUTPUT_TOKEN: number;
/** Compute §78 run metrics from an event stream. */
export declare function computeMetrics(events: AgentEvent[]): RunMetrics;
//# sourceMappingURL=metrics.d.ts.map