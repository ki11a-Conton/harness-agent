#!/usr/bin/env node
// Real CLI/Web hosts, local HTTP scripted provider, real stores/files/processes.
// This proves engineering paths and never claims measured model quality.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const argv = process.argv.slice(2);
if (argv.length && !(argv.length === 2 && argv[0] === '--out' && argv[1])) throw new Error('usage: interaction-acceptance.mjs [--out <directory>]');
const repository = fileURLToPath(new URL('../../../', import.meta.url));
const output = resolve(argv[1] ?? '.ci/gen1-interaction');
await mkdir(output, { recursive: true });
const source = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: repository, encoding: 'utf8' });
assert.equal(source.status, 0);
const sourceSha = source.stdout.trim();
const root = await mkdtemp(join(tmpdir(), 'harness-gen1-interaction-'));
const project = join(root, 'coding project Unicode-中文');
const dataDir = join(root, 'chat data');
await mkdir(project, { recursive: true });
const original = 'module.exports.add = (a, b) => a - b;\n';
await writeFile(join(project, 'math.cjs'), original);
await writeFile(join(project, 'verify.cjs'), "require('node:assert/strict').equal(require('./math.cjs').add(19,23),42,'GEN1_SUM_42');\n");
const cli = join(repository, 'apps/cli/dist/main.js');
const web = join(repository, 'apps/web/dist/main.js');
const cases = []; const requests = []; const artifacts = []; const children = new Set();
let scenario = 'coding'; let stage = 0; let sourceHash;
const check = (name, value, detail) => { assert.ok(value, name); cases.push({ name, passed: true, ...(detail !== undefined ? { detail } : {}) }); };
const tool = (name, args) => ({ role: 'assistant', content: null, reasoning_content: 'Local scripted fixture; no paid provider.', tool_calls: [{ index: 0,
  id: `gen1_${scenario}_${stage}`, type: 'function', function: { name, arguments: JSON.stringify(args) } }] });
