import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runEditReceiptAcceptance } from '../../release/edit-receipts-fixture.mjs';
const source = fileURLToPath(new URL('../../../', import.meta.url));
const output = resolve(process.argv[2] ?? '.ci/edit-receipts'), baseline = process.argv[3] ? resolve(process.argv[3]) : undefined;
await mkdir(output, { recursive: true }); const arms = [];
for (const [name, root] of [...(baseline ? [['baseline', baseline]] : []), ['candidate', source]]) {
  const sourceSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
  const result = await runEditReceiptAcceptance(join(output, name), {
    cli: join(root, 'apps/cli/dist/main.js'), web: join(root, 'apps/web/dist/main.js'), sourceSha, requireReceipts: name === 'candidate',
    sourceTreeClean: execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' }).trim() === '',
  });
  arms.push({ name, ...result });
  console.log(JSON.stringify({ name, sourceSha, status: result.status, runs: result.runs.map(run => ({ surface: run.surface, scenario: run.scenario, calls: run.calls, noOpStatus: run.noOpStatus })) }));
}
if (baseline) for (const surface of ['cli', 'web']) {
  const previous = arms.find(arm => arm.name === 'baseline').runs.find(run => run.surface === surface);
  const next = arms.find(arm => arm.name === 'candidate').runs.find(run => run.surface === surface && run.scenario === 'sequential');
  assert.equal(previous.finalSha256, next.finalSha256); assert.equal(previous.calls.read, 2); assert.equal(next.calls.read, 1);
  assert.equal(previous.requests - next.requests, 1);
}
await writeFile(join(output, 'result.json'), JSON.stringify({ status: 'PASS', paidModelCalls: 0, arms,
  scope: 'Actual sequential guarded edit feedback; counts exclude identical host verification. Existing batch editing is unchanged. Not a real-model success-rate benchmark.' }, null, 2) + '\n');
