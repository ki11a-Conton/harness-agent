import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { performance } from "node:perf_hooks";
const baseline = "20297ccb4da5b5255850d78e5ad9ca28c83ff903";
const source = execFileSync("git", ["show", baseline + ":packages/tools/src/relevant-code-map.ts"], { encoding: "utf8" });
const rankSource = source.slice(source.indexOf("  const sum = seed.reduce"), source.indexOf("  const ordered = index.files"));
assert(rankSource.includes("next[j]! += .85 * rank[i]! * personalization[j]!"));
const priorRank = new Function("seed", "links", rankSource.replace(/(?<=\])!(?=[.\[\s;)])/g, "")
  + "\nreturn rank.map((value,i) => value + personalization[i]);");
const file = pathToFileURL(resolve("packages/tools/dist/relevant-code-map.js")).href;
const { rankRelevantFiles } = await import(file);
const median = values => values.sort((a, b) => a - b)[Math.floor(values.length / 2)];
for (const n of [500, 5000]) {
  const seeds = Array.from({ length: n }, (_, i) => 1 + i % 13);
  const links = seeds.map((_, i) => i % 20 === 0 ? new Map([[(i + 1) % n, 4]]) : new Map());
  const dangling = links.filter(map => !map.size).length;
  const runtime = (fn) => {
    const start = performance.now();
    const scores = fn(seeds, links);
    return { ms: performance.now() - start, scores };
  };
  const a = runtime(priorRank), b = runtime(rankRelevantFiles);
  const maxAbsoluteError = Math.max(...a.scores.map((score, i) => Math.abs(score - b.scores[i])));
  assert(maxAbsoluteError < 1e-12);
  const old = [], next = [];
  for (let i = 0; i < 5; i++) {
    old.push(runtime(priorRank).ms);
    next.push(runtime(rankRelevantFiles).ms);
  }
  const baselineMs = median(old), candidateMs = median(next);
  console.log(JSON.stringify({ n, dangling, baseline, maxAbsoluteError, baselineMs, candidateMs,
    baselineDanglingFanout: 12 * n * dangling, candidatePriorRedistributions: 12 * n,
    note: "Ranking only on generated graphs. These are not repository scan times." }));
}
