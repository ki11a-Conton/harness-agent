#!/usr/bin/env node
// Serial engineering observation, not a model-quality benchmark. Both
// retrieval functions search the same actual store on every invocation.
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import {
  setup, finish, FIXED_NOW, FIXTURE_SHA256, ORIGINAL_FIXED_PROBE_SHA256,
  fixedEntries, fixtureBytes, hash, resultHash, timingStats, seedStore,
} from "./memory-probe-common.mjs";

const context = await setup(import.meta.url);
const { repo, out, report, memory, reference } = context;
const entries = fixedEntries();
const bytes = fixtureBytes(entries);
const originalProbePath = "scripts/research/agent-context-memory-20261004/memory-performance-probe.mjs";
report.fixtureSha256 = hash(bytes);
report.originalFixedProbeSha256 = hash(await readFile(join(repo, originalProbePath)));
report.rowCount = entries.length;
report.fixedNow = FIXED_NOW;
report.warmupsPerImplementation = 2;
report.measuredSamplesPerImplementation = 5;
report.execution = "One process, one awaited call at a time; paired AB/BA alternation in both warmup and measurement phases.";
report.implementations = { A: "Exact frozen 18f162b retrieveMemories; unchanged current production stores and gates", B: "Actual built production retrieveMemories, without instrumentation" };
report.measurementIncludes = ["Production store.search", "Unchanged scope/session/lifecycle/safety gates", "Scoring", "Complete conflict filtering", "Final TopK"];
report.measurementExcludes = ["Fixture construction and seeding", "Result serialization/hash checks", "Source fingerprinting"];
if (report.fixtureSha256 !== FIXTURE_SHA256 || report.originalFixedProbeSha256 !== ORIGINAL_FIXED_PROBE_SHA256) {
  await finish(context, { fixedFixture: false, originalFixedProbe: false });
  throw new Error("fixed 10,000-row fixture or preserved original probe bytes changed");
}

const fixtures = join(out, "fixtures");
await mkdir(fixtures);
for (const backend of ["jsonl", "sqlite"]) {
  const dataDir = join(fixtures, backend);
  const store = backend === "jsonl" ? new memory.JsonlMemoryStore({ dataDir }) : new memory.SqliteMemoryStore({ dataDir });
  try {
    await seedStore(store, backend, dataDir, entries);
    const actualRowCount = backend === "sqlite"
      ? store.database.prepare("SELECT COUNT(*) AS n FROM memories").get().n
      : (await store.list()).length;
    for (const [name, query, expectedMatchCount] of [
      ["warm-fts", "retry", 2000], ["chinese-substring", "端口配置", 2000],
      ["structured-do", "portlint", 2000], ["actual-miss", "unmatchedmarkerquantum", 0],
    ]) {
      const opts = { now: FIXED_NOW, k: 5, sessionId: "session-fixture-owner" };
      const rawHits = await store.search(query);
      const baselineResult = await reference.retrieveMemories(store, query, "workspace", opts);
      const baselineJson = JSON.stringify(baselineResult);
      const baselineResultSha256 = hash(baselineJson);
      const samples = { baseline: [], candidate: [] }, orders = [], calls = [];
      const functions = { baseline: reference.retrieveMemories, candidate: memory.retrieveMemories };
      let fullResultEquivalent = true, candidateResult;
      for (const phase of ["warmup", "measured"]) {
        const count = phase === "warmup" ? report.warmupsPerImplementation : report.measuredSamplesPerImplementation;
        for (let sample = 0; sample < count; sample++) {
          const order = sample % 2 === 0 ? ["baseline", "candidate"] : ["candidate", "baseline"];
          orders.push({ phase, sample, order });
          for (const implementation of order) {
            const started = performance.now();
            const result = await functions[implementation](store, query, "workspace", opts);
            const elapsedMs = performance.now() - started;
            const actualJson = JSON.stringify(result);
            const equivalent = actualJson === baselineJson;
            fullResultEquivalent &&= equivalent;
            calls.push({ phase, sample, implementation, elapsedMs, resultSha256: hash(actualJson), fullResultEquivalent: equivalent });
            if (phase === "measured") samples[implementation].push(elapsedMs);
            if (implementation === "candidate") candidateResult = result;
          }
        }
      }
      const baseline = timingStats(samples.baseline), candidate = timingStats(samples.candidate);
      const resultFile = `result-${backend}-${name}.json`;
      await writeFile(join(out, resultFile), JSON.stringify({ query, queryScope: "workspace", opts, baseline: baselineResult, candidate: candidateResult }, null, 2) + "\n");
      report.cases.push({ backend, name, query, queryScope: "workspace", opts, expectedMatchCount,
        actualMatchCount: rawHits.length, actualRowCount, rowAndMatchCountPass: actualRowCount === report.rowCount && rawHits.length === expectedMatchCount,
        fullResultEquivalent, baselineResultSha256, candidateResultSha256: resultHash(candidateResult),
        returnedTopK: baselineResult.items.length, suppressedCount: baselineResult.suppressed.length,
        baseline, candidate, ratio: candidate.medianMs / baseline.medianMs,
        elapsedReduction: 1 - candidate.medianMs / baseline.medianMs,
        executionOrders: orders, measuredCallsPerImplementation: report.measuredSamplesPerImplementation,
        totalPairedCalls: calls.length, calls, resultFile, resultFileSha256: hash(await readFile(join(out, resultFile))) });
    }
  } finally { store.close?.(); }
}
report.chinesePerformance = report.cases.filter(item => item.name === "chinese-substring").map(item => ({
  backend: item.backend, baselineMedianMs: item.baseline.medianMs, candidateMedianMs: item.candidate.medianMs,
  ratio: item.ratio, reduction: item.elapsedReduction, passesAtLeast50Percent: item.ratio <= .5,
}));
report.limitations = [
  "Wall-clock measurements are environment-specific; the differential probe independently gates deterministic work and full semantic equality.",
  "Cache-only change retains worst-case O(n²) pair comparisons and adds per-call retained token Sets.",
  "SQLite literal supplement still scans filtered live rows; no SQL/search complexity improvement is claimed.",
  "No model task-success or quality improvement measured; no promotion is authorized by this probe.",
];
await finish(context, {
  fixedFixture: report.fixtureSha256 === FIXTURE_SHA256 && report.rowCount === 10_000,
  originalFixedProbe: report.originalFixedProbeSha256 === ORIGINAL_FIXED_PROBE_SHA256,
  exactProductionResults: report.cases.length === 8 && report.cases.every(item => item.fullResultEquivalent),
  rowAndMatchCounts: report.cases.every(item => item.rowAndMatchCountPass),
  serialABBA: report.cases.every(item => item.totalPairedCalls === 14 && item.calls.filter(call => call.phase === "measured").length === 10),
  chineseBothBackendsAtLeast50PercentFaster: report.chinesePerformance.length === 2 && report.chinesePerformance.every(item => item.passesAtLeast50Percent),
});
