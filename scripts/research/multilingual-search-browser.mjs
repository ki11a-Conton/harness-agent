#!/usr/bin/env node
/** Real UI -> native RPC -> actual selected-model HTTP. No browser or RPC mocks. */
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { createHash, randomUUID } from 'node:crypto';
import { observeProductionRpc } from './deepseek-browser-observe.mjs';
import { createReadyWorkspaceSession, editableComposer } from './deepseek-browser-session.mjs';
const { values } = parseArgs({ options: { url: { type: 'string' }, output: { type: 'string' }, 'fixture-evidence': { type: 'string' },
  'playwright-module': { type: 'string' }, chromium: { type: 'string' }, 'expected-assets': { type: 'string' } } });
for (const key of ['url', 'output', 'fixture-evidence', 'playwright-module', 'chromium', 'expected-assets']) assert(values[key], key);
const origin = new URL(values.url).origin, output = resolve(values.output), evidence = resolve(values['fixture-evidence']);
const fixture = JSON.parse(await readFile(join(evidence, 'launch.json'), 'utf8'));
assert.equal(new URL(origin).hostname, '127.0.0.1'); assert.equal(new URL(fixture.providerOrigin).hostname, '127.0.0.1'); assert.equal(fixture.paidModelCalls, 0);
const expected = JSON.parse(values['expected-assets']);
assert.deepEqual(Object.keys(expected).sort(), ['commands', 'model-selection', 'workspace']);
const pw = await import(pathToFileURL(resolve(values['playwright-module'])).href);
await mkdir(output, { recursive: true });
const browser = await pw.chromium.launch({ executablePath: values.chromium, headless: true, args: ['--no-sandbox'] });
const context = await browser.newContext({ locale: 'en-US', viewport: { width: 1440, height: 1180 } });
const page = await context.newPage(), rpc = observeProductionRpc(page, origin), checks = [], assets = [], pending = [], errors = [];
let failure;
page.setDefaultTimeout(12000);
page.on('pageerror', error => errors.push(error.message));
page.on('response', response => { for (const stem of Object.keys(expected)) if (response.url().includes(`dsh-client-ui-${stem}/client.js`)) {
  pending.push(response.body().then(body => assets.push({ stem, sha256: createHash('sha256').update(body).digest('hex') }))); }
});
const check = (name, detail) => checks.push({ name, status: 'PASS', ...(detail === undefined ? {} : { detail }) });
const button = name => page.getByRole('button', { name, exact: typeof name === 'string' }).filter({ visible: true }).first();
const editor = () => page.locator(editableComposer).filter({ visible: true }).last();
async function until(action, label, ms = 20000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) { if (await action()) return; await page.waitForTimeout(40); }
  throw new Error(label);
}
async function read(endpoint, args = {}) {
  assert(['settings/describe', 'session/list', 'session/projections'].includes(endpoint));
  const response = await fetch(origin + '/api/deepseek/call', { method: 'POST', headers: { 'content-type': 'application/json', origin },
    body: JSON.stringify({ endpoint, args, requestId: randomUUID() }), signal: AbortSignal.timeout(10000) });
  const body = await response.json(); assert.equal(body.ok, true, JSON.stringify(body.error)); return body.value;
}
async function requests() { return (await readFile(join(evidence, 'requests.jsonl'), 'utf8').catch(e => { if (e.code === 'ENOENT') return ''; throw e; })).split('\n').filter(Boolean).map(row => JSON.parse(row)); }
async function sidebar() {
  if (await button(/^(Settings|设置)$/).isVisible()) return;
  await button(/^(Open sidebar|打开侧边栏)$/).click(); await button(/^(Settings|设置)$/).waitFor();
}
async function settings() { await sidebar(); await button(/^(Settings|设置)$/).click(); await button(/^(General|通用设置)$/).click(); }
async function configureAppearance(locale, appearance) {
  await settings();
  if (await page.locator('html').getAttribute('lang') !== (locale === 'zh' ? 'zh-CN' : 'en')) {
    await button(/^(English|中文)$/).click(); await page.getByRole('menuitem', { name: locale === 'zh' ? '中文' : 'English', exact: true }).click();
    await until(async () => await page.locator('html').getAttribute('lang') === (locale === 'zh' ? 'zh-CN' : 'en'), 'Locale not applied');
  }
  await button(appearance === 'dark' ? /^(Dark|深色)$/ : /^(Light|浅色)$/).click();
  await escapeOverlay();
}
async function escapeOverlay() {
  await page.keyboard.press('Escape');
  const trigger = button(/^(Select model|选择模型)/);
  // Model selection has a nested root/model pane: the first Escape returns
  // to root, and the second closes it. Respect both real navigation steps.
  if (await trigger.isVisible() && await trigger.getAttribute('aria-expanded') === 'true') {
    await page.keyboard.press('Escape');
    await until(async () => await trigger.getAttribute('aria-expanded') === 'false', 'Model menu did not close');
  }
}
async function modelMenu(query) {
  await button(/^(Select model|选择模型)/).click();
  const branch = page.getByRole('menuitem', { name: /^(Model|模型)/ }).filter({ visible: true }).first();
  const input = page.getByRole('searchbox', { name: /Search models|搜索模型/ });
  await input.or(branch).first().waitFor({ state: 'visible' });
  if (!await input.isVisible()) await branch.click();
  await input.fill(query); return input;
}
async function fresh() { await sidebar(); return createReadyWorkspaceSession(page, rpc); }
async function send(ready, marker, model) {
  const owner = ready.owner;
  await owner.locator(editableComposer).fill(marker); await button(/^(Send message|发送消息)$/).click();
  await until(async () => (await requests()).some(row => row.messages.some(m => m.role === 'user' && String(m.content).includes(marker))), 'Selected model never received actual HTTP');
  const rows = (await requests()).filter(row => row.messages.some(m => m.role === 'user' && String(m.content).includes(marker)));
  assert(rows.length && rows.every(row => row.model === model));
  await until(async () => (await read('session/projections', { request: { sessionId: ready.sessionId } })).values.turnBoundary.openTurnStartSeq === null, 'Coding turn did not settle');
  return rows;
}
async function renameSession(id, title) {
  await sidebar(); const row = page.locator(`[data-row-key="session:${id}"]`); await row.hover();
  await row.getByRole('button', { name: /^(Session actions for|会话操作)/ }).click(); await page.getByRole('menuitem', { name: /^(Rename|重命名)$/, exact: true }).click();
  await page.getByRole('textbox', { name: /^(Session name|会话名称)$/, exact: true }).fill(title);
  await page.getByRole('textbox', { name: /^(Session name|会话名称)$/, exact: true }).press('Enter'); await row.getByText(title, { exact: true }).waitFor();
}
try {
  await page.goto(origin, { waitUntil: 'domcontentloaded' }); await page.locator('[data-harness-controls]').waitFor();
  await configureAppearance('en', 'light'); await settings(); await button('Models').click(); await button('Add model provider').click();
  await page.getByRole('textbox', { name: 'Provider ID', exact: true }).fill('search-fixture');
  await page.getByRole('textbox', { name: 'Display name', exact: true }).fill('Search fixture');
  await page.getByRole('textbox', { name: 'Base URL', exact: true }).fill(fixture.providerOrigin); await page.getByLabel('API key', { exact: true }).fill('local-search-fixture');
  const models = [['search-alpha', 'Alpha Coder'], ['search-beta', 'Beta Reviewer'], ['search-zh', '中文 助手'], ['search-delta', 'Delta'], ['search-gamma', 'Original Name']];
  for (const [offset, [id, name]] of models.entries()) {
    await button('Add model').click(); await page.getByRole('textbox', { name: `Model ID ${offset + 1}`, exact: true }).fill(id);
    await page.getByRole('textbox', { name: `Display name ${offset + 1}`, exact: true }).fill(name);
  }
  await button('Create provider').click(); await until(async () => (await read('settings/describe')).namespaces.find(n => n.ns === 'llm-pi-ai').value.providers['search-fixture']?.models?.length === models.length, 'Model catalog not committed');
  await escapeOverlay(); check('real-ui-catalog-committed');
  await modelMenu('Original'); await page.getByRole('menuitemradio', { name: 'Original Name', exact: true }).waitFor(); await escapeOverlay();
  await settings(); await button('Models').click(); await button(/^Edit.*\(search-fixture\)$/).click(); await page.getByText('Customized settings', { exact: true }).click();
  await page.getByRole('textbox', { name: 'Display name 5', exact: true }).fill('Renamed Agent'); await button('Delete model 2').click(); await button(/^(Apply|Save)$/).click(); await page.getByRole('textbox', { name: 'Display name 1', exact: true }).waitFor({ state: 'hidden' }); await escapeOverlay();
  await fresh(); await modelMenu('Original'); await until(async () => await page.getByRole('menuitemradio').filter({ visible: true }).count() === 0, 'Unexpected stale or unmatched model candidate'); await escapeOverlay();
  await modelMenu('Beta'); await until(async () => await page.getByRole('menuitemradio').filter({ visible: true }).count() === 0, 'Unexpected stale or unmatched model candidate'); await escapeOverlay();
  await modelMenu('Renamed'); await page.getByRole('menuitemradio', { name: 'Renamed Agent', exact: true }).waitFor(); await escapeOverlay(); check('catalog-update-invalidates-old-candidates');

  const ready = await fresh();
  for (const query of ['ａｌｐｈａ', 'Coder Alpha']) {
    const input = await modelMenu(query); const rows = page.getByRole('menuitemradio').filter({ visible: true });
    assert.equal(await rows.count(), 1); assert.match(await rows.first().textContent(), /Alpha Coder/);
    if (query === 'ａｌｐｈａ') { await input.press('ArrowDown'); await input.press('Enter'); await input.waitFor({ state: 'hidden' }); await until(async () => (await button(/^Select model/).getAttribute('aria-label')).includes('Alpha Coder'), 'Native selected model not committed'); } else await escapeOverlay();
    check('model-search-' + query);
  }
  const selected = await read('session/projections', { request: { sessionId: ready.sessionId } });
  assert.equal(selected.values.modelSelection.next.model, 'search-alpha');
  await modelMenu('no-matching-model-928'); await until(async () => await page.getByRole('menuitemradio').filter({ visible: true }).count() === 0, 'Unexpected stale or unmatched model candidate'); await escapeOverlay();
  check('model-empty-result-escape-keeps-selection');
  await send(ready, 'BROWSER-SEARCH-ACTUAL-' + randomUUID(), 'search-alpha'); check('keyboard-selected-model-real-http');
  const commandReceipt = rpc.waitForResult('commands/execute', 30000);
  await editor().fill('/ｐｌａｎ'); const option = page.getByRole('option').filter({ hasText: /plan|计划/i }).first(); await option.waitFor();
  await editor().press('ArrowDown'); await editor().press('Enter');
  const command = await commandReceipt; assert.equal(command.result.ok, true, JSON.stringify(command));
  assert.equal((await read('session/projections', { request: { sessionId: ready.sessionId } })).values.plan.active, true); check('fullwidth-command-real-plan-receipt');
  await renameSession(ready.sessionId, '修复 登录流程');
  for (const query of ['登录 修复', '修 登']) {
    await fresh();
    await button('Search sessions').click(); const input = page.getByPlaceholder('Search session names', { exact: true }); await input.fill(query);
    const row = page.getByRole('treeitem').filter({ hasText: '修复 登录流程' }).first(); await row.waitFor(); await row.press('Enter');
    await page.locator(`[data-conversation-session="${ready.sessionId}"]`).filter({ visible: true }).waitFor(); check('workspace-search-' + query);
  }
  await fresh();
  for (const scenario of [{ name: 'narrow-zh-dark', locale: 'zh', theme: 'dark', width: 390 }, { name: 'desktop-en-light', locale: 'en', theme: 'light', width: 1440 }]) {
    await page.setViewportSize({ width: scenario.width, height: 1000 }); await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))); await configureAppearance(scenario.locale, scenario.theme);
    const input = await modelMenu('助 中'); const row = page.getByRole('menuitemradio', { name: '中文 助手', exact: true }); await row.waitFor();
    const box = await input.boundingBox(); assert(box && box.x >= 0 && box.x + box.width <= scenario.width + 1); await escapeOverlay();
    await page.screenshot({ path: join(output, scenario.name + '.png'), fullPage: true }); check(scenario.name + '-chinese-model-search');
  }
  await Promise.all(pending);
  for (const stem of Object.keys(expected)) assert(assets.some(a => a.stem === stem) && assets.filter(a => a.stem === stem).every(a => a.sha256 === expected[stem]), 'Wrong actual search asset ' + stem);
  assert.deepEqual(errors, []); assert.deepEqual(rpc.externalRequests, []); check('actual-reviewed-assets-and-no-browser-errors');
} catch (error) { failure = String(error.stack ?? error); await page.screenshot({ path: join(output, 'failure.png'), fullPage: true }).catch(() => {}); console.error(failure); }
finally {
  await Promise.allSettled(pending); await browser.close();
  await writeFile(join(output, 'result.json'), JSON.stringify({ status: failure ? 'FAIL' : 'PASS', complete: !failure, checks, failure, assets, expectedAssets: expected,
    errors, externalRequests: rpc.externalRequests, platform: process.platform, paidModelCalls: 0, fixtureInstalled: fixture.installed === true, fixtureSourceSha: fixture.sourceSha }, null, 2) + '\n');
}
if (failure) process.exitCode = 1; else console.log(JSON.stringify({ status: 'PASS', checks: checks.length }));
