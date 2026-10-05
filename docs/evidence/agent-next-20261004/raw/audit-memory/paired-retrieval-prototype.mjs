import { readFile, writeFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { performance } from 'node:perf_hooks';
const repo = '/workspace/harness-agent';
const out = join(repo, '.ci/agent-next-20261004/audit-memory');
const hash = value => createHash('sha256').update(value).digest('hex');
const hashResult = value => hash(JSON.stringify(value));
const root = await import(pathToFileURL(join(repo, 'packages/memory/dist/index.js')));
const challenger = await import(pathToFileURL(join(out, 'retrieval-cache-tokens.mjs')));
const original = await readFile(join(out, 'baseline-18f162b/report.json'), 'utf8').then(JSON.parse);
const fixture = (await readdir(join(out, 'baseline-18f162b'))).find(p => p.startsWith('fixtures-'));
const sourceHashBefore = hash(await readFile(join(repo, 'packages/memory/src/retrieval.ts')));
const report = {
  status: 'RUNNING', observedAt: new Date().toISOString(), sourceHead: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim(),
  prototypeOnly: true, trackedOrProductionModified: false,
  prototypeSha256: hash(await readFile(join(out, 'retrieval-cache-tokens.mjs'))),
  fixtureSha256: original.fixtureSha256, fixtureSource: 'actual existing baseline 10000-row stores',
  fixedNow: 1791000000000, warmupsPerImplementation: 2, measuredSamplesPerImplementation: 5,
  order: 'AB/BA alternation for every paired sample', realProviderCalls: 0, paidCalls: 0, modelQuality: 'NOT_RUN', cases: []
};
const stat = a => ({ samplesMs: a, medianMs: [...a].sort((x,y)=>x-y)[Math.floor(a.length/2)] });
for (const backend of ['jsonl', 'sqlite']) {
  const dataDir = join(out, 'baseline-18f162b', fixture, backend);
  const store = backend === 'jsonl' ? new root.JsonlMemoryStore({ dataDir }) : new root.SqliteMemoryStore({ dataDir });
  try {
    for (const [name, query] of [['warm-fts', 'retry'], ['chinese-substring', '端口配置'], ['structured-do', 'portlint'], ['actual-miss', 'unmatchedmarkerquantum']]) {
      const opts = { k: 5, now: report.fixedNow, sessionId: 'session-fixture-owner' };
      const expected = await root.retrieveMemories(store, query, 'workspace', opts);
      const expectedSha256 = hashResult(expected);
      const measurements = { baseline: [], prototype: [] };
      let totalCalls = 0, equivalent = true;
      const functions = { baseline: root.retrieveMemories, prototype: challenger.retrieveMemories };
      for (let n = -2; n < 5; n++) {
        for (const variant of n % 2 === 0 ? ['baseline', 'prototype'] : ['prototype', 'baseline']) {
          const start = performance.now();
          const result = await functions[variant](store, query, 'workspace', opts);
          const elapsed = performance.now() - start;
          equivalent &&= hashResult(result) === expectedSha256;
          totalCalls++;
          if (n >= 0) measurements[variant].push(elapsed);
        }
      }
      const baseline = stat(measurements.baseline), prototype = stat(measurements.prototype);
      report.cases.push({ backend, name, query, totalCalls, fullResultEquivalent: equivalent, resultSha256: expectedSha256, returnedTopK: expected.items.length, suppressedCount: expected.suppressed.length, baseline, prototype, ratio: prototype.medianMs / baseline.medianMs });
    }
  } finally { store.close?.(); }
}
report.sourceHashBefore = sourceHashBefore;
report.sourceHashAfter = hash(await readFile(join(repo, 'packages/memory/src/retrieval.ts')));
report.sourceUnchanged = report.sourceHashBefore === report.sourceHashAfter;
report.status = report.sourceUnchanged && report.cases.every(c => c.fullResultEquivalent) ? 'PASS' : 'FAIL';
await writeFile(join(out, 'paired-retrieval-prototype.json'), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({ status: report.status, prototypeOnly: true, cases: report.cases.map(c => ({ backend: c.backend, name: c.name, fullResultEquivalent: c.fullResultEquivalent, baselineMs: c.baseline.medianMs, prototypeMs: c.prototype.medianMs, ratio: c.ratio })) }, null, 2));
if (report.status !== 'PASS') process.exitCode = 1;
