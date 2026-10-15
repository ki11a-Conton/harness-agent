import type { Usage } from "@ar/contracts";

const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const count = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;

/** Cache counts are subsets of prompt_tokens, not additional input tokens.
 * Reject contradictory observations rather than manufacturing a hit rate. */
export function parseOpenAIUsage(value: unknown): Usage | undefined {
  const raw = record(value);
  const usage: Usage = {};
  const input = count(raw.prompt_tokens);
  const output = count(raw.completion_tokens);
  if (input !== undefined) usage.inputTokens = input;
  if (output !== undefined) usage.outputTokens = output;
  const details = record(raw.prompt_tokens_details);
  const hasOpenAI = Object.hasOwn(details, "cached_tokens");
  const hasDeepSeek = Object.hasOwn(raw, "prompt_cache_hit_tokens");
  const hasMiss = Object.hasOwn(raw, "prompt_cache_miss_tokens");
  const openai = count(details.cached_tokens);
  const deepseek = count(raw.prompt_cache_hit_tokens);
  const miss = count(raw.prompt_cache_miss_tokens);
  const cached = openai ?? deepseek;
  if ((hasOpenAI && openai === undefined) || (hasDeepSeek && deepseek === undefined) || (hasMiss && miss === undefined)
    || (input !== undefined && [openai, deepseek, miss].some(n => n !== undefined && n > input))) {
    usage.cacheUsageIssue = "invalid";
  } else if ((openai !== undefined && deepseek !== undefined && openai !== deepseek)
    || (input !== undefined && cached !== undefined && miss !== undefined && cached + miss !== input)) {
    usage.cacheUsageIssue = "conflict";
  } else {
    if (cached !== undefined) {
      usage.cacheReadTokens = cached;
      usage.cacheUsageSource = openai !== undefined ? "openai-details" : "deepseek";
    }
  }
  return Object.keys(usage).length ? usage : undefined;
}
