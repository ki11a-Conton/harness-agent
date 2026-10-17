import assert from 'node:assert/strict';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
const { values } = parseArgs({ options: { url: { type: 'string' }, output: { type: 'string' }, 'fixture-root': { type: 'string' }, 'playwright-module': { type: 'string' } } });
assert(values.url && values.output && values['fixture-root'] && values['playwright-module']);
const { chromium } = await import(pathToFileURL(resolve(values['playwright-module'])).href);
const browser = await chromium.launch({ executablePath: '/usr/bin/chromium', headless: true, args: ['--no-sandbox'] });
const checks = [], errors = [], actions = [];
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await context.newPage();
page.on('pageerror', error => errors.push(error.message));
page.on('request', request => {
  if (request.method() !== 'POST' || !request.url().endsWith('/api/deepseek/call')) return;
  try { const body = JSON.parse(request.postData()); if (body.endpoint === 'session/prompt') actions.push(body.args.request); } catch {}
});
const checked = name => checks.push({ name, status: 'PASS' });
const panel = page.locator('[data-harness-coding="panel"]');
const state = panel.locator('#state');
async function refreshUntil(pattern) {
  for (let i = 0; i < 30; i++) { await panel.locator('#refresh').click(); if (pattern.test(await state.innerText())) return; await page.waitForTimeout(250); }
  throw new Error('State did not reach ' + pattern + ': ' + await state.innerText());
}
async function sendMain(text) {
  const input = page.locator('[data-composer-input=true][contenteditable=true]').filter({ visible: true });
  await input.fill(text); await page.getByRole('button', { name: 'Send message', exact: true }).filter({ visible: true }).first().click();
}
async function sendPanel(text) {
  await panel.locator('#prompt').fill(text); await panel.locator('#continue').click();
  await panel.locator('#notice').filter({ hasText: /后端接收|accepted by the backend/ }).waitFor({ timeout: 15000 });
}
try {
  await page.goto(values.url); await page.locator('[data-composer-input=true]').waitFor({ timeout: 15000 });
  await page.getByRole('button', { name: 'Choose workspace', exact: true }).click();
  await page.getByRole('menuitem', { name: 'project', exact: true }).click();
  await sendMain('[fixture:read] Review the current demo.js.');
  await page.locator('pre code').filter({ hasText: 'export const value = 1;' }).last().waitFor({ timeout: 20000 });
  await page.getByRole('button', { name: 'Stop generating', exact: true }).waitFor({ state: 'hidden', timeout: 15000 });
  await panel.locator('#launch').click(); await panel.locator('#session option').first().waitFor({ state: 'attached' });
  await refreshUntil(/任务已结束.*未运行验收|Task ended.*Not verified/); checked('Unverified real model turn is displayed as unverified, not passed');
  const sessionId = await panel.locator('#session').inputValue(); assert(sessionId); checked('Actual authorized session list and status remote are connected');
  await sendPanel('[fixture:slow] Continue the current review.'); await refreshUntil(/运行中|Running/);
  await panel.locator('#cancel').click(); await refreshUntil(/已取消|Cancelled/); checked('Stop button cancels the real Runtime turn before displaying cancellation');
  await sendPanel('[fixture:read] Resume the current coding task.'); await refreshUntil(/任务已结束.*未运行验收|Task ended.*Not verified/);
  assert.equal(actions.filter(item => item.content[0].text.includes('Resume')).length, 1); checked('Continue button submits exactly one actual prompt and completes a follow-up');
  await panel.locator('#close').click();
  await sendMain('[fixture:write] Write the actual browser-created.txt after approval.');
  await page.getByRole('button', { name: 'Allow once', exact: true }).waitFor({ state: 'visible', timeout: 15000 });
  await page.getByRole('button', { name: 'Allow once', exact: true }).click();
  await page.getByRole('button', { name: 'Stop generating', exact: true }).waitFor({ state: 'hidden', timeout: 20000 });
  assert.equal(await readFile(resolve(values['fixture-root'], 'project/browser-created.txt'), 'utf8'), 'Actual approved browser coding output\n');
  checked('An actual approved edit reached disk');
  await panel.locator('#launch').click(); await panel.locator('#session').selectOption(sessionId);
  await refreshUntil(/任务已结束|Task ended/);
  await panel.locator('#files a').filter({ hasText: 'browser-created.txt' }).waitFor({ timeout: 10000 });
  assert.match(await panel.locator('#files a').filter({ hasText: 'browser-created.txt' }).getAttribute('href'), /^vscode:\/\/file\//);
  checked('Successful edit has a scoped, encoded VS Code URI without claiming a server launcher');
  for (let i = 0; i < 20 && await panel.locator('#diff').isDisabled(); i++) { await panel.locator('#refresh').click(); await page.waitForTimeout(200); }
  assert.equal(await panel.locator('#diff').isEnabled(), true);
  await panel.locator('#diff').click(); await panel.locator('#changes').filter({ hasText: 'browser-created.txt' }).waitFor({ timeout: 15000 });
  checked('Diff button reads the actual captured workspace comparison');
  await mkdir(values.output, { recursive: true }); await page.screenshot({ path: resolve(values.output, 'coding-status-desktop.png') });
  await page.setViewportSize({ width: 390, height: 844 }); await page.waitForTimeout(100);
  assert(await panel.locator('dialog').evaluate(element => element.getBoundingClientRect().width <= innerWidth));
  await page.screenshot({ path: resolve(values.output, 'coding-status-mobile.png') }); checked('Record panel fits a mobile viewport');
  await context.setOffline(true); await panel.locator('#prompt').fill('Do not silently duplicate this uncertain request.'); await panel.locator('#continue').click();
  await panel.locator('#error').filter({ hasText: /提交状态未知|Submission uncertain/ }).waitFor({ timeout: 10000 });
  await context.setOffline(false); await panel.locator('#refresh').click();
  assert.equal(await panel.locator('#continue').isDisabled(), true); checked('Transport failure stays visibly uncertain and cannot auto-resubmit a new action');
  await panel.locator('#retry').click(); await refreshUntil(/任务已结束|Task ended/);
  const retried = actions.filter(item => item.content[0].text.includes('uncertain request'));
  assert(retried.length >= 2); assert.equal(new Set(retried.map(item => item.requestId)).size, 1);
  checked('Explicit retry reuses the identical durable request ID');
  assert.deepEqual(errors, []); checked('No browser page errors');
  const launch = JSON.parse(await readFile(resolve(values['fixture-root'], 'evidence/launch.json'), 'utf8'));
  assert.equal(launch.paidModelCalls, 0);
  const requests = (await readFile(resolve(values['fixture-root'], 'evidence/requests.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  assert(requests.some(request => request.messages.some(message => message.role === 'system' && message.content.includes('Policy: coding-v2'))));
  assert(requests.some(request => request.tools.includes('memory_search') && request.tools.includes('session_search')));
  checked('Production Web requests actually use coding-v2 and advertise enabled on-demand memory');
  await writeFile(resolve(values.output, 'browser.json'), JSON.stringify({ verdict: 'PASS', paidCalls: 0, checks, actualPromptActions: actions.length, browser: browser.version(), compiledDigest: launch.compiledDigest, limits: 'Real browser/Runtime with loopback model fixture; not real model quality or physical mobile/Windows evidence.' }, null, 2) + '\n');
  console.log(JSON.stringify({ verdict: 'PASS', checks: checks.length }));
} catch (error) {
  await mkdir(values.output, { recursive: true }); await page.screenshot({ path: resolve(values.output, 'failure.png') }).catch(() => {});
  await writeFile(resolve(values.output, 'failure.json'), JSON.stringify({ error: error.message, checks, errors }, null, 2)); throw error;
} finally { await browser.close(); }
