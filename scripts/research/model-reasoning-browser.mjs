#!/usr/bin/env node
/** Native model form -> production settings -> real loopback HTTP. No UI/RPC mocks. */
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { createHash, randomUUID } from 'node:crypto';
import { observeProductionRpc } from './deepseek-browser-observe.mjs';
const { values } = parseArgs({ options: { url: { type: 'string' }, output: { type: 'string' }, 'fixture-evidence': { type: 'string' },
  'playwright-module': { type: 'string' }, chromium: { type: 'string' }, 'expected-settings-sha': { type: 'string' } } });
for (const key of ['url', 'output', 'fixture-evidence', 'playwright-module', 'chromium', 'expected-settings-sha']) assert(values[key], key);
const origin = new URL(values.url).origin, output = resolve(values.output), evidence = resolve(values['fixture-evidence']);
const fixture = JSON.parse(await readFile(join(evidence, 'launch.json'), 'utf8'));
assert.equal(new URL(origin).hostname, '127.0.0.1'); assert.equal(new URL(fixture.providerOrigin).hostname, '127.0.0.1');
assert.equal(fixture.paidModelCalls, 0);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const expectedAsset = values['expected-settings-sha']; assert(/^[a-f0-9]{64}$/.test(expectedAsset));
await mkdir(output, { recursive: true });
const pw = await import(pathToFileURL(resolve(values['playwright-module'])).href);
const browser = await pw.chromium.launch({ executablePath: values.chromium, headless: true, args: ['--no-sandbox'] });
const checks = [], errors = [], assets = [], assetReads = [], external = [], pages = [];
const observations = new WeakMap();
let active, failure;
const check = (name, detail) => checks.push({ name, status: 'PASS', ...(detail ? { detail } : {}) });
const button = (page, name) => page.getByRole('button', { name, exact: typeof name === 'string' }).filter({ visible: true }).first();
async function until(action, label, ms = 15000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) { if (await action()) return; await new Promise(resolve => setTimeout(resolve, 50)); }
  throw new Error(label);
}
async function read(endpoint, args = {}) {
  assert(['settings/describe', 'session/list', 'session/projections'].includes(endpoint));
  const response = await fetch(origin + '/api/deepseek/call', { method: 'POST', headers: { 'content-type': 'application/json', origin },
    body: JSON.stringify({ endpoint, args, requestId: randomUUID() }), signal: AbortSignal.timeout(10000) });
  const result = await response.json(); assert.equal(result.ok, true, JSON.stringify(result.error)); return result.value;
}
const settings = async () => (await read('settings/describe')).namespaces;
const profile = async () => (await settings()).find(item => item.ns === 'llm-pi-ai').value.providers['ui-reasoning'];
const requests = async () => (await readFile(join(evidence, 'requests.jsonl'), 'utf8').catch(error => { if (error.code === 'ENOENT') return ''; throw error; }))
  .split('\n').filter(Boolean).map(line => JSON.parse(line));
