import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';

const { values } = parseArgs({ options: { out: { type: 'string' } } });
const output = resolve(values.out ?? '.ci/gen1-host-lease');
await mkdir(output, { recursive: true });
const repository = process.cwd();
const temporary = await mkdtemp(join(tmpdir(), 'gen1-host-lease-'));
const project = join(temporary, 'project with spaces');
const data = join(temporary, 'persistent data');
await mkdir(project); await mkdir(data);
await writeFile(join(data, 'consumer-marker.txt'), 'must remain unchanged\n');
const env = { ...process.env, OPENAI_API_KEY: '', OPENAI_BASE_URL: '', OPENAI_MODEL: '',
  HARNESS_DATA_DIR: data, HARNESS_AGENT_PROMPT: 'coding-v1', HARNESS_MEMORY: '0', HARNESS_WEB_PORT: '0' };
const cases = [];
let owner;
const launch = (script, args = [], extra = {}) => {
  const child = spawn(process.execPath, [resolve(repository, script), ...args], { cwd: project, env: { ...env, ...extra }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  let stdout = '', stderr = '';
  child.stdout.on('data', chunk => { stdout += chunk; }); child.stderr.on('data', chunk => { stderr += chunk; });
  const done = new Promise(resolveDone => child.once('close', (code, signal) => resolveDone({ code, signal, stdout, stderr })));
  child.once('error', error => { stderr += String(error); });
  return { child, done, stdout: () => stdout, stderr: () => stderr };
};
async function bounded(promise) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('host acceptance deadline')), 15000); })]); }
  finally { clearTimeout(timer); }
}
async function ready(host) {
  await bounded((async () => {
    for (;;) {
      if (/\[web\] listening on http:/.test(host.stdout())) return;
      if (host.child.exitCode !== null) throw new Error('web failed to start: ' + host.stderr());
      await new Promise(resolveWait => setTimeout(resolveWait, 25));
    }
  })());
}
async function snapshot(directory, prefix = '') {
  const files = {};
  for (const entry of await readdir(join(directory, prefix), { withFileTypes: true })) {
    const path = prefix ? prefix + '/' + entry.name : entry.name;
    if (entry.isDirectory()) Object.assign(files, await snapshot(directory, path));
    else files[path] = createHash('sha256').update(await readFile(join(directory, path))).digest('hex');
  }
  return files;
}
try {
  owner = launch('apps/web/dist/main.js'); await ready(owner);
  const before = await snapshot(data);
  const contender = await bounded(launch('apps/cli/dist/main.js', ['doctor']).done);
  assert.equal(contender.code, 1); assert.match(contender.stderr, /HARNESS_DATA_DIR_IN_USE/);
  assert.deepEqual(await snapshot(data), before);
  assert.ok(!contender.stderr.includes('[harness]'), 'ownership refusal must precede store/provider composition');
  cases.push({ name: 'real CLI refuses a Web-owned directory before loading mutable stores', passed: true, exitCode: contender.code });
  owner.child.kill('SIGKILL'); await bounded(owner.done); owner = undefined;
  const afterCrash = await bounded(launch('apps/cli/dist/main.js', ['doctor']).done);
  assert.equal(afterCrash.code, 0, afterCrash.stderr); assert.match(afterCrash.stdout, /0 error\(s\)/);
  cases.push({ name: 'OS releases product ownership after owner process crash', passed: true });

  const occupied = createServer(); await new Promise(resolveListen => occupied.listen(0, '127.0.0.1', resolveListen));
  try {
    const failedWeb = await bounded(launch('apps/web/dist/main.js', [], { HARNESS_WEB_PORT: String(occupied.address().port) }).done);
    assert.equal(failedWeb.code, 1); assert.match(failedWeb.stderr, /EADDRINUSE/);
    const successor = await bounded(launch('apps/cli/dist/main.js', ['doctor']).done);
    assert.equal(successor.code, 0, successor.stderr);
    cases.push({ name: 'failed Web startup closes resources and releases directory ownership', passed: true });
  } finally { await new Promise(resolveClose => occupied.close(resolveClose)); }
  const result = { status: 'PASS', sourceSha: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
    platform: process.platform, node: process.version, cases, paidModelCalls: 0, realModelQuality: 'NOT_PROVEN' };
  await writeFile(join(output, 'result.json'), JSON.stringify(result, null, 2) + '\n');
  console.log(JSON.stringify(result));
} finally {
  if (owner) { owner.child.kill('SIGKILL'); await bounded(owner.done); }
  await rm(temporary, { recursive: true, force: true });
}
