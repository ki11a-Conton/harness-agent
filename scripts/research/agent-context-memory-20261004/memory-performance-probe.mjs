#!/usr/bin/env node
// Engineering cost observation on fixed safe fixtures, never a model-quality
// benchmark. Seed actual 10,000-row stores directly to avoid measuring 10,000
// JSONL whole-file rewrites instead of the search under study.
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { performance } from "node:perf_hooks";

const [repoArg, outArg] = process.argv.slice(2);
if (!repoArg || !outArg) throw new Error("usage: memory-performance-probe.mjs <built-repository> <output-directory> [--expect-baseline-defects]");
const expectBaselineDefects = process.argv.includes("--expect-baseline-defects");
const repo = resolve(repoArg), out = resolve(outArg);
await mkdir(out, { recursive: true });
try { await readFile(join(out, "report.json")); throw new Error("refusing to overwrite existing report.json; use a fresh output directory"); }
catch (err) { if (err.code !== "ENOENT") throw err; }
const fixtures = await mkdtemp(join(out, "fixtures-"));
const { JsonlMemoryStore, SqliteMemoryStore, retrieveMemories } = await import(pathToFileURL(join(repo, "packages/memory/dist/index.js")));
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const sourcePaths = ["packages/memory/src/search-text.ts", "packages/memory/src/memory-store.ts", "packages/memory/src/sqlite-memory-store.ts", "packages/memory/src/retrieval.ts", "packages/memory/dist/search-text.js", "packages/memory/dist/memory-store.js", "packages/memory/dist/sqlite-memory-store.js", "packages/memory/dist/retrieval.js"];
const report = {
  observedAt: new Date().toISOString(), repo, sourceHead: execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).trim(),
  sourceStatus: execFileSync("git", ["status", "--porcelain"], { cwd: repo, encoding: "utf8" }).trim(),
  sourceHashes: Object.fromEntries(await Promise.all(sourcePaths.map(async (path) => [path, await readFile(join(repo, path)).then(hash, (err) => { if (err.code === "ENOENT") return null; throw err; })]))),
  probeSha256: hash(await readFile(fileURLToPath(import.meta.url))), rowCount: 10_000,
  warmups: 2, measuredSamples: 5, expectBaselineDefects, paidCalls: 0, realProviderCalls: 0, realModelQuality: "NOT_RUN",
  interpretation: "SQLite supplement scans live rows passing type/scope filters: O(n) scan cost. No retrieval throughput improvement claim. Runtime still applies existing TopK/safety/lifecycle/session gates; search contract has no new limit.",
  cases: [],
};
const fixedNow = 1791000000000;
const entries = Array.from({ length: report.rowCount }, (_, i) => ({
  id: `fixture-memory-${String(i).padStart(5, "0")}`, content: i % 5 === 0 ? `Inspect retry failures using diagnostic ${i}` : i % 5 === 1 ? `调试端口配置时先检查环境变量${i}。` : `Distinct historical workflow group${i % 5} observation ${i}`,
  type: "procedural", sourceSession: "session-fixture-owner", scope: "workspace",
  importance: .9, confidence: .9, novelty: .9, stability: .9, createdAt: fixedNow, updatedAt: fixedNow, deleted: false,
  ...(i % 5 === 2 ? { structured: { when: `遇到工具失败${i}时`, do: `执行 portlint 修复步骤 ${i}`, avoid: `重复错误 ${i}`, rootCause: "tool", outcome: "failure", evidenceRefs: ["observed-event"] } } : {}),
}));
const fixtureBytes = Buffer.from(entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n");
report.fixtureSha256 = hash(fixtureBytes);
function stats(samples) {
  const ordered = [...samples].sort((a, b) => a - b);
  return { samplesMs: samples, minMs: ordered[0], medianMs: ordered[Math.floor(ordered.length / 2)], maxMs: ordered.at(-1) };
}
for (const backend of ["jsonl", "sqlite"]) {
  const dataDir = join(fixtures, backend); await mkdir(dataDir, { recursive: true });
  const store = backend === "jsonl" ? new JsonlMemoryStore({ dataDir }) : new SqliteMemoryStore({ dataDir });
  try {
    if (backend === "jsonl") await writeFile(join(dataDir, "memories.jsonl"), fixtureBytes);
    else {
      const insert = store.database.prepare("INSERT INTO memories (id, content, type, source_session, scope, importance, confidence, novelty, stability, created_at, updated_at, deleted, metadata) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)");
      const index = store.database.prepare("INSERT INTO memories_fts (content, id) VALUES (?, ?)");
      store.database.exec("BEGIN IMMEDIATE");
      try {
        for (const entry of entries) {
          insert.run(entry.id, entry.content, entry.type, entry.sourceSession, entry.scope, entry.importance, entry.confidence, entry.novelty, entry.stability, entry.createdAt, entry.updatedAt, 0, JSON.stringify(entry.structured ? { structured: entry.structured } : {}));
          index.run(entry.content, entry.id);
        }
        store.database.exec("COMMIT");
      } catch (err) { store.database.exec("ROLLBACK"); throw err; }
    }
    const actualRowCount = backend === "sqlite" ? store.database.prepare("SELECT COUNT(*) AS n FROM memories").get().n : (await store.list()).length;
    if (actualRowCount !== report.rowCount) throw new Error(`wrong fixture row count ${actualRowCount}`);
    for (const [name, query, expectedMatchCount] of [["warm-fts", "retry", 2000], ["chinese-substring", "端口配置", 2000], ["structured-do", "portlint", 2000], ["actual-miss", "unmatchedmarkerquantum", 0]]) {
      for (let i = 0; i < report.warmups; i++) await store.search(query);
      const samples = [], candidateCounts = [];
      for (let i = 0; i < report.measuredSamples; i++) {
        const start = performance.now(); const hits = await store.search(query); samples.push(performance.now() - start); candidateCounts.push(hits.length);
      }
      const start = performance.now(); const result = await retrieveMemories(store, query, "workspace", { k: 5, now: fixedNow, sessionId: "session-fixture-owner" });
      report.cases.push({ backend, name, query, actualRowCount, filteredLiveRowCount: report.rowCount, expectedMatchCount, candidateCounts, correctnessPass: candidateCounts.every((count) => count === expectedMatchCount), search: stats(samples), retrievalMs: performance.now() - start, returnedTopK: result.items.length, suppressedCount: result.suppressed.length, uniqueReturnedIds: new Set(result.items.map((item) => item.memory.id)).size });
    }
  } finally { store.close?.(); }
}
report.sourceHeadAfter = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).trim();
report.sourceStatusAfter = execFileSync("git", ["status", "--porcelain"], { cwd: repo, encoding: "utf8" }).trim();
report.sourceHashesAfter = Object.fromEntries(await Promise.all(sourcePaths.map(async (path) => [path, await readFile(join(repo, path)).then(hash, (err) => { if (err.code === "ENOENT") return null; throw err; })])));
report.sourceUnchanged = report.sourceHead === report.sourceHeadAfter && report.sourceStatus === report.sourceStatusAfter && JSON.stringify(report.sourceHashes) === JSON.stringify(report.sourceHashesAfter);
report.correctnessFailures = report.cases.filter((item) => !item.correctnessPass).map((item) => `${item.backend}:${item.name}`);
const expectedFailures = expectBaselineDefects ? ["jsonl:structured-do", "sqlite:chinese-substring", "sqlite:structured-do"] : [];
report.status = report.sourceUnchanged && JSON.stringify(report.correctnessFailures) === JSON.stringify(expectedFailures) ? "PASS" : "FAIL";
await writeFile(join(out, "report.json"), JSON.stringify(report, null, 2) + "\n");
console.log(JSON.stringify({ status: report.status, expectBaselineDefects, sourceHead: report.sourceHead, fixtureSha256: report.fixtureSha256, rowCount: report.rowCount, sourceUnchanged: report.sourceUnchanged, cases: report.cases.map(({ search, ...item }) => ({ ...item, searchMedianMs: search.medianMs })), paidCalls: 0 }, null, 2));
if (report.status !== "PASS") process.exitCode = 1;
