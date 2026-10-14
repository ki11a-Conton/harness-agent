#!/usr/bin/env node
// One fixed archive, a fresh project, official UI, and actual native Harness.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { digest, verifyPortable } from './portable-lib.mjs';
import { verifyArchive } from './portable.mjs';

const { values } = parseArgs({ options: {
  archive: { type: 'string' }, out: { type: 'string' }, version: { type: 'string' }, 'source-sha': { type: 'string' },
  'playwright-module': { type: 'string' }, chromium: { type: 'string' },
} });
if (!values.archive || !values.out || !values.version || !/^[a-f0-9]{40}$/.test(values['source-sha'] ?? '') || !values['playwright-module']) {
  throw new Error('Use --archive FILE --out NEW_DIR --version V --source-sha SHA --playwright-module FILE [--chromium FILE]');
}
const output = resolve(values.out), archive = resolve(values.archive);
await mkdir(output, { recursive: true });
const cleanroom = await realpath(await mkdtemp(join(tmpdir(), 'harness-official-ui-consumer-')));
const source = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const saved = { NODE_OPTIONS: process.env.NODE_OPTIONS, NODE_PATH: process.env.NODE_PATH };
delete process.env.NODE_OPTIONS; delete process.env.NODE_PATH;
let host, hostExit, stdout = '', stderr = '';
const timeout = (promise, ms, label) => new Promise((done, reject) => {
  const timer = setTimeout(() => reject(new Error(label)), ms);
  promise.then(value => { clearTimeout(timer); done(value); }, error => { clearTimeout(timer); reject(error); });
});
try {
  const checksums = await readFile(join(dirname(archive), 'SHA256SUMS'), 'utf8');
  assert(checksums.split('\n').includes(`${digest(await readFile(archive))}  ${basename(archive)}`), 'Published archive checksum matches');
  const { root, manifest, sha256 } = await verifyArchive({ archive, out: join(cleanroom, 'extracted'), version: values.version, sourceSha: values['source-sha'] });
  const playwright = await import(pathToFileURL(resolve(values['playwright-module'])).href);
  const chromium = values.chromium ?? playwright.chromium.executablePath();
  const fixture = join(cleanroom, 'fixture');
  host = spawn(process.execPath, [join(source, 'scripts/research/deepseek-live-host.mjs'), '--root', fixture, '--portable-root', root, '--ipc-control'], {
    cwd: cleanroom, windowsHide: true, env: { ...process.env, HARNESS_VERIFY_COMMAND: '' }, stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  // Install exit/error observers before readiness and retain failure evidence.
  hostExit = new Promise((done, reject) => { host.once('error', reject); host.once('exit', (code, signal) => done({ code, signal })); });
  const ready = new Promise((done, reject) => {
    host.stdout.on('data', bytes => { stdout += bytes; const match = stdout.match(/http:\/\/127\.0\.0\.1:\d+/); if (match) done(match[0]); });
    host.stderr.on('data', bytes => { stderr += bytes; });
    hostExit.then(exit => reject(new Error(`Installed host exited before readiness: ${JSON.stringify(exit)} ${stderr}`)), reject);
  });
  const origin = await timeout(ready, 60_000, 'Installed host did not become ready');
  const args = [join(source, 'scripts/research/deepseek-browser-interactions.mjs'), '--url', origin,
    '--output', join(output, 'browser'), '--playwright-module', resolve(values['playwright-module']), '--chromium', chromium,
    '--models', '--fixture-evidence', join(fixture, 'evidence'),
    '--cases', 'settings-general,models-editor,workspace-directory-picker,workspace-files,session-lifecycle,markdown-stream-reload,read-tool,write-approval,write-rejection,ask-reload-answer',
    '--viewports', 'desktop,mobile,narrow-tall'];
  const runner = spawn(process.execPath, args, { cwd: cleanroom, env: process.env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let runnerLog = '';
  runner.stdout.on('data', bytes => { runnerLog += bytes; }); runner.stderr.on('data', bytes => { runnerLog += bytes; });
  let runResult;
  try {
    runResult = await timeout(new Promise((done, reject) => { runner.once('error', reject); runner.once('exit', (code, signal) => done({ code, signal })); }), 10 * 60_000, 'Installed browser acceptance exceeded its deadline');
  } finally {
    if (runner.exitCode === null && runner.signalCode === null) runner.kill('SIGTERM');
    await writeFile(join(output, 'browser.log'), runnerLog);
  }
  assert.equal(runResult.code, 0, runnerLog);
  const browser = JSON.parse(await readFile(join(output, 'browser/result.json'), 'utf8'));
  assert.equal(browser.results.length, 30); assert(browser.complete);
  await verifyPortable(root, { version: values.version, sourceSha: values['source-sha'] });
  host.send({ type: 'fixture-stop' });
  const exit = await timeout(hostExit, 15_000, 'Installed host failed to close');
  assert.equal(exit.code, 0, stderr);
  const launch = JSON.parse(await readFile(join(fixture, 'evidence/launch.json'), 'utf8'));
  assert.equal(launch.installed, true); assert.equal(launch.sourceSha, manifest.sourceSha);
  const receipt = { schemaVersion: 1, status: 'PASS', kind: 'harness-official-ui-installed',
    version: manifest.version, sourceSha: manifest.sourceSha, sourceTree: manifest.sourceTree, archiveSha256: sha256,
    platform: process.platform, architecture: process.arch, node: process.version, files: manifest.files.length,
    workspaceLinks: 0, installedApplication: true, cases: browser.results.length,
    assertions: browser.results.reduce((sum, item) => sum + item.checks.length, 0), paidModelCalls: 0,
    realModelQuality: 'NOT_PROVEN', fullDefaultUiParity: 'NOT_PROVEN',
    scope: 'Named ordinary coding UI controls on this verified archive, three viewport sizes; PTY/Cordis/goal/queue-edit capabilities are not claimed.' };
  await writeFile(join(output, 'result.json'), JSON.stringify(receipt, null, 2) + '\n');
  console.log(JSON.stringify(receipt));
} catch (error) {
  // Preserve the real failure when raw artifact downloads are unavailable.
  // Only bounded fixture case metadata is exposed; the original verdict stays red.
  const escape = text => text.replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
  console.error('::error title=Installed UI acceptance failed::' + escape(String(error).slice(0, 2000)));
  try {
    const report = JSON.parse(await readFile(join(output, 'browser/result.json'), 'utf8'));
    for (const item of report.results.filter(item => item.status !== 'PASS').slice(0, 8)) {
      console.error('::error title=Installed UI case failed::' + escape(JSON.stringify({
        name: item.name, viewport: item.viewport, status: item.status, failure: item.failure,
      }).slice(0, 2000)));
    }
  } catch (diagnosticError) {
    console.error('Installed UI case diagnostics unavailable: ' + diagnosticError.message);
  }
  throw error;
} finally {
  try {
    if (host && host.exitCode === null && host.signalCode === null) {
      if (host.connected) host.send({ type: 'fixture-stop' }); else host.kill('SIGTERM');
      try { await timeout(hostExit, 15_000, 'Fixture shutdown deadline exceeded'); }
      finally { if (host.exitCode === null && host.signalCode === null) host.kill('SIGKILL'); }
    }
    await writeFile(join(output, 'host-stdout.log'), stdout); await writeFile(join(output, 'host-stderr.log'), stderr);
    try { await cp(join(cleanroom, 'fixture/evidence'), join(output, 'fixture'), { recursive: true }); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  } finally {
    for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    await rm(cleanroom, { recursive: true, force: true });
  }
}
