import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const [repoArgument, outputArgument] = process.argv.slice(2);
assert(repoArgument && outputArgument, "usage: node rehydration-budget-probe.mjs <repo> <fresh-output>");
const repo = resolve(repoArgument), output = resolve(outputArgument);
await fs.mkdir(dirname(output), { recursive: true }); await fs.mkdir(output);
const git = (...args) => execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const sourcePaths = [
  "packages/context/src/pipeline.ts", "packages/context/dist/pipeline.js",
  "packages/context/src/rehydration.ts", "packages/context/dist/rehydration.js",
  "packages/context/src/budget.ts", "packages/context/dist/budget.js",
  "packages/context/src/compaction.ts", "packages/context/dist/compaction.js",
  "packages/core/src/runtime/context-controller.ts", "packages/core/dist/runtime/context-controller.js",
  "packages/harness/src/create-harness.ts", "packages/harness/dist/create-harness.js",
  "packages/harness/src/memory-runtime-bridge.ts", "packages/harness/dist/memory-runtime-bridge.js",
  "scripts/research/agent-next2-20261005/rehydration-budget-probe.mjs",
];
const fingerprints = async () => Object.fromEntries(await Promise.all(sourcePaths.map(async path => [path, hash(await fs.readFile(join(repo, path)))])));
const sourceSha = git("rev-parse", "HEAD"), sourceTrackedDirtyAtStart = Boolean(git("status", "--porcelain", "--untracked-files=no"));
const sourceFingerprintsBefore = await fingerprints();
const fromRepo = path => import(pathToFileURL(join(repo, path)).href);
const { ContextPipeline, CompactionCircuitBreaker } = await fromRepo("packages/context/dist/index.js");
const { DEFAULT_REHYDRATION_OPTIONS } = await fromRepo("packages/context/dist/rehydration.js");
const { createHarness } = await fromRepo("packages/harness/dist/index.js");
const { newMemoryId, newSessionId } = await fromRepo("packages/contracts/dist/index.js");
const cases = [], roots = [];
let actualHarnessRequestCount = 0;
const used = blocks => blocks.reduce((sum, block) => sum + block.tokens, 0);
const hydrated = blocks => blocks.filter(block => block.id.startsWith("rehydrate:"));
function state(over = {}) {
  return { goal: "short task", constraints: [], decisions: [], completed: [], filesChanged: [`src/${"a".repeat(130)}.ts`], commandsRun: [], tests: [], failures: [], openTasks: [], importantFacts: [], artifactRefs: [], childAgentRefs: [], ...over };
}
function tool(id, tokens) { return { id, source: "tool", trust: "untrusted", priority: 100, tokens, content: "ordinary data", compressible: true, ephemeral: false }; }
function buildOptions(maxTokens, over = {}) {
  return { cwd: repo, systemPrompt: "sys", priorBlocks: [tool("fits", 10), tool("dropped", 100_000)], budget: { maxTokens, reserved: over.reserved ?? { system: 0, task: 0, output: 0 }, dynamic: 0 }, summaryOverride: over.summary ?? state() };
}
function pipeline(deps = {}) { return new ContextPipeline({ discovery: { discover: async () => [] }, ...deps }); }
async function check(name, run) {
  const observed = {}; let failure;
  try { await run(observed); } catch (error) { failure = { message: String(error), stack: error?.stack }; }
  const rawFile = `${name}.json`;
  await fs.writeFile(join(output, rawFile), JSON.stringify({ name, observed, ...(failure ? { failure } : {}) }, null, 2) + "\n", { flag: "wx" });
  cases.push({ name, status: failure ? "FAIL" : "PASS", rawFile, rawSha256: hash(await fs.readFile(join(output, rawFile))), ...(failure ? { failure } : {}) });
}
async function context(observed, input, deps = {}) {
  observed.input = structuredClone(input);
  const result = await pipeline(deps).build(input); observed.result = structuredClone(result);
  const reserve = Object.values(input.budget.reserved).reduce((sum, value) => sum + value, 0);
  observed.compactedBeforeHydration = used(result.blocks.filter(block => !block.id.startsWith("rehydrate:")));
  observed.spendable = Math.max(0, input.budget.maxTokens - reserve);
  observed.optionalHydrationTokens = used(hydrated(result.blocks));
  assert.equal(result.report.used, used(result.blocks)); assert.equal(result.report.available, input.budget.maxTokens - result.report.used);
  return result;
}

