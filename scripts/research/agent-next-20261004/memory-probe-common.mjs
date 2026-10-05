import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";

export const BASELINE_HEAD = "18f162bf7f12c4b8e8cebcebede4034dd1f3efb7";
export const BASELINE_RETRIEVAL_SOURCE_SHA256 = "0921994bc133782ca2d01ae7e9af05d01e4fd2ac233916cb42c5350ad3621f55";
export const BASELINE_RETRIEVAL_COMPILED_SHA256 = "642e15428ffcb008e68d6448d5465555477c17f20888b6bf4d76e483eab709d6";
export const FIXED_NOW = 1791000000000;
export const FIXTURE_SHA256 = "1d6be9ccf0eb0205ad5aefb65be1e203fbd9db481281647ec0d929b9697b2081";
export const ORIGINAL_FIXED_PROBE_SHA256 = "7e4d7584d3b91909123d1f5dfebbdea814df237b871e16054b87f1ba78820c28";
export const hash = value => createHash("sha256").update(value).digest("hex");
export const resultHash = value => hash(JSON.stringify(value));
const scriptRoot = fileURLToPath(new URL(".", import.meta.url));
const sourcePaths = [
  "packages/memory/src/retrieval.ts", "packages/memory/dist/retrieval.js",
  ...["memory-store", "sqlite-memory-store", "search-text", "security-gate", "lifecycle"].flatMap(name => [`packages/memory/src/${name}.ts`, `packages/memory/dist/${name}.js`]),
  "packages/harness/src/memory-runtime-bridge.ts", "packages/harness/dist/memory-runtime-bridge.js",
  "packages/harness/src/create-harness.ts", "packages/harness/dist/create-harness.js",
];

export async function setup(scriptUrl) {
  const [repoArg, outArg] = process.argv.slice(2);
  if (!repoArg || !outArg || process.argv.length !== 4) throw new Error(`usage: ${fileURLToPath(scriptUrl)} <built-repository> <fresh-output-directory>`);
  const repo = resolve(repoArg), out = resolve(outArg);
  await mkdir(dirname(out), { recursive: true });
  // Failed/partial observations are evidence too. Refuse every existing
  // output directory, rather than only directories containing a report.
  await mkdir(out);
  const frozenSource = await readFile(join(scriptRoot, "memory-reference-18f162b.source.txt"));
  const frozenCompiled = await readFile(join(scriptRoot, "memory-reference-18f162b.mjs"));
  if (hash(frozenSource) !== BASELINE_RETRIEVAL_SOURCE_SHA256 || hash(frozenCompiled) !== BASELINE_RETRIEVAL_COMPILED_SHA256) throw new Error("frozen baseline bytes changed");
  // Search and gates are unchanged by R2. Assert them against native Git
  // objects so both algorithms run with the exact original lexical contract.
  const unchangedSource = {};
  for (const name of ["memory-store", "sqlite-memory-store", "search-text", "security-gate", "lifecycle"]) {
    const path = `packages/memory/src/${name}.ts`;
    const actual = hash(await readFile(join(repo, path)));
    const baseline = hash(execFileSync("git", ["show", `${BASELINE_HEAD}:${path}`], { cwd: repo }));
    unchangedSource[path] = { actual, baseline, matches: actual === baseline };
    if (actual !== baseline) throw new Error(`R2 unchanged search/gate source changed: ${path}`);
  }
  let resolvedReference = frozenCompiled.toString("utf8");
  for (const name of ["security-gate", "lifecycle"]) resolvedReference = resolvedReference.replace(`"./${name}.js"`, JSON.stringify(pathToFileURL(join(repo, `packages/memory/dist/${name}.js`)).href));
  const referencePath = join(out, "resolved-reference.mjs");
  await writeFile(referencePath, resolvedReference);
  const reference = await import(pathToFileURL(referencePath));
  const memory = await import(pathToFileURL(join(repo, "packages/memory/dist/index.js")));
  const before = await snapshot(repo);
  const report = {
    schema: "R2_MEMORY_ENGINEERING_PROBE", observedAt: new Date().toISOString(), repo, sourceHead: before.head, sourceStatus: before.status,
    sourceHashes: before.hashes, probeSha256: hash(await readFile(fileURLToPath(scriptUrl))),
    helperSha256: hash(await readFile(fileURLToPath(import.meta.url))),
    baselineHead: BASELINE_HEAD, baselineRetrievalSourceSha256: hash(frozenSource), baselineRetrievalCompiledSha256: hash(frozenCompiled),
    resolvedReferenceSha256: hash(resolvedReference), unchangedSearchAndGateSources: unchangedSource,
    paidCalls: 0, realProviderCalls: 0, realModelQuality: "NOT_RUN", promotion: "NOT_RUN", cases: [],
  };
  return { repo, out, report, reference, memory, before, frozenCompiled: frozenCompiled.toString("utf8"), resolvedReference };
}

