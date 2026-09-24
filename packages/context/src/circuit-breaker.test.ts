import { describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach } from "vitest";
import type { CompactionSummary, ContextBlock } from "@ar/contracts";
import { CompactionCircuitBreaker } from "./circuit-breaker.js";
import { ContextPipeline } from "./pipeline.js";

let tempRoot: string | undefined;
afterEach(async () => {
  if (tempRoot !== undefined) {
    await rm(tempRoot, { recursive: true, force: true });
    tempRoot = undefined;
  }
});
async function freshRoot(): Promise<string> {
  tempRoot = await mkdtemp(join(tmpdir(), "breaker-"));
  return tempRoot;
}
async function writeDocs(root: string, files: Record<string, string>): Promise<void> {
  for (const [rel, content] of Object.entries(files)) {
    const full = join(root, rel);
    await mkdir(dirname(full), { recursive: true });
    await writeFile(full, content, "utf8");
  }
}
function block(over: Partial<ContextBlock>): ContextBlock {
  return {
    id: "b", source: "tool", trust: "semi-trusted", priority: 100, tokens: 10,
    content: "content", compressible: true, ephemeral: false, category: "evidence", ...over,
  };
}
const SUMMARY: CompactionSummary = {
  goal: "g", constraints: [], decisions: [], completed: [], filesChanged: [],
  commandsRun: [], tests: [], failures: [], openTasks: [], importantFacts: [], artifactRefs: [], childAgentRefs: [],
};

describe("P17-8: compaction circuit breaker + stress", () => {
  it("consecutive ineffective compactions arm then OPEN the breaker (no compact loop)", () => {
    const breaker = new CompactionCircuitBreaker({ maxConsecutiveIneffective: 3 });
    const ineffective = [{ stage: "digest" as const, droppedBlocks: 0, beforeTokens: 100, afterTokens: 100, used: false }];
    expect(breaker.record(ineffective, 1)).toBe("armed");
    expect(breaker.canCompact).toBe(true);
    expect(breaker.record(ineffective, 1)).toBe("armed");
    expect(breaker.record(ineffective, 1)).toBe("open");
    expect(breaker.canCompact).toBe(false); // runtime must stop auto-compacting
    expect(breaker.metrics.ineffectiveCompactions).toBe(3);
    expect(breaker.metrics.netTokenDelta).toBe(0);
  });

  it("an EFFECTIVE compaction resets the streak and records metrics", () => {
    const breaker = new CompactionCircuitBreaker({ maxConsecutiveIneffective: 2 });
    breaker.record([{ stage: "digest", droppedBlocks: 1, beforeTokens: 1000, afterTokens: 900, used: true }], 12);
    expect(breaker.state).toBe("closed");
    expect(breaker.metrics.effectiveCompactions).toBe(1);
    expect(breaker.metrics.netTokenDelta).toBe(-100);
    expect(breaker.metrics.totalLatencyMs).toBe(12);
    expect(breaker.metrics.last).toEqual({ beforeTokens: 1000, afterTokens: 900, latencyMs: 12, fallbackUsed: false });
  });

  it("a compact FAILURE arms the breaker (never tight-loop retries)", () => {
    const breaker = new CompactionCircuitBreaker({ maxConsecutiveIneffective: 2 });
    expect(breaker.recordFailure()).toBe("armed");
    expect(breaker.recordFailure()).toBe("open");
  });

  it("fallback usage is counted in the metrics", () => {
    const breaker = new CompactionCircuitBreaker();
    breaker.record([
      { stage: "digest", droppedBlocks: 1, beforeTokens: 1000, afterTokens: 500, used: true },
      { stage: "summary", droppedBlocks: 0, beforeTokens: 500, afterTokens: 400, used: true },
    ], 5);
    expect(breaker.metrics.fallbackCount).toBe(1);
  });

  it("pipeline with an open breaker proceeds WITHOUT compacting (acceptance: no compact loop)", async () => {
    const breaker = new CompactionCircuitBreaker({ maxConsecutiveIneffective: 1 });
    breaker.recordFailure(); // breaker now OPEN
    const root = await freshRoot();
    await writeDocs(root, { "a.md": "# A\nhi\n" });
    const pipeline = new ContextPipeline({ compactionBreaker: breaker });
    const result = await pipeline.build({
      cwd: root,
      systemPrompt: "sys",
      priorBlocks: [block({ id: "t1", source: "tool", content: "x".repeat(2000), tokens: 1000 })],
      budget: { maxTokens: 100, reserved: { system: 10, task: 10, output: 10 }, dynamic: 10 },
      summaryOverride: SUMMARY,
    });
    expect(result.compacted).toBe(false);
    expect(result.compactionBreakerOpen).toBe(true);
    // NO compaction ran: no digest, no rehydration — the breaker stopped the
    // loop entirely (pending work is preserved by the working state, not lost)
    expect(result.blocks.some((b) => b.id === "compaction-summary")).toBe(false);
    expect(result.blocks.some((b) => b.id?.startsWith("rehydrate:"))).toBe(false);
  });

  it("STRESS: 10k large blocks compact in ONE deterministic pass (no loop, pending preserved)", async () => {
    const breaker = new CompactionCircuitBreaker({ maxConsecutiveIneffective: 3 });
    const pipeline = new ContextPipeline({ compactionBreaker: breaker });
    const blocks: ContextBlock[] = [];
    for (let i = 0; i < 10_000; i++) {
      blocks.push(block({
        id: `tool:${i}`,
        source: "tool",
        content: `result-${i}: ${"y".repeat(200)}`,
        tokens: 60,
      }));
    }
    const root = await freshRoot();
    await writeDocs(root, { "a.md": "# A\nhi\n" });
    const result = await pipeline.build({
      cwd: root,
      systemPrompt: "sys",
      priorBlocks: blocks,
      budget: { maxTokens: 1_000, reserved: { system: 50, task: 50, output: 50 }, dynamic: 100 },
      summaryOverride: { ...SUMMARY, openTasks: ["critical-pending-task"], filesChanged: ["src/keep.ts"] },
    });
    // exactly one compaction pass — the breaker did not re-compact in a loop
    expect(result.compacted).toBe(true);
    expect(breaker.metrics.totalCompactions).toBeLessThanOrEqual(1);
    // the digest still carries the protected pending work
    const summary = result.blocks.find((b) => b.id === "compaction-summary");
    expect(summary!.content).toContain("critical-pending-task");
    expect(summary!.content).toContain("src/keep.ts");
  });
});
