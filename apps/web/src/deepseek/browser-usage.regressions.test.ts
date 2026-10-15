import { readFileSync } from "node:fs";
import vm from "node:vm";
import { expect, it } from "vitest";
import { modelUsageForBrowser } from "./browser-usage.js";

// Execute the actual pinned client's pure normalization, not a rewritten
// version of it. Published originals remain unchanged and separately verified.
const original = readFileSync(new URL("../../public/deepseek/plugins/dsh-client-ui-chat/client.js", import.meta.url), "utf8");
function originalFunction(name: string): string {
  const start = original.indexOf(`function ${name}(`); if (start < 0) throw new Error(`client function absent: ${name}`);
  const end = original.indexOf("\n\t\t}", start); if (end < 0) throw new Error("client function boundary absent");
  return original.slice(start, end + 5);
}
const normalize = vm.runInNewContext(`${originalFunction("isCount")}\n${originalFunction("safeSum")}\n${originalFunction("normalizeUsage")}\nnormalizeUsage;`) as (usage: unknown) => Record<string, unknown> | undefined;

it.each([
  [{ inputTokens: 200, outputTokens: 20 }, 200, undefined],
  [{ inputTokens: 200, outputTokens: 20, cacheReadTokens: 128 }, 72, 128],
  [{ inputTokens: 200, outputTokens: 20, cacheReadTokens: 0 }, 200, 0],
  [{ inputTokens: 200, outputTokens: 20, cacheReadTokens: 128, cacheCreationTokens: 16 }, 56, 128],
  [{ inputTokens: 200, outputTokens: 20, cacheReadTokens: 201 }, 200, undefined],
  [{ inputTokens: 200, outputTokens: 20, cacheReadTokens: 128, cacheUsageIssue: "conflict" }, 200, undefined],
])("C1 actual browser normalization preserves inclusive totals without double counting: %j", (native, input, read) => {
  const wire = modelUsageForBrowser(native)!;
  expect(wire.inputTokens).toBe(input); expect(wire.totalTokens).toBe(220); expect(wire.cacheReadTokens).toBe(read);
  const displayed = normalize(wire);
  expect(displayed).toBeDefined(); expect(displayed!.totalTokens).toBe(220); expect(displayed!.inputTokens).toBe(input);
});
it("unknown output/input and unknown cache creation never become measured zero", () => {
  expect(modelUsageForBrowser({ outputTokens: 20 })).toEqual({ outputTokens: 20 });
  expect(modelUsageForBrowser({ inputTokens: 200, outputTokens: 20, cacheReadTokens: 128 })?.cacheWriteTokens).toBeUndefined();
  expect(modelUsageForBrowser({ source: "unknown" })).toBeUndefined();
});
