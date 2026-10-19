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
  host = spawn(process.execPath, [join(source, 'scripts/research/deepseek-live-host.mjs'), '--root', fixture, '--portable-root', root, '--ipc-control', '--preflight-owner'], {
    cwd: cleanroom, windowsHide: true, env: { ...process.env, HARNESS_VERIFY_COMMAND: '' }, stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  // Install exit/error observers before readiness and retain failure evidence.
  hostExit = new Promise((done, reject) => { host.once('error', reject); host.once('close', (code, signal) => done({ code, signal })); });
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
  const controlsRunner = spawn(process.execPath, [join(source, 'scripts/research/pr15-browser.mjs'), '--url', origin,
    '--output', join(output, 'pr15'), '--fixture-evidence', join(fixture, 'evidence'),
    '--playwright-module', resolve(values['playwright-module']), '--chromium', chromium],
    { cwd: cleanroom, windowsHide: true, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
  let controlsLog = '';
  controlsRunner.stdout.on('data', bytes => { controlsLog += bytes; }); controlsRunner.stderr.on('data', bytes => { controlsLog += bytes; });
  try {
    const result = await timeout(new Promise((done, reject) => { controlsRunner.once('error', reject); controlsRunner.once('close', (code, signal) => done({ code, signal })); }),
      4 * 60_000, 'Installed PR15 controls acceptance exceeded its deadline');
    assert.equal(result.code, 0, controlsLog);
  } finally {
    if (controlsRunner.exitCode === null && controlsRunner.signalCode === null) controlsRunner.kill('SIGTERM');
    await writeFile(join(output, 'pr15.log'), controlsLog);
  }
  const controls = JSON.parse(await readFile(join(output, 'pr15/result.json'), 'utf8'));
  assert.equal(controls.status, 'PASS'); assert.equal(controls.checks.length, 8); assert.deepEqual(controls.pending, []); assert.equal(controls.paidModelCalls, 0);
  await verifyPortable(root, { version: values.version, sourceSha: values['source-sha'] });
  host.send({ type: 'fixture-stop' });
  const exit = await timeout(hostExit, 15_000, 'Installed host failed to close');
  assert.equal(exit.code, 0, stderr);
  const launch = JSON.parse(await readFile(join(fixture, 'evidence/launch.json'), 'utf8'));
  assert.equal(launch.installed, true); assert.equal(launch.sourceSha, manifest.sourceSha);
  const dailyRunner = spawn(process.execPath, [join(source, 'scripts/research/web-daily-20261016/browser-acceptance.mjs'),
    '--output', join(output, 'daily'), '--portable-root', root, '--playwright-module', resolve(values['playwright-module']),
    '--chromium', chromium, '--viewports', 'desktop,mobile,narrow'], { cwd: cleanroom, windowsHide: true, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
  let dailyLog = '';
  dailyRunner.stdout.on('data', bytes => { dailyLog += bytes; }); dailyRunner.stderr.on('data', bytes => { dailyLog += bytes; });
  try {
    const dailyExit = await timeout(new Promise((done, reject) => { dailyRunner.once('error', reject); dailyRunner.once('close', (code, signal) => done({ code, signal })); }),
      8 * 60_000, 'Installed daily-interaction acceptance exceeded its deadline');
    assert.equal(dailyExit.code, 0, dailyLog);
  } finally {
    if (dailyRunner.exitCode === null && dailyRunner.signalCode === null) dailyRunner.kill('SIGTERM');
    await writeFile(join(output, 'daily.log'), dailyLog);
  }
  const daily = JSON.parse(await readFile(join(output, 'daily/result.json'), 'utf8'));
  assert.equal(daily.status, 'PASS'); assert.equal(daily.results.length, 42); assert.equal(daily.paidModelCalls, 0);
  assert.equal(daily.fixture.installed, true); assert.equal(daily.fixture.sourceSha, manifest.sourceSha);
  await verifyPortable(root, { version: values.version, sourceSha: values['source-sha'] });
  const connectionArgs = [join(source, 'scripts/research/web-connection-browser.mjs'), '--output', join(output, 'connection'),
    '--portable-root', root, '--playwright-module', resolve(values['playwright-module']), '--chromium', chromium];
  const connectionRunner = spawn(process.execPath, connectionArgs, { cwd: cleanroom, env: process.env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let connectionLog = '';
  connectionRunner.stdout.on('data', bytes => { connectionLog += bytes; }); connectionRunner.stderr.on('data', bytes => { connectionLog += bytes; });
  try {
    const result = await timeout(new Promise((done, reject) => { connectionRunner.once('error', reject); connectionRunner.once('exit', (code, signal) => done({ code, signal })); }), 5 * 60_000, 'Installed connection acceptance exceeded its deadline');
    assert.equal(result.code, 0, connectionLog);
  } finally {
    if (connectionRunner.exitCode === null && connectionRunner.signalCode === null) connectionRunner.kill('SIGTERM');
    await writeFile(join(output, 'connection.log'), connectionLog);
  }
  const connection = JSON.parse(await readFile(join(output, 'connection/result.json'), 'utf8'));
  assert.equal(connection.status, 'PASS'); assert.equal(connection.paidModelCalls, 0);
  const receipt = { schemaVersion: 1, status: 'PASS', kind: 'harness-official-ui-installed',
    version: manifest.version, sourceSha: manifest.sourceSha, sourceTree: manifest.sourceTree, archiveSha256: sha256,
    platform: process.platform, architecture: process.arch, node: process.version, files: manifest.files.length,
    workspaceLinks: 0, installedApplication: true, cases: browser.results.length,
    assertions: browser.results.reduce((sum, item) => sum + item.checks.length, 0), paidModelCalls: 0,
    pr15Controls: controls.checks.length,
    connectionScenarios: connection.scenarios, connectionAssertions: connection.assertions,
    dailyScenarios: daily.results.length, dailyAssertions: daily.results.reduce((sum, item) => sum + item.checks.length, 0),
    realModelQuality: 'NOT_PROVEN', fullDefaultUiParity: 'NOT_PROVEN',
    scope: 'Named ordinary coding UI controls on this verified archive, three viewport sizes, plus PR15 permissions, reviewed plans, bounded goals, reasoning and context controls. PTY/Cordis/queue-edit capabilities and real model quality are not claimed.' };
  await writeFile(join(output, 'result.json'), JSON.stringify(receipt, null, 2) + '\n');
  console.log(JSON.stringify(receipt));
} catch (error) {
  // Preserve the real failure when raw artifact downloads are unavailable.
  // Only bounded fixture case metadata is exposed; the original verdict stays red.
  const escape = text => text.replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
  console.error('::error title=Installed UI acceptance failed::' + escape(String(error).slice(0, 2000)));
  let remainingDiagnostics = 6;
  for (const phase of ['browser', 'daily', 'pr15']) {
    try {
      const report = JSON.parse(await readFile(join(output, phase, 'result.json'), 'utf8'));
      const cases = report.results ?? (report.status === 'PASS' ? [] : [{ name: report.pending?.[0] ?? 'PR15 controls', status: 'FAIL', failure: report.failure }]);
      for (const item of cases.filter(item => item.status !== 'PASS').slice(0, remainingDiagnostics)) {
        remainingDiagnostics--;
        console.error('::error title=Installed UI case failed::' + escape(JSON.stringify({
          phase, name: item.name, viewport: item.viewport, status: item.status,
          ...(report.failureState === undefined ? {} : { failureState: report.failureState }), failure: item.failure,
        }).slice(0, 2000)));
      }
    } catch (diagnosticError) { console.error('Installed UI ' + phase + ' diagnostics unavailable: ' + diagnosticError.message); }
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
