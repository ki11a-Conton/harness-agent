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
  /** P20-1: how many model.completed records carry NO provider usage (source
   *  "unknown"). A call with unknown usage must never be misread as free. */
  usage_unknown: number;
  /** P20-1: total prompt-cache reads across model.completed usage records. */
  cache_tokens_read: number;
  /** P20-1: total prompt-cache writes across model.completed usage records. */
  cache_tokens_created: number;
  /** P20-1: model calls with a completed usage record (per-call identity;
   *  every record is attributable by its callId). */
  model_call_count: number;
}

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

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function pickNumber(payload: Record<string, unknown>, keys: string[]): number | undefined {
  for (const key of keys) {
    const value = asNumber(payload[key]);
    if (value !== undefined) return value;
  }
  return undefined;
}

function usageOf(payload: Record<string, unknown>): Record<string, unknown> | undefined {
  const usage = payload.usage;
  return typeof usage === "object" && usage !== null
    ? (usage as Record<string, unknown>)
    : undefined;
}

function count(events: AgentEvent[], type: string): number {
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
function sumModelTokens(events: AgentEvent[], keys: string[]): number {
  let total = 0;
  for (const event of events) {
    if (event.type !== "model.completed") continue;
    const usage = usageOf(event.payload);
    const value =
      pickNumber(usage ?? {}, keys) ?? pickNumber(event.payload, keys);
    if (value !== undefined) total += value;
  }
  return total;
}

function sumPayloadNumbers(events: AgentEvent[], keys: string[]): number {
  let total = 0;
  for (const event of events) {
    const value = pickNumber(event.payload, keys);
    if (value !== undefined) total += value;
  }
  return total;
}

/** USD cost: explicit cost recorded on model events wins, else default-rate estimate. */
function computeCost(events: AgentEvent[], tokensInput: number, tokensOutput: number): number {
  let explicit = 0;
  let hasExplicit = false;
  for (const event of events) {
    if (event.type !== "model.completed") continue;
    const usage = usageOf(event.payload);
    const value =
      pickNumber(usage ?? {}, ["cost", "estimatedCostUsd", "estimatedCost"]) ??
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
function sumCompletedUsage(events: AgentEvent[], keys: string[]): number {
  let total = 0;
  for (const event of events) {
    if (event.type !== "model.completed") continue;
    const usage = usageOf(event.payload);
    const value = pickNumber(usage ?? {}, keys);
    if (value !== undefined) total += value;
  }
  return total;
}

/** Compute §78 run metrics from an event stream. */
export function computeMetrics(events: AgentEvent[]): RunMetrics {
  const tokensInput = sumModelTokens(events, ["inputTokens", "input_tokens"]);
  const tokensOutput = sumModelTokens(events, ["outputTokens", "output_tokens"]);
  const contextTokens =
    sumModelTokens(events, ["contextTokens", "context_tokens"]) +
    sumPayloadNumbers(
      events.filter((event) => event.type === "context.built"),
      ["tokens", "contextTokens", "context_tokens"],
    );

  const first = events[0];
  const last = events[events.length - 1];
  const durationMs =
    first !== undefined && last !== undefined
      ? Math.max(0, last.timestamp - first.timestamp)
      : 0;

  const retryCount = events.filter(
    (event) =>
      (event.type === "run.limit_reached" && event.payload.limit === "maxRetries") ||
      (event.type === "tool.failed" && event.payload.retried === true) ||
      event.type === "model.retry",
  ).length;

  const verificationFailures = events.filter(
    (event) =>
      event.type === "verification.failed" ||
      (event.type === "verification.completed" && event.payload.passed === false),
  ).length;

  const humanInterventions = events.filter((event) =>
    HUMAN_EVENT_TYPES.has(event.type),
  ).length;

  // P20-1: provenance + cache accounting from the per-call usage records.
  let usageUnknown = 0;
  let cacheRead = 0;
  let cacheCreated = 0;
  let modelCallCount = 0;
  for (const event of events) {
    if (event.type !== "model.completed") continue;
    modelCallCount += 1;
    const usage = usageOf(event.payload);
    if (usage === undefined) {
      usageUnknown += 1;
      continue;
    }
    if (usage.source === "unknown") usageUnknown += 1;
    const read = asNumber(usage.cacheReadTokens);
    if (read !== undefined) cacheRead += read;
    const created = asNumber(usage.cacheCreationTokens);
    if (created !== undefined) cacheCreated += created;
  }

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
    usage_unknown: usageUnknown,
    cache_tokens_read: cacheRead,
    cache_tokens_created: cacheCreated,
    model_call_count: modelCallCount,
  };
}
