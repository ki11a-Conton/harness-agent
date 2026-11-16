import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function run(source) {
  const directory = mkdtempSync(join(tmpdir(), 'native-preflight-report-'));
  try {
    const fixture = join(directory, 'case.mjs');
    writeFileSync(fixture, "import {test} from 'node:test';\nimport assert from 'node:assert/strict';\n" + source);
    const env = { ...process.env };
    delete env.NODE_TEST_CONTEXT;
    const child = spawnSync(process.execPath, ['--test', '--test-reporter=spec',
      '--test-reporter=' + new URL('./test-failure-annotations.mjs', import.meta.url).href,
      '--test-reporter-destination=stdout', '--test-reporter-destination=stdout', fixture], { encoding: 'utf8', env, maxBuffer: 8 * 1024 * 1024 });
    assert.equal(child.error, undefined);
    const lines = child.stdout.split(/\r?\n/);
    return { ...child, annotations: lines.filter(line => line.startsWith('::error title=Native preflight failure ')),
      summaries: lines.filter(line => line.startsWith('::notice title=Native preflight result::'))
        .map(line => JSON.parse(line.split('::').slice(2).join('::'))) };
  } finally { rmSync(directory, { recursive: true, force: true, maxRetries: process.platform === 'win32' ? 8 : 0, retryDelay: 50 }); }
}

test('a passing native command keeps its zero exit status and has no failure annotation', () => {
  const result = run("test('actual passing assertion',()=>assert.equal(1,1));");
  assert.equal(result.status, 0, result.stderr); assert.deepEqual(result.annotations, []);
  assert.match(result.stdout, /actual passing assertion/);
  assert.equal(result.summaries.length, 1); assert.equal(result.summaries[0].counts.passed, 1);
  assert.equal(result.summaries[0].counts.failed, 0); assert.equal(result.summaries[0].platform, process.platform);
});
test('real assertion failures stay red and retain their actionable cause within annotation budgets', () => {
  const message = '中文真实断言🙂%0A::error::\n'.repeat(1000);
  const result = run(`for(let i=0;i<9;i++)test('actual broken assertion '+i,()=>assert.equal(1,2,${JSON.stringify(message)}));`);
  assert.equal(result.status, 1, result.stderr); assert.equal(result.annotations.length, 6);
  for (const line of result.annotations) {
    const payload = line.split('::').slice(2).join('::');
    assert(Buffer.byteLength(payload, 'utf8') < 3500); assert(!payload.includes('%0A::error::'));
    const detail = JSON.parse(payload.replace(/%0D/g, '\r').replace(/%0A/g, '\n').replace(/%25/g, '%'));
    assert.match(detail.name, /actual broken assertion/); assert.match(detail.failure, /AssertionError|ERR_ASSERTION/);
    assert.match(detail.failure, /中文真实断言/); assert.equal(detail.truncated, true);
  }
  assert.match(result.stdout, /actual broken assertion 8/);
  assert.equal(result.summaries.length, 1); assert.equal(result.summaries[0].counts.failed, 9);
});
