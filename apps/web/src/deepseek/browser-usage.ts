/** Native inputTokens includes cache subsets. The browser protocol's
 * inputTokens is the remaining input category; totalTokens is inclusive.
 * Missing cache observations stay absent, never manufactured as measured zero. */
export function modelUsageForBrowser(value: unknown): Record<string, number> | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  if (raw.source !== undefined && raw.source !== "measured") return undefined;
  const count = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
  const input = count(raw.inputTokens) ? raw.inputTokens : undefined;
  const output = count(raw.outputTokens) ? raw.outputTokens : undefined;
  const cacheRead = count(raw.cacheReadTokens) && raw.cacheUsageIssue === undefined ? raw.cacheReadTokens : undefined;
  const cacheWrite = count(raw.cacheCreationTokens) && raw.cacheUsageIssue === undefined ? raw.cacheCreationTokens : undefined;
  const subset = (cacheRead ?? 0) + (cacheWrite ?? 0);
  const validCache = count(subset) && (input === undefined || subset <= input);
  const usage: Record<string, number> = {};
  if (input !== undefined) usage.inputTokens = input - (validCache ? subset : 0);
  if (output !== undefined) usage.outputTokens = output;
  if (input !== undefined && output !== undefined && count(input + output)) usage.totalTokens = input + output;
  if (validCache && cacheRead !== undefined) usage.cacheReadTokens = cacheRead;
  if (validCache && cacheWrite !== undefined) usage.cacheWriteTokens = cacheWrite;
  return Object.keys(usage).length ? usage : undefined;
}
