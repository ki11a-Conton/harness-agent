import fs from 'node:fs/promises';
import { readFileSync, mkdirSync, constants } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, resolve, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { syncBuiltinESMExports } from 'node:module';
import { createServer } from 'node:net';
import assert from 'node:assert/strict';

const repo = resolve(process.argv[2]);
const out = resolve(process.argv[3]); mkdirSync(dirname(out), { recursive: true }); mkdirSync(out);
const git = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();
const hash = data => createHash('sha256').update(data).digest('hex');
const paths = ['packages/tools/src/tools/read-file.ts', 'packages/tools/src/file-coordination.ts', 'packages/tools/src/orchestrator.ts', 'packages/tools/dist/tools/read-file.js', 'packages/tools/dist/file-coordination.js', 'packages/tools/dist/orchestrator.js', 'packages/harness/dist/create-harness.js', 'scripts/research/agent-next3-20261005/read-resource-probe.mjs'];
const fingerprints = () => Object.fromEntries(paths.map(p => [p, hash(readFileSync(join(repo, p)))]));
const report = { schemaVersion: 'agent-next3-read-resource-v1', sourceSha: git('rev-parse', 'HEAD'), sourceTrackedDirtyAtStart: !!git('status', '--porcelain', '--untracked-files=no'), sourceFingerprintsBefore: fingerprints(), paidProviderCalls: 0, realModelQuality: 'NOT_RUN', windows: 'NOT_RUN', cases: [] };
const root = await fs.mkdtemp(join(tmpdir(), 'ar-read-resource-probe-'));
const originalOpen = fs.open;
const operations = []; const owned = new Set(); let pendingReads = 0, readHook;
fs.open = async (...args) => {
  const observation = { path: String(args[0]), flags: args[1], closed: false, reads: [], stats: 0 };
  operations.push(observation);
  const h = await originalOpen(...args); owned.add(h);
  const close = h.close.bind(h), read = h.readFile.bind(h), stat = h.stat.bind(h);
  h.close = async () => { try { await close(); observation.closed = true; } finally { if (h.fd === -1) owned.delete(h); } };
  h.stat = async (...args) => { observation.stats++; return stat(...args); };
  h.readFile = async options => {
    observation.reads.push({ signalPassed: !!options?.signal, started: Date.now(), aborted: null }); pendingReads++;
    try { const p = read(options); readHook?.(options); return await p; }
    finally { observation.reads.at(-1).aborted = options?.signal?.aborted; pendingReads--; }
  };
  return h;
};
syncBuiltinESMExports();
let server;
try {
  const tools = await import(pathToFileURL(join(repo, 'packages/tools/dist/index.js')).href);
  const coord = await import(pathToFileURL(join(repo, 'packages/tools/dist/file-coordination.js')).href);
  const ids = await import(pathToFileURL(join(repo, 'packages/contracts/dist/ids.js')).href);
  const { createHarness } = await import(pathToFileURL(join(repo, 'packages/harness/dist/index.js')).href);
  const registry = new tools.ToolRegistry();
  for (const tool of tools.createProductionTools({ networkMode: 'deny', availableTools: () => registry.names() })) registry.register(tool);
  const orch = new tools.ToolOrchestrator({ registry, workspaceRoot: root });
  const context = (signal = new AbortController().signal, effect = 'allow', timeoutMs = 1000) => ({ cwd: root, sessionId: ids.newSessionId(), turnId: ids.newTurnId(), agentId: ids.newAgentId(), signal, permissions: { rules: [{ action: 'read', resource: 'file', effect }, { action: 'edit', resource: 'file', effect }] }, sandboxPolicy: { filesystem: { mode: 'workspace-write', allowedPaths: [root] }, network: { mode: 'deny' }, process: { timeoutMs, maxOutputBytes: 1000000 } } });
  const invoke = async (path, versioned = false, ctx = context()) => {
    const offset = operations.length, start = performance.now(); const id = ids.newToolCallId();
    const result = await orch.execute({ id, sessionId: ctx.sessionId, turnId: ctx.turnId, agentId: ctx.agentId, call: { id, name: 'read_file', args: { path, versioned } } }, ctx);
    return { result, elapsedMs: performance.now() - start, operations: operations.slice(offset), ownedAtReturn: owned.size, pendingReadsAtReturn: pendingReads, locksAtReturn: coord.fileLockEntryCount() };
  };
  async function check(name, run) { try { const observed = await run(); report.cases.push({ name, status: 'PASS', observed }); } catch (error) { report.cases.push({ name, status: 'FAIL', error: error.stack }); } }
  const released = r => { assert.equal(r.ownedAtReturn, 0); assert.equal(r.pendingReadsAtReturn, 0); assert.equal(r.locksAtReturn, 0); };
  const regular = Buffer.from('\ufeff中文\r\nbody\n'); await fs.writeFile(join(root, 'regular'), regular);
  for (const [name, bytes] of [['empty', Buffer.alloc(0)], ['unicode-crlf', regular], ['invalid-utf8', Buffer.from([255, 10, 65])]]) {
    await fs.writeFile(join(root, name), bytes);
    await check('versioned-' + name, async () => { const r = await invoke(name, true); assert.equal(r.result.status, 'success'); assert.deepEqual(r.result.output, { path: join(root, name), content: bytes.toString('utf8'), sha256: hash(bytes), bytes: bytes.length }); released(r); return r; });
  }
  await check('regular-default-string', async () => { const r = await invoke('regular'); assert.equal(r.result.output, regular.toString('utf8')); assert.equal(r.operations[0].flags, constants.O_RDONLY | (process.platform === 'win32' ? 0 : constants.O_NONBLOCK)); assert.equal(r.operations[0].reads[0].signalPassed, true); released(r); return r; });
  if (process.platform !== 'win32') {
    execFileSync('mkfifo', [join(root, 'pipe')]); await fs.symlink(join(root, 'pipe'), join(root, 'pipe-alias'));
    for (const path of ['pipe', 'pipe-alias', 'pipe']) await check(path === 'pipe-alias' ? 'fifo-alias-no-writer' : report.cases.some(c => c.name === 'fifo-no-writer') ? 'fifo-repeat-not-queued' : 'fifo-no-writer', async () => {
      const r = await invoke(path); assert.equal(r.result.status, 'failed'); assert.match(r.result.error.message, /regular file/); assert(r.elapsedMs < 250); assert.equal(r.operations[0].reads.length, 0); assert.equal(r.operations[0].closed, true); released(r); return r;
    });
    server = createServer(); await new Promise((yes, no) => { server.once('error', no); server.listen(join(root, 'socket'), yes); });
    await check('unix-socket-not-readable', async () => { const r = await invoke('socket'); assert.equal(r.result.status, 'failed'); assert(r.operations.every(o => o.reads.length === 0)); released(r); return r; });
  }
  await check('directory-not-readable', async () => { const r = await invoke('.'); assert.equal(r.result.status, 'failed'); assert.match(r.result.error.message, /regular file/); assert.equal(r.operations[0].reads.length, 0); released(r); return r; });
  await check('missing-native-error', async () => { const r = await invoke('missing'); assert.equal(r.result.status, 'failed'); assert.match(r.result.error.message, /ENOENT/); released(r); return r; });
  for (const kind of ['permission-deny', 'sandbox-escape', 'pre-abort']) await check(kind + '-zero-open', async () => {
    const ac = new AbortController(); if (kind === 'pre-abort') ac.abort();
    const r = await invoke(kind === 'sandbox-escape' ? '../escape' : 'regular', false, context(ac.signal, kind === 'permission-deny' ? 'deny' : 'allow'));
    assert.equal(r.result.status, kind === 'pre-abort' ? 'cancelled' : 'denied'); assert.equal(r.operations.length, 0); released(r); return r;
  });
  await fs.link(join(root, 'regular'), join(root, 'hard')); await fs.symlink(join(root, 'regular'), join(root, 'alias'));
  for (const path of ['hard', 'alias']) await check(path + '-regular-control', async () => { const r = await invoke(path); assert.equal(r.result.output, regular.toString('utf8')); released(r); return r; });
  await check('native-read-caller-abort', async () => {
    const ac = new AbortController(); readHook = () => ac.abort();
    try { const r = await invoke('regular', false, context(ac.signal)); assert.equal(r.result.status, 'cancelled'); assert.equal(r.result.evidence, undefined); assert.equal(r.operations[0].reads[0].aborted, true); released(r); return r; }
    finally { readHook = undefined; }
  });
  await check('queued-reader-cancellation', async () => {
    let entered, release; const ready = new Promise(r => { entered = r; }), gate = new Promise(r => { release = r; });
    const holder = coord.withFileLock(join(root, 'regular'), undefined, async () => { entered(); await gate; }); await ready;
    const ac = new AbortController(), timer = setTimeout(() => ac.abort(), 20);
    try { const r = await invoke('regular', false, context(ac.signal)); assert.equal(r.result.status, 'cancelled'); assert.equal(r.operations.length, 0); return r; }
    finally { clearTimeout(timer); release(); await holder; assert.equal(coord.fileLockEntryCount(), 0); }
  });
  await check('actual-harness-search-read-conditional-edit', async () => {
    await fs.mkdir(join(root, 'src')); await fs.writeFile(join(root, 'src/target.txt'), 'A=0\r\n中文\n');
    const requests = [], decisions = [], model = { providerId: 'read-resource-probe', modelId: 'scripted' }; let selected, version;
    const provider = { id: model.providerId, listModels: async () => [{ id: model.modelId, name: 'scripted', capabilities: { contextWindowTokens: 128000, toolCalling: true } }], createClient: () => ({ async *generate(request) {
      const phase = requests.length; requests.push(structuredClone(request)); yield { type: 'started', timestamp: Date.now() };
      let call;
      if (phase === 0) call = { id: ids.newToolCallId(), name: 'search_files', args: { path: 'src', pattern: '*.txt' } };
      if (phase === 1) { selected = JSON.parse(request.messages.filter(m => m.role === 'tool').at(-1).content)[0]; call = { id: ids.newToolCallId(), name: 'read_file', args: { path: selected, versioned: true } }; }
      if (phase === 2) { version = JSON.parse(request.messages.filter(m => m.role === 'tool').at(-1).content); call = { id: ids.newToolCallId(), name: 'edit_file', args: { path: selected, oldText: 'A=0', newText: 'A=1', expectedSha256: version.sha256 } }; }
      if (call) decisions.push(call);
      yield { type: 'completed', timestamp: Date.now(), result: call ? { finishReason: 'tool_calls', toolCalls: [call] } : { finishReason: 'stop', text: 'LOCAL_READ_EDIT_DONE' } };
    } }) };
    const dataDir = await fs.mkdtemp(join(tmpdir(), 'ar-read-harness-')); let h, outcome, events;
    try { h = await createHarness({ cwd: root, dataDir, profile: 'test', modelProvider: provider, model }); const session = await h.runtime.createSession({ cwd: root }); const turn = await h.runtime.submitUserInput(session.id, 'Find, read and edit the target'); outcome = await h.runtime.runTurn(session.id, turn.id, new AbortController().signal); events = await h.events.list(session.id); }
    finally { if (h) await h.close(); await fs.rm(dataDir, { recursive: true, force: true }); }
    const raw = { requests, decisions, selected, version, outcome, events, finalBytesBase64: (await fs.readFile(join(root, 'src/target.txt'))).toString('base64') }; await fs.writeFile(join(out, 'harness-search-read-edit.json'), JSON.stringify(raw, null, 2) + '\n');
    assert.equal(outcome.status, 'completed'); assert.equal(requests.length, 4); assert.equal(selected, 'src/target.txt'); assert.equal(version.sha256, hash(Buffer.from('A=0\r\n中文\n'))); assert.equal(await fs.readFile(join(root, 'src/target.txt'), 'utf8'), 'A=1\r\n中文\n'); assert.equal(events.filter(e => e.type === 'tool.completed' && e.payload.status === 'success').length, 3); assert.equal(owned.size, 0); assert.equal(pendingReads, 0); assert.equal(coord.fileLockEntryCount(), 0);
    return { actualHarnessTurns: 1, actualScriptedModelRequests: 4, successfulTools: 3, raw: 'harness-search-read-edit.json', outcome };
  });
} finally {
  fs.open = originalOpen; syncBuiltinESMExports(); if (server) await new Promise(r => server.close(r)); for (const h of owned) await h.close(); await fs.rm(root, { recursive: true, force: true });
  report.sourceShaAtEnd = git('rev-parse', 'HEAD'); report.sourceTrackedDirtyAtEnd = !!git('status', '--porcelain', '--untracked-files=no'); report.sourceFingerprintsAfter = fingerprints(); report.status = report.cases.every(c => c.status === 'PASS') ? 'PASS' : 'FAIL';
  await fs.writeFile(join(out, 'result.json'), JSON.stringify(report, null, 2) + '\n', { flag: 'wx' }); console.log(JSON.stringify({ status: report.status, cases: report.cases.length, failures: report.cases.filter(c => c.status === 'FAIL') }));
}
if (report.status !== 'PASS') process.exitCode = 1;