for (const maxTokens of [51, 52, 60, 61, 62, 89, 90, 100, 101, 150]) await check(`context-boundary-${maxTokens}`, async observed => {
  const result = await context(observed, buildOptions(maxTokens));
  assert(result.summary); assert.equal(result.blocks[0].content, "sys"); assert(result.report.used <= maxTokens);
  if (maxTokens === 51) assert.deepEqual(hydrated(result.blocks), []);
  if (maxTokens === 100) { assert.equal(result.report.used, 90); assert.deepEqual(hydrated(result.blocks).map(block => block.id), ["rehydrate:files"]); }
  if (maxTokens >= 101) assert.deepEqual(hydrated(result.blocks).map(block => block.id), ["rehydrate:files", "rehydrate:pointers"]);
});
for (const [name, reserved] of Object.entries({ system: { system: 20, task: 0, output: 0 }, task: { system: 0, task: 20, output: 0 }, output: { system: 0, task: 0, output: 20 }, combined: { system: 5, task: 7, output: 8 } })) await check(`context-reserved-${name}`, async observed => {
  const result = await context(observed, buildOptions(110, { reserved }));
  assert.equal(result.report.used, 90); assert(result.report.used <= observed.spendable);
  assert.deepEqual(hydrated(result.blocks).map(block => block.id), ["rehydrate:files"]);
});
await check("context-history-not-deducted-twice", async observed => {
  const result = await context(observed, { ...buildOptions(101), messages: [{ role: "assistant", content: "history".repeat(10_000) }] });
  assert(result.report.messagesTokens > 10_000); assert.equal(result.report.used, 101); assert.equal(hydrated(result.blocks).length, 2);
});
await check("context-unicode-byte-estimator-exact-pointer", async observed => {
  const tokenEstimator = { estimate: content => Buffer.byteLength(content, "utf8") };
  const summary = state({ goal: "继续优化🙂", filesChanged: [`src/${"界".repeat(30)}.ts`] });
  const ample = await pipeline({ tokenEstimator }).build(buildOptions(1_000, { summary }));
  observed.ample = ample;
  const digestFootprint = used(ample.blocks.filter(block => !block.id.startsWith("rehydrate:")));
  const result = await context(observed, buildOptions(digestFootprint + 43, { summary }), { tokenEstimator });
  assert(result.report.used <= digestFootprint + 43); assert.deepEqual(hydrated(result.blocks).map(block => block.id), ["rehydrate:pointers"]);
  assert(result.blocks.every(block => block.tokens === tokenEstimator.estimate(block.content)));
});
await check("context-unicode-byte-estimator-reject-pointer-at-42", async observed => {
  const tokenEstimator = { estimate: content => Buffer.byteLength(content, "utf8") };
  const summary = state({ goal: "继续优化🙂", filesChanged: [`src/${"界".repeat(30)}.ts`] });
  const ample = await pipeline({ tokenEstimator }).build(buildOptions(1_000, { summary }));
  observed.ample = ample;
  const digestFootprint = used(ample.blocks.filter(block => !block.id.startsWith("rehydrate:")));
  const result = await context(observed, buildOptions(digestFootprint + 42, { summary }), { tokenEstimator });
  assert.equal(result.summary.content, ample.summary.content); assert.deepEqual(hydrated(result.blocks), []);
  assert.equal(result.report.used, digestFootprint); assert.equal(result.report.available, 42);
});
await check("context-existing-600-cap", async observed => {
  const summary = state({ filesChanged: Array.from({ length: 8 }, (_, i) => `src/${i}-${"x".repeat(240)}.ts`), openTasks: ["verify final command"], artifactRefs: ["artifact/original.txt"], commandsRun: ["pnpm typecheck"], tests: ["pnpm test"] });
  const result = await context(observed, buildOptions(10_000, { summary }));
  assert(used(hydrated(result.blocks)) <= DEFAULT_REHYDRATION_OPTIONS.maxTokens); assert(hydrated(result.blocks).length > 0);
});
await check("context-protected-overflow-not-evicted", async observed => {
  const anchor = { ...tool("user-anchor", 80), source: "user", trust: "trusted", content: "critical user policy", compressible: false };
  const result = await context(observed, { ...buildOptions(100), priorBlocks: [anchor, tool("fits", 10), tool("dropped", 100_000)] });
  assert.equal(result.blocks.find(block => block.id === anchor.id), anchor); assert(result.summary);
  assert.deepEqual(hydrated(result.blocks), []); assert.equal(result.report.used, 131); assert.equal(result.report.available, -31);
});
await check("context-irreducible-digest-no-extra-refs", async observed => {
  const summary = state({ goal: "protected working state ".repeat(50) });
  const result = await context(observed, buildOptions(100, { summary }));
  assert(result.summary.content.includes(summary.goal.trim())); assert(result.report.available < 0); assert.deepEqual(hydrated(result.blocks), []);
});
await check("context-no-compaction-no-refs", async observed => {
  const result = await context(observed, { ...buildOptions(100), priorBlocks: [] });
  assert.equal(result.compacted, false); assert.equal(result.summary, undefined); assert.deepEqual(hydrated(result.blocks), []); assert.equal(result.report.used, 1);
});
await check("context-breaker-and-telemetry-final-footprint", async observed => {
  const breaker = new CompactionCircuitBreaker(), telemetry = [];
  const result = await context(observed, buildOptions(100), { compactionBreaker: breaker, onTelemetry: event => telemetry.push(event) });
  observed.metrics = structuredClone(breaker.metrics); observed.telemetry = telemetry;
  assert.equal(result.report.used, 90); assert.equal(breaker.metrics.last.afterTokens, 90); assert.equal(telemetry.find(event => event.phase === "compacted").tokens, 90);
});
await check("context-frozen-inputs-not-mutated", async observed => {
  const input = buildOptions(100);
  input.priorBlocks.forEach(Object.freeze); Object.freeze(input.priorBlocks); Object.freeze(input.summaryOverride.filesChanged); Object.freeze(input.summaryOverride); Object.freeze(input.budget.reserved); Object.freeze(input.budget);
  const before = JSON.stringify(input), result = await context(observed, input);
  assert.equal(JSON.stringify(input), before); assert(result.report.used <= 100);
});
await check("context-summary-missing-still-failclosed", async observed => {
  const input = buildOptions(100); delete input.summaryOverride; observed.input = input;
  await assert.rejects(() => pipeline().build(input), /summaryOverride is required/);
});
await check("context-open-breaker-no-rehydration", async observed => {
  const breaker = new CompactionCircuitBreaker({ maxConsecutiveIneffective: 1 }); breaker.recordFailure();
  const result = await context(observed, buildOptions(100), { compactionBreaker: breaker });
  assert.equal(result.compactionBreakerOpen, true); assert.equal(result.compacted, false); assert.deepEqual(hydrated(result.blocks), []);
});

