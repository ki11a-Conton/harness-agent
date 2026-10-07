import { join } from "node:path";
import { expect, it } from "vitest";
import { loadBenchmarkCases } from "@ar/evaluation";
import { ScriptedModelProvider } from "@ar/model";
import { runOneCase } from "./benchmark-command.js";

it("B16: the unchanged HTTP oracle is denied by the benchmark network policy instead of falsely verified", async () => {
  const cases = await loadBenchmarkCases(join(process.cwd(), "benchmarks/regression"));
  const caseDef = cases.find((item) => item.id === "reg-22-api-stub")!;
  expect(caseDef).toBeDefined();
  const provider = new ScriptedModelProvider([
    ScriptedModelProvider.toolCall("write_file", { path: "server.js", content: "module.exports = require('http').createServer((req,res) => { res.setHeader('Content-Type','application/json');res.end(JSON.stringify({ok:true})); });\n" }),
    ScriptedModelProvider.text("ready"),
  ]);
  const result = await runOneCase(caseDef, { provider, modelId: "scripted-model", budgetTokens: 32_000 }, "regression");
  expect(result.grade).not.toBe("verified_complete");
  expect(JSON.stringify(result)).toContain("network denied");
  expect(result.events?.filter((event) => event.type === "verification.completed")).toHaveLength(0);
  expect(result.events?.some((event) => event.type === "security.network_denied")).toBe(true);
});
