import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir, cpus, totalmem, platform, release } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { symbolSearchTool } from '../../../packages/tools/dist/tools/navigation-tools.js';
import { buildRelevantCodeMap } from '../../../packages/tools/dist/relevant-code-map.js';
const source = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const goldBytes = await readFile(join(source, 'packages/tools/test-fixtures/coding-retrieval-gold.json'));
const gold = JSON.parse(goldBytes);
const output = resolve(process.argv[2] ?? '.ci/coding-retrieval');
const fixture = await mkdtemp(join(tmpdir(), 'coding-retrieval-measurement-'));
const rows = [], cold = {};
const percentile = values => [...values].sort((a, b) => a - b)[Math.max(0, Math.ceil(values.length * .95) - 1)];
const timed = async action => { const at = performance.now(); const value = await action(); return { value, ms: performance.now() - at }; };
const context = { cwd: fixture, sessionId: 'offline-measurement', agentId: 'offline-measurement', signal: AbortSignal.timeout(60000),
  permissions: { rules: [{ action: 'read', resource: 'file', effect: 'allow' }] },
  sandboxPolicy: { filesystem: { mode: 'read-only', allowedPaths: [fixture] }, network: { mode: 'deny' }, process: { allowedCommands: [] } } };
async function symbol(task, mode) {
  const result = await symbolSearchTool.execute({ symbol: task.symbol, mode }, context);
  assert.equal(result.status, 'success'); return result.output;
}
try {
  const files = new Map();
  for (const task of gold.cases) for (const [path, content] of Object.entries(task.files)) files.set(path, content);
  for (const [path, content] of files) { await mkdir(dirname(join(fixture, path)), { recursive: true }); await writeFile(join(fixture, path), content); }
  for (const [name, action] of [['lexical', () => symbol(gold.cases[0])], ['syntax', () => symbol(gold.cases[0], 'syntax')], ['relevantMap', () => buildRelevantCodeMap({ root: fixture, query: gold.cases[0].query, maxTokens: 1600 })]]) cold[name] = (await timed(action)).ms;
  for (const task of gold.cases) {
    const lexical = await timed(() => symbol(task));
    const syntax = await timed(() => symbol(task, 'syntax'));
    const map = await timed(() => buildRelevantCodeMap({ root: fixture, query: task.query, maxTokens: 1600 }));
    const paths = [task.goldFile, task.callerFile];
    for (const hit of syntax.value.hits) {
      const lines = (await readFile(join(fixture, hit.file), 'utf8')).split('\n');
      assert(hit.line >= 1 && hit.endLine >= hit.line && hit.endLine <= lines.length);
      assert(lines[hit.line - 1].includes(task.symbol));
    }
    const mapBytes = Buffer.byteLength(JSON.stringify(map.value)); assert(mapBytes <= 6400);
    rows.push({ id: task.id, family: /^(rust|go)-/.test(task.id) ? 'rust-go' : task.id.split('-')[0],
      lexical: { ms: lexical.ms, goldAndCallerFound: paths.every(path => lexical.value.hits.some(hit => hit.file === path)) },
      syntax: { ms: syntax.ms, goldAndCallerFound: paths.every(path => syntax.value.hits.some(hit => hit.file === path)), exactDefinitionFound: syntax.value.hits.some(hit => hit.file === task.goldFile && hit.role === 'definition' && hit.line === task.goldLine) },
      relevantMap: { ms: map.ms, recallAt5: map.value.files.slice(0, 5).some(file => file.path === task.goldFile), bytes: mapBytes } });
  }
  const families = [...new Set(rows.map(row => row.family))].map(family => {
    const entries = rows.filter(row => row.family === family);
    return { family, queries: entries.length, lexicalGoldAndCaller: entries.filter(row => row.lexical.goldAndCallerFound).length,
      syntaxGoldAndCaller: entries.filter(row => row.syntax.goldAndCallerFound).length, exactDefinitions: entries.filter(row => row.syntax.exactDefinitionFound).length,
      relevantRecallAt5: entries.filter(row => row.relevantMap.recallAt5).length / entries.length };
  });
  const report = { sourceSha: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: source, encoding: 'utf8' }).trim(),
    sourceClean: execFileSync('git', ['status', '--porcelain'], { cwd: source, encoding: 'utf8' }).trim() === '',
    fixtureSha256: createHash('sha256').update(goldBytes).digest('hex'), paidModelCalls: 0,
    environment: { platform: platform(), release: release(), node: process.version, cpu: cpus()[0].model, logicalCpus: cpus().length, totalMemoryBytes: totalmem() },
    corpus: { files: files.size, bytes: [...files.values()].reduce((sum, text) => sum + Buffer.byteLength(text), 0), queries: rows.length },
    coldMs: cold, warmP95Ms: Object.fromEntries(['lexical', 'syntax', 'relevantMap'].map(name => [name, percentile(rows.map(row => row[name].ms))])),
    processMemory: { rssBytes: process.memoryUsage().rss, maxRssKiB: process.resourceUsage().maxRSS }, families, rows,
    limits: 'Hand-labelled retrieval corpus, not a multi-repository model-success benchmark. Cold means fresh in-process index caches, not cold OS disk caches. Shared cloud host; time/memory are descriptive, not an uncontended-hardware SLO. Existing lexical can also retrieve these identifiers; report both arms.' };
  assert(families.every(family => family.relevantRecallAt5 >= .8));
  await mkdir(output, { recursive: true }); await writeFile(join(output, 'measurement.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ families, coldMs: cold, warmP95Ms: report.warmP95Ms }));
} finally { await rm(fixture, { recursive: true, force: true }); }
