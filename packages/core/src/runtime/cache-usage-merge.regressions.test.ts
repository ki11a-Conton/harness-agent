import { expect, it } from "vitest";
import { mergeUsage } from "./model-call-controller.js";

it("C1 invalid later cache snapshots clear stale hits; a measured zero can recover the observation", () => {
  const first = mergeUsage(undefined, { inputTokens: 200, cacheReadTokens: 128, cacheUsageSource: "deepseek", source: "measured" });
  const invalid = mergeUsage(first, { cacheUsageIssue: "conflict", outputTokens: 20 });
  expect(invalid).toMatchObject({ inputTokens: 200, outputTokens: 20, source: "measured", cacheUsageIssue: "conflict" });
  expect(invalid.cacheReadTokens).toBeUndefined(); expect(invalid.cacheUsageSource).toBeUndefined();
  const recovered = mergeUsage(invalid, { cacheReadTokens: 0, cacheUsageSource: "openai-details" });
  expect(recovered.cacheReadTokens).toBe(0); expect(recovered.cacheUsageIssue).toBeUndefined();
  expect(recovered.inputTokens).toBe(200);
});
