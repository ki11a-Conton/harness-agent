import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { addControlsUi } from './web-controls-ui.mjs';
const source = stem => readFile(new URL(`../../apps/web/public/deepseek/plugins/${stem}/client.js`, import.meta.url), 'utf8');

test('actual composer registration uses the injected live session instead of an unavailable remote service', async () => {
  const derived = addControlsUi('dsh-client-ui-conversation', await source('dsh-client-ui-conversation'));
  const start = derived.indexOf('ctx.slots.inject("conversation.input.left", () => ctx.slots.register({ name: "conversation.input.left", id: "harness-controls"');
  const end = derived.indexOf('}, HarnessControls));', start) + '}, HarnessControls));'.length;
  assert(start >= 0 && end > start);
  let registration; const calls = [];
  const ctx = { slots: { inject(_slot, callback) { callback(); }, register(options) { registration = options; } },
    sessions: { binding(id) { return { session: { async command(line) { calls.push({ id, line }); return { ok: true, value: { matched: true } }; } } }; } },
    get remote() { throw new Error('remote was not injected'); } };
  vm.runInNewContext(derived.slice(start, end), { ctx, HarnessControls() {} });
  await registration.inject('actual-session').runCommand('/plan on');
  assert.deepEqual(calls, [{ id: 'actual-session', line: '/plan on' }]);
});

test('actual goal CAS ref retains an acknowledged edit while projections catch up, without rebasing third-party conflicts', async () => {
  const derived = addControlsUi('dsh-client-ui-goal', await source('dsh-client-ui-goal'));
  const start = derived.indexOf('const sessions = ctx.sessions;'), end = derived.indexOf('const noCurrentGoal', start);
  let goal = { id: 'goal-a', revision: 1 };
  const ctx = { effect() {}, sessions: { binding() { return { session: { projections: { faceOf() { return { getSnapshot() { return { goal }; } }; } } } }; } } };
  const scope = vm.runInNewContext('(() => {' + derived.slice(start, end) + '; return { refOf, remember }; })()', { ctx });
  scope.remember('s', { ok: true, value: { id: 'goal-a', revision: 2 } });
  assert.equal(scope.refOf('s').revision, 2);
  goal = { id: 'goal-a', revision: 3 }; assert.equal(scope.refOf('s').revision, 3);
  scope.remember('s', { ok: false, error: { code: 'goal/conflict' } }); assert.equal(scope.refOf('s').revision, 3);
  goal = { id: 'goal-b', revision: 1 }; assert.equal(scope.refOf('s').id, 'goal-b'); assert.equal(scope.refOf('s').revision, 1);
});
