#!/usr/bin/env node
/** Real daily UI operations. No response interception, direct mutation RPCs or paid provider. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createServer, connect } from 'node:net';
import { Transform } from 'node:stream';
import { mkdir, readFile, writeFile, unlink } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { observeProductionRpc } from '/workspace/harness-agent-web-interactions-20261016/scripts/research/deepseek-browser-observe.mjs';

const { values } = parseArgs({ options: {
  output: { type: 'string' }, 'fixture-script': { type: 'string' }, 'portable-root': { type: 'string' },
  'playwright-module': { type: 'string' }, chromium: { type: 'string', default: '/usr/bin/chromium' },
  cases: { type: 'string' }, viewports: { type: 'string', default: 'desktop' },
} });
for (const key of ['output', 'playwright-module']) assert(values[key], 'Missing --' + key);
const output = path.resolve(values.output), fixtureRoot = path.join(output, 'fixture'), evidence = path.join(fixtureRoot, 'evidence');
await mkdir(output, { recursive: true });
let upstream;
let transportLatency = 0;
const connections = new Set();
// Transparent TCP forwarding delays real bytes in order, including existing
// WebSockets (CDP HTTP throttling alone does not delay established WS frames).
// No HTTP/RPC payload is parsed, intercepted, substituted or fabricated.
const relay = createServer(socket => {
  const peer = connect(Number(upstream.port || 80), upstream.hostname);
  connections.add(socket); connections.add(peer);
  const delay = () => new Transform({ transform(bytes, _encoding, done) {
    if (transportLatency) setTimeout(() => done(null, bytes), transportLatency); else done(null, bytes);
  } });
  socket.pipe(delay()).pipe(peer); peer.pipe(delay()).pipe(socket);
  for (const [from, to] of [[socket, peer], [peer, socket]]) {
    from.on('error', () => to.destroy()); from.on('close', () => { connections.delete(from); to.destroy(); });
  }
});
await new Promise((resolve, reject) => { relay.once('error', reject); relay.listen(0, '127.0.0.1', resolve); });
const origin = `http://127.0.0.1:${relay.address().port}`;
// Use the production server's explicit reverse-proxy allowlist for this ONE
// owned loopback authority. Do not disable its Host/Origin checks or add '*'.
const fixtureScript = values['fixture-script'] ?? '/workspace/harness-agent-web-interactions-20261016/scripts/research/deepseek-live-host.mjs';
const hostArgs = [fixtureScript, '--root', fixtureRoot, '--preflight-owner', '--ipc-control'];
if (values['portable-root']) hostArgs.push('--portable-root', path.resolve(values['portable-root']));
const host = spawn(process.execPath, hostArgs, {
  env: { ...process.env, HARNESS_WEB_ALLOWED_HOSTS: new URL(origin).host }, stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
});
let hostOut = '', hostErr = '';
const hostExit = new Promise((resolve, reject) => { host.once('error', reject); host.once('close', (code, signal) => resolve({ code, signal })); });
const deadline = (promise, ms, message) => new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(Error(message)), ms);
  promise.then(value => { clearTimeout(timer); resolve(value); }, error => { clearTimeout(timer); reject(error); });
});
try {
  upstream = new URL(await deadline(new Promise((resolve, reject) => {
    host.stdout.on('data', bytes => { hostOut += bytes; const match = hostOut.match(/http:\/\/127\.0\.0\.1:\d+/); if (match) resolve(match[0]); });
    host.stderr.on('data', bytes => { hostErr += bytes; });
    hostExit.then(exit => reject(Error('Fixture exited before readiness: ' + JSON.stringify(exit))), reject);
  }), 60000, 'Fixture readiness timed out'));
} catch (error) {
  host.kill('SIGTERM'); for (const socket of connections) socket.destroy(); relay.close(); throw error;
}
assert.equal(upstream.protocol, 'http:'); assert.equal(upstream.hostname, '127.0.0.1');
const fixture = JSON.parse(await readFile(path.join(evidence, 'launch.json'), 'utf8'));
const fixtureRelative = path.relative(fixtureRoot, path.resolve(fixture.cwd));
assert(fixtureRelative && !path.isAbsolute(fixtureRelative) && fixtureRelative !== '..' && !fixtureRelative.startsWith('..' + path.sep)
  && path.basename(fixture.cwd) === 'project', 'Fixture workspace must remain in this owned acceptance directory');
assert.equal(fixture.paidModelCalls, 0); assert.equal(fixture.model, 'web-loopback-fixture');
assert.equal(new URL(fixture.providerOrigin).hostname, '127.0.0.1'); assert.equal(new URL(origin).hostname, '127.0.0.1');
const catalog = { desktop: { width: 1440, height: 900 }, mobile: { width: 390, height: 844 }, narrow: { width: 320, height: 1100 } };
const viewports = values.viewports.split(','); for (const name of viewports) assert(catalog[name], 'Unknown viewport');
const chosen = values.cases && new Set(values.cases.split(','));
const { chromium } = await import(pathToFileURL(path.resolve(values['playwright-module'])).href);
const browser = await chromium.launch({ headless: true, executablePath: values.chromium, args: ['--no-sandbox'] });
await mkdir(output, { recursive: true });
const results = [], observations = new WeakMap();
const composer = page => page.locator('[data-composer-input=true][contenteditable=true]').filter({ visible: true });
const panel = page => page.locator('[data-harness-coding="panel"]');
const button = (page, name) => page.getByRole('button', { name, exact: true }).filter({ visible: true });
const check = (checks, label, detail) => checks.push({ label, status: 'PASS', ...(detail ? { detail } : {}) });
async function sidebar(page) { const open = button(page, 'Open sidebar'); if (await open.isVisible()) await open.click(); }
async function collapseMobile(page) {
  if (page.viewportSize().width >= 700) return;
  const close = button(page, 'Collapse sidebar');
  if (await close.isVisible()) {
    try { await close.click(); }
    catch (error) {
      // Navigation can finish its own responsive collapse after this visibility
      // read. Accept only that observed postcondition, never a missed action.
      if (!await button(page, 'Open sidebar').isVisible()) throw error;
    }
  }
}
async function boot(page) {
  await page.goto(origin, { waitUntil: 'domcontentloaded' });
  await button(page, 'Choose workspace').waitFor({ timeout: 15000 }); await button(page, 'Choose workspace').click();
  await page.getByRole('menuitem', { name: 'project', exact: true }).click();
  await composer(page).waitFor({ timeout: 10000 });
}
async function finished(page) {
  await page.getByRole('heading', { name: 'Actual Harness browser answer', exact: true }).last().waitFor({ timeout: 15000 });
  await page.locator('pre code').filter({ hasText: 'export const value = 1;' }).last().waitFor({ timeout: 15000 });
  await button(page, 'Stop generating').waitFor({ state: 'hidden', timeout: 15000 });
}
async function send(page, text) {
  await composer(page).fill(text); const wait = observations.get(page).waitForResult('session/prompt');
  await button(page, 'Send message').click(); const response = await wait;
  if (response.error) throw response.error; assert.equal(response.result.ok, true, JSON.stringify(response.result));
  return observations.get(page).results.filter(result => result.endpoint === 'session/create' && result.ok).at(-1)?.value?.sessionId;
}
async function newSession(page) {
  await sidebar(page); await button(page, 'New session').last().click(); await collapseMobile(page);
  await page.getByText('Into the Unknown', { exact: true }).waitFor(); await composer(page).waitFor();
}
async function openPanel(page) {
  await panel(page).locator('#launch').click(); await panel(page).locator('#session option').first().waitFor({ state: 'attached' });
}
async function selectPanel(page, id) {
  assert(id, 'The actual create result must name the selected session');
  const p = panel(page); await p.locator('#session').selectOption(id);
  await p.locator('#refresh').click();
  await p.locator('#state').filter({ hasText: /Task ended|Not started|任务已结束|未开始/ }).waitFor({ timeout: 10000 });
}
async function latency(context, page, action) {
  transportLatency = 350;
  try { return await action(); } finally { transportLatency = 0; }
}
async function shortcuts(page) {
  await sidebar(page); await button(page, 'Settings').click(); await button(page, 'General').click();
  await button(page, 'Edit shortcuts').click(); return page.getByRole('dialog', { name: 'Keyboard shortcuts', exact: true });
}
async function bindNewSession(page) {
  const d = await shortcuts(page);
  await d.getByRole('searchbox', { name: 'Search shortcuts', exact: true }).fill('New Session');
  await d.getByRole('button', { name: 'Edit shortcut for New Session', exact: true }).click();
  await d.getByRole('button', { name: 'Press a shortcut', exact: true }).click(); await page.keyboard.press('Control+Shift+,');
  await d.getByRole('button', { name: 'Close keyboard shortcuts', exact: true }).click();
  // Capture completion can close the inline editor before this click; inspect
  // the real remaining modal rather than clicking an already dismissed one.
  if (await d.isVisible()) await d.getByRole('button', { name: 'Close keyboard shortcuts', exact: true }).click();
  await page.getByRole('dialog', { name: 'Settings', exact: true }).getByRole('button', { name: 'Close', exact: true }).click();
  await collapseMobile(page);
}
async function feedbackDialog(page, text, category) {
  const d = page.getByRole('dialog', { name: 'Submit feedback', exact: true }); await d.waitFor();
  if (category) await d.getByRole('button', { name: category, exact: true }).click();
  if (text) await d.getByRole('textbox', { name: 'Feedback details', exact: true }).fill(text);
  await d.getByRole('button', { name: 'Submit', exact: true }).click(); await d.waitFor({ state: 'hidden' });
}
async function readMetadata(id) {
  const data = path.resolve(fixture.cwd, '../data'), index = JSON.parse(await readFile(path.join(data, 'deepseek/owners-index.json'), 'utf8'));
  for (const base of [data, ...index.owners.map(owner => { assert(/^[a-f0-9]{64}$/.test(owner.id)); return path.join(data, 'deepseek/owners', owner.id); })]) {
    let document; try { document = JSON.parse(await readFile(path.join(base, 'deepseek/session-metadata.json'), 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    if (document.sessions[id]) return document.sessions[id];
  }
  throw new Error('No real durable metadata for selected session');
}
const cases = {
  'navigation-draft-ownership': async (page, context, checks) => {
    const title = 'Daily navigation ' + Date.now(); await send(page, title); await finished(page);
    await composer(page).fill('PRIVATE_EXISTING_TASK_DRAFT');
    await sidebar(page);
    await latency(context, page, async () => {
      await button(page, 'New session').last().click(); await collapseMobile(page);
      await composer(page).fill('PASTED_AFTER_NEW_SESSION'); await page.getByText('Into the Unknown', { exact: true }).waitFor();
      assert.equal(await composer(page).innerText(), 'PASTED_AFTER_NEW_SESSION', 'New-task paste was lost or assigned to the previous session');
    });
    check(checks, 'A paste immediately after New Session belongs to the new task under real network latency');
    await sidebar(page); await page.getByText(title, { exact: true }).first().click(); await collapseMobile(page); await finished(page);
    assert.equal(await composer(page).innerText(), 'PRIVATE_EXISTING_TASK_DRAFT');
    check(checks, 'Returning to the previous task preserves its independent composer draft');
  },
  'coding-draft-ownership': async (page, context, checks) => {
    const a = 'Panel A ' + Date.now(), b = 'Panel B ' + Date.now();
    const aId = await send(page, a); await finished(page); await newSession(page); const bId = await send(page, b); await finished(page);
    await openPanel(page); await selectPanel(page, aId); const p = panel(page);
    await p.locator('#prompt').fill('ONLY_A_DRAFT'); await selectPanel(page, bId);
    assert.equal(await p.locator('#prompt').inputValue(), '', 'A private coding draft leaked into B');
    assert.equal(await p.locator('#continue').isDisabled(), true); check(checks, 'Empty coding draft cannot submit');
    await p.locator('#prompt').fill('ONLY_B_DRAFT'); await selectPanel(page, aId);
    assert.equal(await p.locator('#prompt').inputValue(), 'ONLY_A_DRAFT'); check(checks, 'A/B coding panel drafts remain separate through selection');
    await p.locator('#close').click(); await openPanel(page); assert.equal(await p.locator('#prompt').inputValue(), 'ONLY_A_DRAFT');
    check(checks, 'Closing and reopening the coding dialog retains its selected session draft');
  },
  'feedback-roundtrip': async (page, context, checks) => {
    await send(page, 'Feedback target ' + Date.now()); await finished(page);
    const id = observations.get(page).results.filter(r => r.endpoint === 'session/create' && r.ok).at(-1)?.value?.sessionId; assert(id);
    await button(page, 'Good response').click(); await feedbackDialog(page);
    await button(page, 'Remove rating').waitFor(); assert.equal(await button(page, 'Remove rating').getAttribute('aria-pressed'), 'true');
    check(checks, 'A real positive rating submission updates its assistant control');
    await button(page, 'Remove rating').click(); await button(page, 'Good response').waitFor();
    assert.equal(await button(page, 'Good response').getAttribute('aria-pressed'), 'false'); check(checks, 'Clicking the recorded rating retracts it');
    await button(page, 'Bad response').click(); await feedbackDialog(page, 'LOCAL_UI_RATING_NOTE', 'Task result');
    await button(page, 'Remove rating').waitFor(); await page.reload(); await button(page, 'Bad response').waitFor({ timeout: 15000 });
    // The shipped component intentionally loads ratings on pointer/focus, not on mount.
    await button(page, 'Bad response').hover(); await button(page, 'Remove rating').waitFor();
    assert.equal(await button(page, 'Remove rating').getAttribute('aria-pressed'), 'true'); check(checks, 'A persisted negative rating is restored on the actual lazy hover after reload');
    await button(page, 'More actions').click(); await page.getByRole('menuitem', { name: 'Feedback', exact: true }).click();
    await feedbackDialog(page, 'LOCAL_UI_SESSION_NOTE', 'Product features and interaction');
    const stored = await readMetadata(id);
    assert.equal(stored.feedback.filter(e => e.kind === 'message-put').at(-1).item.note, 'LOCAL_UI_RATING_NOTE');
    assert(stored.feedback.some(e => e.kind === 'message-delete')); assert.equal(stored.feedback.at(-1).text, 'LOCAL_UI_SESSION_NOTE');
    check(checks, 'Message put/delete and session remark exist in actual controlled durable metadata');
  },
  'coding-modal-keyboard': async (page, context, checks) => {
    await send(page, 'Modal keyboard task ' + Date.now()); await finished(page); await bindNewSession(page);
    await openPanel(page); const p = panel(page); await p.locator('#prompt').click(); await p.locator('#prompt').fill('MODAL_PRIVATE_DRAFT');
    const rpc = observations.get(page), before = rpc.calls.filter(c => c.endpoint === 'session/create').length, title = await page.title();
    await page.keyboard.press('Control+Shift+,'); await page.waitForTimeout(500);
    assert.equal(rpc.calls.filter(c => c.endpoint === 'session/create').length, before, 'A global shortcut created a hidden session behind the native dialog');
    assert.equal(await page.title(), title); assert.equal(await p.locator('#prompt').inputValue(), 'MODAL_PRIVATE_DRAFT');
    check(checks, 'An assigned New Session shortcut cannot navigate behind the open coding dialog');
    await page.keyboard.press('Escape'); await p.locator('dialog').waitFor({ state: 'hidden' });
    await page.keyboard.press('Control+Shift+,'); await page.getByText('Into the Unknown', { exact: true }).waitFor();
    assert.equal(rpc.calls.filter(c => c.endpoint === 'session/create').length, before + 1);
    check(checks, 'Escape closes the native dialog and the global shortcut works again');
  },
  'coding-diff-ownership': async (page, context, checks) => {
    // Each viewport must start with an actual new file change. The fixture is
    // shared by these cases, so a prior identical write would have no diff.
    try { await unlink(path.join(fixture.cwd, 'browser-created.txt')); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    const a = '[fixture:write] Diff owner A ' + Date.now(), b = 'Diff owner B ' + Date.now();
    const aId = await send(page, a); await button(page, 'Allow once').waitFor({ timeout: 10000 }); await button(page, 'Allow once').click(); await finished(page);
    assert.equal(await readFile(path.join(fixture.cwd, 'browser-created.txt'), 'utf8'), 'Actual approved browser coding output\n');
    await newSession(page); const bId = await send(page, b); await finished(page); await openPanel(page); await selectPanel(page, aId); const p = panel(page);
    await p.locator('#diff:not(:disabled)').waitFor({ timeout: 10000 });
    await latency(context, page, async () => {
      const response = page.waitForResponse(r => new URL(r.url()).pathname === '/api/changes.summary').then(value => ({ value }), error => ({ error }));
      await p.locator('#diff').click(); await selectPanel(page, bId); const result = await response;
      if (result.error) throw result.error; await result.value.finished(); await page.waitForTimeout(500);
      assert.equal(await p.locator('#changes').isVisible(), false, 'The previous session diff was rendered in the new selection');
    });
    check(checks, 'A real delayed diff response cannot render into another selected coding session');
    await selectPanel(page, aId); await p.locator('#diff').click(); await p.locator('#changes').filter({ hasText: 'browser-created.txt' }).waitFor({ timeout: 10000 });
    check(checks, 'Selecting the original owner still displays its actual captured diff');
  },
  'session-reference-menu': async (page, context, checks) => {
    const title = 'Reference UI source ' + Date.now(), nickname = 'R' + Date.now();
    await send(page, title + ' PRIOR_UI_DECISION_SENTINEL'); await finished(page); await sidebar(page);
    const sourceRow = page.locator('[data-row-key^="session:"][aria-selected="true"]');
    await sourceRow.hover(); await sourceRow.getByRole('button', { name: /^Session actions for / }).click();
    await page.getByRole('menuitem', { name: 'Rename', exact: true }).click();
    await page.getByRole('textbox', { name: 'Session name', exact: true }).fill(nickname); await button(page, 'Rename').click();
    await sourceRow.getByText(nickname, { exact: true }).waitFor(); await collapseMobile(page);
    await newSession(page); const input = composer(page); await input.fill('@' + nickname);
    const option = page.getByRole('option').filter({ hasText: nickname }); await option.waitFor({ timeout: 10000 }); await option.click();
    assert((await input.innerText()).includes(nickname)); check(checks, 'The actual @ menu discovers a renamed authorized session and inserts its real reference chip');
    await input.press('End'); await input.pressSequentially(' Continue the referenced coding decision.'); await button(page, 'Send message').click(); await finished(page);
    const requests = (await readFile(path.join(evidence, 'requests.jsonl'), 'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse);
    const received = requests.filter(request => request.messages.some(message => message.role === 'user'
      && typeof message.content === 'string' && message.content.includes('Continue the referenced coding decision.')));
    assert(received.length); const actual = JSON.stringify(received.at(-1).messages);
    assert(actual.includes('PRIOR_UI_DECISION_SENTINEL')); assert(actual.includes('untrusted read-only historical context'));
    check(checks, 'Submitting the real reference chip supplies an actual bounded read-only source snapshot to the real HTTP provider');
    assert(!(await page.locator('body').innerText()).includes('[Referenced sessions: untrusted'));
    await page.reload(); await finished(page); assert(!(await page.locator('body').innerText()).includes('[Referenced sessions: untrusted'));
    await newSession(page); await composer(page).fill('@Continue');
    const nested = page.getByRole('option').filter({ hasText: '@' + nickname }).filter({ hasText: 'Continue the referenced coding decision.' });
    await nested.waitFor(); assert(!(await nested.innerText()).includes('[Referenced'));
    await page.keyboard.press('Escape');
    check(checks, 'Conversation, reload and later reference candidates show readable user text without internal snapshot markers');
  },
  'presentation-controls': async (page, context, checks) => {
    const text = 'Presentation controls [fixture:read] ' + Date.now(); await send(page, text); await finished(page);
    const copies = page.getByRole('button', { name: /^(Copy|Copied)$/ }), copied = [];
    // Turn completion and its footer can arrive in separate WS frames. Wait
    // for the third real control instead of sampling a transient button count.
    await copies.nth(2).waitFor();
    assert.equal(await copies.count(), 3);
    for (let i = 0; i < 3; i++) {
      await copies.nth(i).click();
      await page.waitForFunction(async ({ index, text }) => {
        const value = await navigator.clipboard.readText();
        return index === 0 ? value === text : index === 1 ? value.trim() === 'export const value = 1;' : value.startsWith('# Actual Harness browser answer');
      }, { index: i, text });
      copied.push(await page.evaluate(() => navigator.clipboard.readText()));
    }
    assert.equal(copied[0], text); assert.equal(copied[1].trim(), 'export const value = 1;'); assert(copied[2].startsWith('# Actual Harness browser answer'));
    check(checks, 'User, code block and assistant copy buttons put their distinct actual contents on the clipboard');
    await button(page, 'Wrap lines').click(); await button(page, 'Wrap lines').click();
    await button(page, 'Usage 124 tok').click(); const usage = await page.getByRole('dialog').last().innerText();
    assert(usage.includes('openai/web-loopback-fixture') && usage.includes('64 tok') && usage.includes('60 tok'));
    await page.keyboard.press('Escape'); check(checks, 'Actual per-turn usage popover displays the executed provider and token totals');
    await page.getByRole('tab', { name: 'Trajectory', exact: true }).click();
    assert((await page.locator('body').innerText()).includes('read_file{"path":"demo.js"}'));
    await page.getByRole('tab', { name: 'Chat', exact: true }).click(); await finished(page);
    check(checks, 'Trajectory and Chat tabs retain the actual read tool and conversation');
  },
  'input-queue-stop': async (page, context, checks) => {
    const rpc = observations.get(page), before = rpc.calls.filter(c => c.endpoint === 'session/prompt').length, input = composer(page);
    await input.click(); await input.fill('Line one'); await input.press('Shift+Enter'); await input.pressSequentially('Line two');
    assert.equal(await input.innerText(), 'Line one\nLine two'); assert.equal(rpc.calls.filter(c => c.endpoint === 'session/prompt').length, before);
    check(checks, 'Shift+Enter inserts a real newline without submitting a task');
    await input.fill('[fixture:slow] RUNNING_QUEUE_STOP_' + Date.now()); await input.press('Enter'); await input.press('Enter');
    await button(page, 'Stop generating').waitFor({ timeout: 10000 });
    assert.equal(rpc.calls.filter(c => c.endpoint === 'session/prompt').length, before + 1);
    check(checks, 'Immediate repeated Enter admits one actual running task');
    await input.fill('QUEUED_DAILY_FOLLOWUP'); await button(page, 'Queue message').click();
    await input.fill('UNSENT_DRAFT_SURVIVES_STOP');
    const cancelled = rpc.waitForResult('session/cancel'); await input.press('Escape'); await input.press('Escape');
    const response = await cancelled; if (response.error) throw response.error; assert.equal(response.result.ok, true);
    await button(page, 'Stop generating').waitFor({ state: 'hidden', timeout: 15000 });
    assert.equal(await input.innerText(), 'UNSENT_DRAFT_SURVIVES_STOP');
    assert.equal(rpc.calls.filter(c => c.endpoint === 'session/prompt').length, before + 2);
    check(checks, 'Queue submits once; double Escape reaches real cancellation and retains unsent input');
  },
  'attachment-add-remove-submit': async (page, context, checks) => {
    const filename = 'daily-upload-' + Date.now() + '.txt', file = path.join(fixture.cwd, filename);
    await writeFile(file, 'ACTUAL_DAILY_UPLOADED_CONTEXT\n');
    async function attach() {
      await button(page, 'Add files or run commands').click();
      const chooser = page.waitForEvent('filechooser').then(value => ({ value }), error => ({ error }));
      await page.getByRole('option', { name: 'File', exact: true }).click(); const result = await chooser;
      if (result.error) throw result.error; await result.value.setFiles(file); await button(page, 'Remove file ' + filename).waitFor({ timeout: 10000 });
    }
    await attach(); await button(page, 'Remove file ' + filename).click(); await button(page, 'Remove file ' + filename).waitFor({ state: 'hidden' });
    assert.equal(await button(page, 'Send message').isDisabled(), true); check(checks, 'Removing a selected file restores an empty unsent composer');
    await attach(); await composer(page).fill('Use the attached daily file.');
    await button(page, 'Send message').click({ timeout: 10000 }); await finished(page);
    const requests = (await readFile(path.join(evidence, 'requests.jsonl'), 'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse);
    assert(requests.some(r => r.messages.some(m => m.role === 'user' && String(m.content).includes('ACTUAL_DAILY_UPLOADED_CONTEXT'))));
    check(checks, 'Reattaching and submitting supplies actual authorized UTF-8 file contents to the production model request');
  },
  'files-and-panel-layout': async (page, context, checks) => {
    await button(page, 'Open right sidebar').click(); await page.getByRole('button', { name: /^Workspace files/ }).click();
    await page.getByText('demo.js', { exact: true }).dblclick();
    await page.getByRole('tab', { name: /demo\.js/ }).waitFor();
    await page.getByText('export const value = 1;', { exact: false }).waitFor();
    check(checks, 'A real file tree double-click opens a separate actual content preview tab');
    await button(page, 'Line wrap').click(); await button(page, 'Read the file again').click();
    if (await button(page, 'Fullscreen').isVisible()) { await button(page, 'Fullscreen').click(); await button(page, 'Exit fullscreen').click(); }
    else { await button(page, 'Exit fullscreen').click(); await button(page, 'Open right sidebar').click(); }
    let panes = 1;
    if (await button(page, 'Split').isEnabled()) {
      await button(page, 'Split').click();
      // Split creates an empty second pane, which a user then fills from Start.
      await page.getByRole('button', { name: /^Workspace files/ }).last().click();
      // Resources are globally deduplicated; use a different file to populate
      // the new pane instead of expecting a duplicate tab for the same URI.
      await page.getByText('README.md', { exact: true }).last().dblclick();
      await page.getByRole('tab', { name: /README\.md/ }).waitFor(); panes = 2;
    }
    else assert(page.viewportSize().width < 700, 'Desktop split should be available');
    assert.equal(await page.getByRole('tab', { name: /demo\.js/ }).count(), 1);
    assert.equal(await page.getByRole('tab', { name: /README\.md/ }).count(), panes - 1);
    check(checks, 'Preview wrap/reload, fullscreen restore and available split controls remain reachable', { panes });
    await button(page, 'Collapse right sidebar').click(); await button(page, 'Open right sidebar').click();
    assert.equal(await page.getByRole('tab', { name: /demo\.js/ }).count(), 1);
    assert.equal(await page.getByRole('tab', { name: /README\.md/ }).count(), panes - 1);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    check(checks, 'Closing/reopening the sidebar retains its preview panes without page-wide horizontal overflow');
  },
  'shortcuts-persist-conflict-reset': async (page, context, checks) => {
    await bindNewSession(page); await page.reload(); await composer(page).waitFor({ timeout: 15000 });
    const rpc = observations.get(page), before = rpc.calls.filter(c => c.endpoint === 'session/create').length;
    await page.keyboard.press('Control+Shift+,'); await page.getByText('Into the Unknown', { exact: true }).waitFor();
    assert.equal(rpc.calls.filter(c => c.endpoint === 'session/create').length, before + 1);
    check(checks, 'An edited shortcut persists through real reload and actually creates one new session');
    const d = await shortcuts(page); await d.getByRole('searchbox', { name: 'Search shortcuts', exact: true }).fill('Toggle left sidebar');
    await d.getByRole('button', { name: 'Edit shortcut for Toggle left sidebar', exact: true }).click();
    await d.getByRole('button', { name: 'Press a shortcut', exact: true }).click(); await page.keyboard.press('Control+Shift+,');
    await d.getByText(/Already used by.*New Session/).waitFor(); check(checks, 'An actual conflicting shortcut is rejected with its existing command name');
    await d.getByRole('button', { name: 'Close keyboard shortcuts', exact: true }).click();
    await d.getByRole('button', { name: 'Restore all defaults', exact: true }).click();
    const confirm = page.getByRole('dialog', { name: 'Restore all default shortcuts?', exact: true });
    await confirm.getByRole('button', { name: 'Restore default', exact: true }).click(); await confirm.waitFor({ state: 'hidden' });
    await d.getByRole('button', { name: 'Close keyboard shortcuts', exact: true }).click();
    await page.getByRole('dialog', { name: 'Settings', exact: true }).getByRole('button', { name: 'Close', exact: true }).click();
    await collapseMobile(page); const resetBefore = rpc.calls.filter(c => c.endpoint === 'session/create').length;
    await page.keyboard.press('Control+Shift+,'); await page.waitForTimeout(400);
    assert.equal(rpc.calls.filter(c => c.endpoint === 'session/create').length, resetBefore);
    check(checks, 'Confirmed restore removes the custom command binding without a hidden navigation');
  },
  'settings-font-and-locale': async (page, context, checks) => {
    await sidebar(page); await button(page, 'Settings').click(); await button(page, 'General').click();
    await button(page, 'Increase font size').click();
    await page.waitForFunction(() => document.body.style.getPropertyValue('--dsh-content-font-size') === '15px');
    await button(page, 'Decrease font size').click();
    await page.waitForFunction(() => document.body.style.getPropertyValue('--dsh-content-font-size') === '14px');
    check(checks, 'Font increase/decrease updates the actual conversation layout variable');
    transportLatency = 350;
    await button(page, 'English').click(); await page.getByRole('menuitem', { name: '中文', exact: true }).click();
    await page.waitForFunction(() => document.documentElement.lang === 'zh-CN');
    assert.equal(await page.evaluate(() => document.documentElement.lang), 'zh-CN');
    transportLatency = 0;
    await button(page, '关闭').click(); await collapseMobile(page);
    await panel(page).locator('#launch').click(); const p = panel(page);
    assert.equal(await p.locator('#launch').getAttribute('aria-label'), '打开编码状态');
    assert.equal(await p.locator('dialog').getAttribute('aria-label'), 'Harness 编码状态');
    assert(await p.locator('dialog').evaluate(e => { const r = e.getBoundingClientRect(); return r.left >= 0 && r.right <= innerWidth; }));
    await page.keyboard.press('Escape'); check(checks, 'The actual language setting localizes the coding dialog and its narrow-screen modal fits');
    transportLatency = 350;
    const open = button(page, '打开侧边栏'); if (await open.isVisible()) await open.click();
    await button(page, '设置').click(); await button(page, '通用设置').click(); await button(page, '中文').click();
    await page.getByRole('menuitem', { name: 'English', exact: true }).click();
    await page.waitForFunction(() => document.documentElement.lang === 'en');
    assert.equal(await page.evaluate(() => document.documentElement.lang), 'en');
    transportLatency = 0;
    await button(page, 'Close').click(); await collapseMobile(page);
    assert.equal(await panel(page).locator('#launch').getAttribute('aria-label'), 'Open coding status');
    check(checks, 'Returning to English updates native and shadow components together');
  },
  'capabilities-and-task-filters': async (page, context, checks) => {
    await sidebar(page); await button(page, 'Settings').click(); await button(page, 'General').click();
    await button(page, 'Increase font size').waitFor();
    assert.equal(await button(page, 'Open configuration file').count(), 0);
    check(checks, 'A Web host without a native configuration opener does not advertise that unavailable action');
    await button(page, 'Close').click(); await button(page, 'Plugins').click();
    await button(page, 'Add plugin').waitFor(); assert.equal(await button(page, 'Add plugin').isDisabled(), true);
    assert((await page.locator('body').innerText()).includes('without a manageable profile'));
    check(checks, 'Unavailable plugin installation is disabled with the actual host capability explanation');
    await button(page, 'Automation tasks').click(); await page.locator('input[aria-label="Search tasks"]').waitFor();
    await button(page, 'Enabled').click(); await button(page, 'Inactive').click(); await button(page, 'All').click();
    check(checks, 'The real automation catalog responds to its three list filters without inventing an installed plugin');
  },
  'sidebar-pin-search-filters': async (page, context, checks) => {
    const text = 'PIN_SEARCH_DAILY_' + Date.now(); await send(page, text); await finished(page); await sidebar(page);
    const selected = page.locator('[data-row-key^="session:"][aria-selected="true"]'); const key = await selected.getAttribute('data-row-key'); assert(key);
    async function actions() { const row = page.locator('[data-row-key="' + key + '"]'); await row.hover(); await row.getByRole('button', { name: /^Session actions for / }).click(); }
    await actions(); await page.getByRole('menuitem', { name: 'Pin session', exact: true }).click();
    // The menu closes before the asynchronous mutation. A confirmed pin is
    // visible through the inverse row action only after the real host reply.
    await page.locator('[data-row-key="' + key + '"]').hover();
    await page.locator('[data-row-key="' + key + '"]').getByRole('button', { name: 'Unpin session', exact: true }).waitFor();
    await page.reload();
    await composer(page).waitFor({ timeout: 15000 }); await sidebar(page); await actions();
    await page.getByRole('menuitem', { name: 'Unpin session', exact: true }).waitFor(); await page.keyboard.press('Escape');
    check(checks, 'Pinning a real selected session survives reload and exposes its inverse action');
    await button(page, 'Search sessions').click(); await page.getByPlaceholder('Search session names', { exact: true }).fill(text);
    await page.getByRole('treeitem').filter({ hasText: text }).waitFor(); await page.keyboard.press('Escape');
    check(checks, 'The actual session search finds the matching named session');
    await button(page, 'View options').click(); await page.getByRole('menuitem', { name: 'Archived only', exact: true }).click();
    await page.locator('[data-row-key="' + key + '"]').waitFor({ state: 'hidden' });
    await button(page, 'View options').click(); await page.getByRole('menuitem', { name: 'Hide archived', exact: true }).click();
    await page.locator('[data-row-key="' + key + '"]').waitFor(); await actions(); await page.getByRole('menuitem', { name: 'Unpin session', exact: true }).click();
    await page.locator('[data-row-key="' + key + '"]').hover();
    await page.locator('[data-row-key="' + key + '"]').getByRole('button', { name: 'Pin session', exact: true }).waitFor();
    check(checks, 'Archive filtering hides/restores active sessions and Unpin reaches its real owner');
  },
};
try {
  if (chosen) for (const name of chosen) assert(Object.hasOwn(cases, name), 'Unknown case: ' + name);
  for (const viewport of viewports) for (const [name, run] of Object.entries(cases)) {
    if (chosen && !chosen.has(name)) continue;
    const context = await browser.newContext({ viewport: catalog[viewport], permissions: ['clipboard-read', 'clipboard-write'] });
    const page = await context.newPage(); page.setDefaultTimeout(6000);
    const rpc = observeProductionRpc(page, origin); observations.set(page, rpc);
    const errors = [], assets = [], checks = []; let failure;
    page.on('pageerror', error => errors.push({ type: 'pageerror', message: error.message }));
    page.on('console', message => { if (message.type() === 'error') errors.push({ type: 'console', message: message.text() }); });
    page.on('response', response => { if (new URL(response.url()).origin === origin && /(?:coding-workflow|harness-brand).*\.js/.test(response.url())) assets.push({ path: new URL(response.url()).pathname, status: response.status() }); });
    try { await boot(page); await run(page, context, checks); }
    catch (error) { failure = error.stack; }
    await rpc.settled();
    const unexpected = rpc.results.filter(result => result.ok === false && !result.expected);
    if (!failure && (errors.length || unexpected.length || rpc.externalRequests.length)) failure = 'Unexpected actual browser, RPC or external request errors';
    const screenshot = viewport + '-' + name + '.png'; await page.screenshot({ path: path.join(output, screenshot), fullPage: true });
    const result = { name, viewport, status: failure ? 'FAIL' : 'PASS', checks, failure, errors, calls: rpc.calls, results: rpc.results,
      sockets: rpc.sockets, externalRequests: rpc.externalRequests, assets, screenshot, visibleText: await page.locator('body').innerText() };
    results.push(result); await writeFile(path.join(output, viewport + '-' + name + '.json'), JSON.stringify(result, null, 2) + '\n');
    console.log(JSON.stringify({ name, viewport, status: result.status, checks: checks.length, failure: failure?.split('\n')[0] }));
    await context.close();
  }
} finally {
  await browser.close(); for (const socket of connections) socket.destroy(); await new Promise(resolve => relay.close(resolve));
  if (host.connected) host.send({ type: 'fixture-stop' });
  const exit = await deadline(hostExit, 15000, 'Owned production fixture did not stop');
  await writeFile(path.join(output, 'host-logs.json'), JSON.stringify({ stdout: hostOut, stderr: hostErr, exit }, null, 2) + '\n');
  assert.equal(exit.code, 0, 'Actual production fixture shutdown must complete');
}
const report = { status: results.length && results.every(r => r.status === 'PASS') ? 'PASS' : 'FAIL', paidModelCalls: 0,
  origin, upstreamOrigin: upstream.origin, latency: '350 ms per actual TCP chunk in each direction, only during named race scenarios', fixture: {
    launchId: fixture.launchId, compiledDigest: fixture.compiledDigest, installed: fixture.installed, sourceSha: fixture.sourceSha },
  driverSha256: createHash('sha256').update(await readFile(new URL(import.meta.url))).digest('hex'),
  engine: { node: process.version, chromium: browser.version(), viewportScope: 'Desktop Chromium responsive sizes; no physical mobile or Windows claim' },
  scope: 'Named daily production UI interactions only; not a claim that every visible control is implemented or verified', results };
await writeFile(path.join(output, 'result.json'), JSON.stringify(report, null, 2) + '\n');
if (report.status !== 'PASS') process.exitCode = 1;
