// Offline browser fixture: real composition roots; only the model is scripted.
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { createServer, request as httpRequest } from 'node:http';
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const args = process.argv.slice(2);
const opt = (key, fallback) => args.includes(key) ? args[args.indexOf(key) + 1] : fallback;
const repo = resolve(opt('--repo', resolve(dirname(fileURLToPath(import.meta.url)), '../../..')));
const out = resolve(opt('--out', join(repo, '.ci/web-dsh-20261004/fixture')));
const staticDir = resolve(opt('--static-dir', join(repo, 'apps/web/public')));
const cwd = join(out, 'workspace');
await mkdir(cwd, { recursive: true });
const imported = await Promise.all([
  import(pathToFileURL(join(repo, 'packages/harness/dist/index.js'))),
  import(pathToFileURL(join(repo, 'packages/gateway/dist/index.js'))),
  import(pathToFileURL(join(repo, 'apps/web/dist/index.js'))),
]);
const [{ createHarness }, { createRuntimeRpc, Gateway }, { WebChannelAdapter, SessionBindings, TrackingRegistry, WebServer }] = imported;
const calls = [];
const provider = {
  id: 'offline-web-browser-script',
  async listModels() { return [{ id: 'scripted-web', capabilities: { toolCalling: true, contextWindowTokens: 128000 } }]; },
  createClient() {
    return { async *generate(request, signal) {
      const messages = request.messages;
      const userIndex = messages.findLastIndex(message => message.role === 'user');
      const prompt = String(messages[userIndex]?.content ?? '');
      const after = messages.slice(userIndex + 1);
      const alreadyCalled = after.some(message => message.role === 'tool' || message.toolCalls?.length);
      calls.push({ index: calls.length, prompt, alreadyCalled, at: new Date().toISOString() });
      yield { type: 'started', timestamp: Date.now() };
      if (prompt === '[block]') {
        if (!signal.aborted) await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }));
        calls.at(-1).aborted = signal.aborted;
        yield { type: 'completed', timestamp: Date.now(), result: { finishReason: 'cancelled' } };
        return;
      }
      if (prompt === '[disconnect-complete]') await new Promise(resolve => setTimeout(resolve, 1200));
      if (!alreadyCalled && ['[allow-write]', '[deny-write]', '[sandbox-deny]', '[fail-verification]'].includes(prompt)) {
        const path = prompt === '[allow-write]' ? 'allowed.txt' : prompt === '[deny-write]' ? 'denied.txt' : prompt === '[fail-verification]' ? 'fail-verification.flag' : '../outside.txt';
        const toolCall = { id: `browser-call-${calls.length}`, name: 'write_file', args: { path, content: 'ACTUAL_HARNESS_WRITE\n' } };
        yield { type: 'tool_call_delta', timestamp: Date.now(), toolCall };
        yield { type: 'completed', timestamp: Date.now(), result: { finishReason: 'tool_calls', toolCalls: [toolCall] } };
        return;
      }
      const text = `HARNESS_REPLY:${prompt}`;
      yield { type: 'text_delta', timestamp: Date.now(), text };
      yield { type: 'completed', timestamp: Date.now(), result: { finishReason: 'stop', text } };
    } };
  },
};
const harness = await createHarness({
  cwd, dataDir: join(out, 'runtime-data'), profile: 'interactive',
  modelProvider: provider, model: { providerId: provider.id, modelId: 'scripted-web' },
  task: { id: 'WEB-DSH-20261004-browser', goal: 'Exercise production Web paths',
    completionPolicy: { requiresVerification: true },
    verification: [{ kind: 'command', command: process.execPath, args: ['-e', "console.log('WEB_VERIFICATION_EXECUTED');process.exit(require('node:fs').existsSync('fail-verification.flag')?7:0)"], description: 'Actual offline child-process acceptance gate; real marker created only by approved write_file makes it fail' }] },
});
// Trusted test host authorizes command verification; file-edit approvals remain interactive.
harness.agents[0].permissions = { ...harness.agents[0].permissions, rules: [{ action: 'exec', resource: 'command', effect: 'allow' }, ...harness.agents[0].permissions.rules] };
const bindings = new SessionBindings();
const registry = createRuntimeRpc(harness.runtime, { sessionService: harness.sessionService, sessions: harness.sessions, approvalStore: harness.approvalStore, events: harness.events });
const tracking = new TrackingRegistry(registry, session => bindings.onSessionCreated(session));
const adapter = new WebChannelAdapter();
const gateway = new Gateway({ rpc: tracking, channels: [adapter], sessionService: harness.sessionService, approvalStore: harness.approvalStore, events: harness.events, sessionDefaults: { agentId: harness.agents[0].id, cwd }, pollDelayMs: 10 });
await gateway.start();
// Transparent loopback transport. Faults affect real SSE sockets only; all
// frames still originate from WebServer and no application data is fabricated.
const heldStreams = new Set();
const waitingStreams = new Map();
const liveStreams = new Map();
const transportFaults = [];
const proxy = createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const isSse = url.pathname === '/api/events';
  const from = url.searchParams.get('from');
  const forward = () => {
    if (res.destroyed) return;
  const upstream = httpRequest({ hostname: '127.0.0.1', port: address.port, method: req.method, path: req.url, headers: req.headers }, upstreamRes => {
    entry.upstreamRes = upstreamRes;
    res.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.headers);
    upstreamRes.pipe(res);
    upstreamRes.on('error', () => res.destroy());
  });
  const entry = { upstream, res, upstreamRes: null };
  if (isSse) {
    const entries = liveStreams.get(from) ?? new Set();
    entries.add(entry); liveStreams.set(from, entries);
    res.on('close', () => {
      entries.delete(entry);
      if (entries.size === 0 && liveStreams.get(from) === entries) liveStreams.delete(from);
      upstream.destroy(); entry.upstreamRes?.destroy();
    });
  }
  upstream.on('error', error => {
    if (res.destroyed) return;
    if (!res.headersSent) res.writeHead(502, { 'Content-Type': 'text/plain' });
    res.end(`Transport error: ${error.code ?? 'unknown'}`);
  });
  req.pipe(upstream);
  };
  if (isSse && heldStreams.has(from)) {
    // Keep a real reconnect request pending until release. A non-200 status
    // can permanently close native EventSource and would test another policy.
    const entries = waitingStreams.get(from) ?? new Set();
    const waiting = { res, forward };
    entries.add(waiting); waitingStreams.set(from, entries);
    res.on('close', () => {
      entries.delete(waiting);
      if (entries.size === 0 && waitingStreams.get(from) === entries) waitingStreams.delete(from);
    });
    transportFaults.push({ action: 'held-reconnect', from, at: new Date().toISOString() });
    return;
  }
  forward();
});
await new Promise(resolve => proxy.listen(0, '127.0.0.1', resolve));
// Explicitly authorize this test-owned reverse proxy, preserving production checks.
const server = new WebServer({ adapter, bindings, events: harness.events, store: harness.store, approvalStore: harness.approvalStore, host: '127.0.0.1', port: 0, allowedHosts: ['127.0.0.1:' + proxy.address().port], allowedOrigins: ['http://127.0.0.1:' + proxy.address().port], pollDelayMs: 10, staticDir });
const address = await server.start();

