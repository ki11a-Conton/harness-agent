#!/usr/bin/env node
// Supplemental diagnostic only. Keeps the formal five-sample result intact.
import { readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";
import { DatabaseSync } from "node:sqlite";
import { loadavg } from "node:os";
import {
  setup, finish, FIXED_NOW, FIXTURE_SHA256, fixedEntries, fixtureBytes,
  hash, timingStats,
} from "../../../scripts/research/agent-next-20261004/memory-probe-common.mjs";

const recipePath = fileURLToPath(new URL("./recipe.json", import.meta.url));
const recipeBytes = await readFile(recipePath);
const recipe = JSON.parse(recipeBytes);
const context = await setup(import.meta.url);
const { repo, out, report, memory, reference } = context;
report.schema = "R2_SQLITE_WARM_SUPPLEMENTAL_PROBE";
report.recipe = recipe;
report.recipeSha256 = hash(recipeBytes);
report.recipeProbeHashPass = recipe.probeSha256 === report.probeSha256;
report.expectedHeadPass = report.sourceHead === recipe.expectedSourceHead && report.sourceStatus === "";
report.fixtureSha256 = hash(fixtureBytes(fixedEntries()));
report.fixedFixturePass = report.fixtureSha256 === FIXTURE_SHA256 && report.fixtureSha256 === recipe.fixtureSha256;
report.environment = { node: process.version, platform: process.platform, pid: process.pid, loadAverageBefore: loadavg() };
const formalPath = resolve(repo, recipe.formalReportRelative);
const formalBytes = await readFile(formalPath);
const formal = JSON.parse(formalBytes);
const formalCase = formal.cases.find(row => row.backend === "sqlite" && row.name === "warm-fts");
report.formalReport = { path: formalPath, sha256: hash(formalBytes), unchangedHashPass: hash(formalBytes) === recipe.formalReportSha256,
  sourceHead: formal.sourceHead, warmCase: formalCase };
report.formalProvenancePass = formal.sourceHead === recipe.expectedSourceHead && formal.sourceStatus === ""
  && formal.fixtureSha256 === recipe.fixtureSha256 && formalCase?.fullResultEquivalent === true;
if (!report.recipeProbeHashPass || !report.expectedHeadPass || !report.fixedFixturePass
  || !report.formalReport.unchangedHashPass || !report.formalProvenancePass) {
  await finish(context, { preregisteredRecipe: false, cleanFrozenSource: false, fixedFixture: false, formalOriginalUnchanged: false });
  throw new Error("supplemental preregistration or frozen provenance check failed");
}
const dbPath = resolve(repo, recipe.sqliteDatabaseRelative);
const databaseHashBefore = hash(await readFile(dbPath));
const db = new DatabaseSync(dbPath, { readOnly: true });
const store = new memory.SqliteMemoryStore({ db });
db.exec("PRAGMA query_only=ON");
report.sqlite = { path: dbPath, readOnlyConnectionRequested: true, queryOnly: db.prepare("PRAGMA query_only").get().query_only,
  databaseSha256Before: databaseHashBefore, actualRowCount: db.prepare("SELECT COUNT(*) AS n FROM memories").get().n };
const query = recipe.query;
const opts = { now: FIXED_NOW, k: 5, sessionId: "session-fixture-owner" };
const pairs = { fullRetrieval: [], sameFunctionSearchControl: [], postSearchOnlyDiagnostic: [] };
const calls = [];
let resultIntegrity = true;
try {
  const fixedHits = await store.search(query);
  const hitsJson = JSON.stringify(fixedHits);
  const baselineExpected = await reference.retrieveMemories(store, query, "workspace", opts);
  const expectedJson = JSON.stringify(baselineExpected);
  report.expectedResult = { fullResultSha256: hash(expectedJson), rawHitSha256: hash(hitsJson),
    rawHitCount: fixedHits.length, returnedTopK: baselineExpected.items.length, suppressedCount: baselineExpected.suppressed.length,
    formalResultHashPass: hash(expectedJson) === formalCase.baselineResultSha256 };
  await writeFile(join(out, "expected-full-result.json"), JSON.stringify(baselineExpected, null, 2) + "\n");
  const retrievalFunctions = { A: reference.retrieveMemories, B: memory.retrieveMemories };
  // A and B deliberately share the same bound search function in this control.
  const identicalSearch = store.search.bind(store);
  const postSearchStore = { search: async () => fixedHits };
  async function observe(kind, label, phase, sample) {
    const start = performance.now();
    const value = kind === "sameFunctionSearchControl" ? await identicalSearch(query)
      : await retrievalFunctions[label](kind === "fullRetrieval" ? store : postSearchStore, query, "workspace", opts);
    const elapsedMs = performance.now() - start;
    const serialized = JSON.stringify(value);
    const expected = kind === "sameFunctionSearchControl" ? hitsJson : expectedJson;
    const fullResultEquivalent = serialized === expected;
    resultIntegrity &&= fullResultEquivalent;
    const row = { kind, label, phase, sample, elapsedMs, fullResultEquivalent, resultSha256: hash(serialized) };
    calls.push(row);
    return row;
  }
  async function paired(kind, phase, sample) {
    const order = sample % 2 === 0 ? ["A", "B"] : ["B", "A"];
    const results = {};
    for (const label of order) results[label] = await observe(kind, label, phase, sample);
    const row = { phase, sample, order, aMs: results.A.elapsedMs, bMs: results.B.elapsedMs,
      differenceMs: results.B.elapsedMs - results.A.elapsedMs, ratio: results.B.elapsedMs / results.A.elapsedMs,
      fullResultEquivalent: results.A.fullResultEquivalent && results.B.fullResultEquivalent };
    pairs[kind].push(row);
  }
  // Interleave actual retrieval and identical-search controls in every phase;
  // reverse both block order and within-block order on alternating samples.
  for (const [phase, count] of [["warmup", recipe.warmupsPerImplementation], ["measured", recipe.measuredPairs]]) {
    for (let sample = 0; sample < count; sample++) {
      const blocks = sample % 2 === 0 ? ["fullRetrieval", "sameFunctionSearchControl"] : ["sameFunctionSearchControl", "fullRetrieval"];
      for (const kind of blocks) await paired(kind, phase, sample);
    }
  }
  // Explicitly separate this component diagnostic from actual-store timings.
  // Frozen hit rows eliminate SQLite search without changing gates/ranking.
  for (const [phase, count] of [["warmup", recipe.warmupsPerImplementation], ["measured", recipe.measuredPairs]]) {
    for (let sample = 0; sample < count; sample++) await paired("postSearchOnlyDiagnostic", phase, sample);
  }
  function summarize(kind) {
    const measured = pairs[kind].filter(row => row.phase === "measured");
    const baseline = timingStats(measured.map(row => row.aMs));
    const candidate = timingStats(measured.map(row => row.bMs));
    const difference = timingStats(measured.map(row => row.differenceMs));
    const ratios = timingStats(measured.map(row => row.ratio));
    const byOrder = Object.fromEntries(["AB", "BA"].map(order => {
      const selected = measured.filter(row => row.order.join("") === order);
      return [order, { count: selected.length, pairedDifferenceMs: timingStats(selected.map(row => row.differenceMs)),
        pairedRatios: timingStats(selected.map(row => row.ratio)) }];
    }));
    return { name: kind, backend: "sqlite", baseline, candidate, ratio: candidate.medianMs / baseline.medianMs,
      pairedDifferenceMs: difference, pairedRatios: ratios, bSlowerCount: measured.filter(row => row.differenceMs > 0).length,
      measuredPairs: measured.length, byOrder, pairs: pairs[kind], fullResultEquivalent: pairs[kind].every(row => row.fullResultEquivalent) };
  }
  report.cases = Object.keys(pairs).map(summarize);
  const full = report.cases.find(row => row.name === "fullRetrieval");
  const control = report.cases.find(row => row.name === "sameFunctionSearchControl");
  const diagnostic = report.cases.find(row => row.name === "postSearchOnlyDiagnostic");
  report.analysis = {
    originalObservationRetained: { ratio: formalCase.ratio, baselineMedianMs: formalCase.baseline.medianMs, candidateMedianMs: formalCase.candidate.medianMs,
      bSlowerCount: formalCase.calls.filter(row => row.phase === "measured" && row.implementation === "candidate")
        .filter(candidate => candidate.elapsedMs > formalCase.calls.find(row => row.phase === "measured" && row.sample === candidate.sample && row.implementation === "baseline").elapsedMs).length,
      sampleCount: formalCase.measuredCallsPerImplementation },
    warmRegressionReproducedByPreregisteredRule: full.ratio > recipe.followupReviewRules.reproducedRatioAbove
      && full.pairedDifferenceMs.medianMs > recipe.followupReviewRules.reproducedPairedMedianAboveMs
      && full.bSlowerCount >= recipe.followupReviewRules.reproducedSlowerAtLeast,
    fullRetrievalMedianRatio: full.ratio, fullRetrievalPairedMedianDifferenceMs: full.pairedDifferenceMs.medianMs,
    identicalSearchMedianRatio: control.ratio, identicalSearchPairedMedianDifferenceMs: control.pairedDifferenceMs.medianMs,
    postSearchMedianRatio: diagnostic.ratio, postSearchPairedMedianDifferenceMs: diagnostic.pairedDifferenceMs.medianMs,
    attributionStatus: "REQUIRES_INDEPENDENT_REVIEW_OF_FULL_SEARCH_CONTROL_AND_POST_SEARCH_SAMPLES",
    note: "A valid follow-up does not erase the original +10.54% observation. Identical-function control diagnoses order/scan variability; post-search-only timing is component evidence, not the formal performance gate.",
  };
  report.calls = calls;
} finally { store.close(); }
report.sqlite.databaseSha256After = hash(await readFile(dbPath));
report.sqlite.databaseBytesUnchanged = report.sqlite.databaseSha256Before === report.sqlite.databaseSha256After;
report.formalReport.sha256After = hash(await readFile(formalPath));
report.formalReport.bytesUnchanged = report.formalReport.sha256 === report.formalReport.sha256After;
report.environment.loadAverageAfter = loadavg();
report.formalChineseAtLeast50PercentGate = "UNCHANGED; original formal evidence remains authoritative";
report.limitations = [
  "Additional engineering samples after an observed concern; all original data are retained, and the supplemental recipe was registered before execution.",
  "No paid or real model calls, no model-quality inference, no expansion of the original Chinese >=50% performance acceptance.",
  "Read-only SQLite connection to the existing frozen fixture; no seeding, updates, migration, build, or production-source changes.",
  "Supplemental status gates measurement integrity only. Reproduced material warm regression must remain a completion concern until independently explained or corrected.",
];
await finish(context, {
  preregisteredRecipe: report.recipeProbeHashPass,
  cleanFrozenSource: report.expectedHeadPass,
  fixedFixture: report.fixedFixturePass && report.sqlite.actualRowCount === 10_000 && report.expectedResult.rawHitCount === 2000,
  formalOriginalUnchanged: report.formalReport.bytesUnchanged && report.formalReport.unchangedHashPass,
  readOnlyDatabase: report.sqlite.queryOnly === 1 && report.sqlite.databaseBytesUnchanged,
  fullResultEquivalence: resultIntegrity && report.expectedResult.formalResultHashPass,
  measured15PairsEveryCase: report.cases.length === 3 && report.cases.every(row => row.measuredPairs === 15 && row.fullResultEquivalent),
});
