/** Default price assumption (USD per token) used only when no explicit cost is recorded. */
export const DEFAULT_COST_PER_INPUT_TOKEN = 2 / 1_000_000;
/** Default price assumption (USD per token) used only when no explicit cost is recorded. */
export const DEFAULT_COST_PER_OUTPUT_TOKEN = 8 / 1_000_000;
const HUMAN_EVENT_TYPES = new Set([
    "human.approval",
    "human.correction",
    "human.message",
    "human.cancel",
    "human.override",
]);
function asNumber(value) {
    return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
function pickNumber(payload, keys) {
    for (const key of keys) {
        const value = asNumber(payload[key]);
        if (value !== undefined)
            return value;
    }
    return undefined;
}
function usageOf(payload) {
    const usage = payload.usage;
    return typeof usage === "object" && usage !== null
        ? usage
        : undefined;
}
function count(events, type) {
    return events.filter((event) => event.type === type).length;
}
/**
 * Sum a token field across model.completed events only (P0-9). Usage is the
 * per-call cumulative snapshot carried by the terminal event; summing across
 * model.started / model.retry / model.usage too would double-count the same
 * tokens. A provider that emits a final usage only on model.completed is the
 * single source of truth; anything model.usage delivered was merged into it
 * by the runtime before completion was emitted.
 */
function sumModelTokens(events, keys) {
    let total = 0;
    for (const event of events) {
        if (event.type !== "model.completed")
            continue;
        const usage = usageOf(event.payload);
        const value = pickNumber(usage ?? {}, keys) ?? pickNumber(event.payload, keys);
        if (value !== undefined)
            total += value;
    }
    return total;
}
function sumPayloadNumbers(events, keys) {
    let total = 0;
    for (const event of events) {
        const value = pickNumber(event.payload, keys);
        if (value !== undefined)
            total += value;
    }
    return total;
}
/** USD cost: explicit cost recorded on model events wins, else default-rate estimate. */
function computeCost(events, tokensInput, tokensOutput) {
    let explicit = 0;
    let hasExplicit = false;
    for (const event of events) {
        if (event.type !== "model.completed")
            continue;
        const usage = usageOf(event.payload);
        const value = pickNumber(usage ?? {}, ["cost", "estimatedCostUsd", "estimatedCost"]) ??
            pickNumber(event.payload, ["cost", "estimatedCostUsd", "estimatedCost"]);
        if (value !== undefined) {
            explicit += value;
            hasExplicit = true;
        }
    }
    const cost = hasExplicit
        ? explicit
        : tokensInput * DEFAULT_COST_PER_INPUT_TOKEN +
            tokensOutput * DEFAULT_COST_PER_OUTPUT_TOKEN;
    return Math.round(cost * 1e10) / 1e10;
}
/** Sum a field across model.completed usage snapshots (P0-9 de-dup). */
function sumCompletedUsage(events, keys) {
    let total = 0;
    for (const event of events) {
        if (event.type !== "model.completed")
            continue;
        const usage = usageOf(event.payload);
        const value = pickNumber(usage ?? {}, keys);
        if (value !== undefined)
            total += value;
    }
    return total;
}
/** Compute §78 run metrics from an event stream. */
export function computeMetrics(events) {
    const tokensInput = sumModelTokens(events, ["inputTokens", "input_tokens"]);
    const tokensOutput = sumModelTokens(events, ["outputTokens", "output_tokens"]);
    const contextTokens = sumModelTokens(events, ["contextTokens", "context_tokens"]) +
        sumPayloadNumbers(events.filter((event) => event.type === "context.built"), ["tokens", "contextTokens", "context_tokens"]);
    const first = events[0];
    const last = events[events.length - 1];
    const durationMs = first !== undefined && last !== undefined
        ? Math.max(0, last.timestamp - first.timestamp)
        : 0;
    const retryCount = events.filter((event) => (event.type === "run.limit_reached" && event.payload.limit === "maxRetries") ||
        (event.type === "tool.failed" && event.payload.retried === true) ||
        event.type === "model.retry").length;
    const verificationFailures = events.filter((event) => event.type === "verification.failed" ||
        (event.type === "verification.completed" && event.payload.passed === false)).length;
    const humanInterventions = events.filter((event) => HUMAN_EVENT_TYPES.has(event.type)).length;
    return {
        turn_count: count(events, "turn.started"),
        tool_call_count: count(events, "tool.requested"),
        tokens_input: tokensInput,
        tokens_output: tokensOutput,
        context_tokens: contextTokens,
        compaction_count: count(events, "context.compacted"),
        duration_ms: durationMs,
        retry_count: retryCount,
        verification_failures: verificationFailures,
        human_interventions: humanInterventions,
        estimated_cost: computeCost(events, tokensInput, tokensOutput),
    };
}
//# sourceMappingURL=metrics.js.map