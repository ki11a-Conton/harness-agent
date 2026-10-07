import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { gzipSync } from 'node:zlib';

const cli = fileURLToPath(new URL('../../../apps/cli/dist/main.js', import.meta.url));
const web = fileURLToPath(new URL('../../../apps/web/dist/main.js', import.meta.url));
const sourceRoot = fileURLToPath(new URL('../../../', import.meta.url));
export async function runCodingAcceptance(outputDir = '.ci/coding-acceptance') {
  const root = await mkdtemp(join(tmpdir(), 'harness-real-coding-'));
  const output = resolve(outputDir); await mkdir(output, { recursive: true });
  const requests = []; const assertions = []; let scenario = 'coding'; let stage = 0;
  const check = (name, condition) => { assert.ok(condition, name); assertions.push(name); };
  const tool = (name, args) => ({ role: 'assistant', content: null, tool_calls: [{ index: 0, id: `coding_${scenario}_${stage}`, type: 'function', function: { name, arguments: JSON.stringify(args) } }] });
  const text = content => ({ role: 'assistant', content });
  const server = createServer(async (req, res) => {
    try {
      let raw = ''; for await (const part of req) raw += part;
      const body = JSON.parse(raw); requests.push({ scenario, stage, path: req.url, body });
      let message;
      if (scenario === 'coding' || scenario === 'web-coding') {
        if (stage === 0) message = tool('read_file', { path: 'src/math.cjs', versioned: true });
        else if (stage === 1) {
          check('actual read content reaches HTTP model', JSON.stringify(body.messages).includes('return a - b'));
          message = tool('edit_file', { path: 'src/math.cjs', oldText: 'return a - b', newText: 'return a + b + 1' });
        } else if (stage === 2) message = text('Done.');
        else if (stage === 3) {
          check('premature completion is rejected with a verification failure', body.messages.some(m => m.role === 'system' && m.content.includes('verification failed')));
          check('real failed assertion reaches HTTP model as tool output', body.messages.some(m => m.role === 'tool' && m.content.includes('EXPECTED_SUM_42')));
          message = tool('edit_file', { path: 'src/math.cjs', oldText: 'return a + b + 1', newText: 'return a + b' });
        } else if (stage === 4) message = tool('exec', { command: 'node', args: ['--test', 'test/math.test.cjs'] });
        else message = text('Fixed addition and verified the test.');
      } else if (scenario === 'deny' && stage === 0) message = tool('write_file', { path: 'denied.txt', content: 'must not land' });
      else if (scenario === 'cancel' && stage === 0) message = tool('exec', { command: 'node', args: ['-e', "require('fs').writeFileSync('started.txt','started');setTimeout(()=>{},60000)"] });
      else message = text('Done.');
      stage++;
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.end(`data: ${JSON.stringify({ choices: [{ index: 0, delta: message, finish_reason: message.tool_calls ? 'tool_calls' : 'stop' }] })}\n\ndata: [DONE]\n\n`);
    } catch (error) { res.writeHead(500); res.end(String(error)); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}/v1`;
  const env = { ...process.env, OPENAI_API_KEY: 'local-scripted-no-cost', OPENAI_BASE_URL: base,
    OPENAI_MODEL: 'coding-fixture-model', HARNESS_MEMORY: '0', HARNESS_DATA_DIR: '', OPENAI_MAX_PROVIDER_RETRIES: '0' };
  async function command(file, args, cwd, opts = {}) {
    return new Promise((resolve, reject) => {
      const child = spawn(file, args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
      let stdout = ''; let stderr = ''; let signalTimer;
      const deadline = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`command timed out: ${file}`)); }, 60_000);
      child.stdout.on('data', data => { stdout += data; });
      child.stderr.on('data', data => {
        stderr += data;
        if (opts.cancel && stderr.includes('allowed for this call') && signalTimer === undefined) {
          signalTimer = setInterval(async () => {
            try { await readFile(join(cwd, 'started.txt')); clearInterval(signalTimer); child.kill('SIGINT'); } catch {}
          }, 25);
        }
      });
      child.on('error', reject);
      child.stdin.on('error', error => { if (error.code !== 'EPIPE') reject(error); });
      child.on('close', (code, signal) => { clearTimeout(deadline); clearInterval(signalTimer); resolve({ code, signal, stdout, stderr }); });
      child.stdin.end(opts.input ?? '');
    });
  }
  const runs = {};
  try {
    const project = join(root, 'project with space'); const data = join(root, 'data');
    await mkdir(join(project, 'src'), { recursive: true }); await mkdir(join(project, 'test'));
    await writeFile(join(project, 'package.json'), JSON.stringify({ scripts: { test: 'node --test test/math.test.cjs' } }));
    await writeFile(join(project, 'src/math.cjs'), 'module.exports.add = (a, b) => { return a - b; };\n');
    await writeFile(join(project, 'test/math.test.cjs'), "const {test}=require('node:test');const assert=require('node:assert/strict');const {add}=require('../src/math.cjs');test('EXPECTED_SUM_42',()=>assert.equal(add(19,23),42));\n");
    check('temporary real Git repository initialized', (await command('git', ['init', '-q'], project)).code === 0);
    check('repository files staged for independent diff', (await command('git', ['add', '.'], project)).code === 0);
    runs.coding = await command(process.execPath, [cli, '--data-dir', data, 'run', project, 'Fix addition and verify.', '--verify', 'node --test test/math.test.cjs'], root, { input: 'allow\n'.repeat(5) });
    await writeFile(join(output, 'coding-run.json'), JSON.stringify(runs.coding, null, 2));
    check('real CLI exits successfully', runs.coding.code === 0);
    check('final verification gate actually passed', runs.coding.stdout.includes('verification: passed'));
    check('CLI reports verified_complete rather than relying on assistant text', runs.coding.stdout.includes('grade: verified_complete'));
    check('five separate operations were explicitly approved', (runs.coding.stderr.match(/allowed for this call/g) ?? []).length === 5);
    check('CLI exposes active session and turn before final result', runs.coding.stdout.startsWith('run started: session '));
    check('actual source contains the corrected implementation', (await readFile(join(project, 'src/math.cjs'), 'utf8')).includes('return a + b;'));
    check('repeated edits report one changed file matching the Git diff inventory', runs.coding.stdout.includes('files changed: src/math.cjs\n'));
    runs.independentTest = await command(process.execPath, ['--test', 'test/math.test.cjs'], project);
    check('independent test process passes after the agent exits', runs.independentTest.code === 0);
    runs.diff = await command('git', ['diff', '--', 'src/math.cjs'], project);
    check('Git diff records the real code fix', runs.diff.stdout.includes('-module.exports') && runs.diff.stdout.includes('+module.exports'));
    scenario = 'deny'; stage = 0;
    runs.deny = await command(process.execPath, [cli, 'run', project, 'Write a file'], root);
    let deniedExists = true; try { await readFile(join(project, 'denied.txt')); } catch { deniedExists = false; }
    check('stdin EOF rejects a write and creates no file', !deniedExists && runs.deny.stderr.includes('denied'));
    scenario = 'fail'; stage = 0;
    runs.failedVerification = await command(process.execPath, [cli, 'run', project, 'Claim done', '--verify', 'node -e "process.exit(17)"'], root, { input: 'allow\n'.repeat(3) });
    check('a persistently failing verification cannot return success', runs.failedVerification.code === 1 && runs.failedVerification.stdout.includes('status: failed'));
    check('failed verification gives the model bounded repair attempts', stage === 3);
    if (process.platform !== 'win32') {
      scenario = 'cancel'; stage = 0;
      runs.cancel = await command(process.execPath, [cli, 'run', project, 'Start a long process'], project, { input: 'allow\n', cancel: true });
      check('Ctrl-C cancels the real running command through runtime', runs.cancel.code === 1 && runs.cancel.stdout.includes('status: cancelled'));
    }
    const beforeInvalid = requests.length;
    runs.invalidRoot = await command(process.execPath, [cli, 'run', join(root, 'absent'), 'edit'], root);
    check('invalid cwd fails before any provider request', runs.invalidRoot.code === 1 && requests.length === beforeInvalid);
    runs.resume = await command(process.execPath, [cli, '--data-dir', data, 'sessions'], root);
    const sessionId = /run started: session (\S+)/.exec(runs.coding.stdout)[1];
    check('a fresh CLI process can read the durable session', runs.resume.code === 0 && runs.resume.stdout.includes(sessionId));
    runs.trace = await command(process.execPath, [cli, '--data-dir', data, 'trace', sessionId, join(output, 'episode')], root);
    check('a fresh CLI process can export the durable completed turn', runs.trace.code === 0);
    const archivedSession = JSON.parse(await readFile(join(output, 'episode/session.json'), 'utf8'));
    check('session model identity equals the model used on the HTTP wire', archivedSession.model.modelId === 'coding-fixture-model' && requests.every(request => request.body.model === 'coding-fixture-model'));
    // Real production Web entrypoint: HTTP message + live SSE approval + the
    // same required verification, then a restart and follow-up on that session.
    await writeFile(join(project, 'src/math.cjs'), 'module.exports.add = (a, b) => { return a - b; };\n');
    const webData = join(root, 'web-data'); let child; let childExit; let webLogs = ''; let stream;
    const frames = [];
    async function startWeb() {
      child = spawn(process.execPath, [web], { cwd: project, env: { ...env, HARNESS_WEB_PORT: '0', HARNESS_DATA_DIR: webData,
        HARNESS_VERIFY_COMMAND: 'node --test test/math.test.cjs' }, stdio: ['ignore', 'pipe', 'pipe'] });
      childExit = new Promise(resolve => child.once('close', (code, signal) => resolve({ code, signal })));
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Web startup timed out')), 30_000);
        let output = '';
        child.on('error', reject);
        child.stderr.on('data', data => { webLogs += data; });
        child.stdout.on('data', data => {
          output += data; webLogs += data;
          const match = /listening on (http:\/\/127\.0\.0\.1:\d+)/.exec(output);
          if (match) { clearTimeout(timer); resolve(match[1]); }
        });
        child.once('close', () => { clearTimeout(timer); if (!output.includes('listening on')) reject(new Error('Web exited before startup')); });
      });
    }
    async function stopWeb() { child.kill('SIGTERM'); return childExit; }
    async function webTurn(address, text) {
      const afterSequence = Math.max(0, ...frames.map(frame => frame.event?.sequence ?? 0));
      const response = await fetch(`${address}/api/events?from=coding-audit`); stream = response.body.getReader();
      const delivered = await fetch(`${address}/api/messages`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ from: 'coding-audit', text }) });
      check('Web accepts a real coding message', delivered.status === 200);
      let buffer = ''; const decoder = new TextDecoder(); const approved = new Set();
      const timeout = setTimeout(() => { void stream.cancel('SSE acceptance deadline'); }, 30_000);
      try {
        while (true) {
          const chunk = await stream.read(); if (chunk.done) throw new Error('SSE ended before the turn completed');
          buffer += decoder.decode(chunk.value, { stream: true });
          let boundary;
          while ((boundary = buffer.indexOf('\n\n')) !== -1) {
            const block = buffer.slice(0, boundary); buffer = buffer.slice(boundary + 2);
            for (const line of block.split('\n')) {
              if (!line.startsWith('data: ')) continue;
              const frame = JSON.parse(line.slice(6)); frames.push(frame);
              const event = frame.event;
              if (event && event.sequence <= afterSequence) continue;
              if (event?.type === 'approval.created' && event.payload.pending && !approved.has(event.payload.approvalId)) {
                approved.add(event.payload.approvalId);
                const decision = await fetch(`${address}/api/commands`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ from: 'coding-audit', text: `approve:${event.payload.approvalId}:allow` }) });
                check('Web approval button protocol authorizes one real operation', decision.status === 200);
              }
              if (event?.type === 'turn.failed' || event?.type === 'turn.cancelled') throw new Error(`Web turn ${event.type}`);
              if (event?.type === 'turn.completed') return { approvals: approved.size, event };
            }
          }
        }
      } finally { clearTimeout(timeout); await stream.cancel(); stream = undefined; }
    }
    try {
      scenario = 'web-coding'; stage = 0;
      let address = await startWeb();
      runs.webCoding = await webTurn(address, 'Fix addition in this project and verify.');
      check('Web coding repair performs five independently approved operations', runs.webCoding.approvals === 5);
      check('Web final completion follows a real successful verification', frames.some(frame => frame.event?.type === 'verification.completed'));
      runs.webIndependentTest = await command(process.execPath, ['--test', 'test/math.test.cjs'], project);
      check('independent process verifies the Web agent code change', runs.webIndependentTest.code === 0);
      const history = await (await fetch(`${address}/api/history?from=coding-audit`)).json();
      check('Web history retains the corrected answer', history.messages.some(message => message.content.includes('Fixed addition and verified')));
      runs.webShutdown = await stopWeb();
      scenario = 'web-followup'; stage = 0;
      address = await startWeb();
      const restored = await (await fetch(`${address}/api/history?from=coding-audit`)).json();
      check('production Web restart restores the same session and history', restored.sessionId === history.sessionId && restored.messages.length === history.messages.length);
      // A fresh SSE stream replays old events; ignore those through the
      // established reconnect cursor rather than treating them as a new turn.
      runs.webFollowup = await webTurn(address, 'Confirm the fix again.');
      check('Web follow-up gets its own verification approval', runs.webFollowup.approvals === 1);
      check('restored session runs a new turn', runs.webFollowup.event.turnId !== runs.webCoding.event.turnId);
      runs.webFinalShutdown = await stopWeb(); child = undefined;
      await writeFile(join(output, 'web-frames.json'), JSON.stringify(frames, null, 2));
      await writeFile(join(output, 'web-process.log'), webLogs);
    } finally { if (stream) await stream.cancel(); if (child) { child.kill('SIGTERM'); await childExit; } }
    const sourceSha = (await command('git', ['rev-parse', 'HEAD'], sourceRoot)).stdout.trim();
    const sourceTreeClean = (await command('git', ['status', '--porcelain'], sourceRoot)).stdout.trim() === '';
    const result = { schemaVersion: 1, kind: 'scripted-local-HTTP-engineering-acceptance', paidModelCalls: 0, sourceSha, sourceTreeClean,
      platform: process.platform, node: process.version, assertions, requests: requests.length, status: 'PASS',
      skipped: process.platform === 'win32' ? ['POSIX SIGINT CLI case; native Windows tree cancellation is exercised by windows-acceptance regressions'] : [] };
    await writeFile(join(output, 'result.json'), JSON.stringify(result, null, 2) + '\n');
    // Lossless small receipt remains obtainable through the official Checks
    // API when the environment cannot download Actions blob artifacts.
    if (process.env.GITHUB_ACTIONS === 'true') console.log(`::notice title=Coding acceptance receipt::${JSON.stringify({ encoding: 'gzip+base64', data: gzipSync(Buffer.from(JSON.stringify(result))).toString('base64') })}`);
    return result;
  } finally {
    await writeFile(join(output, 'requests.json'), JSON.stringify(requests, null, 2) + '\n');
    await writeFile(join(output, 'runs.json'), JSON.stringify(runs, null, 2) + '\n');
    await new Promise(resolve => server.close(resolve));
    await rm(root, { recursive: true, force: true });
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  console.log(JSON.stringify(await runCodingAcceptance(process.argv[2])));
}
