import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { deriveBrandModule } from './web-branding-lib.mjs';

const stem = 'dsh-client-ui-conversation';
const original = await readFile(new URL(`../../apps/web/public/deepseek/plugins/${stem}/client.js`, import.meta.url));
function composer(bytes) {
  const source = bytes.toString('utf8');
  const prefix = 'onPick: (workspaceId) => {';
  const start = source.indexOf(prefix), end = source.indexOf(',\n\t\t\t\t\t\tonClose:', start);
  assert(start >= 0 && end > start, 'the actual pinned workspace selection handler is present');
  const handler = source.slice(start + 'onPick: '.length, end);
  const guard = /const inert = ([^;]+);/.exec(source)?.[1];
  assert(guard, 'the actual pinned editor readiness predicate is present');
  let pending = false, pendingId;
  const attempts = [];
  const choose = new Function('setPickerOpen', 'setPendingWorkspaceId', 'selectWorkspace', 'workspaceSelection', 'setWorkspaceSelectionPending', `return (${handler});`)(
    () => {}, value => { pendingId = typeof value === 'function' ? value(pendingId) : value; },
    workspaceId => new Promise((resolve, reject) => { attempts.push({ workspaceId, resolve, reject }); }),
    { current: 0 }, value => { pending = value; },
  );
  const inert = new Function('workspaceSelectionPending', 'navigationPending', 'sessionId', 'hero', 'chipTitle', `return (${guard});`);
  return { choose, attempts, blocked: (navigationPending = false) => inert(pending, navigationPending, 'old-session', true, 'project'), pendingId: () => pendingId };
}
const settled = () => new Promise(resolve => setImmediate(resolve));

test('original optimistic workspace label permits sending to the old session before selection settles', async () => {
  const stack = composer(original); stack.choose('project');
  assert.equal(stack.blocked(), false, 'deterministic original readiness defect');
  stack.attempts[0].resolve(); await settled();
});
test('reviewed actual composer blocks the same-workspace replacement until its real promise settles', async () => {
  const stack = composer(deriveBrandModule(stem, original)); stack.choose('project');
  assert.equal(stack.blocked(), true);
  stack.attempts[0].resolve(); await settled();
  assert.equal(stack.blocked(), false);
});
test('an older selection completing cannot unlock a newer pending workspace choice', async () => {
  const stack = composer(deriveBrandModule(stem, original)); stack.choose('one'); stack.choose('two');
  stack.attempts[0].resolve(); await settled(); assert.equal(stack.blocked(), true);
  stack.attempts[1].resolve(); await settled(); assert.equal(stack.blocked(), false);
});
test('a rejected latest selection restores the previous editor and clears its optimistic label', async () => {
  const stack = composer(deriveBrandModule(stem, original)); stack.choose('missing');
  assert.equal(stack.blocked(), true);
  stack.attempts[0].reject(new Error('actual selection refused')); await settled();
  assert.equal(stack.blocked(), false); assert.equal(stack.pendingId(), undefined);
});
test('the actual composer remains inert during navigation even without a workspace-picker request', () => {
  const stack = composer(deriveBrandModule(stem, original));
  assert.equal(stack.blocked(), false);
  assert.equal(stack.blocked(true), true);
  assert.equal(stack.attempts.length, 0);
});
