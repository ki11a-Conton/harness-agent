import { expect, it } from "vitest";
import { createCodingSummaryAdapter } from "./coding-summary.js";
import { MultiStageCompactor } from "./compaction.js";
import type { ContextBlock } from "@ar/contracts";

const critical = "# Compaction Summary\n\n## Goal\nFix the current task, not the old one\n\n## Failures\n- pnpm test exits 1: exact failure\n\n## Open Tasks\n- repair src/a.ts at version sha-current";
const full = critical + "\n\n## Completed Work\n" + Array.from({ length: 80 }, (_, i) => `- read file ${i}: ${"observed ".repeat(10)}`).join("\n");
it("structured summary preserves current goal, unresolved check and file version while bounding completed work", async () => {
  const summary = await createCodingSummaryAdapter({ mode: "structured-v1", minTokens: 1, maxTokens: 600 })(full);
  expect(summary).toContain(critical); expect(summary.length).toBeLessThan(full.length);
  expect(Buffer.byteLength(summary)).toBeLessThanOrEqual(2400);
});
it("external summary rejects dropped facts, expansion, timeout and thrown callbacks", async () => {
  for (const summarize of [() => "all done", () => full + full, () => { throw new Error("host unavailable"); }, (_: string, signal: AbortSignal) => new Promise<string>((_, reject) => signal.addEventListener("abort", () => reject(new Error("cancelled"))))]) {
    const adapter = createCodingSummaryAdapter({ mode: "external-v1", implementationId: "offline-v1", summarize, minTokens: 1, maxTokens: 600, timeoutMs: 5 });
    expect(await adapter(full)).toBe(full);
  }
});
it("accepts a genuinely smaller factual host summary, without inventing a model call", async () => {
  const adapter = createCodingSummaryAdapter({ mode: "external-v1", implementationId: "offline-factual-v1", minTokens: 1, maxTokens: 600, summarize: () => critical });
  expect(await adapter(full)).toBe(critical);
});
it("summary remains semi-trusted, non-instructional, nonpersistable in the real compactor", async () => {
  const compactor = new MultiStageCompactor({ summarize: createCodingSummaryAdapter({ mode: "structured-v1", minTokens: 1, maxTokens: 600 }) });
  const block: ContextBlock = { id: "tool-evidence", content: "read evidence", source: "tool", trust: "untrusted", priority: 1, tokens: 4, compressible: true, ephemeral: false, category: "evidence" };
  const result = await compactor.compact([block], { goal: "current goal", constraints: ["preserve user work"], decisions: [], completed: [], filesChanged: ["src/a.ts"], commandsRun: ["pnpm test"], tests: ["failed"], failures: ["exit 1"], openTasks: ["repair"], importantFacts: [], artifactRefs: [], childAgentRefs: [] });
  expect(result.find(item => item.id === "compaction-summary")).toMatchObject({ trust: "semi-trusted", instructional: false, persistable: false });
});
