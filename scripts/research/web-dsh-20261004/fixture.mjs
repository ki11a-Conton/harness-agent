// Offline browser fixture: real composition roots; only the model is scripted.
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
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
const bindings = new SessionBindings();
const registry = createRuntimeRpc(harness.runtime, { sessionService: harness.sessionService, sessions: harness.sessions, approvalStore: harness.approvalStore, events: harness.events });
const tracking = new TrackingRegistry(registry, session => bindings.onSessionCreated(session));
const adapter = new WebChannelAdapter();
const gateway = new Gateway({ rpc: tracking, channels: [adapter], sessionService: harness.sessionService, approvalStore: harness.approvalStore, events: harness.events, sessionDefaults: { agentId: harness.agents[0].id, cwd }, pollDelayMs: 10 });
await gateway.start();
const server = new WebServer({ adapter, bindings, events: harness.events, store: harness.store, approvalStore: harness.approvalStore, host: '127.0.0.1', port: 0, pollDelayMs: 10, staticDir });
const address = await server.start();
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
  return { ...provenance, bindings: bindings.all(), calls, pendingApprovals: harness.approvalStore.listPending(), records, files };
}
// Separate loopback-only, READ-ONLY evidence endpoint; never starts/approves turns.
const inspector = createServer((req, res) => {
  if (req.method !== 'GET' || req.url !== '/snapshot') { res.writeHead(404); res.end(); return; }
  void snapshot().then(data => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(data)); }, error => { res.writeHead(500); res.end(String(error)); });
});
await new Promise(resolve => inspector.listen(0, '127.0.0.1', resolve));
const ready = { base: `http://127.0.0.1:${address.port}`, inspector: `http://127.0.0.1:${inspector.address().port}/snapshot`, cwd, ...provenance };
await writeFile(join(out, 'ready.json'), JSON.stringify(ready, null, 2) + '\n');
console.log(JSON.stringify({ ready: true, ...ready }));
let stopping = false;
async function stop() {
  if (stopping) return; stopping = true;
  await writeFile(join(out, 'runtime-snapshot.json'), JSON.stringify(await snapshot(), null, 2) + '\n');
  await new Promise(resolve => inspector.close(resolve));
  await server.stop(); await gateway.stop(); await harness.close();
}
process.once('SIGTERM', () => void stop());
process.once('SIGINT', () => void stop());
