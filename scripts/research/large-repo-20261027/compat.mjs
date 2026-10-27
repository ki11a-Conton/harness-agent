// Compare actual ToolOrchestrator results on identical, synthetic source files.
// Usage: node compare.mjs <baseline-repo> <candidate-repo>
import { strict as assert } from "node:assert";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

if (process.argv.length !== 4) throw new Error("Supply baseline and candidate repository paths");
const dirs = process.argv.slice(2).map(path => resolve(path));
async function load(repo) {
  const module = path => import(pathToFileURL(join(repo, path)).href);
  const [{ ToolOrchestrator }, { ToolRegistry }, { symbolSearchTool }, contracts] = await Promise.all([
    module("packages/tools/dist/orchestrator.js"), module("packages/tools/dist/registry.js"),
    module("packages/tools/dist/tools/navigation-tools.js"), module("packages/contracts/dist/index.js"),
  ]);
  return { ToolOrchestrator, ToolRegistry, symbolSearchTool, contracts };
}
const implementations = await Promise.all(dirs.map(load));
const root = await fs.mkdtemp(join(tmpdir(), "coding-navigation-compare-"));
try {
  for (let i = 0; i < 40; i++) {
    const suffix = String(i).padStart(2, "0");
    await fs.writeFile(join(root, `frontend-${suffix}.ts`), `export const SharedSymbol = ${i};\n`);
    await fs.writeFile(join(root, `worker-${suffix}.py`), `def SharedSymbol():\n    return ${i}\n`);
  }
  await fs.writeFile(join(root, "worker.go"), "func SharedSymbol() int { return 2 }\n");
  await fs.writeFile(join(root, "worker.rs"), "pub fn SharedSymbol() -> usize { 3 }\n");
  const times = [[], []], observed = [null, null];
  async function execute(index) {
    const impl = implementations[index];
    const { newAgentId, newSessionId, newToolCallId, newTurnId } = impl.contracts;
    const context = { cwd: root, sessionId: newSessionId(), agentId: newAgentId(), turnId: newTurnId(),
      signal: new AbortController().signal, permissions: { rules: [], defaultEffect: "allow" },
      sandboxPolicy: { filesystem: { mode: "workspace-write" }, network: { mode: "deny" }, process: { timeoutMs: 10000, maxOutputBytes: 65536 } } };
    const registry = new impl.ToolRegistry(); registry.register(impl.symbolSearchTool);
    const orchestrator = new impl.ToolOrchestrator({ registry, workspaceRoot: root });
    const start = performance.now();
    const result = await orchestrator.execute({ id: newToolCallId(), sessionId: context.sessionId, agentId: context.agentId,
      turnId: context.turnId, call: { id: newToolCallId(), name: "symbol_search", args: { symbol: "SharedSymbol" } } }, context);
    times[index].push(Math.round((performance.now() - start) * 100) / 100);
    assert.equal(result.status, "success", JSON.stringify(result.error));
    const files = result.output.hits.map(hit => hit.file);
    observed[index] = { total: files.length, typescript: files.filter(file => file.endsWith(".ts")).length,
      python: files.filter(file => file.endsWith(".py")).length, go: files.includes("worker.go"), rust: files.includes("worker.rs"),
      outputBytes: Buffer.byteLength(JSON.stringify(result.output), "utf8") };
  }
  for (const order of [[0, 1], [1, 0], [0, 1], [1, 0]]) for (const index of order) await execute(index);
  assert.deepEqual({ ...observed[0], outputBytes: undefined }, { total: 82, typescript: 40, python: 40, go: true, rust: true, outputBytes: undefined });
  assert.deepEqual({ ...observed[1], outputBytes: undefined }, { total: 82, typescript: 40, python: 40, go: true, rust: true, outputBytes: undefined });
  const mixed = { fixture: "40 TS + 40 Python + Go + Rust", baseline: { ...observed[0], elapsedMs: [...times[0]] },
    candidate: { ...observed[1], elapsedMs: [...times[1]] } };
  for (let i = 0; i < 40; i++) await fs.rm(join(root, `worker-${String(i).padStart(2, "0")}.py`));
  await fs.rm(join(root, "worker.go")); await fs.rm(join(root, "worker.rs"));
  await fs.writeFile(join(root, "README.md"), "Documentation without the searched identifier.\n");
  times[0].length = 0; times[1].length = 0;
  for (const order of [[0, 1], [1, 0], [0, 1], [1, 0]]) for (const index of order) await execute(index);
  for (const result of observed) assert.equal(result.total, 40);
  const typescriptOnly = { fixture: "40 TS + unrelated README", baseline: { ...observed[0], elapsedMs: [...times[0]] },
    candidate: { ...observed[1], elapsedMs: [...times[1]] } };
  console.log(JSON.stringify({ pairedOrder: ["AB", "BA", "AB", "BA"], mixed, typescriptOnly, paidModelCalls: 0 }, null, 2));
} finally {
  await fs.rm(root, { recursive: true, force: true });
}
