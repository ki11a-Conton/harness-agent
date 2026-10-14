#!/usr/bin/env node
/** Production browser branding acceptance. No interception, DOM replacement or paid model. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { markPath } from './web-branding-lib.mjs';
const { values } = parseArgs({ options: {
  output: { type: 'string' }, 'playwright-module': { type: 'string' },
  chromium: { type: 'string', default: '/usr/bin/chromium' }, 'portable-root': { type: 'string' },
} });
assert(values.output && values['playwright-module'], 'Use --output NEW_DIR --playwright-module FILE');
const output = path.resolve(values.output);
await mkdir(output, { recursive: true });
const playwright = await import(pathToFileURL(path.resolve(values['playwright-module'])).href);
const browser = await playwright.chromium.launch({ headless: true, executablePath: values.chromium, args: ['--no-sandbox'] });
const fixtureScript = fileURLToPath(new URL('./deepseek-live-host.mjs', import.meta.url));
const results = [];
const timeout = (promise, ms, label) => new Promise((done, reject) => {
  const timer = setTimeout(() => reject(new Error(label)), ms);
  promise.then(value => { clearTimeout(timer); done(value); }, error => { clearTimeout(timer); reject(error); });
});
const copy = {
  en: { continue: 'Continue', settings: 'Settings', close: 'Close', models: 'Models', plugins: 'Plugins', inventory: 'Built-in plugins', about: 'About plugins', dark: 'Dark', light: 'Light' },
  zh: { continue: '继续', settings: '设置', close: '关闭', models: '模型', plugins: '插件', inventory: '内置插件', about: '插件说明', dark: '深色', light: '浅色' },
};
const viewportCatalog = { desktop: { width: 1440, height: 900 }, mobile: { width: 390, height: 844 }, 'narrow-tall': { width: 320, height: 1100 } };
try {
  for (const language of ['en', 'zh']) for (const [viewport, dimensions] of Object.entries(viewportCatalog)) {
    const name = language + '-' + viewport, directory = path.join(output, name);
    await mkdir(directory, { recursive: true });
    const args = [fixtureScript, '--root', path.join(directory, 'fixture'), '--ipc-control'];
    if (values['portable-root']) args.push('--portable-root', path.resolve(values['portable-root']));
    const host = spawn(process.execPath, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
    let stdout = '', stderr = '';
    const exit = new Promise((done, reject) => { host.once('exit', (code, signal) => done({ code, signal })); host.once('error', reject); });
    const ready = new Promise((done, reject) => {
      host.stdout.on('data', bytes => { stdout += bytes; const match = stdout.match(/http:\/\/127\.0\.0\.1:\d+/); if (match) done(match[0]); });
      host.stderr.on('data', bytes => { stderr += bytes; });
      exit.then(result => reject(new Error('Host exited before ready: ' + JSON.stringify(result) + stderr)), reject);
    });
    let context;
    const checks = [], surfaces = [], errors = [], externalRequests = [];
    let failure;
    try {
      const origin = await timeout(ready, 60000, 'Host readiness exceeded deadline');
      context = await browser.newContext({ viewport: dimensions, locale: language === 'en' ? 'en-US' : 'zh-CN' });
      const page = await context.newPage();
      page.on('pageerror', error => errors.push(error.message));
      page.on('request', request => { const url = request.url(); if (/^https?:/.test(url) && new URL(url).origin !== origin) externalRequests.push(url); });
      const button = text => page.getByRole('button', { name: text, exact: true }).filter({ visible: true }).first();
      async function scan(label, requireMark = false) {
        const surface = await page.evaluate(() => {
          const visible = element => element.getClientRects().length > 0 && getComputedStyle(element).visibility !== 'hidden';
          return { title: document.title, language: document.documentElement.lang, text: document.body.innerText,
            labels: [...document.querySelectorAll('[aria-label],[title],[placeholder],img[alt]')].filter(visible)
              .flatMap(element => ['aria-label', 'title', 'placeholder', 'alt'].map(key => element.getAttribute(key)).filter(Boolean)),
            marks: [...document.querySelectorAll('[data-harness-brand="mark"]')].filter(visible).map(element => element.querySelector('path')?.getAttribute('d')),
            whaleSvgs: [...document.querySelectorAll('svg')].filter(visible).filter(element =>
              /23\.16 17\.04/.test(element.getAttribute('viewBox') ?? '') || element.querySelector('[id^="dsh-wordmark-"]')).length,
            images: [...document.querySelectorAll('img')].filter(visible).map(element => element.getAttribute('src')?.slice(0, 200)),
            overflow: document.documentElement.scrollWidth > innerWidth,
          };
        });
        assert(!/deepseek[\s\u2014_-]*harness/i.test(JSON.stringify(surface)), label + ': upstream product branding visible');
        assert(!/Preview Notice|预览版说明/.test(surface.text), label + ': preview notice visible');
        assert.equal(surface.whaleSvgs, 0, label + ': upstream whale/wordmark rendered');
        assert(!surface.images.some(src => /onboarding-welcome|favicon-dark|\/deepseek\/favicon\.svg/.test(src ?? '')), label + ': original illustration visible');
        assert(!surface.overflow, label + ': horizontal overflow');
        if (requireMark) {
          assert(surface.marks.length > 0, label + ': actual brand slot must render');
          assert(surface.marks.every(value => value === markPath), label + ': incorrect mark artwork');
        }
        checks.push(label); surfaces.push({ label, ...surface });
        await page.screenshot({ path: path.join(directory, label + '.png'), fullPage: true, timeout: 15000 });
      }
      await page.goto(origin, { waitUntil: 'domcontentloaded' });
      await page.locator('[data-composer-input=true]').waitFor({ state: 'visible', timeout: 15000 });
      await page.locator('[data-harness-brand="mark"]').first().waitFor({ state: 'attached', timeout: 10000 });
      await scan('first-start', true);
      assert.equal(await button(copy[language].continue).count(), 0, 'fresh startup requires no preview acknowledgement');
      assert.equal(await page.getByText(/^(Preview|预览版)$/).count(), 0, 'home has no preview badge');
      checks.push('no-preview-notice');
      await scan('empty-conversation', true);
      assert.equal(await page.title(), 'Harness Agent'); checks.push('document-title');
      const manifest = await (await page.request.get(origin + '/deepseek/manifest.webmanifest')).json();
      assert.equal(manifest.name, 'Harness Agent'); assert.equal(manifest.short_name, 'Harness Agent');
      assert.equal(manifest.icons[0].src, '/deepseek/harness-brand/favicon.svg');
      const favicon = await page.locator('link[rel=icon]').getAttribute('href'); assert.equal(favicon, manifest.icons[0].src);
      const icon = await page.request.get(origin + favicon); assert.equal(icon.status(), 200); assert((await icon.text()).includes(markPath));
      checks.push('manifest-and-favicon');
      await button(copy[language].settings).click();
      await scan('settings-general');
      await button(copy[language].dark).click();
      await page.waitForFunction(() => document.documentElement.style.colorScheme === 'dark');
      await scan('settings-dark');
      await button(copy[language].light).click();
      await page.waitForFunction(() => document.documentElement.style.colorScheme === 'light');
      await scan('settings-light');
      await button(copy[language].models).click();
      await scan('settings-models');
      await button(copy[language].inventory).click();
      await page.getByRole('searchbox', { name: language === 'en' ? 'Search plugins' : '搜索插件', exact: true }).fill('Harness Agent');
      await page.getByText('Harness Agent · ui brand official', { exact: true }).first().waitFor({ state: 'visible', timeout: 10000 });
      await scan('component-inventory'); checks.push('component-display-names');
      await button(copy[language].close).click();
      await button(copy[language].plugins).click();
      await scan('plugins');
      await button(copy[language].about).click(); await scan('plugins-help');
      await page.goto(origin, { waitUntil: 'domcontentloaded' });
      await page.locator('[data-composer-input=true]').waitFor({ state: 'visible' });
      await scan('reload', true);
      await page.goto(origin + '/legacy/index.html', { waitUntil: 'domcontentloaded' });
      await scan('legacy');
      assert.deepEqual(errors, [], 'Browser boot errors'); assert.deepEqual(externalRequests, [], 'No external branding requests');
      checks.push('no-browser-errors-or-external-assets');
      const launch = JSON.parse(await readFile(path.join(directory, 'fixture/evidence/launch.json'), 'utf8'));
      assert.equal(launch.paidModelCalls, 0);
    } catch (error) {
      failure = error.stack;
      const page = context?.pages()[0];
      if (page) {
        await writeFile(path.join(directory, 'failure-text.txt'), await page.locator('body').innerText().catch(() => 'Page unavailable'));
        await page.screenshot({ path: path.join(directory, 'failure.png'), timeout: 10000 }).catch(() => {});
      }
    }
    finally {
      await context?.close();
      if (host.exitCode === null && host.signalCode === null) { if (host.connected) host.send({ type: 'fixture-stop' }); else host.kill('SIGTERM'); }
      try { const result = await timeout(exit, 15000, 'Host close deadline'); if (result.code !== 0) failure ??= 'Host close failed: ' + JSON.stringify(result); }
      catch (error) { failure ??= error.message; host.kill('SIGKILL'); }
      await writeFile(path.join(directory, 'host-stdout.log'), stdout); await writeFile(path.join(directory, 'host-stderr.log'), stderr);
    }
    const result = { name, language, viewport, status: failure ? 'FAIL' : 'PASS', checks, surfaces, errors, externalRequests, ...(failure ? { failure } : {}) };
    results.push(result); await writeFile(path.join(directory, 'result.json'), JSON.stringify(result, null, 2) + '\n');
    console.log(JSON.stringify({ name, status: result.status, assertions: checks.length, ...(failure ? { failure } : {}) }));
  }
} finally { await browser.close(); }
const receipt = { status: results.length === 6 && results.every(result => result.status === 'PASS') ? 'PASS' : 'FAIL',
  chromium: browser.version(), node: process.version, installed: Boolean(values['portable-root']), scenarios: results.length,
  assertions: results.reduce((sum, result) => sum + result.checks.length, 0), paidModelCalls: 0,
  scope: 'Actual production UI: fresh first-run English/Chinese across desktop/mobile/narrow-tall viewport sizes; not a physical mobile OS claim.',
  results: results.map(({ surfaces, ...result }) => result) };
await writeFile(path.join(output, 'result.json'), JSON.stringify(receipt, null, 2) + '\n');
if (receipt.status !== 'PASS') process.exitCode = 1;
