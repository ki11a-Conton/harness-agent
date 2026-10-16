#!/usr/bin/env node
/** Actual host loss/restart, browser network hints and connection chrome. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
const { values } = parseArgs({ options: { output: { type: 'string' }, 'playwright-module': { type: 'string' }, chromium: { type: 'string', default: '/usr/bin/chromium' }, 'portable-root': { type: 'string' }, 'fixture-script': { type: 'string' } } });
assert(values.output && values['playwright-module']);
const output = path.resolve(values.output); await mkdir(output, { recursive: true });
const fixture = values['fixture-script'] ?? fileURLToPath(new URL('./deepseek-live-host.mjs', import.meta.url));
const { chromium } = await import(pathToFileURL(path.resolve(values['playwright-module'])).href);
const browser = await chromium.launch({ headless: true, executablePath: values.chromium, args: ['--no-sandbox'] });
const timeout = (promise, ms, label) => new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error(label)), ms);
  promise.then(value => { clearTimeout(timer); resolve(value); }, error => { clearTimeout(timer); reject(error); });
});
async function freePort() {
  const socket = createServer(); await new Promise(resolve => socket.listen(0, '127.0.0.1', resolve));
  const port = socket.address().port; await new Promise(resolve => socket.close(resolve)); return port;
}
const results = [];
try {
  for (const language of ['en', 'zh']) {
    const directory = path.join(output, language), root = path.join(directory, 'fixture'); await mkdir(directory, { recursive: true });
    const webPort = await freePort(), providerPort = await freePort();
    const origin = `http://127.0.0.1:${webPort}`;
    let host, context, page;
    const logs = [], frames = [], errors = [], checks = [], consoleLog = [], socketLifecycle = [];
    let failure;
    async function start() {
      const args = [fixture, '--root', root, '--web-port', String(webPort), '--provider-port', String(providerPort), '--ipc-control'];
      if (values['portable-root']) args.push('--portable-root', path.resolve(values['portable-root']), '--preflight-owner');
      const child = spawn(process.execPath, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
      let stdout = '', stderr = '';
      const exit = new Promise((resolve, reject) => { child.once('exit', (code, signal) => resolve({ code, signal })); child.once('error', reject); });
      const ready = new Promise((resolve, reject) => {
        child.stdout.on('data', bytes => { stdout += bytes; if (stdout.includes(origin)) resolve(); });
        child.stderr.on('data', bytes => { stderr += bytes; });
        exit.then(result => reject(new Error('Host exited before ready: ' + JSON.stringify(result) + stderr)), reject);
      });
      host = { child, exit, log: () => ({ stdout, stderr }) };
      await timeout(ready, 60_000, 'Production host readiness timeout');
    }
    async function stop() {
      if (!host) return;
      const current = host;
      try {
        if (current.child.connected) current.child.send({ type: 'fixture-stop' });
        const result = await timeout(current.exit, 15_000, 'Production host shutdown timeout');
        assert.equal(result.code, 0, 'Actual production shutdown must finish');
      } finally {
        logs.push(current.log()); host = undefined;
        if (current.child.exitCode === null && current.child.signalCode === null) current.child.kill('SIGKILL');
      }
    }
    try {
      await start();
      context = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: language === 'en' ? 'en-US' : 'zh-CN' });
      await context.addInitScript(() => Object.defineProperty(Navigator.prototype, 'onLine', { get: () => false, configurable: true }));
      page = await context.newPage();
      page.on('console', message => consoleLog.push({ type: message.type(), text: message.text() }));
      page.on('pageerror', error => errors.push(error.message));
      page.on('websocket', socket => { socketLifecycle.push({ type: 'open', url: socket.url() }); socket.on('close', () => socketLifecycle.push({ type: 'close', url: socket.url() })); socket.on('framereceived', event => {
        try { const frame = JSON.parse(String(event.payload)); if (frame.value?.type === 'ready') frames.push(frame); } catch { /* Observing other actual wire frames. */ }
      }); });
      const reconnecting = page.getByText(language === 'en' ? /^Reconnecting[. …]*$/ : /^重新连接中[. …]*$/);
      await page.goto(origin, { waitUntil: 'domcontentloaded' });
      await timeout((async () => { while (frames.length < 1) await page.waitForTimeout(30); })(), 10_000, 'Real loopback readiness despite interface hint');
      await page.locator('[data-composer-input=true][contenteditable=true]').waitFor({ state: 'visible', timeout: 10_000 });
      await reconnecting.waitFor({ state: 'hidden', timeout: 5000 }); checks.push('real loopback generation ready while navigator.onLine=false');
      await page.screenshot({ path: path.join(directory, 'healthy.png') });
      await stop();
      await reconnecting.waitFor({ state: 'visible', timeout: 10_000 }); checks.push('actual backend loss remains visible rather than forced connected');
      await page.screenshot({ path: path.join(directory, 'disconnected.png') });
      await page.evaluate(() => { const now = Date.now.bind(Date); globalThis.__testRestoreWallClock = () => { Date.now = now; }; Date.now = () => now() - 60_000; });
      const previousFrames = frames.length;
      await start();
      await timeout((async () => { while (frames.length <= previousFrames) await page.waitForTimeout(30); })(), 15_000, 'Real readiness after restarting the same authority');
      await reconnecting.waitFor({ state: 'hidden', timeout: 5000 }); checks.push('recovery clears stale Reconnecting within a bound despite wall-clock correction');
      await page.evaluate(() => globalThis.__testRestoreWallClock());
      await page.getByRole('button', { name: language === 'en' ? 'Choose workspace' : '选择工作区', exact: true }).click();
      await page.getByRole('menuitem', { name: 'project', exact: true }).click();
      const composer = page.locator('[data-composer-input=true][contenteditable=true]');
      await composer.fill('[fixture:read] Read demo.js after the actual host reconnection.');
      await page.getByRole('button', { name: language === 'en' ? 'Send message' : '发送消息', exact: true }).click();
      await page.getByRole('heading', { name: 'Actual Harness browser answer', exact: true }).last().waitFor({ state: 'visible', timeout: 15_000 });
      await page.getByRole('button', { name: language === 'en' ? 'Stop generating' : '停止生成', exact: true }).waitFor({ state: 'hidden', timeout: 15_000 });
      const requests = (await readFile(path.join(root, 'evidence/requests.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
      assert(requests.some(request => request.messages.some(message => message.role === 'tool' && JSON.stringify(message).includes('export const value = 1'))));
      checks.push('reconnected production agent really reads a file and returns the real tool result to the HTTP model');
      await page.screenshot({ path: path.join(directory, 'recovered-coding.png') });
      assert.deepEqual(errors, []); checks.push('no unhandled browser errors');
    } catch (error) { failure = error.stack; if (page) { await writeFile(path.join(directory, 'failure-text.txt'), await page.locator('body').innerText()); await page.screenshot({ path: path.join(directory, 'failure.png') }); } }
    finally { await context?.close(); try { await stop(); } catch (error) { failure ??= error.stack; } }
    const result = { language, status: failure ? 'FAIL' : 'PASS', checks, readinessFrames: frames.length, errors, consoleLog, socketLifecycle, ...(failure ? { failure } : {}) };
    await writeFile(path.join(directory, 'result.json'), JSON.stringify(result, null, 2) + '\n');
    await writeFile(path.join(directory, 'host-logs.json'), JSON.stringify(logs, null, 2) + '\n');
    results.push(result); console.log(JSON.stringify(result));
  }
} finally { await browser.close(); }
const receipt = { status: results.length === 2 && results.every(result => result.status === 'PASS') ? 'PASS' : 'FAIL', scenarios: results.length, assertions: results.reduce((sum, result) => sum + result.checks.length, 0), paidModelCalls: 0, results,
  shutdownControl: 'Test-only IPC invokes the actual production SIGTERM handler; not native OS signal delivery.',
  scope: 'Actual loopback HTTP/WebSocket and coding after host loss/restart. Browser network hint and wall clock are controlled; backend responses are not mocked.' };
await writeFile(path.join(output, 'result.json'), JSON.stringify(receipt, null, 2) + '\n');
if (receipt.status !== 'PASS') process.exitCode = 1;
