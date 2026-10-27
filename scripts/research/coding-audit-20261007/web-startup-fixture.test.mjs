import { test } from 'node:test';
import assert from 'node:assert/strict';
import { allocateWebStartupFixture, WebStartupExit } from './web-startup-fixture.mjs';

const busy = () => new WebStartupExit({ code: 1, signal: null, stdout: '', stderr: 'HARNESS_DATA_DIR_IN_USE: genuine startup refusal\n' });
test('initial Web fixture admission replaces only a genuinely busy pre-listening path', async () => {
  const paths = [];
  const result = await allocateWebStartupFixture(async path => {
    paths.push(path); if (paths.length === 1) throw busy(); return 'http://127.0.0.1:1234';
  }, 'initial', attempt => `fresh-${attempt}`, true);
  assert.deepEqual(paths, ['initial', 'fresh-1']);
  assert.deepEqual(result, { dataDir: 'fresh-1', address: 'http://127.0.0.1:1234' });
});
test('persistence restarts never reallocate their data after a busy refusal', async () => {
  let attempts = 0; const failure = busy();
  await assert.rejects(allocateWebStartupFixture(async () => { attempts++; throw failure; }, 'committed', () => assert.fail('restart changed identity')), error => error === failure);
  assert.equal(attempts, 1);
});
test('startup allocation never retries business errors, permission failures or a process that already listened', async () => {
  for (const failure of [Object.assign(new Error('HARNESS_DATA_DIR_IN_USE: copied assertion'), { code: 'HARNESS_DATA_DIR_IN_USE' }),
    new WebStartupExit({ code: 1, signal: null, stdout: '', stderr: 'HARNESS_DATA_DIR_LEASE_FAILED: EACCES' }),
    new WebStartupExit({ code: 1, signal: null, stdout: 'listening on http://127.0.0.1:1234', stderr: 'HARNESS_DATA_DIR_IN_USE: later failure' })]) {
    let attempts = 0;
    await assert.rejects(allocateWebStartupFixture(async () => { attempts++; throw failure; }, 'initial', () => assert.fail('unrelated error retried'), true), error => error === failure);
    assert.equal(attempts, 1);
  }
});
test('unavailable initial Web fixture admission is bounded and retains the original refusal', async () => {
  let attempts = 0; const failure = busy();
  await assert.rejects(allocateWebStartupFixture(async () => { attempts++; throw failure; }, 'initial', n => `fresh-${n}`, true), error => error.cause === failure && /16 busy/.test(error.message));
  assert.equal(attempts, 16);
});
