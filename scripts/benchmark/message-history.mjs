#!/usr/bin/env node
// Offline fixtures: counts budget work, never measured provider usage.
import { promises as fs } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { performance } from "node:perf_hooks";

const argv = process.argv.slice(2);
const option = (name, fallback) => argv.includes(name) ? argv[argv.indexOf(name) + 1] : fallback;
const digest = (value) => createHash("sha256").update(value).digest("hex");
const median = (values) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
async function save(value) {
  const output = option("--out");
  if (!output) return;
  await fs.mkdir(dirname(resolve(output)), { recursive: true });
  await fs.writeFile(resolve(output), `${JSON.stringify(value, null, 2)}\n`);
}

if (argv.includes("--compare")) {
  const baseline = JSON.parse(await fs.readFile(resolve(option("--baseline")), "utf8"));
  const candidate = JSON.parse(await fs.readFile(resolve(option("--candidate")), "utf8"));
  if (JSON.stringify(baseline.config) !== JSON.stringify(candidate.config)
    || baseline.scriptDigest !== candidate.scriptDigest
    || JSON.stringify(baseline.environment) !== JSON.stringify(candidate.environment)) {
    throw new Error("Paired fixtures, script and Node/platform environment must match");
  }
  const gates = [4_000, 8_000].flatMap((count) => ["countedBytes", "countCalls", "sliceCopiedMessages"].map((operation) => {
    const before = baseline.scenarios[count].medians[operation];
    const after = candidate.scenarios[count].medians[operation];
    const reduction = 1 - after / before;
    return { scenario: count, operation, before, after, reduction, minimumReduction: 0.99, passed: before > 0 && reduction >= 0.99 };
  }));
  for (const count of [2_000, 4_000]) {
    const before = candidate.scenarios[count].medians.countedBytes;
    const after = candidate.scenarios[count * 2].medians.countedBytes;
    gates.push({ scenario: `${count}->${count * 2}`, operation: "linearScaling", ratio: after / before, maximumRatio: 2.1, passed: before > 0 && after / before <= 2.1 });
  }
  const identicalTextViews = baseline.config.counts.every((count) => baseline.scenarios[count].outputDigest === candidate.scenarios[count].outputDigest);
  const correctnessPassed = Object.values(candidate.correctness).every((value) => value === true);
  const report = { schemaVersion: 1, baseline, candidate, gates, identicalTextViews, correctnessPassed,
    passed: identicalTextViews && correctnessPassed && gates.every((gate) => gate.passed) };
  await save(report);
  console.log(JSON.stringify({ gates, identicalTextViews, correctnessPassed, passed: report.passed }, null, 2));
  if (!report.passed) process.exitCode = 1;
} else {
  const repoRoot = resolve(option("--repo-root", process.cwd()));
  const config = { samples: Number(option("--samples", "7")), counts: [2_000, 4_000, 8_000], contentBytes: 512, headroom: 0 };
  if (!Number.isInteger(config.samples) || config.samples < 1) throw new Error("--samples must be a positive integer");
  const moduleUrl = (path) => pathToFileURL(join(repoRoot, path)).href;
  const { trimMessageHistory } = await import(moduleUrl("packages/core/dist/runtime/turn-helpers.js"));
  const { ContextPipeline, estimateMessageTokens } = await import(moduleUrl("packages/context/dist/pipeline.js"));
  const { DEFAULT_TOKEN_ESTIMATOR } = await import(moduleUrl("packages/context/dist/tokenizer.js"));
  const { assertToolProtocol } = await import(moduleUrl("packages/contracts/dist/message-protocol.js"));
  const message = (id, role, content = "", extra = {}) => ({ id, sessionId: "bench-session", role, content, createdAt: 0, ...extra });
  const correctness = {};
  const scenarios = {};
  const nativeByteLength = Buffer.byteLength;
  const nativeSlice = Array.prototype.slice;
  let active = null;
  // Instrument only this standalone process. Timing includes instrumentation;
  // acceptance uses operation counts, and originals are restored in finally.
  Buffer.byteLength = function (...args) {
    const bytes = Reflect.apply(nativeByteLength, this, args);
    if (active && typeof args[0] === "string") {
      active.countCalls += 1;
      active.countedBytes += bytes;
    }
    return bytes;
  };
  Array.prototype.slice = function (...args) {
    const result = Reflect.apply(nativeSlice, this, args);
    if (active && typeof this[0]?.id === "string" && this[0].id.startsWith("bench-message-")) {
      active.sliceCalls += 1;
      active.sliceCopiedMessages += result.length;
    }
    return result;
  };
  try {
    for (const count of config.counts) {
      const history = Object.freeze(Array.from({ length: count }, (_, i) => Object.freeze(message(`bench-message-${i}`, i % 2 ? "assistant" : "user", "x".repeat(config.contentBytes)))));
      const samples = [];
      let outputDigest;
      for (let sample = 0; sample < config.samples; sample++) {
        const work = { countedBytes: 0, countCalls: 0, sliceCalls: 0, sliceCopiedMessages: 0 };
        active = work;
        const started = performance.now();
        let output;
        try { output = trimMessageHistory(history, config.headroom); } finally { active = null; }
        const elapsedMs = performance.now() - started;
        const currentDigest = digest(JSON.stringify(output.map((item) => item.id)));
        if (outputDigest !== undefined && outputDigest !== currentDigest) throw new Error("Nondeterministic message view");
        outputDigest = currentDigest;
        correctness[`tailPreserved${count}`] = output.length === 4 && output[0] === history[count - 4] && output[3] === history[count - 1];
        samples.push({ elapsedMs, ...work, outputMessages: output.length });
      }
      scenarios[count] = { samples, outputDigest,
        medians: Object.fromEntries(Object.keys(samples[0]).map((key) => [key, median(samples.map((sample) => sample[key]))])) };
    }
  } finally {
    active = null;
    Buffer.byteLength = nativeByteLength;
    Array.prototype.slice = nativeSlice;
  }

  const estimate = (text) => DEFAULT_TOKEN_ESTIMATOR.estimate(text);
  const call = { id: "call-old", name: "edit_file", args: { content: "x".repeat(32_000) } };
  const hidden = message("old-call", "assistant", "", { toolCalls: [call] });
  const reasoning = message("old-reasoning", "assistant", "", { reasoningContent: "中文🙂".repeat(3_000) });
  const expectedCallTokens = 8 + estimate(hidden.content) + 8 + estimate(call.id) + estimate(call.name) + estimate(JSON.stringify(call.args));
  const expectedReasoningTokens = 8 + estimate(reasoning.content) + estimate(reasoning.reasoningContent);
  const payloadAccounting = { toolArgumentReported: estimateMessageTokens([hidden]), toolArgumentExpected: expectedCallTokens,
    reasoningReported: estimateMessageTokens([reasoning]), reasoningExpected: expectedReasoningTokens };
  correctness.toolArgumentsCounted = payloadAccounting.toolArgumentReported === expectedCallTokens;
  correctness.reasoningCounted = payloadAccounting.reasoningReported === expectedReasoningTokens;
  correctness.toolResultIdCounted = estimateMessageTokens([message("result-id", "tool", "", { toolCallId: "x".repeat(4_000) })]) === 1_008;
  const recent = Array.from({ length: 4 }, (_, i) => message(`recent-${i}`, i % 2 ? "assistant" : "user", "recent"));
  const toolHistory = [message("old-user", "user", "old"), hidden, message("old-result", "tool", "ok", { toolCallId: call.id }), ...recent];
  const toolView = trimMessageHistory(toolHistory, 500);
  correctness.hiddenCallTrimmed = toolView.length === 4 && toolView.every((item, i) => item === recent[i]);
  correctness.toolViewLegal = true;
  try { assertToolProtocol(toolView); } catch { correctness.toolViewLegal = false; }
  const corrupt = [hidden, message("interleaved", "system", "illegal"), message("corrupt-result", "tool", "ok", { toolCallId: call.id }), recent[0]];
  const corruptView = trimMessageHistory(corrupt, 0);
  correctness.corruptionRemainsVisible = corruptView.length === 4;
  try { assertToolProtocol(corruptView); correctness.corruptionRemainsVisible = false; } catch { /* expected local refusal */ }
  const prices = new Map();
  const countedHistory = Array.from({ length: 10 }, (_, i) => message(`priced-${i}`, "user", ""));
  const countedView = trimMessageHistory(countedHistory, 60, (item) => { prices.set(item.id, (prices.get(item.id) ?? 0) + 1); return 10; });
  correctness.injectedCounterHonored = countedView.length === 6 && countedView[0] === countedHistory[4];
  correctness.eachMessagePricedOnce = prices.size === 10 && [...prices.values()].every((value) => value === 1);
  const estimator = { estimate: (text) => Buffer.byteLength(text, "utf8") };
  const pipeline = new ContextPipeline({ discovery: { discover: async () => [] }, tokenEstimator: estimator });
  const built = await pipeline.build({ cwd: repoRoot, systemPrompt: "sys", priorBlocks: [], messages: [hidden],
    budget: { maxTokens: 1_000, reserved: { system: 0, task: 0, output: 0 }, dynamic: 0 } });
  correctness.pipelineCountsHiddenFields = built.report.messagesTokens > 32_000;
  correctness.pipelineCounterMatchesReport = typeof pipeline.estimateMessageTokens === "function"
    && pipeline.estimateMessageTokens([hidden]) === built.report.messagesTokens;

  const sourcePaths = ["packages/context/src/pipeline.ts", "packages/context/src/tokenizer.ts", "packages/context/src/index.ts",
    "packages/core/src/runtime/turn-helpers.ts", "packages/core/src/runtime/context-controller.ts", "packages/contracts/src/message-protocol.ts"];
  const sourceHashes = {};
  const compiledHashes = {};
  for (const path of sourcePaths) {
    sourceHashes[path] = digest(await fs.readFile(join(repoRoot, path)));
    const compiledPath = path.replace("/src/", "/dist/").replace(/\.ts$/, ".js");
    compiledHashes[compiledPath] = digest(await fs.readFile(join(repoRoot, compiledPath)));
  }
  const scriptPath = new URL(import.meta.url);
  const sourceDiff = execFileSync("git", ["diff", "HEAD", "--", ...sourcePaths], { cwd: repoRoot, encoding: "utf8" });
  const report = { schemaVersion: 1, label: option("--label", "unlabeled"), config,
    environment: { node: process.version, platform: process.platform, arch: process.arch },
    gitHead: execFileSync("git", ["rev-parse", "HEAD"], { cwd: repoRoot, encoding: "utf8" }).trim(),
    sourceDiffDigest: digest(sourceDiff), sourceHashes, compiledHashes, scriptDigest: digest(await fs.readFile(scriptPath)),
    scenarios, payloadAccounting, correctness };
  await save(report);
  console.log(JSON.stringify({ label: report.label, scenarios: Object.fromEntries(Object.entries(scenarios).map(([key, value]) => [key, value.medians])), payloadAccounting, correctness }, null, 2));
}