async function actualHarness(name, maxTokens, options = {}) {
  await check(name, async observed => {
    const root = await fs.mkdtemp(join(tmpdir(), "ar-rehydration-budget-probe-")); roots.push(root);
    const requests = [], builds = [], goal = options.goal ?? "continue";
    const provider = { id: "rehydration-budget-probe", listModels: async () => [{ id: "scripted", capabilities: { contextWindowTokens: 128_000 } }], createClient: () => ({ async *generate(request) {
      requests.push(structuredClone(request)); yield { type: "started", timestamp: 0 }; yield { type: "completed", result: { finishReason: "stop", text: "done" }, timestamp: 0 };
    } }) };
    const memory = options.memory ?? true;
    const config = { cwd: root, dataDir: join(root, "data"), profile: "test", modelProvider: provider, model: { providerId: provider.id, modelId: "scripted" }, ...(memory ? { memory: { enabled: true, scope: "workspace" } } : {}), featureFlags: { skills: false, mcp: false, delegation: false, learning: false }, contextBudget: { maxTokens, reserved: { system: 0, task: 0, output: options.outputReserved ?? 0 }, dynamic: 0 } };
    observed.hostBudget = config.contextBudget; observed.memoryOptIn = memory;
    const h = await createHarness(config);
    try {
      if (memory) {
        const now = Date.now(), entries = [];
        for (const content of [`${goal} useful hint`, `${goal} detailed ${"other ".repeat(1_000)}`]) {
          const entry = { id: newMemoryId(), sourceSession: newSessionId(), content, type: "procedural", importance: 0.9, confidence: 0.9, novelty: 0.5, stability: 0.6, createdAt: now, updatedAt: now, deleted: false, scope: "global" };
          entries.push(entry); await h.memoryStore.write(entry);
        }
        observed.originalMemoryEntries = entries;
      }
      // Observe actual inputs/results only; do not replace any production
      // return value, budget field, admission policy or model payload.
      const build = h.context.pipeline.build.bind(h.context.pipeline);
      h.context.pipeline.build = async input => { const before = structuredClone(input), result = await build(input); builds.push({ input: before, result: structuredClone(result) }); return result; };
      const session = await h.runtime.createSession({ agent: h.agents[0], cwd: root });
      const turn = await h.runtime.startTurn(session.id, goal);
      const outcome = await h.runtime.runTurn(session.id, turn.id, new AbortController().signal);
      const events = await h.events.list(session.id);
      Object.assign(observed, { outcome, requests, builds, events, storedMessages: await h.store.listMessages(session.id) });
      if (options.protectedOverflow) {
        assert.equal(outcome.status, "failed"); assert.equal(requests.length, 0);
        assert.deepEqual(events.find(event => event.type === "run.limit_reached").payload, { limit: "maxTokens", used: 140 });
        return;
      }
      assert.equal(outcome.status, "completed"); assert.equal(requests.length, 1);
      assert(requests[0].messages.some(message => message.role === "user" && message.content === goal));
      assert(!events.some(event => event.type === "run.limit_reached"));
      if (!memory) { assert(!requests[0].system.includes("# Compaction Summary")); assert(!events.some(event => event.type === "memory.retrieved")); return; }
      assert.equal(events.find(event => event.type === "memory.retrieved").payload.count, 2);
      assert(requests[0].system.includes(`# Compaction Summary\n\n## Goal\n${goal}`));
      const built = builds[0], reserved = Object.values(built.input.budget.reserved).reduce((sum, value) => sum + value, 0);
      observed.actualReserved = built.input.budget.reserved;
      observed.postDigestBeforeHydration = used(built.result.blocks.filter(block => !block.id.startsWith("rehydrate:")));
      observed.remainingSpendable = maxTokens - reserved - observed.postDigestBeforeHydration;
      assert.equal(built.input.budget.reserved.task, 10); assert(built.result.report.used <= maxTokens - reserved);
      if (maxTokens === 170) { assert(requests[0].system.includes("## Refs\n- full transcript preserved on disk")); assert.equal(built.result.report.used, 158); }
      else { assert(!requests[0].system.includes("## Refs")); assert.deepEqual(hydrated(built.result.blocks), []); }
      if (maxTokens === 165) { assert.equal(observed.postDigestBeforeHydration, 147); assert.equal(observed.remainingSpendable, 8); assert.equal(built.result.report.used, 147); }
    } finally { actualHarnessRequestCount += requests.length; await h.close(); }
  });
}
await actualHarness("harness-165-original-avoidable-failure", 165);
await actualHarness("harness-170-pointer-still-admitted", 170);
await actualHarness("harness-output-reservation", 175, { outputReserved: 10 });
await actualHarness("harness-unicode-user-reservation", 164, { goal: "继续" });
await actualHarness("harness-default-memory-off", 165, { memory: false });
await actualHarness("harness-protected-overflow-still-fails", 129, { protectedOverflow: true });

