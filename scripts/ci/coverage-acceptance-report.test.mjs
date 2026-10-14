import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';

const script = new URL('./coverage-acceptance-report.mjs', import.meta.url);
function fixture(log, digest) {
  const root = mkdtempSync(join(tmpdir(), 'coverage-public-report-'));
  writeFileSync(join(root, 'gate.log'), log);
  writeFileSync(join(root, 'coverage.json'), JSON.stringify({ gate: 'coverage', passed: false, state: 'failed', exitCode: 1,
    errorSummary: 'exitCode=1', logRef: { path: 'gate.log', digest: digest ?? createHash('sha256').update(log).digest('hex') } }));
  return { root, run: () => spawnSync(process.execPath, [fileURLToPath(script), join(root, 'coverage.json')], { encoding: 'utf8' }) };
}

test('publishes the real failure block after expected-error noise, including Unicode', () => {
  const detail = 'Failed Tests 1\nFAIL 模型路由\nAssertionError: expected completed\n';
  const f = fixture('expected refusal\n'.repeat(500) + detail);
  try {
    const result = f.run(); assert.equal(result.status, 0);
    const lines = result.stdout.trim().split('\n');
    const record = JSON.parse(lines[0].split('::').at(-1)); assert.equal(record.passed, false); assert.equal(record.exitCode, 1);
    const packets = lines.slice(1).map(line => JSON.parse(line.split('::').at(-1))).sort((a, b) => a.index - b.index);
    assert.equal(packets.length, packets[0].total); assert.ok(packets.length <= 9);
    const decoded = JSON.parse(gunzipSync(Buffer.from(packets.map(p => p.data).join(''), 'base64')));
    assert.equal(decoded.truncated, false); assert.equal(decoded.text, detail);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('refuses changed log bytes rather than publishing a fabricated failure detail', () => {
  const f = fixture('Failed Tests\nchanged log\n', '0'.repeat(64));
  try {
    const result = f.run(); assert.equal(result.status, 1); assert.match(result.stderr, /log digest mismatch/); assert.doesNotMatch(result.stdout, /Coverage failure detail/);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('marks bounded failure detail as truncated', () => {
  const f = fixture('Failed Tests\n' + '诊断\n'.repeat(10_000));
  try {
    const result = f.run(); assert.equal(result.status, 0);
    const packets = result.stdout.trim().split('\n').slice(1).map(line => JSON.parse(line.split('::').at(-1))).sort((a, b) => a.index - b.index);
    const decoded = JSON.parse(gunzipSync(Buffer.from(packets.map(p => p.data).join(''), 'base64')));
    assert.equal(decoded.truncated, true); assert.equal(decoded.text.length, 24_000);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});
