import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, mkdir, writeFile, copyFile } from 'node:fs/promises';
import { join } from 'node:path';
import vm from 'node:vm';

const repository = '/workspace/harness-agent-gen1-ssefix';
const output = join(repository, '.ci/gen1-sse-race-control');
await mkdir(output, { recursive: true });
const original = await readFile('/workspace/harness-agent-gen1-20261008/scripts/research/gen1-20261008/interaction-acceptance.mjs', 'utf8');
const fixed = await readFile(join(repository, 'scripts/research/gen1-20261008/interaction-acceptance.mjs'), 'utf8');
const cases = [];
const reply = (turnId = 'turn-new') => ({ type: 'assistant_text', turnId, text: 'Web first task completed.' });
const terminal = (turnId = 'turn-new', sessionId = 'session-original', status = 'completed') => ({ type: 'event',
  event: { type: 'turn.completed', id: `event-${turnId}`, turnId, sessionId, payload: { turnId, status } } });
const stream = frames => ({ frames, failure: () => undefined });
function harness() {
  const timers = []; let clock = 0;
  const context = { assert, Date: { now: () => clock }, setTimeout(callback, delay) { assert.equal(delay, 15); timers.push(callback); } };
  const waitFor = fixed.slice(fixed.indexOf('async function waitFor('), fixed.indexOf('let webChild;'));
  const helpers = fixed.slice(fixed.indexOf('function completedWebTurn('), fixed.indexOf('async function post('));
  vm.runInNewContext(`${waitFor}\n${helpers}\nglobalThis.api = { waitFor, completedWebTurn, waitForWebTurn };`, context);
  return { context, api: context.api, timers, advance(time) { clock = time; } };
}
async function flush() { for (let n = 0; n < 10; n++) await Promise.resolve(); }
async function tick(h) { assert.ok(h.timers.length, 'wait must be pending on the unchanged poll cadence'); h.timers.shift()(); await flush(); }
async function caseRun(name, run) { await run(); cases.push({ name, passed: true }); }

await caseRun('RED: actual original two-tab snippet rejects reply frames before later terminal frames', async () => {
  const h = harness(); const a = stream([reply()]); const b = stream([reply()]);
  Object.assign(h.context, { a, b, check(name, value) { assert.ok(value, name); }, waitFor: h.api.waitFor });
  const start = original.indexOf('  await waitFor(() => [a, b].every');
  const end = original.indexOf('  const before =', start);
  assert.ok(start > 0 && end > start);
  await assert.rejects(vm.runInNewContext(`(async () => { ${original.slice(start, end)} })()`, h.context), /two real SSE tabs receive the same completed Web turn/);
  assert.equal(h.timers.length, 0, 'original check fails immediately after text rather than awaiting a terminal');
});
await caseRun('GREEN: actual fixed helper gates both tabs until the matching completion arrives on each', async () => {
  const h = harness(); const a = stream([reply()]); const b = stream([reply()]); let settled = false;
  const done = h.api.waitForWebTurn([a, b], reply().text, 'controlled two-tab completion').then(value => { settled = true; return value; });
  await flush(); assert.equal(settled, false);
  a.frames.push(terminal('old-turn')); b.frames.push(terminal('old-turn'));
  await tick(h); assert.equal(settled, false, 'another turn completion cannot satisfy a reply');
  a.frames.push(terminal()); await tick(h); assert.equal(settled, false, 'the second stream remains required');
  b.frames.push(terminal()); await tick(h);
  const completion = await done; assert.equal(completion.turnId, 'turn-new'); assert.equal(completion.sessionId, 'session-original');
  assert.equal(completion.completionEventId, 'event-turn-new');
});
await caseRun('restart rejects replayed old completion and requires a new terminal on the original session', async () => {
  const h = harness(); const c = stream([terminal('old-turn'), reply()]);
  const options = { sessionId: 'session-original', excludeTurnId: 'old-turn' };
  assert.equal(h.api.completedWebTurn([c], reply().text, options), undefined);
  c.frames.push(terminal()); assert.equal(h.api.completedWebTurn([c], reply().text, options).turnId, 'turn-new');
  assert.throws(() => h.api.completedWebTurn([stream([reply(), terminal('turn-new', 'wrong-session')])], reply().text, options), /original session/);
});
await caseRun('mismatched two-tab terminal ids are rejected', async () => {
  const h = harness(); const a = stream([reply(), terminal()]); const b = stream([reply('different-turn'), terminal('different-turn')]);
  assert.throws(() => h.api.completedWebTurn([a, b], reply().text), /same completed turn/);
});
await caseRun('stream error, failed/cancelled turn and noncompleted status remain failures', async () => {
  const h = harness(); const a = stream([]);
  assert.throws(() => h.api.completedWebTurn([a, { frames: [], failure: () => new Error('controlled stream failure') }], reply().text), /SSE stream failure/);
  for (const type of ['turn.failed', 'turn.cancelled']) assert.throws(() => h.api.completedWebTurn([stream([{ type: 'event', event: { type, turnId: 'turn-new' } }])], reply().text), /failed or was cancelled/);
  assert.throws(() => h.api.completedWebTurn([stream([reply(), terminal('turn-new', 'session-original', 'failed')])], reply().text), /terminal status/);
  assert.throws(() => h.api.completedWebTurn([stream([{ type: 'error' }])], reply().text), /protocol error/);
});
await caseRun('missing terminal keeps the original fixed 15000ms deadline and fails without retry', async () => {
  const h = harness(); const done = h.api.waitForWebTurn([stream([reply()])], reply().text, 'terminal never delivered');
  const rejected = assert.rejects(done, /deadline: terminal never delivered/); await flush();
  h.advance(15000); await tick(h); await rejected; assert.equal(h.timers.length, 0);
});
const originalCi = [];
for (const platform of ['ubuntu', 'windows']) {
  const source = `/tmp/gen1-ci-debug-bec526b/gen1-ci-bundle/${platform}/interaction/result.json`;
  const bytes = await readFile(source); const result = JSON.parse(bytes);
  assert.equal(result.status, 'FAIL'); assert.equal(result.failure.message, 'two real SSE tabs receive the same completed Web turn');
  await writeFile(join(output, `${platform}-original-ci-red.json`), bytes);
  originalCi.push({ platform, sourceSha: result.sourceSha, node: result.node, assertionCount: result.assertionCount,
    requestCount: result.requestCount, sha256: createHash('sha256').update(bytes).digest('hex') });
}
await copyFile('/tmp/gen1-sse-race-control.mjs', join(output, 'reproducer.mjs'));
const receipt = { status: 'PASS', scope: 'Controlled scheduling executes the actual original snippet and actual fixed wait helpers; it does not substitute for real HTTP or native OS acceptance.',
  cases, originalCi, scriptSha256: createHash('sha256').update(fixed).digest('hex'), paidModelCalls: 0 };
await writeFile(join(output, 'result.json'), JSON.stringify(receipt, null, 2) + '\n');
console.log(JSON.stringify(receipt));