const text = content => ({ role: 'assistant', content, reasoning_content: 'Local scripted fixture; no paid provider.' });
const server = createServer(async (request, response) => {
  try {
    let raw = ''; for await (const chunk of request) raw += chunk;
    const body = JSON.parse(raw);
    requests.push({ scenario, stage, path: request.url, body });
    let message;
    if (scenario === 'coding') {
      if (stage === 0) message = tool('read_file', { path: 'math.cjs', versioned: true });
      else if (stage === 1) {
        check('versioned native file content and sha reach the HTTP provider', JSON.stringify(body.messages).includes(sourceHash) && JSON.stringify(body.messages).includes('a - b'));
        message = tool('edit_file', { path: 'math.cjs', oldText: 'a - b', newText: 'a + b', expectedSha256: sourceHash });
      } else if (stage === 2) message = text('Corrected addition; the configured verification must pass.');
      else {
        check('second chat turn includes first task and completed assistant reply', JSON.stringify(body.messages).includes('repair addition') && JSON.stringify(body.messages).includes('Corrected addition'));
        message = text('Follow-up completed using the existing conversation.');
      }
    } else if (scenario === 'resume') {
      check('fresh CLI resumes with both earlier user turns and assistant history', ['repair addition', 'follow-up check', 'Follow-up completed'].every(value => JSON.stringify(body.messages).includes(value)));
      message = text('Resumed third task on the original session.');
    } else if (scenario === 'deny' || scenario === 'eof') {
      if (stage === 0) message = tool('write_file', { path: `${scenario}-must-not-exist.txt`, content: 'forbidden' });
      else {
        check(`${scenario} denial reaches model as tool result`, body.messages.some(item => item.role === 'tool' && /denied|PERMISSION_DENIED/i.test(item.content)));
        message = text('The requested write was denied.');
      }
    } else if (scenario === 'cancel') {
      if (stage === 0) message = tool('exec', { command: process.execPath, args: ['-e', "require('fs').writeFileSync('started.flag','ready');setTimeout(()=>{},60000)"] });
      else message = text('The next turn works after cancellation.');
    } else if (scenario === 'web-first') message = text('Web first task completed.');
    else if (scenario === 'web-resume') {
      check('restarted Web retains earlier conversation in the actual model request', JSON.stringify(body.messages).includes('web first task') && JSON.stringify(body.messages).includes('Web first task completed.'));
      message = text('Web resumed task completed.');
    } else throw new Error(`unknown fixture scenario ${scenario}`);
    stage++;
    response.writeHead(200, { 'Content-Type': 'text/event-stream' });
    response.end(`data: ${JSON.stringify({ choices: [{ index: 0, delta: message, finish_reason: message.tool_calls ? 'tool_calls' : 'stop' }] })}\n\ndata: [DONE]\n\n`);
  } catch (error) { response.writeHead(500); response.end(String(error)); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const env = { ...process.env, OPENAI_API_KEY: 'local-scripted-not-a-credential', OPENAI_BASE_URL: `http://127.0.0.1:${server.address().port}/v1`,
  OPENAI_MODEL: 'gen1-fixture-model', HARNESS_AGENT_PROMPT: 'coding-v1', HARNESS_MEMORY: '0', HARNESS_DATA_DIR: '', OPENAI_MAX_PROVIDER_RETRIES: '0' };
async function save(name, data) {
  await writeFile(join(output, name), JSON.stringify(data, null, 2) + '\n'); artifacts.push(name);
}
async function command(args, options = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, args, { cwd: options.cwd ?? root, env: { ...env, ...options.env }, windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'] });
    children.add(child); let stdout = ''; let stderr = ''; let approvalCount = 0; let failed = false;
    const deadline = setTimeout(() => fail(new Error(`CLI deadline: ${stdout}\n${stderr}`)), 60_000);
    const fail = error => { if (failed) return; failed = true; clearTimeout(deadline); child.kill('SIGKILL'); reject(error); };
    child.on('error', fail);
    child.stdin.on('error', error => { if (error.code !== 'EPIPE') fail(error); });
    child.stdout.on('data', data => {
      stdout += data;
      try { options.progress?.({ child, stdout, stderr }); } catch (error) { fail(error); }
    });
    child.stderr.on('data', data => {
      stderr += data;
      if (options.approvals !== undefined) {
        const count = (stderr.match(/allow\/deny> /g) ?? []).length;
        while (approvalCount < count) { approvalCount++; child.stdin.write(`${options.approvals}\n`); }
      }
    });
    child.once('close', (code, signal) => { children.delete(child); clearTimeout(deadline); if (!failed) resolvePromise({ code, signal, stdout, stderr, approvalCount }); });
    if (options.keepInput) child.stdin.write(options.input ?? '');
    else child.stdin.end(options.input ?? '');
  });
}
function scriptedProgress(messages) {
  let sent = 0;
  return ({ child, stdout }) => {
    const completed = (stdout.match(/status: completed\n/g) ?? []).length;
    while (sent < completed && sent < messages.length) child.stdin.write(`${messages[sent++]}\n`);
  };
}
async function waitFor(predicate, label, timeout = 15_000) {
  const until = Date.now() + timeout;
  while (Date.now() < until) { if (await predicate()) return; await new Promise(resolve => setTimeout(resolve, 15)); }
  throw new Error(`deadline: ${label}`);
}
let webChild; let webExit; let webLogs = '';
async function startWeb() {
  webChild = spawn(process.execPath, [web], { cwd: project, env: { ...env, HARNESS_DATA_DIR: join(root, 'web data'), HARNESS_WEB_PORT: '0' },
    windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  children.add(webChild);
  webExit = new Promise(resolve => webChild.once('close', (code, signal) => { children.delete(webChild); resolve({ code, signal }); }));
  return new Promise((resolvePromise, reject) => {
    let stdout = '';
    const timer = setTimeout(() => reject(new Error(`Web startup deadline: ${webLogs}`)), 30_000);
    webChild.on('error', error => { clearTimeout(timer); reject(error); });
    webChild.stderr.on('data', data => { webLogs += data; });
    webChild.stdout.on('data', data => {
      stdout += data; webLogs += data;
      const match = /listening on (http:\/\/127\.0\.0\.1:\d+)/.exec(stdout);
      if (match) { clearTimeout(timer); resolvePromise(match[1]); }
    });
    webChild.once('close', () => { clearTimeout(timer); if (!stdout.includes('listening on')) reject(new Error(`Web exited: ${webLogs}`)); });
  });
}
async function stopWeb() { webChild.kill('SIGTERM'); await webExit; }
async function subscribe(address, from) {
  const controller = new AbortController();
  const response = await fetch(`${address}/api/events?from=${from}`, { signal: controller.signal });
  assert.equal(response.status, 200);
  const reader = response.body.getReader(); const frames = []; const decoder = new TextDecoder(); let buffer = ''; let failure;
  const done = (async () => {
    try {
      for (;;) {
        const next = await reader.read(); if (next.done) break;
        buffer += decoder.decode(next.value, { stream: true });
        let index;
        while ((index = buffer.indexOf('\n\n')) !== -1) {
          const block = buffer.slice(0, index); buffer = buffer.slice(index + 2);
          for (const line of block.split('\n')) if (line.startsWith('data: ')) frames.push(JSON.parse(line.slice(6)));
        }
      }
    } catch (error) { if (!controller.signal.aborted) failure = error; }
  })();
  await waitFor(() => frames.some(frame => frame.type === 'hello'), 'SSE hello');
  return { frames, failure: () => failure, async close() { controller.abort(); await done; } };
}
async function post(address, from, text) {
  const response = await fetch(`${address}/api/messages`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ from, text }) });
  assert.equal(response.status, 200);
}
let status = 'FAIL'; let failure;
try {
  sourceHash = createHash('sha256').update(original).digest('hex');
  const coding = await command([cli, 'chat', project, '--verify', 'node verify.cjs', '--data-dir', dataDir], { keepInput: true, input: 'repair addition\n',
    approvals: 'allow', progress: scriptedProgress(['follow-up check', '/quit']) });
  await save('chat-coding.json', coding);
  check('real CLI completes two turns in one live chat process', coding.code === 0 && (coding.stdout.match(/status: completed\n/g) ?? []).length === 2);
  const ids = [...coding.stdout.matchAll(/run started: session (\S+)/g)].map(match => match[1]);
  check('both CLI turns share one durable session id', ids.length === 2 && ids[0] === ids[1]);
  check('native edit and both verification commands received individual approval', coding.approvalCount === 3 && (coding.stderr.match(/allowed for this call/g) ?? []).length === 3);
  check('CLI reports real successful verification on both turns', (coding.stdout.match(/verification: passed/g) ?? []).length === 2);
  check('native conditional edit fixes the actual project file', (await readFile(join(project, 'math.cjs'), 'utf8')).includes('a + b'));
  const independent = spawnSync(process.execPath, ['verify.cjs'], { cwd: project, encoding: 'utf8' });
  check('independent test succeeds outside the agent', independent.status === 0);
  scenario = 'resume'; stage = 0;
  const resumed = await command([cli, 'chat', project, '--resume', ids[0], '--verify', 'node verify.cjs', '--data-dir', dataDir], {
    keepInput: true, input: 'third task after restart\n', approvals: 'allow', progress: scriptedProgress(['/quit']) });
  await save('chat-resume.json', resumed);
  check('fresh CLI continues the same session and third turn', resumed.code === 0 && resumed.stdout.includes(`run started: session ${ids[0]}`));
  const beforeRefusal = requests.length;
  const other = join(root, 'other project'); await mkdir(other);
  const wrongProject = await command([cli, 'chat', other, '--resume', ids[0], '--data-dir', dataDir]);
  await save('wrong-project.json', wrongProject);
  check('cross-project resume fails without a provider request', wrongProject.code === 1 && wrongProject.stdout.includes('belongs to project') && requests.length === beforeRefusal);
  const wrongPolicy = await command([cli, 'chat', project, '--resume', ids[0], '--verify', 'node verify.cjs', '--data-dir', dataDir], { env: { HARNESS_AGENT_PROMPT: 'legacy' } });
  await save('wrong-policy.json', wrongPolicy);
  check('incompatible prompt policy fails without a provider request', wrongPolicy.code === 1 && /config drifted|CONFIG_DRIFT_REJECTED/i.test(wrongPolicy.stdout) && requests.length === beforeRefusal);
  const badData = await command([cli, 'chat', project, '--data-dir']);
  const help = await command([cli, '--help'], { env: { HARNESS_AGENT_PROMPT: 'invalid-for-test' } });
  await save('flags-and-help.json', { badData, help });
  check('missing data-dir fails before provider while help works without constructing one', badData.code === 1 && /requires/.test(badData.stdout) && help.code === 0 && /chat/.test(help.stdout) && requests.length === beforeRefusal);
  for (const mode of ['deny', 'eof']) {
    scenario = mode; stage = 0;
    const result = await command([cli, 'chat', project, '--data-dir', join(root, `${mode} data`)], mode === 'deny'
      ? { keepInput: true, input: 'attempt a write\n', approvals: 'deny', progress: scriptedProgress(['/quit']) }
      : { input: 'attempt a write\n' });
    await save(`chat-${mode}.json`, result);
    let absent = false; try { await readFile(join(project, `${mode}-must-not-exist.txt`)); } catch (error) { if (error.code === 'ENOENT') absent = true; else throw error; }
    check(`${mode} cannot authorize native writes`, absent && result.stderr.includes('denied') && result.code === 0);
  }
  if (process.platform !== 'win32') {
    scenario = 'cancel'; stage = 0; let interrupted = false; let sentNext = false; let sentQuit = false; let poll;
    const result = await command([cli, 'chat', project, '--data-dir', join(root, 'cancel data')], { keepInput: true,
      input: 'start a long command\n', approvals: 'allow', progress({ child, stdout }) {
        if (poll === undefined) poll = setInterval(async () => {
          if (interrupted) return;
          try { await readFile(join(project, 'started.flag')); interrupted = true; child.kill('SIGINT'); }
          catch (error) { if (error.code !== 'ENOENT') throw error; }
        }, 20);
        if (!sentNext && stdout.includes('status: cancelled')) { sentNext = true; child.stdin.write('after cancellation\n'); }
        if (!sentQuit && stdout.includes('status: completed')) { sentQuit = true; child.stdin.write('/quit\n'); }
      } }).finally(() => clearInterval(poll));
    await save('chat-cancel.json', result);
    const turnSessions = [...result.stdout.matchAll(/run started: session (\S+)/g)].map(match => match[1]);
    check('Ctrl-C cancels only the current turn and the same chat accepts another task', interrupted && result.code === 0 && result.stdout.includes('status: cancelled') && turnSessions.length === 2 && turnSessions[0] === turnSessions[1]);
  }
  scenario = 'web-first'; stage = 0;
  let address = await startWeb(); const from = 'gen1-web-session'; const a = await subscribe(address, from); const b = await subscribe(address, from);
  await post(address, from, 'web first task');
  await waitFor(() => [a, b].every(stream => stream.frames.some(frame => frame.type === 'assistant_text' && frame.text === 'Web first task completed.')), 'both Web tabs receive the real reply');
  check('two real SSE tabs receive the same completed Web turn', [a, b].every(stream => !stream.failure() && stream.frames.some(frame => frame.event?.type === 'turn.completed')));
  const before = await (await fetch(`${address}/api/history?from=${from}`)).json();
  check('Web history stores its actual user/assistant conversation', before.messages.some(message => message.role === 'user' && message.content === 'web first task'));
  await a.close(); await b.close(); await stopWeb();
  scenario = 'web-resume'; stage = 0; address = await startWeb(); const c = await subscribe(address, from);
  const sessions = await (await fetch(`${address}/api/sessions`)).json();
  check('a new browser can discover persistent backend conversations after restart', sessions.sessions.some(session => session.from === from && session.sessionId === before.sessionId));
  await post(address, from, 'web second task');
  await waitFor(() => c.frames.some(frame => frame.type === 'assistant_text' && frame.text === 'Web resumed task completed.'), 'resumed Web reply');
  const after = await (await fetch(`${address}/api/history?from=${from}`)).json();
  check('restarted Web sends the follow-up on the original session', after.sessionId === before.sessionId && after.messages.filter(message => message.role === 'user').length === 2);
  await save('web-frames.json', { firstTab: a.frames, secondTab: b.frames, restarted: c.frames });
  await save('web-history.json', { before, after, sessions });
  await c.close(); await stopWeb();
  await save('web-logs.json', { text: webLogs });
  check('all actual HTTP requests use the configured model and selected coding policy', requests.every(request => request.body.model === 'gen1-fixture-model' && request.body.messages.some(message => message.role === 'system' && message.content.includes('coding agent'))));
  status = 'PASS';
} catch (error) { failure = { message: error.message, stack: error.stack }; throw error; }
finally {
  for (const child of children) child.kill('SIGKILL');
  await new Promise(resolve => server.close(resolve));
  await save('requests.json', requests);
  const receipt = { status, sourceSha, platform: process.platform, node: process.version, provider: 'local-scripted-http', paidModelCalls: 0,
    realModelQuality: 'NOT_PROVEN', cases, assertionCount: cases.length, requestCount: requests.length, artifacts, ...(failure ? { failure } : {}),
    skips: process.platform === 'win32' ? ['POSIX SIGINT-to-handler behavior; native Windows cancellation is covered by the Windows gate'] : [] };
  await save('result.json', receipt);
  process.stdout.write(JSON.stringify(receipt) + '\n');
  await rm(root, { recursive: true, force: true });
}
