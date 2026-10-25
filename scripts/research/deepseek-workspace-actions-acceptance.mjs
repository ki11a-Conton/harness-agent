#!/usr/bin/env node
/** Real production-host workspace keyboard acceptance; no DOM/CSS/RPC replacement. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { observeProductionRpc } from './deepseek-browser-observe.mjs';

const { values } = parseArgs({ options: {
  url: { type: 'string' }, 'expected-workspace-sha': { type: 'string' }, output: { type: 'string' }, 'fixture-evidence': { type: 'string' },
  'playwright-module': { type: 'string' }, chromium: { type: 'string', default: '/usr/bin/chromium' },
  baseline: { type: 'boolean', default: false }, viewports: { type: 'string', default: 'desktop,mobile,narrow-tall' },
} });
for (const key of ['url', 'output', 'fixture-evidence', 'playwright-module', 'expected-workspace-sha']) assert(values[key], 'Missing --' + key);
const origin = new URL(values.url).origin, output = path.resolve(values.output), expectedWorkspaceSha256 = values['expected-workspace-sha'];
assert(/^[a-f0-9]{64}$/.test(expectedWorkspaceSha256), 'Expected workspace SHA-256 must be 64 lowercase hex characters');
assert.equal(new URL(origin).hostname, '127.0.0.1');
const fixture = JSON.parse(await readFile(path.join(path.resolve(values['fixture-evidence']), 'launch.json'), 'utf8'));
assert.equal(fixture.paidModelCalls, 0); assert.equal(fixture.model, 'web-loopback-fixture');
assert.equal(new URL(fixture.providerOrigin).hostname, '127.0.0.1');
await mkdir(output, { recursive: true });
const { chromium } = await import(pathToFileURL(path.resolve(values['playwright-module'])).href);
const browser = await chromium.launch({ headless: true, executablePath: values.chromium, args: ['--no-sandbox'] });
const viewportCatalog = { desktop: { width: 1440, height: 900 }, mobile: { width: 390, height: 844 }, 'narrow-tall': { width: 320, height: 1100 } };
const cases = [];
async function runCase(viewportName) {
assert(viewportCatalog[viewportName], 'Unknown viewport: ' + viewportName);
const caseOutput = path.join(output, viewportName); await mkdir(caseOutput, { recursive: true });
const context = await browser.newContext({ viewport: viewportCatalog[viewportName] });
const page = await context.newPage(); page.setDefaultTimeout(4000);
const rpc = observeProductionRpc(page, origin), assets = [], assetsPending = [], errors = [], checks = [], observations = [];
page.on('response', response => {
  const url = new URL(response.url());
  if (url.origin === origin && url.pathname.startsWith('/deepseek/') && response.status() === 200 && /dsh-client-ui-workspace.*client\.js|dsh-client-ui-workspace\/client\.js/.test(response.url())) {
    assetsPending.push((async () => { const bytes = await response.body(); assets.push({ url: url.pathname + url.search, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }); })());
  }
});
page.on('pageerror', error => errors.push(String(error)));
page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
// Observation only: these listeners do not prevent, stop or change any event.
await page.addInitScript(() => {
  window.__workspaceKeyboardEvents = [];
  for (const type of ['keydown', 'click']) document.addEventListener(type, event => {
    const row = event.target instanceof Element ? event.target.closest('[role="treeitem"]') : null;
    if (row) window.__workspaceKeyboardEvents.push({ type, key: event.key, repeat: event.repeat,
      targetTag: event.target.tagName, targetRole: event.target.getAttribute('role'), targetLabel: event.target.getAttribute('aria-label'),
      rowKey: row.getAttribute('data-row-key'), rowText: row.textContent?.slice(0, 120), isTrusted: event.isTrusted });
  }, true);
});
const button = name => page.getByRole('button', { name, exact: true }).filter({ visible: true });
const composer = () => page.locator('[data-composer-input=true][contenteditable=true]').filter({ visible: true });
async function sidebar() { const open = button('Open sidebar'); if (await open.isVisible()) await open.click(); }
async function collapseMobile() { if (page.viewportSize().width < 700) { const close = button('Collapse sidebar'); if (await close.isVisible()) await close.click(); } }
const project = () => page.getByRole('treeitem').filter({ has: page.locator('button[aria-label="Workspace actions for project"]') });
const session = id => page.getByRole('treeitem').and(page.locator('[data-row-key="session:' + id + '"]'));
const selectedId = () => page.getByRole('treeitem').and(page.locator('[data-row-key^="session:"][aria-selected="true"]')).getAttribute('data-row-key').then(key => key?.slice('session:'.length));
const ownerId = () => page.locator('[data-conversation-content][data-conversation-session]').filter({ visible: true }).getAttribute('data-conversation-session');
const check = (label, detail) => checks.push({ label, status: 'PASS', ...(detail ? { detail } : {}) });
async function result(pending) { const outcome = await pending; if (outcome.error) throw outcome.error; assert.equal(outcome.result.ok, true, JSON.stringify(outcome.result.error)); return outcome.result; }
async function settleCreates() {
  const until = Date.now() + 12000;
  while (rpc.calls.filter(item => item.endpoint === 'session/create').length !== rpc.results.filter(item => item.endpoint === 'session/create').length) { assert(Date.now() < until, 'Prior session admissions did not settle'); await page.waitForTimeout(25); }
  assert(rpc.results.filter(item => item.endpoint === 'session/create').every(item => item.ok === true));
}
async function createNew(title) {
  await sidebar(); await settleCreates();
  const created = rpc.waitForResult('session/create');
  await button('New session').last().click();
  const response = await result(created), id = response.value?.sessionId; assert(id); let targetId = id;
  const owner = page.locator('[data-conversation-content][data-conversation-session="' + id + '"]').filter({ visible: true });
  await owner.waitFor(); await collapseMobile(); await owner.locator('[data-composer-input=true]').waitFor();
  const choose = owner.getByRole('button', { name: 'Choose workspace', exact: true });
  if (await choose.isVisible()) {
    await choose.click(); await settleCreates(); const adoption = rpc.waitForResult('session/create');
    await page.getByRole('menuitem', { name: 'project', exact: true }).click();
    const adopted = await result(adoption); assert(adopted.value?.sessionId); targetId = adopted.value.sessionId;
  }
  await collapseMobile();
  const targetOwner = page.locator('[data-conversation-content][data-conversation-session="' + targetId + '"]').filter({ visible: true });
  await targetOwner.waitFor(); assert.equal(await targetOwner.count(), 1, 'The admitted target must own one visible conversation');
  const targetInput = targetOwner.locator('[data-composer-input=true][contenteditable=true]').filter({ visible: true });
  await targetInput.waitFor(); assert.equal(await targetInput.count(), 1, 'The admitted target must own one editable composer');
  await targetInput.fill(title);
  const prompted = rpc.waitForResult('session/prompt'); await targetOwner.getByRole('button', { name: 'Send message', exact: true }).click(); await result(prompted);
  await targetOwner.getByRole('heading', { name: 'Actual Harness browser answer', exact: true }).last().waitFor({ timeout: 15000 });
  await targetOwner.locator('pre code').filter({ hasText: 'export const value = 1;' }).last().waitFor({ timeout: 15000 });
  await targetOwner.getByRole('button', { name: 'Stop generating', exact: true }).waitFor({ state: 'hidden', timeout: 15000 });
  await sidebar(); assert.equal(await selectedId(), targetId, 'The actual admitted target must be selected'); await session(targetId).getByText(title, { exact: true }).waitFor();
  observations.push({ name: 'setup-admitted-owner', sessionId: targetId }); return targetId;
}
async function openMenuPointer(row, label) { await row.hover(); await row.getByRole('button', { name: label }).click(); }
async function archivePointer(id) {
  await openMenuPointer(session(id), /^Session actions for /);
  const archived = rpc.waitForResult('workspace/archiveSession');
  await page.getByRole('menuitem', { name: 'Archive session', exact: true }).click(); await result(archived);
  await session(id).waitFor({ state: 'hidden' });
}
async function openSearch(query) {
  await button('Search sessions').click();
  const searched = rpc.waitForResult('session/search', 30000);
  await page.getByPlaceholder('Search session names', { exact: true }).fill(query);
  await result(searched);
  await page.getByRole('treeitem').filter({ hasText: query }).first().waitFor();
}
async function treeSnapshot() { return page.getByRole('treeitem').evaluateAll(nodes => nodes.map(row => ({
  text: row.textContent, key: row.getAttribute('data-row-key'), tabIndex: row.tabIndex, selected: row.getAttribute('aria-selected'),
  actions: [...row.querySelectorAll('button')].map(action => ({ label: action.getAttribute('aria-label'), visible: action.getClientRects().length > 0 })),
}))); }
async function tabCycle(anchor, count = 42) {
  await anchor.focus(); const trace = [];
  for (let index = 0; index < count; index++) { await page.keyboard.press('Tab'); trace.push(await page.evaluate(() => ({
    tag: document.activeElement.tagName, role: document.activeElement.getAttribute('role'),
    key: document.activeElement.getAttribute('data-row-key'), label: document.activeElement.getAttribute('aria-label'),
    text: document.activeElement.textContent?.slice(0, 100),
  }))); }
  return trace;
}
async function activeMatches(locator) { return locator.evaluateAll(nodes => nodes.length === 1 && nodes[0] === document.activeElement); }
async function tabTo(locator, anchor = button('Search sessions')) {
  await anchor.focus(); const trace = [];
  for (let index = 0; index < 60; index++) {
    await page.keyboard.press('Tab');
    const entry = await page.evaluate(() => ({ tag: document.activeElement.tagName, role: document.activeElement.getAttribute('role'), key: document.activeElement.getAttribute('data-row-key'), label: document.activeElement.getAttribute('aria-label') }));
    trace.push(entry); if (await activeMatches(locator)) { observations.push({ name: 'native-tab-path', trace }); return; }
  }
  observations.push({ name: 'native-tab-path-failed', trace }); throw Error('Native Tab did not reach expected row/action');
}
async function eventsSince(index) { return page.evaluate(from => window.__workspaceKeyboardEvents.slice(from), index); }
const eventCount = () => page.evaluate(() => window.__workspaceKeyboardEvents.length);
const createCalls = () => rpc.calls.filter(item => item.endpoint === 'session/follow' && item.route === 'open').length;
async function frames() { await page.evaluate(() => new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done)))); }
async function rowKey(locator, key, { navigates = false, id } = {}) {
  const from = await eventCount(), beforeNavigationSubscriptions = createCalls();
  await page.keyboard.press(key);
  if (navigates) { assert(id); const owner = page.locator('[data-conversation-content][data-conversation-session="' + id + '"]').filter({ visible: true }); await owner.waitFor(); await collapseMobile(); await owner.locator('[data-composer-input=true][contenteditable=true]').waitFor(); }
  await frames();
  const events = await eventsSince(from), clicks = events.filter(item => item.type === 'click');
  assert.equal(clicks.length, 1, 'Row keyboard activation must dispatch exactly one click');
  assert.equal(clicks[0].targetRole, 'treeitem', 'Keyboard must activate the focused row itself');
  assert.equal(createCalls(), beforeNavigationSubscriptions + (navigates ? 1 : 0), 'Row activation must not create duplicate navigation subscriptions');
  observations.push({ name: 'row-keyboard', key, beforeNavigationSubscriptions, afterNavigationSubscriptions: createCalls(), events });
}
async function nestedKey(locator, key, menuName) {
  await tabTo(locator); const from = await eventCount(), owner = await ownerId(), expanded = await project().getAttribute('aria-expanded'), beforeNavigationSubscriptions = createCalls();
  await page.keyboard.press(key); await page.getByRole('menuitem', { name: menuName, exact: true }).waitFor(); await frames();
  assert.equal(await ownerId(), owner, 'Nested action must keep current selected session');
  assert.equal(await project().getAttribute('aria-expanded'), expanded, 'Nested action must not toggle the project');
  assert.equal(createCalls(), beforeNavigationSubscriptions, 'Nested action must not admit a row navigation');
  const events = await eventsSince(from), clicks = events.filter(item => item.type === 'click');
  assert.equal(clicks.length, 1); assert.equal(clicks[0].targetTag, 'BUTTON', 'Nested native button key must not dispatch a row click');
  observations.push({ name: 'nested-action-keyboard', key, owner, expanded, beforeNavigationSubscriptions, afterNavigationSubscriptions: createCalls(), events });
}
async function geometry(locator, name) { const detail = await locator.evaluate(node => { const { x,y,width,height } = node.getBoundingClientRect(); return { x,y,width,height, viewportWidth:innerWidth,viewportHeight:innerHeight, documentWidth:document.documentElement.scrollWidth }; }); assert(detail.width > 0 && detail.height > 0 && detail.x >= 0 && detail.x + detail.width <= detail.viewportWidth + 1); assert(detail.documentWidth <= detail.viewportWidth + 1); observations.push({ name, geometry: detail }); }
async function greenAcceptance({ idA, idB, titleA, titleB }) {
  await sidebar(); await tabTo(project());
  const outline = await project().evaluate(node => ({ focusVisible: node.matches(':focus-visible'), outline: getComputedStyle(node).outline, width: getComputedStyle(node).outlineWidth }));
  assert(outline.focusVisible); assert(parseFloat(outline.width) > 0); check('native Tab reaches project with visible focus outline', outline);
  assert.equal(await project().getAttribute('aria-expanded'), 'true');
  await rowKey(project(), 'Enter'); assert.equal(await project().getAttribute('aria-expanded'), 'false');
  await rowKey(project(), 'Space'); assert.equal(await project().getAttribute('aria-expanded'), 'true');
  check('project Enter collapses and Space expands exactly once');
  const workspaceMenu = project().getByRole('button', { name: 'Workspace actions for project', exact: true });
  await nestedKey(workspaceMenu, 'Enter', 'Rename'); await geometry(workspaceMenu, 'project-menu-anchor-geometry'); await page.keyboard.press('Escape'); await frames(); assert(await activeMatches(workspaceMenu)); await page.getByRole('menuitem', { name: 'Rename', exact: true }).waitFor({ state: 'hidden' }); check('project menu Escape restores keyboard focus to the anchor');
  await nestedKey(workspaceMenu, 'Space', 'Rename');
  await page.getByRole('menuitem', { name: 'Rename', exact: true }).click();
  await page.getByRole('textbox', { name: 'Workspace name', exact: true }).waitFor();
  await button('Cancel').click(); assert.equal(await project().getByText('project', { exact: true }).count(), 1);
  check('project menu is keyboard reachable by Enter/Space; nested button never toggles or navigates; rename dialog cancels without mutating fixture');
  for (const key of ['Enter', 'Space']) {
    const newSession = project().getByRole('button', { name: 'New session in project', exact: true }); await tabTo(newSession);
    const expanded = await project().getAttribute('aria-expanded'), from = await eventCount(), beforeCreates = rpc.calls.filter(item => item.endpoint === 'session/create').length;
    const created = rpc.waitForResult('session/create'); await page.keyboard.press(key); const response = await result(created); assert(response.value?.sessionId);
    await page.locator('[data-conversation-content][data-conversation-session="' + response.value.sessionId + '"]').filter({ visible: true }).waitFor(); await sidebar(); await frames();
    assert.equal(await project().getAttribute('aria-expanded'), expanded); assert.equal(rpc.calls.filter(item => item.endpoint === 'session/create').length, beforeCreates + 1);
    const events = await eventsSince(from), clicks = events.filter(item => item.type === 'click'); assert.equal(clicks.length, 1); assert.equal(clicks[0].targetTag, 'BUTTON');
    observations.push({ name: 'project-new-session-keyboard', key, expanded, sessionId: response.value.sessionId, beforeCreates, afterCreates: rpc.calls.filter(item => item.endpoint === 'session/create').length, events });
    await tabTo(session(idB)); await rowKey(session(idB), 'Enter', { navigates: true, id: idB }); await sidebar();
  }
  check('project New session native Enter/Space admits exactly one actual session and never toggles project');
  await tabTo(session(idA)); await rowKey(session(idA), 'Enter', { navigates: true, id: idA });
  await sidebar();
  assert.equal(await selectedId(), idA); check('session row Enter opens the intended actual session with one navigation subscription');
  await tabTo(session(idB)); await rowKey(session(idB), 'Space', { navigates: true, id: idB }); await sidebar();
  assert.equal(await selectedId(), idB); check('session row Space opens the intended actual session with one navigation subscription');
  await button('Search sessions').focus(); await page.mouse.move(page.viewportSize().width - 4, page.viewportSize().height - 4);
  const selectedMenu = session(idB).getByRole('button', { name: /^Session actions for / });
  assert(await selectedMenu.isVisible()); await geometry(selectedMenu, 'selected-session-action-geometry'); assert.equal(await session(idB).evaluate(node => node.matches(':hover') || node.matches(':focus-within')), false);
  await selectedMenu.click(); await page.getByRole('menuitem', { name: 'Rename', exact: true }).waitFor(); await page.keyboard.press('Escape');
  check('selected session menu stays visible and is actually clickable after pointer and focus leave the row');
  const otherMenu = session(idA).getByRole('button', { name: /^Session actions for / });
  await nestedKey(otherMenu, 'Enter', 'Rename'); await page.keyboard.press('Escape'); await frames(); assert(await activeMatches(otherMenu)); await page.getByRole('menuitem', { name: 'Rename', exact: true }).waitFor({ state: 'hidden' }); check('session menu Escape restores keyboard focus to the anchor');
  await nestedKey(otherMenu, 'Space', 'Rename');
  await page.getByRole('menuitem', { name: 'Rename', exact: true }).click(); await page.getByRole('textbox', { name: 'Session name', exact: true }).waitFor(); await button('Cancel').click();
  assert.equal(await selectedId(), idB); check('nonselected session nested menu Enter/Space preserves owner and has no extra row navigation subscription; original rename dialog works');
  for (const [key, title, id] of [['Enter', titleA, idA], ['Space', titleB, idB]]) {
    await openSearch(title); const searchRow = page.getByRole('treeitem').filter({ hasText: title });
    await tabTo(searchRow, page.getByPlaceholder('Search session names', { exact: true })); await rowKey(searchRow, key, { navigates: true, id }); await sidebar();
    assert.equal(await selectedId(), id); check('search result ' + key + ' opens intended session exactly once');
  }
  await archivePointer(idA); await button('View options').click(); await page.getByRole('menuitem', { name: 'All conversations (show archived)', exact: true }).click();
  await openSearch(titleA); let archived = page.getByRole('treeitem').filter({ hasText: titleA });
  await tabTo(archived, page.getByPlaceholder('Search session names', { exact: true }));
  const unarchive = archived.getByRole('button', { name: 'Unarchive session', exact: true }); assert(await unarchive.isVisible()); await geometry(unarchive, 'search-unarchive-action-geometry');
  const before = createCalls(), owner = await ownerId(), from = await eventCount();
  await page.keyboard.press('Tab'); assert(await activeMatches(unarchive));
  const recovered = rpc.waitForResult('workspace/unarchiveSession'); await page.keyboard.press('Space'); await result(recovered); await frames();
  assert.equal(await ownerId(), owner); assert.equal(createCalls(), before); assert.equal(await page.getByPlaceholder('Search session names', { exact: true }).inputValue(), titleA);
  const events = await eventsSince(from), clicks = events.filter(item => item.type === 'click'); assert.equal(clicks.length, 1); assert.equal(clicks[0].targetTag, 'BUTTON');
  await unarchive.waitFor({ state: 'hidden' }); observations.push({ name: 'archived-search-unarchive', owner, beforeNavigationSubscriptions: before, afterNavigationSubscriptions: createCalls(), events });
  check('archived search row Tab reveals native Unarchive button; Space performs real recovery once without opening row or changing owner');
  await page.getByPlaceholder('Search session names', { exact: true }).focus(); await page.keyboard.press('Escape');
  await session(idA).waitFor(); await tabTo(session(idA));
  const pin = session(idA).getByRole('button', { name: 'Pin session', exact: true });
  await tabTo(pin); const ownerBeforePin = await ownerId(), pinCreates = createCalls(); const pinned = rpc.waitForResult('workspace/pinSession'); await page.keyboard.press('Enter'); await result(pinned); await frames();
  assert.equal(await ownerId(), ownerBeforePin); assert.equal(createCalls(), pinCreates);
  const unpin = session(idA).getByRole('button', { name: 'Unpin session', exact: true }); await unpin.waitFor(); await tabTo(unpin);
  const unpinned = rpc.waitForResult('workspace/unpinSession'); await page.keyboard.press('Space'); await result(unpinned); await frames();
  assert.equal(await ownerId(), ownerBeforePin); assert.equal(createCalls(), pinCreates); check('real pin/unpin reorder keeps same session identity reachable and does not navigate');
  await button('View options').click(); await page.getByRole('menuitem', { name: 'Hide archived', exact: true }).click();
}
let failure;
try {
  await page.goto(origin, { waitUntil: 'domcontentloaded' }); await page.locator('[data-composer-input=true]').filter({ visible: true }).waitFor({ timeout: 10000 });
  const titleA = 'Keyboard actions A ' + Date.now(), titleB = 'Keyboard actions B ' + Date.now();
  const idA = await createNew(titleA), idB = await createNew(titleB);
  await page.mouse.move(page.viewportSize().width - 4, page.viewportSize().height - 4); await button('Search sessions').focus();
  if (values.baseline) {
    const normal = { name: 'normal-tree-keyboard', rows: await treeSnapshot(), trace: await tabCycle(button('Search sessions')) };
    assert(normal.rows.some(row => row.key?.startsWith('workspace:'))); assert(normal.rows.some(row => row.key === 'session:' + idB));
    assert(normal.rows.every(row => row.tabIndex === -1)); assert(normal.rows.every(row => row.actions.every(action => !action.visible)));
    assert(normal.trace.every(item => item.role !== 'treeitem' && !/^Session actions for |^Workspace actions for /.test(item.label ?? '')));
    observations.push(normal); check('old production UI native Tab skips project/session rows and their selected-session actions', { selectedId: idB });
    await archivePointer(idB); await button('View options').click(); await page.getByRole('menuitem', { name: 'All conversations (show archived)', exact: true }).click(); await openSearch(titleB); await page.mouse.move(page.viewportSize().width - 4, page.viewportSize().height - 4);
    const archived = page.getByRole('treeitem').filter({ hasText: titleB });
    assert.equal(await archived.getByRole('button', { name: 'Unarchive session', exact: true, includeHidden: true }).count(), 1);
    const search = { name: 'archived-search-keyboard', rows: await treeSnapshot(), trace: await tabCycle(page.getByPlaceholder('Search session names', { exact: true })) };
    assert(search.rows.every(row => row.tabIndex === -1)); assert(search.rows.every(row => row.actions.every(action => !action.visible)));
    assert(search.trace.every(item => item.role !== 'treeitem' && item.label !== 'Unarchive session'));
    observations.push(search); check('old production UI native Tab skips archived search result and Unarchive session');
    await page.screenshot({ path: path.join(caseOutput, 'archived-search.png'), fullPage: true });
  } else {
    await greenAcceptance({ idA, idB, titleA, titleB });
  }
} catch (error) { failure = String(error.stack ?? error); }
await rpc.settled(); const assetOutcomes = await Promise.allSettled(assetsPending);
try {
  assert(assetOutcomes.every(item => item.status === 'fulfilled'), 'Actual served workspace asset body observation failed');
  assert(assets.length > 0, 'No actual served workspace asset bytes observed');
  assert(assets.every(item => item.sha256 === expectedWorkspaceSha256), 'Actual workspace asset differs from the independently expected SHA-256');
  assert(assets.every(item => /[?&]rev=([a-f0-9]{12})$/.exec(item.url)?.[1] === item.sha256.slice(0, 12)), 'Actual workspace asset bytes do not match their requested revision');
  assert.equal(new Set(assets.map(item => item.sha256)).size, 1, 'Browser received mixed workspace asset identities');
  check('actual served workspace asset bytes match their requested revision', assets[0]);
} catch (error) { failure ??= String(error.stack ?? error); }
if (rpc.externalRequests.length || errors.length || rpc.results.some(item => item.ok === false)) failure ??= 'Unexpected production UI, external network or RPC error';
const report = { expectedWorkspaceSha256, name: 'workspace-keyboard-actions', viewport: viewportName, status: failure ? 'FAIL' : values.baseline ? 'RED_BASELINE_CONFIRMED' : 'PASS', assertions: checks.length, paidModelCalls: fixture.paidModelCalls, complete: !failure, mode: values.baseline ? 'baseline-inaccessible-observation' : 'keyboard-acceptance',
  scope: 'Real production host UI with read-only DOM/network/event observation; no element/style mutation, handler substitution or RPC mocks; not historical Windows timeout attribution',
  historicalWindowsTimeoutRootCause: 'NOT_PROVEN', engine: { platform: process.platform, node: process.version, chromium: browser.version(), playwright: JSON.parse(await readFile(path.join(path.dirname(values['playwright-module']), 'package.json'), 'utf8')).version },
  fixture: { launchId: fixture.launchId, compiledDigest: fixture.compiledDigest, paidModelCalls: fixture.paidModelCalls },
  assets, checks, observations, events: await page.evaluate(() => window.__workspaceKeyboardEvents), calls: rpc.calls, results: rpc.results,
  errors, externalRequests: rpc.externalRequests, ...(failure ? { failure } : {}) };
await page.screenshot({ path: path.join(caseOutput, 'final.png'), fullPage: true });
await writeFile(path.join(caseOutput, 'result.json'), JSON.stringify(report, null, 2) + '\n');
await context.close(); return report;
}
try { for (const viewportName of values.viewports.split(',')) cases.push(await runCase(viewportName)); } finally { await browser.close(); }
const report = { expectedWorkspaceSha256, mode: values.baseline ? 'baseline-inaccessible-observation' : 'keyboard-acceptance', engine: { platform: process.platform }, status: cases.every(item => item.complete) ? values.baseline ? 'RED_BASELINE_CONFIRMED' : 'PASS' : 'FAIL', complete: cases.every(item => item.complete), cases, assertions: cases.reduce((sum, item) => sum + item.assertions, 0), paidModelCalls: 0, historicalWindowsTimeoutRootCause: 'NOT_PROVEN' };
await writeFile(path.join(output, 'result.json'), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({ output, status: report.status, assertions: report.assertions, cases: cases.map(({ viewport, status, failure }) => ({ viewport, status, failure })) }, null, 2));
if (!report.complete) process.exitCode = 1;