// Separate, explicitly named fault controller. Inspector below stays read-only.
const transportControl = createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const from = url.searchParams.get('from');
  if (req.method !== 'POST' || !['/hold', '/release'].includes(url.pathname) || from === null || !/^[A-Za-z0-9-]{8,64}$/.test(from)) {
    res.writeHead(400); res.end('invalid transport fault command'); return;
  }
  let droppedSockets = 0;
  let releasedRequests = 0;
  if (url.pathname === '/hold') {
    heldStreams.add(from);
    for (const entry of liveStreams.get(from) ?? []) {
      droppedSockets++;
      entry.res.destroy(); entry.upstreamRes?.destroy(); entry.upstream.destroy();
    }
  } else {
    heldStreams.delete(from);
    const waiting = waitingStreams.get(from);
    waitingStreams.delete(from);
    for (const entry of waiting ?? []) {
      if (!entry.res.destroyed) { releasedRequests++; entry.forward(); }
    }
  }
  const receipt = { action: url.pathname.slice(1), from, droppedSockets, releasedRequests, at: new Date().toISOString() };
  transportFaults.push(receipt);
  res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(receipt));
});
await new Promise(resolve => transportControl.listen(0, '127.0.0.1', resolve));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const sourcePaths = ['apps/web/src/server.ts', 'apps/web/src/adapter.ts', 'apps/web/src/bindings.ts', 'packages/gateway/src/gateway.ts', 'packages/harness/src/create-harness.ts'];
const distPaths = ['apps/web/dist/server.js', 'apps/web/dist/adapter.js', 'apps/web/dist/bindings.js', 'packages/gateway/dist/gateway.js', 'packages/harness/dist/create-harness.js'];
const fingerprints = {};
for (const path of [...sourcePaths, ...distPaths]) fingerprints[path] = hash(await readFile(join(repo, path)));
for (const path of (await readdir(staticDir, { recursive: true })).sort()) {
  if ((await stat(join(staticDir, path))).isFile()) fingerprints[`static/${path}`] = hash(await readFile(join(staticDir, path)));
}
const provenance = { sourceSha: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim(), trackedDirty: Boolean(execFileSync('git', ['status', '--porcelain', '--untracked-files=no'], { cwd: repo, encoding: 'utf8' }).trim()), fingerprints, node: process.version, fixtureSha256: hash(await readFile(fileURLToPath(import.meta.url))), staticDir, paidCalls: 0, realModelQuality: 'NOT_RUN', promotion: 'NOT_RUN' };
async function snapshot() {
  const sessions = await harness.store.listSessions();
  const records = [];
  for (const session of sessions) records.push({ session, messages: await harness.store.listMessages(session.id), events: await harness.events.list(session.id) });
  const files = {};
  for (const name of ['allowed.txt', 'denied.txt', '../outside.txt', 'fail-verification.flag']) {
    try { files[name] = await readFile(join(cwd, name), 'utf8'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; files[name] = null; }
  }
  return { ...provenance, bindings: bindings.all(), calls, pendingApprovals: harness.approvalStore.listPending(), records, files, transportFaults };
}
// Separate loopback-only, READ-ONLY evidence endpoint; never starts/approves turns.
const inspector = createServer((req, res) => {
  if (req.method !== 'GET' || req.url !== '/snapshot') { res.writeHead(404); res.end(); return; }
  void snapshot().then(data => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(data)); }, error => { res.writeHead(500); res.end(String(error)); });
});
await new Promise(resolve => inspector.listen(0, '127.0.0.1', resolve));
const ready = { base: `http://127.0.0.1:${proxy.address().port}`, backend: `http://127.0.0.1:${address.port}`, transportControl: `http://127.0.0.1:${transportControl.address().port}`, inspector: `http://127.0.0.1:${inspector.address().port}/snapshot`, cwd, ...provenance };
await writeFile(join(out, 'ready.json'), JSON.stringify(ready, null, 2) + '\n');
console.log(JSON.stringify({ ready: true, ...ready }));
let stopping = false;
async function stop() {
  if (stopping) return; stopping = true;
  await writeFile(join(out, 'runtime-snapshot.json'), JSON.stringify(await snapshot(), null, 2) + '\n');
  for (const entries of liveStreams.values()) for (const entry of entries) { entry.res.destroy(); entry.upstreamRes?.destroy(); entry.upstream.destroy(); }
  for (const entries of waitingStreams.values()) for (const entry of entries) entry.res.destroy();
  await new Promise(resolve => proxy.close(resolve));
  await new Promise(resolve => transportControl.close(resolve));
  await new Promise(resolve => inspector.close(resolve));
  await server.stop(); await gateway.stop(); await harness.close();
}
process.once('SIGTERM', () => void stop());
process.once('SIGINT', () => void stop());