async function pageOf(options) {
  const context = await browser.newContext(options), page = await context.newPage(); active = page; pages.push({ page, context });
  observations.set(page, observeProductionRpc(page, origin));
  page.setDefaultTimeout(10000);
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => { const url = new URL(request.url()); if (url.protocol.startsWith('http') && url.origin !== origin) external.push(url.origin); });
  page.on('response', response => { if (response.url().includes('dsh-client-ui-settings-models')) assetReads.push(response.body().then(body => {
    assert(body.length > 0); assets.push({ url: response.url(), sha256: hash(body), bytes: body.length });
  })); });
  await page.goto(origin, { waitUntil: 'domcontentloaded' }); await page.locator('[data-harness-controls]').waitFor();
  return page;
}
async function openSettings(page) {
  const sidebar = button(page, /^(Open sidebar|打开侧边栏)$/); if (await sidebar.isVisible()) await sidebar.click();
  await button(page, /^(Settings|设置)$/).click();
}
async function language(page, locale) {
  await button(page, /^(General|通用设置)$/).click();
  const expected = locale === 'zh' ? 'zh-CN' : 'en';
  if (await page.locator('html').getAttribute('lang') !== expected) {
    await button(page, /^(English|中文)$/).click();
    await page.getByRole('menuitem', { name: locale === 'zh' ? '中文' : 'English', exact: true }).click();
    await until(async () => (await settings()).find(item => item.ns === 'locale').value.preference === locale, 'Locale write not committed');
    await until(async () => await page.locator('html').getAttribute('lang') === expected, 'Locale not rendered');
  }
}
async function theme(page, appearance) {
  await button(page, /^(General|通用设置)$/).click();
  const current = (await settings()).find(item => item.ns === 'ui-theme').value.preference;
  if (current !== appearance) await button(page, appearance === 'dark' ? /^(Dark|深色)$/ : /^(Light|浅色)$/).click();
  await until(async () => (await settings()).find(item => item.ns === 'ui-theme').value.preference === appearance, 'Theme write not committed');
  await until(async () => await page.evaluate(() => document.documentElement.style.colorScheme) === appearance, 'Actual theme not rendered');
}
async function edit(page) {
  await button(page, /^(Models|模型)$/).click(); await button(page, /^(Edit|编辑).*\(ui-reasoning\)$/).click();
  await page.getByText(/^(Customized settings|自定义设置)$/, { exact: true }).click();
  await button(page, /^(Model options|模型选项) 1$/).click();
}
const apply = page => button(page, /^(Apply|Save|保存)$/);
const group = page => page.getByRole('group', { name: /^(Reasoning levels|推理等级) 1$/, exact: true });
const toggle = page => page.getByRole('switch', { name: /^(Reasoning levels|推理等级) 1$/, exact: true });
async function layout(page, label) {
  const appearance = await page.evaluate(() => document.documentElement.style.colorScheme);
  assert.equal(appearance, label.includes('dark') ? 'dark' : 'light');
  const card = page.locator('[class$="_modelEntry"]').filter({ has: group(page) });
  await card.scrollIntoViewIfNeeded();
  const context = await page.getByRole('textbox', { name: /^(Context window|上下文窗口) 1$/ }).boundingBox();
  const maximum = await page.getByRole('textbox', { name: /^(Max output tokens|最大输出 token 数) 1$/ }).boundingBox();
  assert(context && maximum);
  if (page.viewportSize().width >= 700) { assert(Math.abs(context.y - maximum.y) < 2); assert(context.x < maximum.x); }
  const bounds = await group(page).evaluate(element => ({ rect: element.getBoundingClientRect().toJSON(), width: innerWidth,
    controls: [...element.querySelectorAll('button,input,select')].map(item => item.getBoundingClientRect().toJSON()),
    documentWidth: document.documentElement.scrollWidth }));
  assert(bounds.rect.left >= 0 && bounds.rect.right <= bounds.width + 1);
  assert(bounds.controls.every(rect => rect.width > 0 && rect.left >= 0 && rect.right <= bounds.width + 1));
  assert(bounds.documentWidth <= bounds.width + 1);
  assert.equal(await group(page).locator('textarea').count(), 0);
  await page.screenshot({ path: join(output, label + '.png'), fullPage: true });
  await card.screenshot({ path: join(output, label + '-card.png') });
  check(label, { context, maximum, bounds, appearance });
}
let sessionId, owner, modelId = 'spec-reasoner';
async function chooseModel(page, id) {
  await button(page, /^Select model/).click();
  const submenu = page.getByRole('menuitem', { name: /^Model/ }); if (await submenu.isVisible()) await submenu.click();
  await page.getByRole('menuitemradio', { name: id, exact: true }).click();
  await page.getByRole('menuitemradio', { name: id, exact: true }).waitFor({ state: 'hidden' });
  await until(async () => (await button(page, /^Select model/).getAttribute('aria-label')).includes(id), 'Selected model not rendered');
  modelId = id;
}
async function selectEffort(page, effort) {
  await button(page, /^Select model/).click(); await page.getByRole('menuitem', { name: /^Effort/ }).click();
  await page.getByRole('menuitemradio', { name: effort, exact: true }).click();
  await until(async () => (await read('session/projections', { request: { sessionId } })).values.modelSelection.next.reasoningEffort === effort, 'Reasoning selection not committed');
}
async function prompt(page, label, expected) {
  const prior = (await read('session/projections', { request: { sessionId } })).values.turnBoundary.lastTurn;
  const text = 'Model editor actual HTTP ' + label + ' ' + randomUUID();
  owner = page.locator('[data-conversation-content][data-conversation-session="' + sessionId + '"]').filter({ visible: true });
  await owner.locator('[data-composer-input=true][contenteditable=true]').fill(text); await button(page, 'Send message').click();
  await until(async () => (await requests()).some(item => item.messages.some(message => message.role === 'user' && message.content.includes(text))), 'No actual model HTTP request');
  await until(async () => { const boundary = (await read('session/projections', { request: { sessionId } })).values.turnBoundary;
    return boundary.lastTurn > prior && boundary.openTurnStartSeq === null; }, 'Actual turn did not finish', 30000);
  const rows = (await requests()).filter(item => item.messages.findLast(message => message.role === 'user')?.content.includes(text));
  assert(rows.length); assert(rows.every(item => item.model === modelId));
  if (expected === undefined) assert(rows.every(item => !Object.hasOwn(item, 'reasoningEffort')));
  else assert(rows.every(item => item.reasoningEffort === expected));
  assert(rows.every(item => item.maxTokens <= 128000));
  check(label, rows.map(item => ({ call: item.call, model: item.model, reasoningEffort: item.reasoningEffort, maxTokens: item.maxTokens })));
}
try {
  const page = await pageOf({ locale: 'en-US', colorScheme: 'light', viewport: { width: 1440, height: 1180 } });
  const rpc = observations.get(page);
  await until(() => rpc.calls.filter(item => item.endpoint === 'session/create').length === rpc.results.filter(item => item.endpoint === 'session/create').length, 'Prior session admissions not settled');
  const newSession = rpc.waitForResult('session/create');
  await page.getByRole('button', { name: 'New session', exact: true }).filter({ visible: true }).last().click();
  const admitted = await newSession; if (admitted.error) throw admitted.error; assert(admitted.result.ok && admitted.result.value?.sessionId);
  sessionId = admitted.result.value.sessionId;
  owner = page.locator('[data-conversation-content][data-conversation-session="' + sessionId + '"]').filter({ visible: true }); await owner.waitFor();
  const choose = owner.getByRole('button', { name: 'Choose workspace', exact: true });
  if (await choose.isVisible()) {
    await choose.click(); const adoption = rpc.waitForResult('session/create');
    await page.getByRole('menuitem', { name: 'project', exact: true }).click();
    const adopted = await adoption; if (adopted.error) throw adopted.error; assert(adopted.result.ok && adopted.result.value?.sessionId);
    sessionId = adopted.result.value.sessionId;
    owner = page.locator('[data-conversation-content][data-conversation-session="' + sessionId + '"]').filter({ visible: true }); await owner.waitFor();
  }
  await owner.locator('[data-composer-input=true][contenteditable=true]').waitFor();
  check('fresh-session-actual-admission-and-owner', { sessionId });
  await button(page, /^Access mode, current:/).click(); await page.getByRole('menuitem', { name: 'Full access', exact: true }).click();
  await page.getByRole('checkbox').check(); await button(page, 'Enable Full access').click();
  await button(page, 'Access mode, current: Full access').waitFor();
  await openSettings(page); await language(page, 'en'); await theme(page, 'light'); await button(page, 'Models').click(); await button(page, 'Add model provider').click();
  await page.getByRole('textbox', { name: 'Provider ID', exact: true }).fill('ui-reasoning');
  await page.getByRole('textbox', { name: 'Display name', exact: true }).fill('UI reasoning');
  await page.getByRole('textbox', { name: 'Base URL', exact: true }).fill(fixture.providerOrigin);
  await page.getByLabel('API key', { exact: true }).fill('local-editor-fixture');
  await button(page, 'Add model').click(); await page.getByRole('textbox', { name: 'Model ID 1', exact: true }).fill('spec-reasoner');
  await button(page, 'Model options 1').click();
  await page.getByRole('textbox', { name: 'Context window 1', exact: true }).fill('1048576');
  await page.getByRole('textbox', { name: 'Max output tokens 1', exact: true }).fill('128K');
  assert.equal(await toggle(page).getAttribute('aria-checked'), 'false'); await layout(page, 'desktop-light-off');
  await toggle(page).press('Space'); assert.equal(await toggle(page).getAttribute('aria-checked'), 'true');
  assert(await page.getByRole('textbox', { name: 'off API value', exact: true }).isDisabled());
  await button(page, 'Add level').click(); await page.getByRole('combobox', { name: 'Level 5', exact: true }).selectOption('max');
  await page.getByRole('textbox', { name: 'max API value', exact: true }).fill('xhigh');
  const choices = await page.getByRole('combobox', { name: 'Level 5', exact: true }).locator('option').evaluateAll(nodes => nodes.map(node => node.value));
  assert(!choices.includes('off') && !choices.includes('high'));
  await button(page, 'About reasoning levels').click(); await page.getByRole('tooltip').filter({ hasText: 'reasoning_effort' }).waitFor(); await page.keyboard.press('Escape');
  await layout(page, 'desktop-light-on');
  const created = rpc.waitForResult('settings/mutate'); await button(page, 'Create provider').click();
  const committed = await created; if (committed.error) throw committed.error; assert.equal(committed.result.ok, true, JSON.stringify(committed.result.error));
  await page.getByRole('textbox', { name: 'Provider ID', exact: true }).waitFor({ state: 'hidden' });
  assert.deepEqual((await profile()).models[0], { id: 'spec-reasoner', contextWindow: 1048576, maxTokens: 128000,
    reasoningEfforts: { off: null, low: 'low', medium: 'medium', high: 'high', max: 'xhigh' } }); check('UI-save-real-settings');
  // Verify editing before an owner pins the route. Existing owners deliberately
  // reject profile replacement; testing deletion must not bypass that guard.
  await edit(page);
  assert.equal(await page.getByRole('textbox', { name: 'max API value', exact: true }).inputValue(), 'xhigh');
  await page.getByRole('textbox', { name: 'max API value', exact: true }).fill('temporary'); await button(page, 'Cancel').click();
  assert.equal((await profile()).models[0].reasoningEfforts.max, 'xhigh'); check('cancel-keeps-committed-profile');
  await edit(page);
  for (const level of ['low', 'medium', 'high', 'max']) await button(page, 'Delete level ' + level).click();
  assert(await apply(page).isDisabled()); await page.getByText('Add at least one level besides Off, or turn reasoning levels off.', { exact: true }).waitFor();
  await button(page, 'Cancel').click(); assert.equal((await profile()).models[0].reasoningEfforts.max, 'xhigh'); check('invalid-off-only-blocked-before-save');
  await edit(page); await toggle(page).click(); await apply(page).click();
  await until(async () => !Object.hasOwn((await profile()).models[0], 'reasoningEfforts'), 'Disable not committed');
  check('disabled-form-actually-removes-capability');
  await button(page, 'Close').click(); await chooseModel(page, 'spec-reasoner');
  await prompt(page, 'disabled-capability-omits-wire', undefined);

  // A separate, newly configured route proves enabled wire values without
  // changing a profile already used by an actual owner.
  await openSettings(page); await button(page, 'Models').click(); await button(page, 'Add model provider').click();
  await page.getByRole('textbox', { name: 'Provider ID', exact: true }).fill('ui-reasoning-wire');
  await page.getByRole('textbox', { name: 'Display name', exact: true }).fill('UI reasoning wire');
  await page.getByRole('textbox', { name: 'Base URL', exact: true }).fill(fixture.providerOrigin);
  await page.getByLabel('API key', { exact: true }).fill('local-editor-fixture');
  await button(page, 'Add model').click(); await page.getByRole('textbox', { name: 'Model ID 1', exact: true }).fill('wire-reasoner');
  await button(page, 'Model options 1').click();
  await page.getByRole('textbox', { name: 'Context window 1', exact: true }).fill('1048576');
  await page.getByRole('textbox', { name: 'Max output tokens 1', exact: true }).fill('128K');
  await toggle(page).click(); await button(page, 'Add level').click();
  await page.getByRole('combobox', { name: 'Level 5', exact: true }).selectOption('max');
  await page.getByRole('textbox', { name: 'max API value', exact: true }).fill('xhigh');
  await button(page, 'Create provider').click();
  await page.getByRole('textbox', { name: 'Provider ID', exact: true }).waitFor({ state: 'hidden' });
  const wireProfile = (await settings()).find(item => item.ns === 'llm-pi-ai').value.providers['ui-reasoning-wire'];
  assert.deepEqual(wireProfile.models[0].reasoningEfforts, { off: null, low: 'low', medium: 'medium', high: 'high', max: 'xhigh' });
  await button(page, 'Close').click(); await chooseModel(page, 'wire-reasoner');
  await selectEffort(page, 'high'); await prompt(page, 'high-wire', 'high');
  await selectEffort(page, 'off'); await prompt(page, 'off-null-omits-wire', undefined);
  await selectEffort(page, 'max'); await prompt(page, 'max-custom-wire', 'xhigh');
  await page.reload(); await page.locator('[data-harness-controls]').waitFor();
  const row = page.locator('[data-row-key="session:' + sessionId + '"]'); await row.focus(); await row.press('Enter');
  await prompt(page, 'reload-retains-custom-wire', 'xhigh');

  for (const scenario of [
    { name: 'desktop-zh-light', locale: 'zh', colorScheme: 'light', width: 1182, height: 1185 },
    { name: 'mobile-en-dark', locale: 'en', colorScheme: 'dark', width: 390, height: 844 },
    { name: 'narrow-zh-dark', locale: 'zh', colorScheme: 'dark', width: 320, height: 1100 },
  ]) {
    const p = await pageOf({ locale: scenario.locale === 'zh' ? 'zh-CN' : 'en-US', colorScheme: scenario.colorScheme, viewport: { width: scenario.width, height: scenario.height } });
    await openSettings(p); await language(p, scenario.locale); await theme(p, scenario.colorScheme); await edit(p);
    await layout(p, scenario.name + '-off'); await toggle(p).click();
    await button(p, /^(Add level|添加档位)$/).click();
    await p.getByRole('combobox', { name: /^(Level|档位) 5$/, exact: true }).selectOption('max');
    await p.getByRole('textbox', { name: /^max (API value|API 参数值)$/, exact: true }).fill('xhigh');
    await layout(p, scenario.name + '-on');
    await button(p, /^(Cancel|取消)$/).click(); await language(p, 'en'); await theme(p, 'light'); await button(p, 'Close').click();
    assert(!Object.hasOwn((await profile()).models[0], 'reasoningEfforts')); check(scenario.name + '-cancel-keeps-profile');
  }
  await Promise.all(assetReads); assert(assets.length && assets.every(asset => asset.sha256 === expectedAsset && new URL(asset.url).searchParams.get('rev') === expectedAsset.slice(0, 12)));
  assert.deepEqual(errors, []); assert.deepEqual(external, []); check('actual-assets-and-browser-errors');
} catch (error) {
  failure = String(error.stack ?? error); if (active) await active.screenshot({ path: join(output, 'failure.png'), fullPage: true }).catch(() => {});
} finally {
  await browser.close();
  await writeFile(join(output, 'result.json'), JSON.stringify({ status: failure ? 'FAIL' : 'PASS', complete: !failure, checks, failure,
    assets, expectedAsset, errors, externalRequests: external, paidModelCalls: 0, platform: process.platform }, null, 2) + '\n');
}
if (failure) throw new Error(failure);
console.log(JSON.stringify({ status: 'PASS', checks: checks.length, paidModelCalls: 0, expectedAsset }));
