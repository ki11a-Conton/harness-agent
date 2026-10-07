import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ScriptedModelProvider } from "@ar/model";
import { loadBenchmarkCases } from "@ar/evaluation";
import { runOneCase } from "./benchmark-command.js";

describe("source audit: actual file effects and experiment arm lineage", () => {
  it.each([{ candidate: "tool_call_efficiency_v1", armId: "baseline" },
    { candidate: "context_safe_tool_call_efficiency_v2", armId: "candidate" }, { armId: "baseline" }])("denied outside write is contained: %j", async opts => {
    const root = mkdtempSync(join(tmpdir(), "audit-denied-")); const outside = join(root, "outside.txt");
    try {
      const cases = await loadBenchmarkCases(join(process.cwd(), "benchmarks/regression"));
      const target = cases.find(c => c.id === "reg-01-fix-off-by-one") ?? cases[0]!;
      const provider = new ScriptedModelProvider([ScriptedModelProvider.toolCall("write_file", { path: outside, content: "denied" }),
        ScriptedModelProvider.text("done"), ScriptedModelProvider.text("done"), ScriptedModelProvider.text("done")]);
      const outcome = await runOneCase(target, { ...opts, provider, modelId: "scripted", budgetTokens: 32000, repetition: 0, attempt: 2 }, "regression");
      expect(existsSync(outside)).toBe(false);
      expect(outcome.failureCategory).not.toBe("infrastructure");
      expect(outcome.securityOutcome).toMatchObject({ armId: opts.armId, kind: "CONTAINED", hardBreach: false });
      expect(outcome.securityOutcome?.facts).not.toHaveLength(0);
      for (const fact of outcome.securityOutcome!.facts) expect(fact.correlation).toMatchObject({ armId: opts.armId, repetition: 0, attempt: 2 });
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
