import { describe, expect, it } from "vitest";
import type { AgentEvent } from "@ar/contracts";
import { computeMetrics } from "./metrics.js";

function completed(
  usage: Record<string, unknown> | undefined,
  extra: Record<string, unknown> = {},
): AgentEvent {
  return {
    id: "e" as never,
    sessionId: "s" as never,
    sequence: 1,
    timestamp: 0,
    type: "model.completed",
    payload: { callId: "call-1", finishReason: "stop", ...(usage !== undefined ? { usage } : {}), ...extra },
  } as unknown as AgentEvent;
}

describe("P20-1 metrics usage accounting", () => {
  it("C1 reports cache coverage separately from missing and zero observations", () => {
    const m = computeMetrics([
      completed({ inputTokens: 200, outputTokens: 20, cacheReadTokens: 128, source: "measured" }),
      completed({ inputTokens: 200, outputTokens: 20, cacheReadTokens: 0, source: "measured" }),
      completed({ inputTokens: 200, outputTokens: 20, source: "measured" }),
      completed({ inputTokens: 200, outputTokens: 20, cacheUsageIssue: "conflict", source: "measured" }),
    ]);
    expect(m).toMatchObject({ tokens_input: 800, tokens_output: 80, cache_tokens_read: 128,
      cache_observed_calls: 2, cache_unknown_calls: 2, cache_conflicting_calls: 1,
      cache_measured_prompt_tokens: 400, cache_hit_rate: .32 });
  });
  it.each(["estimated", "unknown", undefined])("C1 %s provenance cannot certify a measured cache hit", source => {
    const m = computeMetrics([completed({ inputTokens: 200, outputTokens: 20, cacheReadTokens: 128, ...(source === undefined ? {} : { source }) })]);
    expect(m.cache_observed_calls).toBe(0); expect(m.cache_unknown_calls).toBe(1);
    expect(m.cache_hit_rate).toBeUndefined(); expect(m.cache_measured_read_tokens).toBe(0);
  });
  it("C1 partial usage cannot certify a fully measured call or a cache hit rate", () => {
    const m = computeMetrics([completed({ outputTokens: 20, source: "measured" })]);
    expect(m.usage_unknown).toBe(1);
    expect(m.cache_unknown_calls).toBe(1);
    expect(m.cache_hit_rate).toBeUndefined();
  });
  it("tokens come from the nested usage record; provenance rides along", () => {
    const m = computeMetrics([
      completed({ inputTokens: 100, outputTokens: 50, source: "measured" }),
      completed({ inputTokens: 30, outputTokens: 10, source: "measured" }),
    ]);
    expect(m.tokens_input).toBe(130);
    expect(m.tokens_output).toBe(60);
    expect(m.usage_unknown).toBe(0);
    expect(m.model_call_count).toBe(2);
  });

  it("a provider-less call counts as usage_unknown and contributes NO tokens", () => {
    const m = computeMetrics([
      completed({ inputTokens: 100, outputTokens: 50, source: "measured" }),
      // provider returned nothing — the runtime stamped { source: "unknown" }.
      completed({ source: "unknown" }),
    ]);
    expect(m.tokens_input).toBe(100);
    expect(m.tokens_output).toBe(50);
    expect(m.usage_unknown).toBe(1);
    expect(m.model_call_count).toBe(2);
  });

  it("a missing usage payload counts as unknown too (never a free call)", () => {
    const m = computeMetrics([completed(undefined)]);
    expect(m.usage_unknown).toBe(1);
    expect(m.tokens_input).toBe(0);
    expect(m.model_call_count).toBe(1);
  });

  it("cache tokens are aggregated from the usage record", () => {
    const m = computeMetrics([
      completed({ inputTokens: 100, outputTokens: 50, cacheReadTokens: 40, cacheCreationTokens: 200, source: "measured" }),
      completed({ inputTokens: 10, outputTokens: 5, cacheReadTokens: 90, source: "measured" }),
    ]);
    expect(m.cache_tokens_read).toBe(130);
    expect(m.cache_tokens_created).toBe(200);
  });
});
