#!/usr/bin/env node
/** PR15 real UI -> production host -> loopback HTTP -> durable tools.
 * No RPC mutations outside UI, interception, DOM replacement, or paid models. */
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { randomUUID } from 'node:crypto';
import { observeProductionRpc } from './deepseek-browser-observe.mjs';
const { values } = parseArgs({ options: { url: { type: 'string' }, output: { type: 'string' }, 'fixture-evidence': { type: 'string' },
  'playwright-module': { type: 'string' }, chromium: { type: 'string', default: '/usr/bin/chromium' } } });
assert(values.url && values.output && values['fixture-evidence'] && values['playwright-module']);
const origin = new URL(values.url).origin, output = resolve(values.output), evidence = resolve(values['fixture-evidence']);
const fixture = JSON.parse(await readFile(join(evidence, 'launch.json'), 'utf8'));
assert.equal(new URL(origin).hostname, '127.0.0.1'); assert.equal(new URL(fixture.providerOrigin).hostname, '127.0.0.1');
assert.equal(fixture.paidModelCalls, 0); assert.equal(fixture.model, 'web-loopback-fixture');
await mkdir(output, { recursive: true });
const playwright = await import(pathToFileURL(resolve(values['playwright-module'])).href);
const browser = await playwright.chromium.launch({ executablePath: values.chromium, headless: true, args: ['--no-sandbox'] });
const context = await browser.newContext({ locale: 'en-US', viewport: { width: 1440, height: 900 } });
const page = await context.newPage(); page.setDefaultTimeout(10000);
const errors = [], checks = [], permissionFrames = [], rpc = observeProductionRpc(page, origin);
page.on('websocket', socket => socket.on('framereceived', event => {
  let frame; try { frame = JSON.parse(String(event.payload)); } catch { return; }
  const value = frame.type === 'frame' ? frame.value : undefined;
  if (value?.type !== 'projection' || value.key !== 'permissions') return;
  permissionFrames.push({ at: Date.now(), sessionId: value.sessionId, seq: value.seq, currentValue: value.value?.currentValue });
  if (permissionFrames.length > 80) permissionFrames.shift();
}));
page.on('pageerror', error => errors.push(error.message));
page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
const button = name => page.getByRole('button', { name, exact: typeof name === 'string' }).filter({ visible: true }).first();
const composer = () => page.locator('[data-composer-input=true][contenteditable=true]');
async function modeCommand(description) {
  await button('Add files or run commands').click();
  await page.getByRole('option').filter({ hasText: description }).click();
}
async function enterPlan() {
  await modeCommand('Enter or leave plan mode');
  await button('Plan mode on, press to turn off').waitFor();
  await until(async () => (await read('session/projections', { request: { sessionId: id } })).values.plan.active, 'Plan mode not persisted');
}
const requests = async () => (await readFile(join(evidence, 'requests.jsonl'), 'utf8').catch(error => { if (error.code === 'ENOENT') return ''; throw error; })).split('\n').filter(Boolean).map(line => JSON.parse(line));
async function until(action, label, ms = 15000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await action()) return; await page.waitForTimeout(80); }
  throw new Error(label);
}
async function read(endpoint, args) {
  // Read-side assertions only; all state changes below are real UI controls.
  assert(['session/list', 'session/projections', 'goals/get', 'settings/describe'].includes(endpoint));
  const response = await fetch(origin + '/api/deepseek/call', { method: 'POST', headers: { 'content-type': 'application/json', origin }, body: JSON.stringify({ endpoint, args, requestId: randomUUID() }), signal: AbortSignal.timeout(10000) });
  const result = await response.json(); assert.equal(result.ok, true, JSON.stringify(result.error)); return result.value;
}
async function prompt(text) {
  const previousTurn = (await read('session/projections', { request: { sessionId: id } })).values.turnBoundary.lastTurn;
  const before = rpc.results.length;
  await page.locator('[data-composer-input=true][contenteditable=true]').fill(text);
  await button('Send message').click();
  await until(() => rpc.results.slice(before).some(item => item.endpoint === 'session/prompt' && item.ok), 'UI admission missing');
  await until(async () => (await requests()).some(request => request.messages.some(message => message.role === 'user' && message.content.includes(text))), 'Actual HTTP model request missing');
  await until(async () => {
    const boundary = (await read('session/projections', { request: { sessionId: id } })).values.turnBoundary;
    return boundary.lastTurn > previousTurn && boundary.openTurnStartSeq === null && !await button('Stop generating').isVisible();
  }, 'Actual admitted turn did not settle', 30000);
}
async function permission(label) {
  const expected = { 'Read Only': 'read-only', 'Workspace Write': 'workspace-write', 'Full access': 'danger-full-access' }[label];
  if ((await read('session/projections', { request: { sessionId: id } })).values.permissions.currentValue === expected) {
    await button('Access mode, current: ' + label).waitFor(); return;
  }
  await button(/^Access mode, current:/).click(); await page.getByRole('menuitem', { name: label, exact: true }).click();
  if (label === 'Full access') {
    const enable = button('Enable Full access'); assert(await enable.isDisabled(), 'Full access enabled without acknowledgement');
    await page.getByRole('checkbox').check(); await enable.click();
  }
  // Native Windows can retry an atomic settings replacement for 7.13s; a
  // command also commits its lifecycle. Await the actual acknowledgement.
  await button('Access mode, current: ' + label).waitFor({ state: 'visible', timeout: 30000 });
  await until(() => button('Access mode, current: ' + label).isEnabled(), 'Permission save is still pending', 30000);
  assert.equal((await read('session/projections', { request: { sessionId: id } })).values.permissions.currentValue, expected);
}
let id, failure, failureState;
const cases = [
  ['removed-surfaces', async () => {
    await page.goto(origin, { waitUntil: 'domcontentloaded' }); await page.locator('[data-harness-controls]').waitFor();
    const listed = await read('session/list', { _request: {} }); id = listed.items.find(item => item.blank && item.agentAvailable).sessionId;
    await page.locator(`[data-row-key="session:${id}"]`).click();
    const home = await page.locator('body').innerText(); assert(!/插件|\bPlugins\b|Into the Unknown|探索未至之境|Coding status|编码状态/u.test(home));
    await button('Settings').click(); const settings = await page.locator('body').innerText();
    assert(!/插件|\bPlugins\b|Agent presets|Agent 预设|Current version|当前版本/u.test(settings));
    await button('Close').click();
    await page.setViewportSize({ width: 320, height: 1100 });
    assert.equal(await page.getByRole('combobox', { name: 'Task mode', exact: true }).count(), 0);
    await enterPlan();
    const layout = await page.locator('[data-harness-controls]').evaluate(element => {
      const rect = element.getBoundingClientRect();
      return { left: rect.left, right: rect.right, width: rect.width, viewport: innerWidth,
        buttons: [...element.querySelectorAll('button')].filter(button => button.getClientRects().length).map(button => button.getBoundingClientRect().toJSON()) };
    });
    assert(layout.width > 0 && layout.left >= 0 && layout.right <= layout.viewport + 1, JSON.stringify(layout));
    assert(layout.buttons.length > 0 && layout.buttons.every(rect => rect.width > 0 && rect.left >= 0 && rect.right <= layout.viewport + 1), 'Native composer controls overflow: ' + JSON.stringify(layout));
    await page.screenshot({ path: join(output, 'narrow-plan-mode.png'), fullPage: true });
    await button('Plan mode on, press to turn off').click();
    await until(async () => !(await read('session/projections', { request: { sessionId: id } })).values.plan.active, 'Narrow plan mode did not exit');
    const before = (await requests()).length;
    await modeCommand('Set or view the goal for a long-running task');
    await page.locator('[data-composer-input=true][data-phase=claimed]').waitFor();
    await composer().pressSequentially('An unsent native goal draft');
    assert.equal(await page.getByRole('textbox', { name: 'Goal objective', exact: true }).count(), 0);
    await page.screenshot({ path: join(output, 'narrow-goal-editor.png'), fullPage: true });
    await composer().press('ControlOrMeta+A'); await composer().press('Backspace');
    await until(async () => (await composer().innerText()).trim() === '', 'Native draft did not clear');
    assert.equal(await read('goals/get', { agentId: id }), undefined);
    assert.equal((await requests()).length, before, 'Cancelling a goal draft must not call the model');
    await page.setViewportSize({ width: 1440, height: 900 });
  }],
  ['permission-real-denial-and-confirmation', async () => {
    await permission('Read Only'); await prompt('[fixture:write-deny] PR15 read-only must deny the actual write.');
    await assert.rejects(readFile(join(fixture.cwd, 'browser-rejected.txt')), { code: 'ENOENT' });
    assert((await requests()).some(request => request.messages.some(message => message.role === 'tool' && /denied|permission/i.test(message.content))));
    await permission('Workspace Write'); await permission('Full access');
    await page.reload(); await page.locator('[data-harness-controls]').waitFor();
    await page.locator(`[data-row-key="session:${id}"]`).click(); await button('Access mode, current: Full access').waitFor();
    const state = await read('session/projections', { request: { sessionId: id } }); assert.equal(state.values.permissions.currentValue, 'danger-full-access');
  }],
  ['plan-review-before-real-write', async () => {
    await enterPlan();
    await prompt('[fixture:plan] Prepare the actual file change; await human approval.');
    await assert.rejects(readFile(join(fixture.cwd, 'plan-approved.txt')), { code: 'ENOENT' });
    const review = page.locator('[data-harness-plan-review]'); await review.waitFor({ timeout: 30000 }); await review.locator('summary').click();
    assert((await review.locator('pre').innerText()).includes('plan-approved.txt'));
    await button('Approve and implement').click();
    await until(async () => (await readFile(join(fixture.cwd, 'plan-approved.txt'), 'utf8').catch(() => '')) === 'Actual human approved plan output\n', 'Approved plan did not produce real bytes', 30000);
    await until(async () => !await button('Stop generating').isVisible(), 'Approved execution did not settle');
  }],
  ['length-notice-and-continue', async () => {
    await prompt('[fixture:length] Preserve the truncated output.');
    await page.getByText('Output token limit reached', { exact: true }).waitFor();
    assert((await page.locator('body').innerText()).includes('Partial coding result retained'));
    await prompt('Continue after the PR15 length boundary.');
    await page.getByRole('heading', { name: 'Actual Harness browser answer', exact: true }).last().waitFor();
    assert(!/provider.*protocol.*length|finish_reason.*length.*error/i.test(await page.locator('body').innerText()));
  }],
  ['manual-compaction-real-completion', async () => {
    assert.equal(await button('Compress context').count(), 0, 'Manual compaction must live in the native plus menu');
    await button('Add files or run commands').click();
    await page.getByRole('option').filter({ hasText: 'Compact older conversation history' }).click();
    await page.getByText('Will compress next request', { exact: true }).waitFor();
    await page.setViewportSize({ width: 320, height: 1100 });
    await button('Add files or run commands').press('Enter');
    const compactOption = page.getByRole('option').filter({ hasText: 'Compact older conversation history' });
    await compactOption.waitFor();
    const editor = page.locator('[data-composer-input=true][contenteditable=true]');
    for (let index = 0; index < 20 && await compactOption.getAttribute('aria-selected') !== 'true'; index++) await editor.press('ArrowDown');
    assert.equal(await compactOption.getAttribute('aria-selected'), 'true', 'Native Compact must be reachable with the keyboard');
    await page.screenshot({ path: join(output, 'narrow-compact-plus-keyboard.png'), fullPage: true });
    await editor.press('Enter');
    await compactOption.waitFor({ state: 'hidden' });
    await page.setViewportSize({ width: 1440, height: 900 });
    await prompt('Continue after explicit PR15 context compression.');
    await page.getByText('Context prepared', { exact: true }).waitFor();
    const state = await read('session/projections', { request: { sessionId: id } });
    assert.equal(state.values.harnessCompaction.pending, false); assert(state.values.harnessCompaction.lastCompletedAt > 0);
    assert.equal(state.values.harnessCompaction.lastSummarySource, 'model');
    const summary = (await requests()).filter(request => request.purpose === 'compaction').at(-1);
    assert(summary && (!summary.tools || summary.tools.length === 0) && summary.maxTokens <= 2048);
    assert(await page.getByText('Output token limit reached', { exact: true }).isVisible(), 'Compression lost the previous turn');
  }],
  ['goal-create-pause-edit-resume-clear', async () => {
    await modeCommand('Set or view the goal for a long-running task');
    await page.locator('[data-composer-input=true][data-phase=claimed]').waitFor();
    await composer().pressSequentially('[fixture:read] Review demo.js and improve the coding proof.');
    const before = (await requests()).length, saved = rpc.waitForResult('commands/execute', 30000);
    await button('Send message').click();
    const receipt = await saved; if (receipt.error) throw receipt.error; assert.equal(receipt.result.ok, true);
    await button('Pause goal').waitFor();
    await until(async () => (await requests()).length >= before + 3, 'Goal did not continue across actual rounds', 30000);
    await button('Pause goal').click(); await button('Resume goal').waitFor();
    const paused = await read('goals/get', { agentId: id }); assert.equal(paused.phase, 'paused');
    await until(async () => {
      const boundary = (await read('session/projections', { request: { sessionId: id } })).values.turnBoundary;
      return boundary.openTurnStartSeq === null && !await button('Stop generating').isVisible();
    }, 'Paused goal turn did not settle', 30000);
    const pausedCount = (await requests()).length; await page.waitForTimeout(2100);
    const stillPaused = await read('goals/get', { agentId: id });
    assert.equal(stillPaused.phase, 'paused');
    assert.equal(stillPaused.roundsStarted, paused.roundsStarted, 'Paused goal started another goal round');
    // An already admitted read round can make its tool-result model request
    // after pause. Verify goal rounds, rather than miscounting every HTTP call.
    for (const request of (await requests()).slice(pausedCount)) {
      const text = request.messages.findLast(message => message.role === 'user')?.content ?? '';
      const round = /^Continue the user goal \((\d+)\/(\d+)\):/u.exec(text);
      assert(round && Number(round[1]) <= paused.roundsStarted, 'Pause admitted an unclaimed goal round');
    }
    await button('Edit goal').click(); await page.getByRole('textbox', { name: 'Goal objective', exact: true }).fill('[fixture:read] Updated proof goal.');
    await button('Save goal').click(); await button('Resume goal').waitFor();
    assert.equal((await read('goals/get', { agentId: id })).objective, '[fixture:read] Updated proof goal.');
    await button('Resume goal').click(); await button('Pause goal').waitFor(); await button('Pause goal').click(); await button('Resume goal').waitFor();
    await button('Clear goal').click(); await button('Resume goal').waitFor({ state: 'hidden' });
    assert.equal(await read('goals/get', { agentId: id }), undefined);
  }],
  ['custom-model-reasoning-wire-and-persistence', async () => {
    await button(/^Select model/).click(); await page.getByText('This model provides no reasoning effort levels.', { exact: true }).waitFor(); await page.keyboard.press('Escape');
    await button('Settings').click(); await button('Models').click(); await button('Add model provider').click();
    await page.getByRole('textbox', { name: 'Provider ID', exact: true }).fill('pr15-reasoning');
    await page.getByRole('textbox', { name: 'Display name', exact: true }).fill('PR15 loopback reasoning');
    await page.getByRole('textbox', { name: 'Base URL', exact: true }).fill(fixture.providerOrigin);
    await page.getByLabel('API key', { exact: true }).fill('local-pr15-reasoning-only');
    await button('Add model').click(); await page.getByRole('textbox', { name: 'Model ID 1', exact: true }).fill('pr15-reasoner');
    await page.getByRole('button', { name: 'Model options 1', exact: true }).click();
    await page.getByRole('switch', { name: 'Reasoning levels 1', exact: true }).click();
    await button('Delete level off').click(); await button('Delete level medium').click();
    await button('Create provider').click(); await page.getByRole('textbox', { name: 'Provider ID', exact: true }).waitFor({ state: 'hidden' }); await button('Close').click();
    await button(/^Select model/).click(); const model = page.getByRole('menuitem', { name: /^Model/ }); if (await model.isVisible()) await model.click();
    await page.getByRole('menuitemradio', { name: 'pr15-reasoner', exact: true }).click();
    await page.getByRole('menuitemradio', { name: 'pr15-reasoner', exact: true }).waitFor({ state: 'hidden' });
    await button(/^Select model/).click(); await page.getByRole('menuitem', { name: /^Effort/ }).click(); await page.getByRole('menuitemradio', { name: 'high', exact: true }).click();
    await until(async () => (await read('session/projections', { request: { sessionId: id } })).values.modelSelection.next.reasoningEffort === 'high', 'Reasoning selection missing');
    const before = (await requests()).length; await prompt('PR15 reasoning high real HTTP request.');
    const actual = (await requests()).slice(before); assert(actual.length); assert(actual.every(request => request.model === 'pr15-reasoner' && request.reasoningEffort === 'high'));
    await page.reload(); await page.locator('[data-harness-controls]').waitFor(); await page.locator(`[data-row-key="session:${id}"]`).click();
    await button(/reasoning effort high$/).waitFor();
    await prompt('PR15 reasoning survives reload.'); assert.equal((await requests()).at(-1).reasoningEffort, 'high');
  }],
  ['new-session-control-isolation', async () => {
    await button('New session').click();
    await until(async () => (await read('session/list', { _request: {} })).items.some(item => item.blank && item.sessionId !== id), 'New session missing');
    const next = (await read('session/list', { _request: {} })).items.find(item => item.blank && item.sessionId !== id && item.cwd === fixture.cwd);
    assert(next); await page.locator(`[data-row-key="session:${next.sessionId}"]`).click();
    const state = await read('session/projections', { request: { sessionId: next.sessionId } });
    assert.equal(state.values.permissions.currentValue, 'workspace-write');
    assert.equal(state.values.modelSelection.next.reasoningEffort, undefined);
    assert.equal(state.values.plan.active, false); assert.equal(state.values.goal, null);
    await button('Access mode, current: Workspace Write').waitFor();
  }],
  ['automatic-context-checkpoint-keeps-history', async () => {
    // Return to the populated session through the native sidebar. All new
    // history below is sent through the actual composer, never seeded by RPC.
    await page.locator(`[data-row-key="session:${id}"]`).click();
    await prompt('BROWSER-CONTEXT-EARLY-FACT: the reconciliation key is invoiceId in src/reconcile.ts. Keep this decision.');
    const before = (await requests()).length;
    for (let round = 0; round < 3 && !(await requests()).slice(before).some(request => request.purpose === 'compaction'); round++) {
      await prompt('Investigate context history round ' + round + ': ' + 'ordinary coding observation '.repeat(1600) + 'End of observations.');
    }
    const automatic = (await requests()).slice(before).filter(request => request.purpose === 'compaction');
    assert(automatic.length > 0, 'Automatic compaction never ran without clicking Compact');
    assert(automatic.some(request => JSON.stringify(request.messages).includes('BROWSER-CONTEXT-EARLY-FACT')), 'Summary input lost the earlier decision');
    assert(automatic.every(request => !request.tools?.length && request.maxTokens <= 2048));
    await prompt('Continue coding using the earlier invoiceId decision.');
    const coding = (await requests()).at(-1);
    assert.equal(coding.purpose, 'coding'); assert(JSON.stringify(coding.messages).includes('invoiceId'));
    assert(!JSON.stringify(coding.messages).includes('Investigate context history round 0:'), 'Covered history was sent again');
    assert(await page.getByText('Output token limit reached', { exact: true }).isVisible(), 'Compaction deleted rendered original history');
    assert(!(await page.locator('body').innerText()).includes('deterministic local fixture handoff'), 'Private summary leaked into chat');
    await page.reload(); await page.locator('[data-harness-controls]').waitFor(); await page.locator(`[data-row-key="session:${id}"]`).click();
    await prompt('Continue using the persisted handoff after refresh.');
    assert(JSON.stringify((await requests()).at(-1).messages).includes('invoiceId'));
  }],
  ['pre-output-reset-recovers-real-write-once', async () => {
    await permission('Full access');
    const before = (await requests()).length;
    await prompt('[fixture:reset-before-output] Recover this actual HTTP interruption and write the proof once.');
    assert.equal(await readFile(join(fixture.cwd, 'browser-reset-recovered.txt'), 'utf8'), 'Actual recovered write exactly once\n');
    const actual = (await requests()).slice(before).filter(request => request.purpose === 'coding');
    assert.equal(actual.length, 3); assert.deepEqual(actual[0].messages, actual[1].messages);
    const lastUser = actual[2].messages.findLastIndex(message => message.role === 'user');
    const toolResults = actual[2].messages.slice(lastUser + 1).filter(message => message.role === 'tool'); assert.equal(toolResults.length, 1);
    await permission('Workspace Write');
  }],
];
try {
  for (const [name, operation] of cases) {
    await operation(); checks.push({ name, status: 'PASS' });
    await page.screenshot({ path: join(output, name + '.png'), fullPage: true });
    console.log(JSON.stringify({ name, status: 'PASS' }));
  }
  assert.deepEqual(errors, []); assert.deepEqual(rpc.externalRequests, []);
  assert(!await page.evaluate(() => document.documentElement.scrollWidth > innerWidth));
} catch (error) {
  failure = error.stack; await writeFile(join(output, 'failure-text.txt'), await page.locator('body').innerText().catch(() => 'Page unavailable'));
  if (id) {
    try {
      const state = await read('session/projections', { request: { sessionId: id } });
      failureState = { sessionId: id, permission: state.values.permissions?.currentValue,
        plan: state.values.harnessPlan === undefined ? undefined : { status: state.values.harnessPlan.status, revision: state.values.harnessPlan.revision },
        selectedRows: await page.locator('[data-row-key^="session:"][aria-selected="true"]').evaluateAll(rows => rows.map(row => row.getAttribute('data-row-key'))),
        pendingCommands: rpc.calls.filter(call => call.endpoint === 'commands/execute' && call.state === 'sent').length,
        asOfSeq: state.asOfSeq, turnBoundary: state.values.turnBoundary,
        goal: state.values.harnessGoal === null ? null : { phase: state.values.harnessGoal?.phase, roundsStarted: state.values.harnessGoal?.roundsStarted },
        permissionButtons: await page.getByRole('button', { name: /^Access mode, current:/ }).evaluateAll(buttons => buttons.map(button => ({ label: button.getAttribute('aria-label'), busy: button.getAttribute('aria-busy'), disabled: button.disabled }))),
        permissionFrames: permissionFrames.filter(frame => frame.sessionId === id).slice(-10),
        transportErrors: rpc.results.filter(result => result.ok === false).map(result => ({ endpoint: result.endpoint, error: result.error })) };
    } catch (diagnosticError) { failureState = { sessionId: id, unavailable: String(diagnosticError.message) }; }
  }
  await page.screenshot({ path: join(output, 'failure.png'), fullPage: true }).catch(() => {});
} finally {
  await rpc.settled();
  await writeFile(join(output, 'result.json'), JSON.stringify({ status: failure ? 'FAIL' : 'PASS', paidModelCalls: 0,
    scope: 'Real Chromium UI and production host with scripted loopback HTTP. Model quality is NOT_PROVEN.', checks,
    pending: cases.map(([name]) => name).filter(name => !checks.some(check => check.name === name)), errors,
    requests: (await requests()).map(request => ({ call: request.call, model: request.model, reasoningEffort: request.reasoningEffort })),
    rpc: { calls: rpc.calls, results: rpc.results, sockets: rpc.sockets, externalRequests: rpc.externalRequests }, permissionFrames, failureState, failure }, null, 2) + '\n');
  await browser.close();
}
if (failure) { console.error(failure); process.exitCode = 1; }
