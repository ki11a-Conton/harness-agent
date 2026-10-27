// Linux: run with `ulimit -c 0` before starting; the baseline child may OOM.
// Usage: node probe.mjs <built-repository> [--expect-success]
import { strict as assert } from "node:assert";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const script = fileURLToPath(import.meta.url);
const mode = process.argv[2];
if (mode === "child-large" || mode === "child-line" || mode === "child-cache" || mode === "child-parallel") {
  const repo = resolve(process.argv[3]), root = resolve(process.argv[4]);
  const load = path => import(pathToFileURL(join(repo, path)).href);
  if (mode === "child-large" || mode === "child-line") {
    const [{ ToolOrchestrator }, { ToolRegistry }, { symbolSearchTool }, c] = await Promise.all([
      load("packages/tools/dist/orchestrator.js"), load("packages/tools/dist/registry.js"),
      load("packages/tools/dist/tools/navigation-tools.js"), load("packages/contracts/dist/index.js"),
    ]);
    const context = { cwd: root, sessionId: c.newSessionId(), agentId: c.newAgentId(), turnId: c.newTurnId(),
      signal: new AbortController().signal, permissions: { rules: [], defaultEffect: "allow" },
      sandboxPolicy: { filesystem: { mode: "workspace-write" }, network: { mode: "deny" }, process: { timeoutMs: 20000 } } };
    const registry = new ToolRegistry(); registry.register(symbolSearchTool);
    const orch = new ToolOrchestrator({ registry, workspaceRoot: root });
    const result = await orch.execute({ id: c.newToolCallId(), sessionId: context.sessionId, agentId: context.agentId,
      turnId: context.turnId, call: { id: c.newToolCallId(), name: "symbol_search", args: { symbol: "Needle" } } }, context);
    assert.equal(result.status, "success", JSON.stringify(result.error));
    await new Promise(resolve => setImmediate(resolve));
    global.gc?.();
    await new Promise(resolve => setImmediate(resolve));
    global.gc?.();
    console.log(JSON.stringify({ status: result.status, hits: result.output.hits.map(h => ({ file: h.file, line: h.line })),
      complete: result.output.complete ?? null, limitedLongLines: result.output.lexicalSummary?.limitedLongLines ?? null,
      rss: process.memoryUsage().rss, heapUsed: process.memoryUsage().heapUsed, external: process.memoryUsage().external }));
  } else if (mode === "child-cache") {
    const { getSymbolIndex } = await load("packages/tools/dist/symbol-index.js");
    for (let i = 0; i < 16; i++) {
      const scope = `scope-${String(i).padStart(2, "0")}`;
      const index = await getSymbolIndex(root, scope);
      assert.equal(index.filesIndexed, 1);
      assert.ok(index.files.has(`${scope}/source.ts`));
      global.gc?.();
      console.log(JSON.stringify({ scope, heapUsed: process.memoryUsage().heapUsed, rss: process.memoryUsage().rss }));
    }
    const again = await getSymbolIndex(root, "scope-00");
    assert.ok(again.files.has("scope-00/source.ts"));
    console.log(JSON.stringify({ completed: true, rss: process.memoryUsage().rss, heapUsed: process.memoryUsage().heapUsed }));
  } else {
    const [{ ToolOrchestrator }, { ToolRegistry }, { symbolSearchTool }, c] = await Promise.all([
      load("packages/tools/dist/orchestrator.js"), load("packages/tools/dist/registry.js"),
      load("packages/tools/dist/tools/navigation-tools.js"), load("packages/contracts/dist/index.js"),
    ]);
    let peakRss = 0, peakHeap = 0;
    const timer = setInterval(() => {
      const memory = process.memoryUsage(); peakRss = Math.max(peakRss, memory.rss); peakHeap = Math.max(peakHeap, memory.heapUsed);
    }, 5);
    try {
      const results = await Promise.all(Array.from({ length: 5 }, async (_, i) => {
        const context = { cwd: root, sessionId: c.newSessionId(), agentId: c.newAgentId(), turnId: c.newTurnId(), signal: new AbortController().signal,
          permissions: { rules: [], defaultEffect: "allow" }, sandboxPolicy: { filesystem: { mode: "workspace-write" }, network: { mode: "deny" }, process: { timeoutMs: 20000 } } };
        const registry = new ToolRegistry(); registry.register(symbolSearchTool);
        const orch = new ToolOrchestrator({ registry, workspaceRoot: root });
        const result = await orch.execute({ id: c.newToolCallId(), sessionId: context.sessionId, agentId: context.agentId, turnId: context.turnId,
          call: { id: c.newToolCallId(), name: "symbol_search", args: { symbol: "Needle", path: `source-${i}.ts` } } }, context);
        return { status: result.status, complete: result.output?.complete, hits: result.output?.hits?.map(hit => ({ file: hit.file, line: hit.line })) };
      }));
      console.log(JSON.stringify({ results, peakRss, peakHeap }));
    } finally { clearInterval(timer); }
  }
} else {
  if (process.argv.length !== 3 && !(process.argv.length === 4 && process.argv[3] === "--expect-success")) {
    throw new Error("Supply a built repository path and optional --expect-success");
  }
  const repo = resolve(mode), root = await fs.mkdtemp(join(tmpdir(), "ar-large-index-probe-"));
  try {
    const largeDir = join(root, "large"), lineDir = join(root, "line"), cacheDir = join(root, "cache"), parallelDir = join(root, "parallel");
    await fs.mkdir(largeDir); await fs.mkdir(lineDir); await fs.mkdir(cacheDir); await fs.mkdir(parallelDir);
    const large = join(largeDir, "big.ts");
    await fs.writeFile(large, "const item = 123;\n".repeat(1200000) + "export const Needle = 1;\n");
    for (let i = 0; i < 5; i++) await fs.link(large, join(parallelDir, `source-${i}.ts`));
    await fs.writeFile(join(lineDir, "minified.ts"), "A".repeat(21600000) + "Needle");
    const template = join(root, "template.txt");
    await fs.writeFile(template, "// abc def\n".repeat(180000));
    for (let i = 0; i < 16; i++) {
      const scope = join(cacheDir, `scope-${String(i).padStart(2, "0")}`);
      await fs.mkdir(scope); await fs.link(template, join(scope, "source.ts"));
    }
    function child(name, cwd) {
      const result = spawnSync(process.execPath, ["--max-old-space-size=64", "--expose-gc", script, name, repo, cwd],
        { encoding: "utf8", timeout: 30000, maxBuffer: 65536 });
      return { exit: result.status, signal: result.signal, stdout: result.stdout.trim().slice(-3500),
        stderrTail: result.stderr.trim().slice(-1800), error: result.error?.message ?? null };
    }
    const largeFile = child("child-large", largeDir), longLine = child("child-line", lineDir), cache = child("child-cache", cacheDir),
      parallel = child("child-parallel", parallelDir);
    console.log(JSON.stringify({ fixture: { bytes: (await fs.stat(large)).size, lines: 1200001, scopes: 16,
      bytesPerScope: (await fs.stat(template)).size, heapLimitMiB: 64 },
      largeFile, longLine, cache, parallel, paidModelCalls: 0 }, null, 2));
    if (process.argv[3] === "--expect-success") {
      assert.equal(largeFile.exit, 0, "large-file child failed");
      assert.deepEqual(JSON.parse(largeFile.stdout).hits, [{ file: "big.ts", line: 1200001 }]);
      assert.equal(longLine.exit, 0, "long-line child failed");
      assert.deepEqual(JSON.parse(longLine.stdout).hits, [{ file: "minified.ts", line: 1 }]);
      assert.equal(JSON.parse(longLine.stdout).complete, false);
      assert.equal(JSON.parse(longLine.stdout).limitedLongLines, 1);
      assert.equal(cache.exit, 0, "cache child failed");
      assert.equal(JSON.parse(cache.stdout.split("\n").at(-1)).completed, true);
      assert.equal(parallel.exit, 0, "parallel child failed");
      const concurrent = JSON.parse(parallel.stdout).results;
      assert.equal(concurrent.length, 5);
      for (let i = 0; i < concurrent.length; i++) {
        assert.equal(concurrent[i].status, "success"); assert.equal(concurrent[i].complete, true);
        assert.deepEqual(concurrent[i].hits, [{ file: `source-${i}.ts`, line: 1200001 }]);
      }
    }
  } finally { await fs.rm(root, { recursive: true, force: true }); }
}
