#!/usr/bin/env node
// Offline paired benchmark. Run against compiled baseline/candidate worktrees.
import { promises as fs } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { performance } from "node:perf_hooks";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";

const args = process.argv.slice(2);
function option(name, fallback) {
  const index = args.indexOf(name);
  return index < 0 ? fallback : args[index + 1];
}
function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}
const native = Object.fromEntries(
  ["stat", "readFile", "readdir", "writeFile", "mkdir", "mkdtemp", "rm"].map(
    (name) => [name, fs[name].bind(fs)],
  ),
);

if (args.includes("--compare")) {
  const baseline = JSON.parse(await native.readFile(resolve(option("--baseline")), "utf8"));
  const candidate = JSON.parse(await native.readFile(resolve(option("--candidate")), "utf8"));
  if (JSON.stringify(baseline.config) !== JSON.stringify(candidate.config)) {
    throw new Error("Baseline and candidate fixture configurations must match");
  }
  if (baseline.scriptDigest !== candidate.scriptDigest || JSON.stringify(baseline.environment) !== JSON.stringify(candidate.environment)) {
    throw new Error("Paired measurements must use the same script and Node/platform environment");
  }
  const gates = [
    ["repoWarmBurst", "stat", 0.90],
    ["repoChanged", "stat", 0.45],
    ["boundedScan", "readdir", 0.75],
    ["symbolColdBurst", "readFile", 0.90],
  ].map(([scenario, operation, minimumReduction]) => {
    const before = baseline.scenarios[scenario].medianOperations[operation];
    const after = candidate.scenarios[scenario].medianOperations[operation];
    const reduction = 1 - after / before;
    return { scenario, operation, before, after, reduction, minimumReduction, passed: before > 0 && reduction >= minimumReduction };
  });
  const correctnessPassed = Object.values(candidate.correctness).every(Boolean);
  const report = { schemaVersion: 1, baseline, candidate, gates, correctnessPassed, passed: correctnessPassed && gates.every((gate) => gate.passed) };
  const output = option("--out");
  if (output) {
    await native.mkdir(dirname(resolve(output)), { recursive: true });
    await native.writeFile(resolve(output), `${JSON.stringify(report, null, 2)}\n`);
  }
  console.log(JSON.stringify({ gates, correctnessPassed, passed: report.passed }, null, 2));
  if (!report.passed) process.exitCode = 1;
} else {
  const repoRoot = resolve(option("--repo-root", process.cwd()));
  const config = { samples: Number(option("--samples", "7")), directories: 24, filesPerDirectory: 8, concurrency: 16, scanLimit: 8 };
  if (!Number.isInteger(config.samples) || config.samples < 1) throw new Error("--samples must be a positive integer");
  let active = null;
  for (const name of ["stat", "readFile", "readdir"]) {
    fs[name] = async (...input) => {
      if (active) active[name]++;
      return native[name](...input);
    };
  }
  syncBuiltinESMExports();
  const modulePath = (file) => pathToFileURL(join(repoRoot, "packages/tools/dist", file)).href;
  const { RepositoryMapCache, scanRepoStats } = await import(modulePath("repo-map.js"));
  const { getSymbolIndex, indexedSymbolSearch } = await import(modulePath("symbol-index.js"));
  const { makeRepoMapResolver } = await import(modulePath("tools/repo-map-tool.js"));
  const sourceDigest = createHash("sha256");
  for (const source of ["repo-map.ts", "symbol-index.ts", "tools/repo-map-tool.ts"]) {
    sourceDigest.update(source).update(await native.readFile(join(repoRoot, "packages/tools/src", source)));
  }
  const fixtureRoot = await native.mkdtemp(join(tmpdir(), "workspace-knowledge-bench-"));
  let sequence = 0;
  async function fixture() {
    const root = join(fixtureRoot, `sample-${sequence++}`);
    await native.mkdir(root, { recursive: true });
    await native.writeFile(join(root, "package.json"), JSON.stringify({ name: "fixture-v1", scripts: { test: "node --test" } }));
    for (let dir = 0; dir < config.directories; dir++) {
      const directory = join(root, "sources", `group-${String(dir).padStart(2, "0")}`);
      await native.mkdir(directory, { recursive: true });
      for (let file = 0; file < config.filesPerDirectory; file++) {
        await native.writeFile(join(directory, `file-${file}.ts`), `export const SearchNeedle = ${dir * config.filesPerDirectory + file};\n`);
      }
    }
    return root;
  }
  async function measure(action) {
    active = { stat: 0, readFile: 0, readdir: 0 };
    const operations = active;
    const started = performance.now();
    try {
      const value = await action();
      return { operations, elapsedMs: performance.now() - started, value };
    } finally {
      active = null;
    }
  }
  const observations = { repoWarmBurst: [], repoChanged: [], boundedScan: [], symbolColdBurst: [], symbolWarmBurst: [], symbolChanged: [] };
  const correctness = { repoWarmStable: true, repoChangeVisible: true, scanBounded: true, symbolBurstComplete: true, symbolWarmReuse: true, symbolChangedVisible: true };
  try {
    for (let sample = 0; sample < config.samples; sample++) {
      const root = await fixture();
      const cache = new RepositoryMapCache({ root });
      const initial = await cache.get();
      const warm = await measure(() => Promise.all(Array.from({ length: config.concurrency }, () => cache.get())));
      correctness.repoWarmStable &&= warm.value.every((map) => map === initial);
      observations.repoWarmBurst.push({ operations: warm.operations, elapsedMs: warm.elapsedMs });
      await native.writeFile(join(root, "package.json"), JSON.stringify({ name: "fixture-v2-with-change", scripts: { test: "node --test" } }));
      const changed = await measure(() => cache.get());
      correctness.repoChangeVisible &&= changed.value.packages.some((pkg) => pkg.name === "fixture-v2-with-change");
      observations.repoChanged.push({ operations: changed.operations, elapsedMs: changed.elapsedMs });
      const bounded = await measure(() => scanRepoStats(root, config.scanLimit));
      correctness.scanBounded &&= bounded.value.length === config.scanLimit;
      observations.boundedScan.push({ operations: bounded.operations, elapsedMs: bounded.elapsedMs });
      const cold = await measure(() => Promise.all(Array.from({ length: config.concurrency }, () => getSymbolIndex(root))));
      correctness.symbolBurstComplete &&= cold.value.every((index) => index.filesIndexed === config.directories * config.filesPerDirectory);
      observations.symbolColdBurst.push({ operations: cold.operations, elapsedMs: cold.elapsedMs });
      const symbolCached = await getSymbolIndex(root);
      const symbolWarm = await measure(() => Promise.all(Array.from({ length: config.concurrency }, () => getSymbolIndex(root))));
      correctness.symbolWarmReuse &&= symbolWarm.value.every((index) => index.files.get("sources/group-00/file-0.ts") === symbolCached.files.get("sources/group-00/file-0.ts"));
      observations.symbolWarmBurst.push({ operations: symbolWarm.operations, elapsedMs: symbolWarm.elapsedMs });
      await native.writeFile(join(root, "sources/group-00/file-0.ts"), "export const ChangedSingleFileSymbol = 10000;\n");
      const symbolChanged = await measure(() => indexedSymbolSearch({ root, symbol: "ChangedSingleFileSymbol" }));
      correctness.symbolChangedVisible &&= symbolChanged.value.hits.some((hit) => hit.file === "sources/group-00/file-0.ts");
      observations.symbolChanged.push({ operations: symbolChanged.operations, elapsedMs: symbolChanged.elapsedMs });
    }
    const root = await fixture();
    const all = await indexedSymbolSearch({ root, symbol: "SearchNeedle", relPath: "." });
    correctness.defaultSymbolScope = all.hits.length === config.directories * config.filesPerDirectory;
    const changedFile = join(root, "sources/group-00/file-0.ts");
    await native.writeFile(changedFile, "export const ChangedNestedSymbol = 10000;\n");
    correctness.nestedSymbolChangeVisible = (await indexedSymbolSearch({ root, symbol: "ChangedNestedSymbol" })).hits.some((hit) => hit.file === "sources/group-00/file-0.ts");
    const resolver = makeRepoMapResolver();
    const otherRoot = await fixture();
    await resolver.resolve({}, root);
    correctness.workspaceIsolation = (await resolver.resolve({}, otherRoot)).root === otherRoot;
    correctness.fileBudgetIsolation = (await resolver.resolve({ maxFiles: 2 }, root)).fileCount === 2;
    const scenarios = Object.fromEntries(Object.entries(observations).map(([name, samples]) => [name, {
      samples,
      medianOperations: Object.fromEntries(["stat", "readFile", "readdir"].map((operation) => [operation, median(samples.map((sample) => sample.operations[operation]))])),
      medianElapsedMs: median(samples.map((sample) => sample.elapsedMs)),
    }]));
    // A zero count would indicate instrumentation failure, not an optimization.
    if (scenarios.repoWarmBurst.medianOperations.stat === 0 || scenarios.symbolColdBurst.medianOperations.readFile === 0) {
      throw new Error("Filesystem instrumentation did not observe both map and index operations");
    }
    const sourceChangesFromCommit = execFileSync("git", ["diff", "--name-only", "HEAD", "--", "packages/tools/src/repo-map.ts", "packages/tools/src/symbol-index.ts", "packages/tools/src/tools/repo-map-tool.ts"], { cwd: repoRoot, encoding: "utf8" }).trim().split("\n").filter(Boolean);
    const report = { schemaVersion: 1, label: option("--label", "unspecified"), sourceCommit: execFileSync("git", ["rev-parse", "HEAD"], { cwd: repoRoot, encoding: "utf8" }).trim(), sourceChangesFromCommit, sourceDigest: sourceDigest.digest("hex"), scriptDigest: createHash("sha256").update(await native.readFile(new URL(import.meta.url))).digest("hex"), environment: { node: process.version, platform: process.platform, arch: process.arch }, config, scenarios, correctness };
    const output = option("--out");
    if (output) {
      await native.mkdir(dirname(resolve(output)), { recursive: true });
      await native.writeFile(resolve(output), `${JSON.stringify(report, null, 2)}\n`);
    }
    console.log(JSON.stringify({ label: report.label, scenarios: Object.fromEntries(Object.entries(scenarios).map(([name, scenario]) => [name, { operations: scenario.medianOperations, elapsedMs: scenario.medianElapsedMs }])), correctness }, null, 2));
  } finally {
    await native.rm(fixtureRoot, { recursive: true, force: true });
  }
}