export async function snapshot(repo) {
  return {
    head: execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).trim(),
    status: execFileSync("git", ["status", "--porcelain"], { cwd: repo, encoding: "utf8" }).trim(),
    hashes: Object.fromEntries(await Promise.all(sourcePaths.map(async path => [path, hash(await readFile(join(repo, path)))]))),
  };
}

export async function finish(context, gates) {
  const after = await snapshot(context.repo);
  const report = context.report;
  report.sourceHeadAfter = after.head; report.sourceStatusAfter = after.status; report.sourceHashesAfter = after.hashes;
  report.sourceUnchanged = JSON.stringify(context.before) === JSON.stringify(after);
  report.gates = { ...gates, sourceUnchanged: report.sourceUnchanged };
  report.status = Object.values(report.gates).every(value => value === true) ? "PASS" : "FAIL";
  await writeFile(join(context.out, "report.json"), JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify({ status: report.status, sourceHead: report.sourceHead, sourceUnchanged: report.sourceUnchanged, gates: report.gates,
    cases: report.cases.map(item => ({ name: item.name, backend: item.backend, fullResultEquivalent: item.fullResultEquivalent, ratio: item.ratio, baselineMs: item.baseline?.medianMs, candidateMs: item.candidate?.medianMs })), paidCalls: 0 }, null, 2));
  if (report.status !== "PASS") process.exitCode = 1;
}

export function fixedEntries() {
  return Array.from({ length: 10_000 }, (_, i) => ({
    id: `fixture-memory-${String(i).padStart(5, "0")}`, content: i % 5 === 0 ? `Inspect retry failures using diagnostic ${i}` : i % 5 === 1 ? `调试端口配置时先检查环境变量${i}。` : `Distinct historical workflow group${i % 5} observation ${i}`,
    type: "procedural", sourceSession: "session-fixture-owner", scope: "workspace",
    importance: .9, confidence: .9, novelty: .9, stability: .9, createdAt: FIXED_NOW, updatedAt: FIXED_NOW, deleted: false,
    ...(i % 5 === 2 ? { structured: { when: `遇到工具失败${i}时`, do: `执行 portlint 修复步骤 ${i}`, avoid: `重复错误 ${i}`, rootCause: "tool", outcome: "failure", evidenceRefs: ["observed-event"] } } : {}),
  }));
}
export const fixtureBytes = entries => Buffer.from(entries.map(entry => JSON.stringify(entry)).join("\n") + "\n");
export function timingStats(samples) { const ordered = [...samples].sort((a, b) => a - b); return { samplesMs: samples, minMs: ordered[0], medianMs: ordered[Math.floor(ordered.length / 2)], maxMs: ordered.at(-1) }; }

/** Seed disposable actual stores directly. This keeps fixture setup out of
 * measured retrieval and allows read-gate hostile-row controls without
 * pretending the production write gate would have accepted those rows. */
export async function seedStore(store, backend, dataDir, entries) {
  await mkdir(dataDir, { recursive: true });
  if (backend === "jsonl") {
    await writeFile(join(dataDir, "memories.jsonl"), fixtureBytes(entries));
    return;
  }
  if (backend !== "sqlite") throw new Error(`unsupported backend: ${backend}`);
  const db = store.database;
  const insert = db.prepare("INSERT INTO memories (id, content, type, source_session, scope, importance, confidence, novelty, stability, created_at, updated_at, deleted, evidence, usefulness, state, metadata) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)");
  const index = db.prepare("INSERT INTO memories_fts (content, id) VALUES (?, ?)");
  db.exec("BEGIN IMMEDIATE");
  try {
    for (const entry of entries) {
      const metadata = {};
      for (const key of ["sourceTurn", "structured", "derivability", "promotionState", "securityScan", "pollutionSources"]) {
        if (entry[key] !== undefined) metadata[key] = entry[key];
      }
      const optional = value => value === undefined ? null : JSON.stringify(value);
      insert.run(entry.id, entry.content, entry.type, entry.sourceSession, entry.scope,
        entry.importance, entry.confidence, entry.novelty, entry.stability,
        entry.createdAt, entry.updatedAt, entry.deleted ? 1 : 0,
        optional(entry.evidence) ?? "{}", optional(entry.usefulness) ?? "{}", optional(entry.state), JSON.stringify(metadata));
      index.run(entry.content, entry.id);
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}
