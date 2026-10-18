import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Engineering A/B: one input-dependent local HTTP provider, real entrypoints,
// separate project/state copies, identical permission and verification policy.
// This does not measure real-model obedience or autonomous task success.
const candidate = fileURLToPath(new URL('../../../', import.meta.url));
const output = resolve(process.argv[2] ?? '.ci/coding-tools');
const baseline = process.argv[3] ? resolve(process.argv[3]) : undefined;
await mkdir(output, { recursive: true });
const root = await mkdtemp(join(tmpdir(), 'coding-tools-http-'));
const before = 'exports.first = 1;\nexports.second = 2;\nexports.third = 3;\n';
const expected = 'exports.first = 10;\nexports.second = 20;\nexports.third = 30;\n';
const edits = [1, 2, 3].map(n => ({ oldText: `= ${n};`, newText: `= ${n * 10};` }));
const digest = data => createHash('sha256').update(data).digest('hex');
const runs = []; const requests = []; let active;
const server = createServer(async (req, res) => {
  try {
    assert.equal(req.url, '/v1/chat/completions');
    let raw = ''; for await (const part of req) raw += part;
    const body = JSON.parse(raw); const run = active;
    const record = { arm: run.arm, surface: run.surface, index: run.requests++, body }; requests.push(record);
    const schemas = Object.fromEntries(body.tools.map(t => [t.function.name, t.function.parameters]));
    const canBatch = !!schemas.edit_file.properties.edits;
    const canScope = !!schemas.repo_map.properties.queryPath;
    run.schema = { canBatch, canScope };
    const history = body.messages.filter(m => m.role === 'tool');
    const last = history.at(-1)?.content ?? '';
    let name, args;
    if (!run.phase) {
      name = 'repo_map'; args = { query: 'formatInvoice', maxFiles: 1, maxCodeTokens: 1600,
        ...(canScope ? { queryPath: 'zzz-target' } : {}) }; run.phase = 'map';
    } else if (run.phase === 'map') {
      assert.ok(!/^\[(failed|denied|cancelled)\]/.test(last), last);
      const map = JSON.parse(last.slice(last.indexOf('{'))).relevantCode;
      run.retrieval = { scope: map.scope ?? null, filesIndexed: map.filesIndexed, complete: map.complete,
        targetFound: map.files.some(f => f.path === 'zzz-target/target.ts'), paths: map.files.map(f => f.path) };
      assert.equal(run.retrieval.targetFound, canScope);
      assert.equal(map.filesIndexed, canScope ? 2 : 500);
      name = 'read_file'; args = { path: 'values.cjs', versioned: true }; run.phase = 'read';
    } else if (run.phase === 'read') {
      assert.ok(!/^\[(failed|denied|cancelled)\]/.test(last), last);
      const read = JSON.parse(last.slice(last.indexOf('{')));
      assert.ok(read.content.includes(edits[run.edited].oldText), 'edit anchor must come from the actual HTTP read');
      name = 'edit_file'; args = { path: 'values.cjs', expectedSha256: read.sha256,
        ...(canBatch ? { edits } : edits[run.edited]) }; run.phase = 'edit';
    } else if (run.phase === 'edit') {
      assert.ok(!/^\[(failed|denied|cancelled)\]/.test(last), last);
      run.edited += canBatch ? 3 : 1;
      if (run.edited < 3) { name = 'read_file'; args = { path: 'values.cjs', versioned: true }; run.phase = 'read'; }
      else { name = 'exec'; args = { command: process.execPath, args: ['--test', 'check.test.cjs'] }; run.phase = 'exec'; }
    } else {
      assert.equal(run.phase, 'exec'); assert.ok(!/^\[(failed|denied|cancelled)\]/.test(last), last);
      assert.ok(last.includes('CODING_THREE_VALUES'), 'real test output must reach the provider'); run.phase = 'done';
    }
    const message = name ? { role: 'assistant', content: null, tool_calls: [{ index: 0, id: `step_${record.index}`, type: 'function', function: { name, arguments: JSON.stringify(args) } }] }
      : { role: 'assistant', content: 'All three values fixed and the actual project tests passed.' };
    message.reasoning_content = 'Local engineering replay; no external model used.';
    if (name) run.toolCalls.push({ name, args });
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.end(`data: ${JSON.stringify({ choices: [{ index: 0, delta: message, finish_reason: name ? 'tool_calls' : 'stop' }] })}\n\ndata: [DONE]\n\n`);
  } catch (error) { active.providerError = String(error.stack); res.writeHead(500); res.end(String(error)); }
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const env = { ...process.env, OPENAI_API_KEY: 'local-scripted-no-cost', OPENAI_BASE_URL: `http://127.0.0.1:${server.address().port}/v1`,
  OPENAI_MODEL: 'coding-tools-fixture', OPENAI_MAX_PROVIDER_RETRIES: '0', HARNESS_MEMORY: '0', HARNESS_DATA_DIR: '', HARNESS_AGENT_PROMPT: 'coding-v2' };
async function command(file, args, cwd, input = '') {
  return new Promise((resolveRun, reject) => {
    const child = spawn(file, args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] }); let stdout = '', stderr = '';
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('command timed out')); }, 60000);
    child.stdout.on('data', d => { stdout += d; }); child.stderr.on('data', d => { stderr += d; });
    child.stdin.on('error', e => { if (e.code !== 'EPIPE') reject(e); }); child.once('error', reject);
    child.once('close', (code, signal) => { clearTimeout(timer); resolveRun({ code, signal, stdout, stderr }); }); child.stdin.end(input);
  });
}
async function webTurn(entry, project, data, run) {
  let child, exit, reader; const frames = [];
  try {
    child = spawn(process.execPath, [entry], { cwd: project, env: { ...env, HARNESS_WEB_PORT: '0', HARNESS_DATA_DIR: data,
      HARNESS_VERIFY_COMMAND: 'node --test check.test.cjs' }, stdio: ['ignore', 'pipe', 'pipe'] });
    exit = new Promise(r => child.once('close', (code, signal) => r({ code, signal }))); let logs = '';
    const address = await new Promise((r, reject) => {
      const timer = setTimeout(() => reject(new Error('Web startup timed out')), 30000);
      child.once('error', e => { clearTimeout(timer); reject(e); });
      child.stdout.on('data', d => { logs += d; const match = /listening on (http:\/\/127\.0\.0\.1:\d+)/.exec(logs); if (match) { clearTimeout(timer); r(match[1]); } });
      child.stderr.on('data', d => { logs += d; });
      child.once('close', () => { clearTimeout(timer); reject(new Error(`Web exited: ${logs}`)); });
    });
    const stream = await fetch(`${address}/api/events?from=coding-tools`); assert.equal(stream.status, 200); reader = stream.body.getReader();
    const sent = await fetch(`${address}/api/messages`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: 'coding-tools', text: 'Inspect the invoice code under zzz-target, then fix all three values and verify.' }) }); assert.equal(sent.status, 200);
    let buffer = ''; const decoder = new TextDecoder(); const approved = new Set(); let completed = false;
    const timer = setTimeout(() => { void reader.cancel('deadline'); }, 60000);
    try {
      while (!completed) {
        const chunk = await reader.read(); assert.ok(!chunk.done, 'SSE must reach completion'); buffer += decoder.decode(chunk.value, { stream: true });
        let boundary;
        while ((boundary = buffer.indexOf('\n\n')) >= 0) {
          const block = buffer.slice(0, boundary); buffer = buffer.slice(boundary + 2);
          for (const line of block.split('\n')) if (line.startsWith('data: ')) {
            const frame = JSON.parse(line.slice(6)); frames.push(frame); const event = frame.event;
            if (event?.type === 'approval.created' && event.payload.pending && !approved.has(event.payload.approvalId)) {
              approved.add(event.payload.approvalId);
              const approvedResponse = await fetch(`${address}/api/commands`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ from: 'coding-tools', text: `approve:${event.payload.approvalId}:allow` }) }); assert.equal(approvedResponse.status, 200);
            }
            assert.ok(!['turn.failed', 'turn.cancelled'].includes(event?.type), JSON.stringify(event));
            if (event?.type === 'turn.completed') { completed = true; run.completedEvent = event; }
          }
        }
      }
    } finally { clearTimeout(timer); }
    assert.ok(frames.some(f => f.event?.type === 'verification.completed'));
    run.approvals = approved.size;
    await writeFile(join(output, `${run.arm}-${run.surface}-frames.json`), JSON.stringify(frames, null, 2) + '\n');
    await writeFile(join(output, `${run.arm}-${run.surface}-web.log`), logs);
  } finally { if (reader) await reader.cancel(); if (child) { child.kill('SIGTERM'); await exit; } }
}
try {
  for (const [arm, source] of [...(baseline ? [['baseline', baseline]] : []), ['candidate', candidate]]) {
    for (const surface of ['cli', 'web']) {
      const project = join(root, `${arm}-${surface} project`); const data = join(root, `${arm}-${surface}-state`);
      await mkdir(join(project, 'aaa-noise'), { recursive: true }); await mkdir(join(project, 'zzz-target'));
      await writeFile(join(project, 'values.cjs'), before);
      await writeFile(join(project, 'package.json'), JSON.stringify({ scripts: { test: 'node --test check.test.cjs' } }));
      await writeFile(join(project, 'check.test.cjs'), "const{test}=require('node:test');const assert=require('node:assert/strict');test('CODING_THREE_VALUES',()=>assert.deepEqual(require('./values.cjs'),{first:10,second:20,third:30}));\n");
      await writeFile(join(project, 'zzz-target/target.ts'), 'export function formatInvoice(value: number) { return String(value); }\n');
      await writeFile(join(project, 'zzz-target/caller.ts'), "import {formatInvoice} from './target.js';export function renderInvoice() { return formatInvoice(2); }\n");
      await Promise.all(Array.from({ length: 510 }, (_, i) => writeFile(join(project, 'aaa-noise', `${String(i).padStart(4, '0')}.ts`), `export function noise${i}() { return 0; }\n`)));
      assert.equal((await command('git', ['init', '-q'], project)).code, 0); assert.equal((await command('git', ['add', '.'], project)).code, 0);
      const run = active = { arm, surface, sourceSha: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: source, encoding: 'utf8' }).trim(),
        sourceTreeClean: execFileSync('git', ['status', '--porcelain'], { cwd: source, encoding: 'utf8' }).trim() === '', requests: 0, edited: 0, toolCalls: [] }; runs.push(run);
      if (surface === 'cli') {
        run.process = await command(process.execPath, [join(source, 'apps/cli/dist/main.js'), '--data-dir', data, 'run', project,
          'Inspect the invoice code under zzz-target, then fix all three values and verify.', '--verify', 'node --test check.test.cjs'], root, 'allow\n'.repeat(20));
        assert.equal(run.process.code, 0, run.providerError ?? run.process.stderr); assert.ok(run.process.stdout.includes('grade: verified_complete'));
        run.approvals = (run.process.stderr.match(/allowed for this call/g) ?? []).length;
      } else await webTurn(join(source, 'apps/web/dist/main.js'), project, data, run);
      assert.equal(run.providerError, undefined); assert.equal(run.phase, 'done');
      const after = await readFile(join(project, 'values.cjs')); assert.equal(after.toString('utf8'), expected); run.finalSha256 = digest(after);
      run.independentTest = await command(process.execPath, ['--test', 'check.test.cjs'], project); assert.equal(run.independentTest.code, 0);
      run.diff = (await command('git', ['diff', '--', 'values.cjs'], project)).stdout; assert.ok(run.diff.includes('+exports.third = 30;'));
      run.calls = { total: run.toolCalls.length, read: run.toolCalls.filter(t => t.name === 'read_file').length, edit: run.toolCalls.filter(t => t.name === 'edit_file').length,
        exec: run.toolCalls.filter(t => t.name === 'exec').length, map: run.toolCalls.filter(t => t.name === 'repo_map').length };
      console.log(JSON.stringify({ arm, surface, calls: run.calls, retrieval: run.retrieval, status: 'PASS' }));
    }
  }
  for (const surface of ['cli', 'web']) {
    const next = runs.find(r => r.arm === 'candidate' && r.surface === surface); assert.equal(next.calls.read, 1); assert.equal(next.calls.edit, 1); assert.equal(next.calls.exec, 1);
    assert.ok(next.schema.canBatch && next.schema.canScope); assert.ok(next.retrieval.targetFound);
    const previous = runs.find(r => r.arm === 'baseline' && r.surface === surface);
    if (previous) { assert.ok(next.calls.total < previous.calls.total); assert.equal(next.finalSha256, previous.finalSha256); assert.ok(!previous.schema.canBatch && !previous.schema.canScope); }
  }
  await writeFile(join(output, 'result.json'), JSON.stringify({ schemaVersion: 1, status: 'PASS', kind: 'paired-local-HTTP-tool-engineering', paidModelCalls: 0,
    realModelQuality: 'NOT_PROVEN', platform: process.platform, node: process.version, beforeSha256: digest(before), expectedSha256: digest(expected), runs,
    limitation: 'A scripted provider selects actions from actual advertised schemas and observed tool results. Counts exclude the host verification command, identical in both arms. No real-model quality claim.' }, null, 2) + '\n');
} finally {
  await writeFile(join(output, 'requests.json'), JSON.stringify(requests, null, 2) + '\n');
  await writeFile(join(output, 'runs.json'), JSON.stringify(runs, null, 2) + '\n');
  await new Promise(r => server.close(r)); await rm(root, { recursive: true, force: true });
}