await Promise.all(roots.map(root => fs.rm(root, { recursive: true, force: true })));
const sourceShaAtEnd = git("rev-parse", "HEAD"), sourceTrackedDirtyAtEnd = Boolean(git("status", "--porcelain", "--untracked-files=no"));
const sourceFingerprintsAfter = await fingerprints();
let identityFailure;
try { assert.equal(sourceShaAtEnd, sourceSha); assert.deepEqual(sourceFingerprintsAfter, sourceFingerprintsBefore); } catch (error) { identityFailure = { message: String(error), stack: error?.stack }; }
const result = { status: cases.every(item => item.status === "PASS") && !identityFailure ? "PASS" : "FAIL", sourceSha, sourceShaAtEnd, sourceTrackedDirtyAtStart, sourceTrackedDirtyAtEnd, sourceFingerprintsBefore, sourceFingerprintsAfter, cases, ...(identityFailure ? { identityFailure } : {}), paidProviderCalls: 0, actualHarnessTurns: 6, actualHarnessRequests: actualHarnessRequestCount, node: process.version, platform: process.platform, realModelQuality: "NOT_RUN", windowsRuntime: "NOT_RUN", limits: "Production compiled pipeline and actual Harness/JSONL retrieval with scripted provider. Estimates verify the existing context accounting contract, not a real tokenizer hard limit or model quality. Host configured reserved0 differs from effective active-user reserved.task10; complete message history is not charged twice. Protected/digest overflow remains visible. Memory remains opt-in; no promotion or paid calls." };
await fs.writeFile(join(output, "result.json"), JSON.stringify(result, null, 2) + "\n", { flag: "wx" });
process.stdout.write(JSON.stringify({ status: result.status, cases: cases.length, actualHarnessTurns: result.actualHarnessTurns, actualHarnessRequests: result.actualHarnessRequests, sourceSha, sourceTrackedDirtyAtStart, sourceTrackedDirtyAtEnd }) + "\n");
if (result.status !== "PASS") process.exitCode = 1;
