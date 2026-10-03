import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';

const argument = key => process.argv[process.argv.indexOf(key) + 1];
const repo = process.argv.includes('--repo') ? argument('--repo') : '/workspace/harness-agent';
const output = process.argv.includes('--out') ? argument('--out') : '/workspace/harness-agent/.ci/agent-measurement-20261003/independent-review/concurrent-ledger-baseline.json';
const { SkillEffectivenessLedger } = await import(pathToFileURL(join(repo, 'packages/harness/dist/skill-context.js')).href);

const observations = [];
for (let run = 0; run < 20; run++) {
  const dir = await mkdtemp(join(tmpdir(), 'm1-independent-ledger-'));
  const seed = new SkillEffectivenessLedger(dir, () => 1);
  await seed.apply('same-skill', { kind: 'loaded' });
  const ledger = new SkillEffectivenessLedger(dir, () => 2);
  await Promise.all(Array.from({ length: 100 }, () => ledger.apply('same-skill', { kind: 'injected' })));
  const inMemory = await ledger.get('same-skill');
  const persisted = await readFile(join(dir, 'skill-effectiveness.jsonl'), 'utf8');
  let persistedInjected;
  try { persistedInjected = JSON.parse(persisted.trim()).effectiveness.injectedCount; }
  catch { persistedInjected = 'INVALID_JSON'; }
  observations.push({ run, expectedInjected: 100, inMemoryInjected: inMemory?.injectedCount, persistedInjected });
}
const result = {
  kind: 'INDEPENDENT_REAL_FS_CONCURRENT_LEDGER_REPRO',
  sourceBaseSha: 'c31e4a8046f1e22b0da29c9310f5c131c5d9a38f',
  repo,
  sourceSha256: createHash('sha256').update(await readFile(join(repo, 'packages/harness/src/skill-context.ts'))).digest('hex'),
  paidCalls: 0,
  observations,
  inconsistentRuns: observations.filter(x => x.inMemoryInjected !== x.expectedInjected || x.persistedInjected !== x.expectedInjected).length,
};
await writeFile(output, JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify(result));
