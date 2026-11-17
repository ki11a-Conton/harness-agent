import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const before = '\ufeffexports.first = 1;\r\nexports.second = 2;\n';
const expected = '\ufeffexports.first = 10;\r\nexports.second = 20;\n';
const external = '// external writer retained\n';
// Native successes are plain JSON on the Chat Completions wire; failures
// retain their explicit status prefix. Inspect the actual transport shape.
const status = text => /^\[([^\]]+)\]/.exec(text)?.[1] ?? (text.trimStart().startsWith('{') ? 'success' : undefined);
const payload = text => { assert.equal(status(text), 'success', text); return JSON.parse(text.slice(text.indexOf('{'))); };
const timeout = (promise, ms, label) => new Promise((done, reject) => {
  const timer = setTimeout(() => reject(new Error(label)), ms);
  promise.then(value => { clearTimeout(timer); done(value); }, error => { clearTimeout(timer); reject(error); });
});

/** Shared production CLI/Web protocol fixture. The provider only chooses from
 * actual tool feedback; fixture observers perform the external-user mutation.
 * Installed callers verify the archive before and after invoking this module. */
export async function runEditReceiptAcceptance(outputDir, entrypoints) {
  assert(entrypoints.cli && entrypoints.web && /^[a-f0-9]{40}$/.test(entrypoints.sourceSha));
  const output = resolve(outputDir); await mkdir(output, { recursive: true });
  const root = await realpath(await mkdtemp(join(tmpdir(), 'coding-edit-receipts-')));
  const runs = [], requests = []; let active;
  const server = createServer(async (request, response) => {
    try {
      if (request.url === '/v1/models') {
        response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify({ data: [{ id: 'edit-receipts-fixture' }] })); return;
      }
      assert.equal(request.url, '/v1/chat/completions'); const run = active; assert(run);
      let raw = ''; for await (const chunk of request) raw += chunk;
      const body = JSON.parse(raw); requests.push({ surface: run.surface, scenario: run.scenario, index: run.requests++, body });
      assert(body.tools.some(tool => tool.function.name === 'edit_file'));
      if (entrypoints.requireReceipts !== false) assert(JSON.stringify(body.messages.filter(message => message.role === 'system'))
        .includes('A successful edit returns sha256'), 'coding-v2 must advertise the actual version feedback guidance');
      const last = body.messages.filter(message => message.role === 'tool').at(-1)?.content ?? '';
      let name, args;
      const editSecond = () => { name = 'edit_file'; args = { path: 'values.cjs', expectedSha256: run.version, oldText: 'second = 2', newText: 'second = 20' }; };
      if (run.phase === 'start') {
        name = 'read_file'; args = { path: 'values.cjs', versioned: true }; run.phase = 'read';
      } else if (run.phase === 'read') {
        const read = payload(last); assert.equal(read.content, before); assert.match(read.sha256, /^[a-f0-9]{64}$/); run.version = read.sha256;
        name = 'edit_file'; args = { path: 'values.cjs', expectedSha256: run.version, oldText: 'first = 1', newText: 'first = 1' }; run.phase = 'noop';
      } else if (run.phase === 'noop') {
        run.noOpStatus = status(last); assert.equal(await readFile(run.target, 'utf8'), before);
        if (entrypoints.requireReceipts !== false) { assert.equal(run.noOpStatus, 'failed', last); assert.match(last, /no change|identical/i); }
        else { assert.equal(run.noOpStatus, 'success'); assert.deepEqual(payload(last).diff, ['(no change)']); }
        name = 'edit_file'; args = { path: 'values.cjs', expectedSha256: run.version, oldText: 'first = 1', newText: 'first = 10' }; run.phase = 'first';
      } else if (run.phase === 'first') {
        const receipt = payload(last); run.firstReceipt = receipt;
        assert.equal(await readFile(run.target, 'utf8'), before.replace('first = 1', 'first = 10'));
        if (receipt.sha256 !== undefined) {
          assert.equal(receipt.sha256, digest(await readFile(run.target))); run.version = receipt.sha256;
          if (run.scenario === 'external-writer') await writeFile(run.target, before.replace('first = 1', 'first = 10') + external);
          editSecond(); run.phase = run.scenario === 'external-writer' ? 'stale' : 'second';
        } else {
          assert.equal(entrypoints.requireReceipts, false, 'successful edit must expose its actual version');
          name = 'read_file'; args = { path: 'values.cjs', versioned: true }; run.phase = 'refresh';
        }
      } else if (run.phase === 'stale') {
        assert.equal(status(last), 'failed', last); assert.match(last, /version changed|missing|read the file again/i);
        assert.equal(await readFile(run.target, 'utf8'), before.replace('first = 1', 'first = 10') + external);
        run.externalPreservedAfterRefusal = true; name = 'read_file'; args = { path: 'values.cjs', versioned: true }; run.phase = 'refresh';
      } else if (run.phase === 'refresh') {
        const read = payload(last); assert.match(read.sha256, /^[a-f0-9]{64}$/); run.version = read.sha256;
        if (run.scenario === 'external-writer') assert(read.content.endsWith(external));
        editSecond(); run.phase = 'second';
      } else if (run.phase === 'second') {
        const receipt = payload(last); run.secondReceipt = receipt;
        if (entrypoints.requireReceipts !== false) assert.equal(receipt.sha256, digest(await readFile(run.target)));
        name = 'exec'; args = { command: process.execPath, args: ['check.cjs'] }; run.phase = 'exec';
      } else {
        assert.equal(run.phase, 'exec'); assert.equal(status(last), 'success', last); assert(last.includes('EDIT_RECEIPTS_CHECK_PASSED')); run.phase = 'done';
      }
      if (name) run.toolCalls.push({ name, args });
      const message = name ? { role: 'assistant', content: null, tool_calls: [{ index: 0, id: `receipt_${run.requests}`, type: 'function', function: { name, arguments: JSON.stringify(args) } }] }
        : { role: 'assistant', content: 'Applied both changes and verified the actual project.' };
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.end(`data: ${JSON.stringify({ choices: [{ index: 0, delta: message, finish_reason: name ? 'tool_calls' : 'stop' }] })}\n\ndata: [DONE]\n\n`);
    } catch (error) {
      if (active) active.providerError = String(error.stack ?? error);
      response.writeHead(500); response.end(String(error));
    }
  });
  await new Promise((done, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', done); });
  const env = { ...process.env, OPENAI_API_KEY: 'local-edit-receipts-fixture', OPENAI_MODEL: 'edit-receipts-fixture',
    OPENAI_BASE_URL: `http://127.0.0.1:${server.address().port}/v1`, OPENAI_MAX_PROVIDER_RETRIES: '0',
    HARNESS_MEMORY: '0', HARNESS_AGENT_PROMPT: 'coding-v2' };
  delete env.NODE_PATH; delete env.NODE_OPTIONS;
  async function command(file, args, cwd, input = '', overrides = {}) {
    const child = spawn(file, args, { cwd, env: { ...env, ...overrides }, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = ''; child.stdout.on('data', bytes => { stdout += bytes; }); child.stderr.on('data', bytes => { stderr += bytes; });
    const exit = new Promise((done, reject) => { child.once('error', reject); child.once('close', (code, signal) => done({ code, signal, stdout, stderr })); });
    child.stdin.on('error', error => { if (error.code !== 'EPIPE') child.kill(); }); child.stdin.end(input);
    try { return await timeout(exit, 60000, 'edit receipt command deadline'); }
    finally { if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await exit; } }
  }
  async function web(project, data, run) {
    const child = spawn(process.execPath, [entrypoints.web], { cwd: project, windowsHide: true,
      env: { ...env, HARNESS_WEB_PORT: '0', HARNESS_DATA_DIR: data, HARNESS_VERIFY_COMMAND: 'node check.cjs' }, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '', reader; const frames = [];
    const exit = new Promise((done, reject) => { child.once('error', reject); child.once('close', (code, signal) => done({ code, signal })); });
    child.stderr.on('data', bytes => { stderr += bytes; });
    try {
      const origin = await timeout(new Promise((done, reject) => {
        child.stdout.on('data', bytes => { stdout += bytes; const match = /listening on (http:\/\/127\.0\.0\.1:\d+)/.exec(stdout); if (match) done(match[1]); });
        exit.then(value => reject(new Error(`Web exited before readiness: ${JSON.stringify(value)} ${stderr}`)), reject);
      }), 30000, 'edit receipt Web readiness deadline');
      const stream = await fetch(origin + '/api/events?from=edit-receipts'); assert.equal(stream.status, 200); reader = stream.body.getReader();
      const sent = await fetch(origin + '/api/messages', { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ from: 'edit-receipts', text: 'Fix both values, preserve user changes and verify the project.' }) }); assert.equal(sent.status, 200);
      let buffer = '', completed = false; const decoder = new TextDecoder(), approved = new Set();
      const deadline = Date.now() + 60000;
      while (!completed) {
        const chunk = await timeout(reader.read(), Math.max(1, deadline - Date.now()), 'edit receipt Web turn deadline');
        assert(!chunk.done, 'Web event stream closed before completion'); buffer += decoder.decode(chunk.value, { stream: true });
        let at;
        while ((at = buffer.indexOf('\n\n')) >= 0) {
          const block = buffer.slice(0, at); buffer = buffer.slice(at + 2);
          for (const line of block.split('\n')) if (line.startsWith('data: ')) {
            const frame = JSON.parse(line.slice(6)); frames.push(frame); const event = frame.event;
            if (event?.type === 'approval.created' && event.payload.pending && !approved.has(event.payload.approvalId)) {
              approved.add(event.payload.approvalId);
              const response = await fetch(origin + '/api/commands', { method: 'POST', headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ from: 'edit-receipts', text: `approve:${event.payload.approvalId}:allow` }) }); assert.equal(response.status, 200);
            }
            assert(!['turn.failed', 'turn.cancelled'].includes(event?.type), JSON.stringify(event));
            if (event?.type === 'turn.completed') { completed = true; run.completedEvent = event; }
          }
        }
      }
      assert(frames.some(frame => frame.event?.type === 'verification.completed'));
      assert.equal(run.completedEvent.payload.terminationReason, 'verified_complete'); run.approvals = approved.size;
    } finally {
      await reader?.cancel().catch(() => {});
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
      try { await timeout(exit, 15000, 'edit receipt Web shutdown deadline'); }
      finally { if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await exit; } }
      await writeFile(join(output, `${run.surface}-${run.scenario}-web.log`), stdout + stderr);
      await writeFile(join(output, `${run.surface}-${run.scenario}-frames.json`), JSON.stringify(frames, null, 2) + '\n');
    }
  }
  try {
    const scenarios = entrypoints.requireReceipts === false ? ['sequential'] : ['sequential', 'external-writer'];
    for (const surface of ['cli', 'web']) for (const scenario of scenarios) {
      const project = join(root, `${surface}-${scenario}`); await mkdir(project); await writeFile(join(project, 'values.cjs'), before);
      await writeFile(join(project, 'check.cjs'), "require('node:assert/strict').deepEqual(require('./values.cjs'),{first:10,second:20});console.log('EDIT_RECEIPTS_CHECK_PASSED');\n");
      const run = active = { surface, scenario, project, target: join(project, 'values.cjs'), phase: 'start', requests: 0, toolCalls: [] }; runs.push(run);
      const data = join(root, `${surface}-${scenario}-state`);
      if (surface === 'cli') {
        run.process = await command(process.execPath, [entrypoints.cli, '--data-dir', data, 'run', project,
          'Fix both values, preserve user changes and verify the project.', '--verify', 'node check.cjs'], root, 'allow\n'.repeat(30));
        assert.equal(run.process.code, 0, run.providerError ?? run.process.stderr); assert(run.process.stdout.includes('grade: verified_complete'), run.process.stdout);
        run.approvals = (run.process.stderr.match(/allowed for this call/g) ?? []).length;
      } else await web(project, data, run);
      assert.equal(run.providerError, undefined); assert.equal(run.phase, 'done');
      const after = await readFile(run.target); assert.equal(after.toString('utf8'), expected + (scenario === 'external-writer' ? external : ''));
      run.finalSha256 = digest(after); run.independentCheck = await command(process.execPath, ['check.cjs'], project); assert.equal(run.independentCheck.code, 0);
      run.calls = { total: run.toolCalls.length, read: run.toolCalls.filter(tool => tool.name === 'read_file').length,
        edit: run.toolCalls.filter(tool => tool.name === 'edit_file').length, exec: run.toolCalls.filter(tool => tool.name === 'exec').length };
      assert.equal(run.calls.read, scenario === 'sequential' && entrypoints.requireReceipts !== false ? 1 : 2);
      if (scenario === 'external-writer') assert(run.externalPreservedAfterRefusal);
      assert(run.approvals >= 3, 'state-changing calls used the actual approval path');
    }
    const result = { status: 'PASS', kind: 'actual-CLI-Web-edit-receipts', sourceSha: entrypoints.sourceSha,
      sourceTreeClean: entrypoints.sourceTreeClean ?? entrypoints.installed === true, agentPrompt: 'coding-v2',
      installed: entrypoints.installed === true, platform: process.platform, node: process.version, paidModelCalls: 0, scenarios: runs.length,
      runs, limitation: 'Deterministic loopback provider; engineering feedback and call counts only, real model quality NOT_PROVEN.' };
    await writeFile(join(output, 'result.json'), JSON.stringify(result, null, 2) + '\n'); return result;
  } finally {
    await writeFile(join(output, 'requests.json'), JSON.stringify(requests, null, 2) + '\n');
    await writeFile(join(output, 'runs.json'), JSON.stringify(runs, null, 2) + '\n');
    server.closeAllConnections(); await new Promise(done => server.close(done));
    await rm(root, { recursive: true, force: true, maxRetries: process.platform === 'win32' ? 8 : 0, retryDelay: 50 });
  }
}
