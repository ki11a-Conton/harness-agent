#!/usr/bin/env node
/** Native Goal/Plan menu -> actual Host -> durable projections and loopback HTTP.
 * No RPC mutations, route interception, forced clicks, or paid models. */
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { createHash, randomUUID } from 'node:crypto';
import { observeProductionRpc, canonicalPluginResource } from './deepseek-browser-observe.mjs';
import { createReadyWorkspaceSession } from './deepseek-browser-session.mjs';
const { values } = parseArgs({ options: { url: { type: 'string' }, output: { type: 'string' }, 'fixture-evidence': { type: 'string' },
  'playwright-module': { type: 'string' }, chromium: { type: 'string' }, 'expected-composer-sha': { type: 'string' }, 'expected-commands-sha': { type: 'string' } } });
for (const key of ['url', 'output', 'fixture-evidence', 'playwright-module', 'chromium', 'expected-composer-sha', 'expected-commands-sha']) assert(values[key], key);
for (const key of ['expected-composer-sha', 'expected-commands-sha']) assert(/^[a-f0-9]{64}$/.test(values[key]), key);
const origin = new URL(values.url).origin, output = resolve(values.output), evidence = resolve(values['fixture-evidence']);
const fixture = JSON.parse(await readFile(join(evidence, 'launch.json'), 'utf8'));
assert.equal(new URL(origin).hostname, '127.0.0.1'); assert.equal(new URL(fixture.providerOrigin).hostname, '127.0.0.1');
assert.equal(fixture.paidModelCalls, 0);
await mkdir(output, { recursive: true });
const pw = await import(pathToFileURL(resolve(values['playwright-module'])).href);
const browser = await pw.chromium.launch({ executablePath: values.chromium, headless: true, args: ['--no-sandbox'] });
const context = await browser.newContext({ locale: 'en-US', viewport: { width: 1440, height: 1000 } });
const page = await context.newPage(); page.setDefaultTimeout(10000);
const rpc = observeProductionRpc(page, origin), checks = [], errors = [], assets = [], assetReads = [];
page.on('pageerror', error => errors.push(error.message));
page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
page.on('response', response => {
  const resource = canonicalPluginResource(response.url(), origin);
  const kind = ['/deepseek/harness-brand/plugins/dsh-client-ui-conversation/client.js', '/deepseek/plugins/dsh-client-ui-conversation/client.js'].includes(resource) ? 'composer'
    : resource === '/deepseek/plugins/dsh-client-ui-commands/client.js' ? 'commands' : undefined;
  if (kind) assetReads.push(response.body().then(bytes => assets.push({ kind, url: response.url(), bytes: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex') })));
});
const check = (name, detail) => { checks.push({ name, status: 'PASS', ...(detail === undefined ? {} : { detail }) }); console.log(JSON.stringify({ name, status: 'PASS' })); };
const button = name => page.getByRole('button', { name, exact: typeof name === 'string' }).filter({ visible: true }).first();
const editor = () => page.locator('[data-composer-input=true][contenteditable=true]').filter({ visible: true });
const plus = () => button(/^(Add files or run commands|添加文件或调用指令)$/);
const planChip = () => button(/^(Plan mode on, press to turn off|计划模式已开启，按下关闭)$/);
const option = kind => page.getByRole('option').filter({ hasText: kind === 'goal'
  ? /Set or view the goal for a long-running task|设置或查看长期任务目标/ : /Enter or leave plan mode|进入或退出计划模式/ });
let sessionId, failure;
async function until(action, label, ms = 15000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) { if (await action()) return; await new Promise(resolve => setTimeout(resolve, 50)); }
  throw new Error(label);
}
async function read(endpoint, args = {}) {
  assert(['settings/describe', 'session/list', 'session/projections', 'goals/get'].includes(endpoint));
  const response = await fetch(origin + '/api/deepseek/call', { method: 'POST', headers: { 'content-type': 'application/json', origin },
    body: JSON.stringify({ endpoint, args, requestId: randomUUID() }), signal: AbortSignal.timeout(10000) });
  const result = await response.json(); assert.equal(result.ok, true, JSON.stringify(result.error)); return result.value;
}
const state = () => read('session/projections', { request: { sessionId } });
const goal = () => read('goals/get', { agentId: sessionId });
const frames = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
const requests = async () => (await readFile(join(evidence, 'requests.jsonl'), 'utf8').catch(error => { if (error.code === 'ENOENT') return ''; throw error; }))
  .split('\n').filter(Boolean).map(line => JSON.parse(line));
async function acknowledged(action) {
  const receipt = rpc.waitForResult('commands/execute', 30000); await action();
  const result = await receipt; if (result.error) throw result.error; assert.equal(result.result.ok, true, JSON.stringify(result));
}
async function nativeCommand(kind, keyboard = false) {
  if (keyboard) {
    await plus().press('Enter'); await option(kind).waitFor();
    for (let count = 0; count < 20 && await option(kind).getAttribute('aria-selected') !== 'true'; count++) await editor().press('ArrowDown');
    assert.equal(await option(kind).getAttribute('aria-selected'), 'true', kind + ' is not keyboard reachable');
    await editor().press('Enter');
  } else { await plus().click(); await option(kind).click(); }
}
async function clearDraft() {
  await editor().press('ControlOrMeta+A'); await editor().press('Backspace');
  await until(async () => (await editor().innerText()).trim() === '', 'Native draft did not clear');
}
async function freshSession() {
  const sidebar = button(/^(Open sidebar|打开侧边栏)$/); if (await sidebar.isVisible()) await sidebar.click();
  const ready = await createReadyWorkspaceSession(page, rpc); sessionId = ready.sessionId;
  assert((await read('session/list', { _request: {} })).items.some(item => item.sessionId === sessionId && item.cwd === fixture.cwd && item.agentAvailable));
  const collapse = button(/^(Collapse sidebar|收起侧边栏)$/); if (await collapse.isVisible()) await collapse.click();
}
async function appearance(locale, theme) {
  const sidebar = button(/^(Open sidebar|打开侧边栏)$/); if (await sidebar.isVisible()) await sidebar.click();
  await button(/^(Settings|设置)$/).click(); await button(/^(General|通用设置)$/).click();
  const expected = locale === 'zh' ? 'zh-CN' : 'en';
  if (await page.locator('html').getAttribute('lang') !== expected) {
    await button(/^(English|中文)$/).click(); await page.getByRole('menuitem', { name: locale === 'zh' ? '中文' : 'English', exact: true }).click();
    await until(async () => (await read('settings/describe')).namespaces.find(item => item.ns === 'locale').value.preference === locale, 'Locale not committed');
    await until(async () => await page.locator('html').getAttribute('lang') === expected, 'Locale not rendered');
  }
  const current = (await read('settings/describe')).namespaces.find(item => item.ns === 'ui-theme').value.preference;
  if (current !== theme) await button(theme === 'dark' ? /^(Dark|深色)$/ : /^(Light|浅色)$/).click();
  await until(async () => await page.evaluate(() => document.documentElement.style.colorScheme) === theme, 'Theme not rendered');
  await button(/^(Close|关闭)$/).click();
  const collapse = button(/^(Collapse sidebar|收起侧边栏)$/); if (await collapse.isVisible()) await collapse.click();
}
async function layout(label) {
  const bounds = await page.locator('[data-harness-controls]').filter({ visible: true }).evaluate(element => ({ rect: element.getBoundingClientRect().toJSON(), viewport: innerWidth,
    buttons: [...element.querySelectorAll('button')].filter(button => button.getClientRects().length).map(button => button.getBoundingClientRect().toJSON()), documentWidth: document.documentElement.scrollWidth }));
  assert(bounds.rect.width > 0 && bounds.rect.left >= 0 && bounds.rect.right <= bounds.viewport + 1);
  assert(bounds.buttons.length > 0 && bounds.buttons.every(rect => rect.width > 0 && rect.left >= 0 && rect.right <= bounds.viewport + 1));
  assert(bounds.documentWidth <= bounds.viewport + 1);
  assert.equal(await page.getByRole('combobox', { name: /^(Task mode|任务模式)$/, exact: true }).count(), 0);
  assert.equal(await page.getByRole('textbox', { name: /^(Goal objective|目标内容)$/, exact: true }).count(), 0);
  const visibleEditor = await editor().evaluate(element => {
    const range = document.createRange(); range.selectNodeContents(element);
    const ancestors = []; let current = element;
    while (current && ancestors.length < 5) { const css = getComputedStyle(current); ancestors.push({ tag: current.tagName, className: current.className,
      rect: current.getBoundingClientRect().toJSON(), color: css.color, opacity: css.opacity, visibility: css.visibility, overflow: css.overflow, scrollTop: current.scrollTop }); current = current.parentElement; }
    return { html: element.outerHTML, range: range.getBoundingClientRect().toJSON(), ancestors };
  });
  await writeFile(join(output, label + '-editor.json'), JSON.stringify(visibleEditor, null, 2) + '\n');
  for (const ancestor of visibleEditor.ancestors.filter(item => item.overflow === 'auto' || item.overflow === 'hidden')) {
    assert(ancestor.rect.height >= 24, label + ': input text clipped by a collapsed scrollport ' + JSON.stringify(ancestor));
    if (visibleEditor.range.height > 0) assert(visibleEditor.range.bottom > ancestor.rect.top && visibleEditor.range.top < ancestor.rect.bottom, label + ': draft text lies outside its scrollport');
  }
  await page.screenshot({ path: join(output, label + '.png'), fullPage: true }); return bounds;
}
try {
  await page.goto(origin, { waitUntil: 'domcontentloaded' }); await page.locator('[data-harness-controls]').waitFor();
  await freshSession(); check('fresh-session-real-admission', { sessionId });
  for (const [label, width, height, locale, theme] of [
    ['desktop-en-light', 1440, 1000, 'en', 'light'], ['desktop-zh-light', 1440, 1000, 'zh', 'light'],
    ['mobile-en-dark', 390, 844, 'en', 'dark'], ['narrow-zh-dark', 320, 1100, 'zh', 'dark']]) {
    await page.setViewportSize({ width, height }); await frames(); await appearance(locale, theme);
    const before = (await requests()).length;
    await editor().fill('Unsent coding draft ' + label); await plus().press('Enter'); await option('plan').waitFor();
    // Upstream hides argument commands in a non-leading position so an
    // existing coding draft cannot accidentally become a goal objective.
    assert.equal(await option('goal').count(), 0);
    await editor().press('Escape'); await option('plan').waitFor({ state: 'hidden' });
    assert.equal((await editor().innerText()).trim(), 'Unsent coding draft ' + label); await clearDraft();
    check(label + '-escape-keeps-draft');
    await acknowledged(() => nativeCommand('plan', true)); await planChip().waitFor(); assert((await state()).values.plan.active);
    await page.reload(); await planChip().waitFor(); assert((await state()).values.plan.active);
    const bounds = await layout(label + '-plan');
    await acknowledged(() => planChip().click()); await until(async () => !(await state()).values.plan.active, 'Native Plan chip did not exit');
    check(label + '-keyboard-plan-persists', bounds);
    await plus().click(); await option('goal').waitFor(); await option('plan').waitFor();
    assert(await option('goal').locator('svg').count()); assert(await option('plan').locator('svg').count());
    await option('goal').click(); await page.locator('[data-composer-input=true][data-phase=claimed]').filter({ visible: true }).waitFor();
    assert.match(await editor().innerText(), locale === 'zh' ? /^\/目标\s/u : /^\/goal\s/u);
    const hint = await editor().evaluate(element => element.style.getPropertyValue('--dsh-composer-hint'));
    assert(hint.includes(locale === 'zh' ? '输入目标' : 'describe the objective'));
    await editor().pressSequentially('Native unsent goal ' + label); await layout(label + '-goal'); await clearDraft();
    assert.equal(await goal(), undefined); assert.equal((await requests()).length, before);
    check(label + '-native-goal-cancel-no-side-effects');
    if (locale === 'zh') {
      await editor().fill('/plan'); await acknowledged(() => editor().press('Enter'));
      await planChip().waitFor(); assert((await state()).values.plan.active);
      await editor().fill('/plan'); await acknowledged(() => editor().press('Enter'));
      await until(async () => !(await state()).values.plan.active, 'Canonical /plan alias did not exit in Chinese');
      await editor().fill('/goal'); await editor().press('Enter');
      await page.locator('[data-composer-input=true][data-phase=claimed]').filter({ visible: true }).waitFor();
      // An English alias is accepted and the menu renders its localized chip.
      assert.match(await editor().innerText(), /^\/目标\s/u); await clearDraft();
      assert.equal(await goal(), undefined); assert.equal((await requests()).length, before);
      check(label + '-canonical-slash-aliases');
      if (label === 'desktop-zh-light') {
        await acknowledged(() => nativeCommand('plan')); await planChip().waitFor();
        await nativeCommand('goal'); const objective = '[fixture:read] 中文原生目标 ' + randomUUID();
        await editor().pressSequentially(objective); await acknowledged(() => button('发送消息').click());
        await button('暂停目标').waitFor(); assert.equal((await goal()).objective, objective);
        assert((await state()).values.plan.active); assert.equal((await goal()).roundsStarted, 0);
        await button('暂停目标').click(); await button('恢复目标').waitFor(); await button('清除目标').click();
        await until(async () => (await goal()) === undefined, 'Chinese Goal did not clear');
        await acknowledged(() => planChip().click()); await until(async () => !(await state()).values.plan.active, 'Chinese Plan did not exit');
        assert.equal((await requests()).length, before); check('zh-localized-goal-real-command');
      }
    }
  }
  await page.setViewportSize({ width: 1440, height: 1000 }); await frames(); await appearance('en', 'light');
  await editor().fill('/goal'); await editor().press('Enter');
  await page.locator('[data-composer-input=true][data-phase=claimed]').filter({ visible: true }).waitFor();
  assert.equal(await goal(), undefined); await clearDraft(); check('typed-bare-goal-claims-main-composer');
  await editor().fill('/plan'); await acknowledged(() => editor().press('Enter'));
  await planChip().waitFor(); assert((await state()).values.plan.active); check('typed-bare-plan-enters');
  const objective = '[fixture:read] Native command goal ' + randomUUID(), before = (await requests()).length;
  await nativeCommand('goal'); await editor().pressSequentially(objective); await acknowledged(() => button('Send message').click());
  await button('Pause goal').waitFor(); await page.waitForTimeout(1200);
  assert.equal((await goal()).objective, objective); assert((await state()).values.plan.active);
  assert.equal((await goal()).roundsStarted, 0); assert.equal((await requests()).length, before);
  check('goal-preserves-unapproved-plan-and-pauses-driver');
  await editor().fill('/plan'); await acknowledged(() => editor().press('Enter'));
  await until(async () => !(await state()).values.plan.active, 'Typed Plan did not exit');
  await until(async () => (await requests()).length >= before + 3, 'Goal did not run actual loopback HTTP', 30000);
  await button('Pause goal').click(); await button('Resume goal').waitFor();
  await until(async () => (await state()).values.turnBoundary.openTurnStartSeq === null && !await button('Stop generating').isVisible(), 'Paused turn did not settle', 30000);
  const paused = await goal(); assert.equal(paused.phase, 'paused'); assert(paused.roundsStarted > 0);
  await page.reload(); await button('Resume goal').waitFor(); assert.equal((await goal()).objective, objective);
  const rounds = (await goal()).roundsStarted; await page.waitForTimeout(1100); assert.equal((await goal()).roundsStarted, rounds);
  check('goal-real-http-pause-and-reload', { objective, rounds });
  await button('Edit goal').click(); await page.getByRole('textbox', { name: 'Goal objective', exact: true }).fill(objective + ' edited');
  await button('Save goal').click(); await until(async () => (await goal()).objective === objective + ' edited', 'Goal edit not persisted');
  await button('Resume goal').click(); await button('Pause goal').waitFor(); await button('Pause goal').click(); await button('Resume goal').waitFor();
  await button('Clear goal').click(); await until(async () => (await goal()) === undefined, 'Goal did not clear');
  check('native-goal-edit-resume-clear');
  await freshSession(); const isolated = (await state()).values;
  assert.equal(isolated.goal, null); assert.equal(isolated.plan.active, false); await layout('new-session-default');
  check('new-session-default-coding-isolation');
  const typedObjective = '[fixture:read] Typed goal ' + randomUUID();
  await editor().fill('/goal ' + typedObjective);
  await acknowledged(() => button('Send message').click()); await button('Pause goal').waitFor();
  assert.equal((await goal()).objective, typedObjective);
  await until(async () => (await requests()).some(request => request.messages.some(message => message.role === 'user' && message.content.includes(typedObjective))), 'Typed Goal never reached actual model HTTP', 30000);
  await button('Pause goal').click(); await button('Resume goal').waitFor();
  await until(async () => (await state()).values.turnBoundary.openTurnStartSeq === null && !await button('Stop generating').isVisible(), 'Last admitted Goal turn did not settle before handoff', 30000);
  await button('Clear goal').click();
  await until(async () => (await goal()) === undefined, 'Typed goal did not clear'); check('typed-goal-with-objective-executes');
  await Promise.all(assetReads); await rpc.settled();
  for (const [kind, expected] of [['composer', values['expected-composer-sha']], ['commands', values['expected-commands-sha']]]) {
    const actual = assets.filter(asset => asset.kind === kind); assert(actual.length > 0, kind + ' not loaded');
    assert(actual.every(asset => asset.sha256 === expected), kind + ' archive bytes differ');
  }
  assert.deepEqual(errors, []); assert.deepEqual(rpc.externalRequests, []); check('actual-assets-and-no-browser-errors');
} catch (error) {
  failure = error.stack; await writeFile(join(output, 'failure-text.txt'), await page.locator('body').innerText().catch(() => 'Page unavailable'));
  await page.screenshot({ path: join(output, 'failure.png'), fullPage: true }).catch(() => {});
} finally {
  await Promise.allSettled(assetReads); await rpc.settled();
  await writeFile(join(output, 'result.json'), JSON.stringify({ status: failure ? 'FAIL' : 'PASS', complete: !failure, platform: process.platform,
    paidModelCalls: 0, expectedComposerSha256: values['expected-composer-sha'], expectedCommandsSha256: values['expected-commands-sha'],
    checks, assets, errors, externalRequests: rpc.externalRequests, sessionId,
    rpc: { calls: rpc.calls, results: rpc.results }, ...(failure ? { failure } : {}),
    scope: 'Native Goal/Plan menu, keyboard and typed commands across responsive en/zh light/dark views, durable Host state and real loopback HTTP. Real model quality is not measured.' }, null, 2) + '\n');
  await browser.close();
}
if (failure) { console.error(failure); process.exitCode = 1; }
