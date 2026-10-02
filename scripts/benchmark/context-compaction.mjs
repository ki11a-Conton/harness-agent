#!/usr/bin/env node
// Offline paired fixture benchmark; token values are estimator budgets, not provider usage.
import { promises as fs } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { performance } from "node:perf_hooks";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";

const args = process.argv.slice(2);
const option = (name, fallback) => args.includes(name) ? args[args.indexOf(name) + 1] : fallback;
const median = (values) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
async function save(value) {
  const output = option("--out");
  if (output) {
    await fs.mkdir(dirname(resolve(output)), { recursive: true });
    await fs.writeFile(resolve(output), `${JSON.stringify(value, null, 2)}\n`);
  }
}
if (args.includes("--compare")) {
  const baseline = JSON.parse(await fs.readFile(resolve(option("--baseline")), "utf8"));
  const candidate = JSON.parse(await fs.readFile(resolve(option("--candidate")), "utf8"));
  if (JSON.stringify(baseline.config) !== JSON.stringify(candidate.config) || baseline.scriptDigest !== candidate.scriptDigest || JSON.stringify(baseline.environment) !== JSON.stringify(candidate.environment)) {
    throw new Error("Paired fixtures, script and Node/platform environment must match");
  }
  const gates = [
    ["singleLineAscii", "outputBytes", 0.99],
    ["singleLineUnicode", "outputBytes", 0.99],
    ["denseLines", "splitInputBytes", 0.99],
  ].map(([scenario, operation, minimumReduction]) => {
    const before = baseline.scenarios[scenario].medians[operation];
    const after = candidate.scenarios[scenario].medians[operation];
    const reduction = 1 - after / before;
    return { scenario, operation, before, after, reduction, minimumReduction, passed: before > 0 && reduction >= minimumReduction };
  });
  const correctnessPassed = Object.values(candidate.correctness).every(Boolean);
  const report = { schemaVersion: 1, baseline, candidate, gates, correctnessPassed, passed: correctnessPassed && gates.every((gate) => gate.passed) };
  await save(report);
  console.log(JSON.stringify({ gates, correctnessPassed, passed: report.passed }, null, 2));
  if (!report.passed) process.exitCode = 1;
} else {
  const repoRoot = resolve(option("--repo-root", process.cwd()));
  const config = { samples: Number(option("--samples", "7")), previewBytes: 4096, asciiBytes: 1_048_576, unicodeRepeats: 131_072, denseLineRepeats: 262_144 };
  if (!Number.isInteger(config.samples) || config.samples < 1) throw new Error("--samples must be a positive integer");
  const modulePath = (name) => pathToFileURL(join(repoRoot, "packages/context/dist", name)).href;
  const { MultiStageCompactor, DefaultCompactor, previewMarker } = await import(modulePath("compaction.js"));
  const { buildRehydrationBlocks } = await import(modulePath("rehydration.js"));
  const { DEFAULT_TOKEN_ESTIMATOR } = await import(modulePath("tokenizer.js"));
  const { ContextPipeline } = await import(modulePath("pipeline.js"));
  const { CompactionCircuitBreaker } = await import(modulePath("circuit-breaker.js"));
  const summary = { goal: "continue task", constraints: [], decisions: [], completed: [], filesChanged: [], commandsRun: [], tests: [], failures: [], openTasks: [], importantFacts: [], artifactRefs: [], childAgentRefs: [] };
  const block = (over = {}) => ({ id: "evidence", source: "mcp", trust: "semi-trusted", category: "evidence", priority: 100, content: "evidence", tokens: 2, compressible: true, ephemeral: false, ...over });
  const scenarios = {};
  const correctness = { previewBodyBounded: true, previewTokensAccurate: true, previewUnicodeValid: true };
  const nativeSplit = String.prototype.split;
  let operations = null;
  String.prototype.split = function (...input) {
    if (operations && input[0] === "\n") operations.splitInputBytes += Buffer.byteLength(String(this), "utf8");
    return Reflect.apply(nativeSplit, this, input);
  };
  try {
    const fixtures = { singleLineAscii: "x".repeat(config.asciiBytes), singleLineUnicode: "中文🙂".repeat(config.unicodeRepeats), denseLines: "row\n".repeat(config.denseLineRepeats) };
    for (const [name, content] of Object.entries(fixtures)) {
      const samples = [];
      for (let sample = 0; sample < config.samples; sample++) {
        const input = block({ content, tokens: DEFAULT_TOKEN_ESTIMATOR.estimate(content) });
        const compactor = new MultiStageCompactor({ previewMaxBytes: config.previewBytes });
        operations = { splitInputBytes: 0 };
        const observed = operations;
        const started = performance.now();
        let output;
        try { output = await compactor.compact([input], summary); } finally { operations = null; }
        const elapsedMs = performance.now() - started;
        const preview = output.find((candidate) => candidate.id === input.id);
        const marker = previewMarker(Buffer.byteLength(content));
        const suffix = `\n${marker}\n`;
        const body = preview?.content.endsWith(suffix) ? preview.content.slice(0, -suffix.length) : preview?.content ?? "";
        correctness.previewBodyBounded &&= Boolean(preview) && Buffer.byteLength(body) <= config.previewBytes && content.startsWith(body);
        correctness.previewTokensAccurate &&= Boolean(preview) && preview.tokens === DEFAULT_TOKEN_ESTIMATOR.estimate(preview.content);
        correctness.previewUnicodeValid &&= !body.includes("\uFFFD");
        samples.push({ elapsedMs, splitInputBytes: observed.splitInputBytes, inputBytes: Buffer.byteLength(content), outputBytes: Buffer.byteLength(preview?.content ?? ""), reportedTokens: preview?.tokens ?? 0, estimatedOutputTokens: DEFAULT_TOKEN_ESTIMATOR.estimate(preview?.content ?? "") });
      }
      scenarios[name] = { samples, medians: Object.fromEntries(Object.keys(samples[0]).map((key) => [key, median(samples.map((sample) => sample[key]))])) };
    }
  } finally { String.prototype.split = nativeSplit; }
  const compactor = new MultiStageCompactor({ previewMaxBytes: config.previewBytes });
  const anchor = block({ id: "anchor", source: "user", content: "constraint ".repeat(1000), ephemeral: true, compressible: false });
  correctness.protectedAnchorPreserved = (await compactor.compact([anchor], summary))[0] === anchor;
  const prefix = "same\n".repeat(1000);
  const distinct = await compactor.compact([block({ id: "one", content: `${prefix}tail-A` }), block({ id: "two", content: `${prefix}tail-B` })], summary);
  correctness.distinctOriginalsPreserved = distinct.length === 2;
  const ordered = await compactor.compact([block({ id: "old", content: "A" }), block({ id: "b", content: "B" }), block({ id: "new", content: "A" })], summary);
  correctness.latestOccurrenceOrder = ordered.map((candidate) => candidate.id).join(",") === "b,new";
  const unicodeDigest = new DefaultCompactor().compact([block({ source: "tool" })], { ...summary, goal: "优化智能体🙂".repeat(100) })[0];
  correctness.unicodeDigestTokensAccurate = unicodeDigest.tokens === DEFAULT_TOKEN_ESTIMATOR.estimate(unicodeDigest.content);
  const rehydrated = buildRehydrationBlocks({ ...summary, filesChanged: [`src/${"界".repeat(20)}.ts`] }, { maxTokens: 20 });
  correctness.rehydrationBudgetAccurate = rehydrated.reduce((total, candidate) => total + DEFAULT_TOKEN_ESTIMATOR.estimate(candidate.content), 0) <= 20;
  const breaker = new CompactionCircuitBreaker({ maxConsecutiveIneffective: 3 });
  const pipeline = new ContextPipeline({ discovery: { discover: async () => [] }, compactionBreaker: breaker });
  const build = (priorBlocks, maxTokens) => pipeline.build({ cwd: repoRoot, systemPrompt: "sys", priorBlocks, budget: { maxTokens, reserved: { system: 0, task: 0, output: 0 }, dynamic: maxTokens }, summaryOverride: summary });
  await build([1, 2, 3].map((id) => block({ id: `tool-${id}`, source: "tool", content: String(id).repeat(160), tokens: 40 })), 100);
  for (let round = 0; round < 3; round++) await build([block({ content: "x".repeat(100), tokens: 25 })], 10);
  correctness.breakerRecognizesLaterIneffectiveness = breaker.state === "open";
  const sources = ["compaction.ts", "pipeline.ts", "rehydration.ts", "tokenizer.ts"];
  const sourceDigest = createHash("sha256");
  for (const name of sources) sourceDigest.update(name).update(await fs.readFile(join(repoRoot, "packages/context/src", name)));
  const git = (input) => execFileSync("git", input, { cwd: repoRoot, encoding: "utf8" }).trim();
  const report = { schemaVersion: 1, label: option("--label", "unspecified"), sourceCommit: git(["rev-parse", "HEAD"]), sourceChangesFromCommit: git(["diff", "--name-only", "HEAD", "--", ...sources.map((name) => `packages/context/src/${name}`)]).split("\n").filter(Boolean), sourceDigest: sourceDigest.digest("hex"), scriptDigest: createHash("sha256").update(await fs.readFile(new URL(import.meta.url))).digest("hex"), environment: { node: process.version, platform: process.platform, arch: process.arch }, config, scenarios, correctness, timingNote: "Elapsed time includes split instrumentation; hard gates use payload/processed-byte counts, not timings. Tokens are heuristic budget estimates, not provider measurements." };
  await save(report);
  console.log(JSON.stringify({ label: report.label, scenarios: Object.fromEntries(Object.entries(scenarios).map(([name, result]) => [name, result.medians])), correctness }, null, 2));
}
