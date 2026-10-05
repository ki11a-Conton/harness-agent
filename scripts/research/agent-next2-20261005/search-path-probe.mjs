import fs from 'node:fs/promises';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import assert from 'node:assert/strict';

const repo = resolve(process.argv[2] ?? process.cwd());
if (!process.argv[3]) throw new Error('usage: node search-path-probe.mjs <repo> <fresh-output-dir>');
const out = resolve(process.argv[3]);
mkdirSync(dirname(out), { recursive: true });
mkdirSync(out); // Refuse to overwrite baseline evidence.
const git = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const sourcePaths = ['packages/tools/src/tools/search-files.ts', 'packages/tools/src/tools/read-file.ts', 'packages/tools/src/orchestrator.ts', 'packages/security/src/permission.ts', 'packages/security/src/sandbox.ts', 'tasks/P0/VS-001.md', 'packages/tools/dist/tools/search-files.js', 'packages/tools/dist/tools/read-file.js', 'packages/tools/src/production-tools.ts', 'packages/tools/dist/production-tools.js', 'packages/tools/dist/orchestrator.js', 'packages/tools/dist/registry.js', 'packages/security/dist/permission.js', 'packages/security/dist/sandbox.js', 'packages/harness/src/create-harness.ts', 'packages/harness/dist/create-harness.js', 'scripts/research/agent-next2-20261005/search-path-probe.mjs'];
const fingerprints = () => Object.fromEntries(sourcePaths.map(p => [p, hash(readFileSync(join(repo, p)))]));
const before = fingerprints();
const report = { sourceSha: git('rev-parse', 'HEAD'), sourceTrackedDirtyAtStart: git('status', '--porcelain=v1', '--untracked-files=no') !== '', profile: 'production ToolRegistry -> ToolOrchestrator -> DeterministicPermissionEngine -> SandboxManager -> unchanged native filesystem tools', schema: 'HARNESS_SCOPED_SEARCH_PATH_PRODUCTION_V1', paidProviderCalls: 0, realModelQuality: 'NOT_RUN', windowsRuntime: 'NOT_RUN', contract: 'tasks/P0/VS-001.md: search_files returns workspace-relative POSIX paths', observedAt: new Date().toISOString(), sourceFingerprintsBefore: before, cases: [] };
const root = mkdtempSync(join(tmpdir(), 'ar-search-path-audit-'));
const outside = mkdtempSync(join(tmpdir(), 'ar-search-path-audit-outside-'));
const originals = { readFile: fs.readFile, readdir: fs.readdir };
const operations = [];
for (const name of Object.keys(originals)) fs[name] = async (...args) => {
  operations.push({ operation: name, path: resolve(String(args[0])) });
  return originals[name](...args);
};
syncBuiltinESMExports();
try {
  const tools = await import(pathToFileURL(join(repo, 'packages/tools/dist/index.js')).href);
  const ids = await import(pathToFileURL(join(repo, 'packages/contracts/dist/ids.js')).href);
  const { createHarness } = await import(pathToFileURL(join(repo, 'packages/harness/dist/index.js')).href);
  const registry = new tools.ToolRegistry();
  for (const tool of tools.createProductionTools({ networkMode: 'deny', availableTools: () => registry.names() })) registry.register(tool);
  const orchestrator = new tools.ToolOrchestrator({ registry, workspaceRoot: root });
  const sessionId = ids.newSessionId(), agentId = ids.newAgentId(), turnId = ids.newTurnId();
  const context = (cwd = root, permissions = { rules: [{ action: 'read', resource: 'file', pattern: '**/*', effect: 'allow' }] }) => ({ sessionId, agentId, turnId, cwd, signal: new AbortController().signal, permissions, sandboxPolicy: { filesystem: { mode: 'workspace-write', allowedPaths: [root] }, network: { mode: 'deny' }, process: { timeoutMs: 2000, maxOutputBytes: 100000 } } });
  const invoke = async (name, args, ctx = context()) => {
    operations.length = 0;
    const result = await orchestrator.execute({ id: ids.newToolCallId(), sessionId, agentId, turnId, call: { id: ids.newToolCallId(), name, args } }, ctx);
    return { args, result, operations: [...operations] };
  };
  const write = async (path, bytes) => { await fs.mkdir(dirname(join(root, path)), { recursive: true }); await fs.writeFile(join(root, path), bytes); };
  await write('src/deep/target.ts', 'SCOPED_TARGET_SENTINEL');
  await write('target.ts', 'ROOT_DISTRACTOR_SENTINEL');
  await write('src/root.ts', 'SCOPED_TOPLEVEL_SENTINEL');
  await write('root.ts', 'WRONG_ROOT_SENTINEL');
  await write('src/.git/hidden.ts', 'IGNORED');
  await write('src/node_modules/hidden.ts', 'IGNORED');
  await fs.writeFile(join(outside, 'outside.ts'), 'OUTSIDE');
  const record = (id, expected, observed, pass) => report.cases.push({ name: id, expected, observed, status: pass ? 'PASS' : 'FAIL' });
  const rootSearch = await invoke('search_files', { pattern: '**/*.ts' });
  record('UNSCOPED_WORKSPACE_RELATIVE_CONTROL', { contains: 'src/deep/target.ts' }, rootSearch, rootSearch.result.status === 'success' && rootSearch.result.output.includes('src/deep/target.ts'));
  for (const [id, path] of [['SCOPED_RELATIVE', 'src'], ['SCOPED_RELATIVE_ALIAS', './src/deep/..'], ['SCOPED_ABSOLUTE_ALIAS', join(root, 'src')]]) {
    const found = await invoke('search_files', { pattern: '**/*.ts', path });
    const returned = found.result.output?.find(p => p.endsWith('deep/target.ts'));
    const followup = returned === undefined ? null : await invoke('read_file', { path: returned });
    record(id, { paths: ['src/deep/target.ts', 'src/root.ts'], roundtrip: 'SCOPED_TARGET_SENTINEL' }, { found, returned, followup }, found.result.status === 'success' && found.result.output.includes('src/deep/target.ts') && followup?.result.output === 'SCOPED_TARGET_SENTINEL');
  }
  const shallow = await invoke('search_files', { pattern: 'root.ts', path: 'src' });
  const wrongRead = await invoke('read_file', { path: shallow.result.output[0] });
  record('SCOPED_BASENAME_WRONG_FILE_CLOSED_LOOP', { path: 'src/root.ts', read: 'SCOPED_TOPLEVEL_SENTINEL' }, { shallow, wrongRead }, shallow.result.output[0] === 'src/root.ts' && wrongRead.result.output === 'SCOPED_TOPLEVEL_SENTINEL');
  const nestedContext = context(join(root, 'src'));
  const nested = await invoke('search_files', { pattern: '**/*.ts', path: 'deep' }, nestedContext);
  const nestedRead = await invoke('read_file', { path: nested.result.output[0] }, nestedContext);
  record('NESTED_SESSION_CWD_CLOSED_LOOP', { path: 'deep/target.ts', read: 'SCOPED_TARGET_SENTINEL' }, { nested, nestedRead }, nested.result.output[0] === 'deep/target.ts' && nestedRead.result.output === 'SCOPED_TARGET_SENTINEL');
  const globScope = await invoke('search_files', { pattern: 'deep/*.ts', path: 'src' });
  record('PATTERN_REMAINS_SELECTED_ROOT_RELATIVE', { matchCount: 1 }, globScope, globScope.result.status === 'success' && globScope.result.output.length === 1);
  const cap = await invoke('search_files', { pattern: '**/*.ts', path: 'src', maxResults: 1 });
  record('MAX_RESULTS_CONTROL', { count: 1 }, cap, cap.result.status === 'success' && cap.result.output.length === 1);
  record('IGNORED_DIRS_CONTROL', { hiddenHits: 0, hiddenReads: 0 }, rootSearch, !rootSearch.result.output.some(p => p.includes('hidden.ts')) && !rootSearch.operations.some(p => p.path.includes('/.git/') || p.path.includes('/node_modules/')));
  await fs.symlink(join(outside, 'outside.ts'), join(root, 'src', 'outside-file-link.ts'));
  await fs.symlink(outside, join(root, 'src', 'outside-dir-link'));
  const links = await invoke('search_files', { pattern: '**/*', path: 'src' });
  record('DESCENDANT_SYMLINK_EXISTING_NO_FOLLOW_CONTROL', { outsideReads: 0, symlinkNamesMayBeReturned: true }, links, links.result.status === 'success' && !links.operations.some(o => o.path === outside || o.path.startsWith(`${outside}/`) || o.path.includes('/outside-dir-link/')));
  const restricted = await invoke('search_files', { pattern: '**/*.ts', path: 'src' }, context(root, { rules: [{ action: 'read', resource: 'file', pattern: 'src', effect: 'allow' }], defaultEffect: 'deny' }));
  record('SELECTED_SCOPE_PERMISSION_CONTROL', { status: 'success', allEnumerationWithinSrc: true }, restricted, restricted.result.status === 'success' && restricted.operations.every(o => o.path === join(root, 'src') || o.path.startsWith(join(root, 'src') + '/')));
  const denied = await invoke('search_files', { pattern: '**/*', path: 'src' }, context(root, { rules: [], defaultEffect: 'deny' }));
  record('PERMISSION_DENIAL_ZERO_ENUMERATION_CONTROL', { status: 'denied', enumerations: 0 }, denied, denied.result.status === 'denied' && denied.operations.length === 0);
  const escaped = await invoke('search_files', { pattern: '**/*', path: outside });
  record('SANDBOX_DENIAL_ZERO_ENUMERATION_CONTROL', { status: 'denied', enumerations: 0 }, escaped, escaped.result.status === 'denied' && escaped.operations.length === 0);
  const missing = await invoke('search_files', { pattern: '**/*', path: 'missing' });
  record('MISSING_ROOT_FAILURE_CONTROL', { status: 'failed', evidence: false }, missing, missing.result.status === 'failed' && missing.result.evidence === undefined);
  const invalid = await invoke('search_files', { pattern: '**/*', path: 'src', maxResults: 0 });
  record('SCHEMA_DENIAL_ZERO_ENUMERATION_CONTROL', { status: 'failed', code: 'TOOL_SCHEMA_ERROR', enumerations: 0 }, invalid, invalid.result.status === 'failed' && invalid.result.error?.code === 'TOOL_SCHEMA_ERROR' && invalid.operations.length === 0);
  await write('代码/深层/目标.ts', 'UNICODE_SCOPED_SENTINEL');
  const unicode = await invoke('search_files', { pattern: '**/*.ts', path: '代码' });
  const unicodeRead = await invoke('read_file', { path: unicode.result.output[0] });
  record('UNICODE_SCOPED_PATH_CLOSED_LOOP', { path: '代码/深层/目标.ts', read: 'UNICODE_SCOPED_SENTINEL' }, { unicode, unicodeRead }, unicode.result.output[0] === '代码/深层/目标.ts' && unicodeRead.result.output === 'UNICODE_SCOPED_SENTINEL');

  // The scripted provider chooses its read_file argument ONLY from the actual
  // search_files tool message seen on the next model request. It never supplies
  // the expected scoped path to the runtime or bypasses policy gates.
  async function actualHarness(name, cwd, searchArgs, expectedPath, expectedBody) {
    const requests = [], emittedModelEvents = [], toolDecisions = [];
    let returnedPath, selectedReadPath, readBody, outcome, events, error;
    const model = { providerId: 'scoped-search-production-probe', modelId: 'scripted' };
    const provider = {
      id: model.providerId,
      listModels: async () => [{ id: model.modelId, name: 'scripted', capabilities: { contextWindowTokens: 128000, toolCalling: true } }],
      createClient: () => ({ async *generate(request) {
        const phase = requests.length;
        requests.push(structuredClone(request));
        const started = { type: 'started', timestamp: Date.now() };
        emittedModelEvents.push(started); yield started;
        let completed;
        if (phase === 0) {
          const call = { id: ids.newToolCallId(), name: 'search_files', args: searchArgs };
          toolDecisions.push(call);
          completed = { type: 'completed', timestamp: Date.now(), result: { finishReason: 'tool_calls', toolCalls: [call] } };
        } else if (phase === 1) {
          const message = request.messages.filter(item => item.role === 'tool').at(-1);
          const paths = JSON.parse(message.content);
          assert(Array.isArray(paths) && paths.length === 1 && typeof paths[0] === 'string', 'one actual search result is required');
          returnedPath = paths[0]; selectedReadPath = returnedPath;
          const call = { id: ids.newToolCallId(), name: 'read_file', args: { path: selectedReadPath } };
          toolDecisions.push(call);
          completed = { type: 'completed', timestamp: Date.now(), result: { finishReason: 'tool_calls', toolCalls: [call] } };
        } else {
          readBody = request.messages.filter(item => item.role === 'tool').at(-1)?.content;
          completed = { type: 'completed', timestamp: Date.now(), result: { finishReason: 'stop', text: 'LOCAL_SCOPED_SEARCH_READ_DONE' } };
        }
        emittedModelEvents.push(completed); yield completed;
      } }),
    };
    const dataDir = await fs.mkdtemp(join(tmpdir(), 'ar-scoped-search-harness-data-'));
    operations.length = 0;
    let h;
    try {
      h = await createHarness({ cwd: root, dataDir, profile: 'test', modelProvider: provider, model });
      const session = await h.runtime.createSession({ agent: h.agents[0], cwd });
      const turn = await h.runtime.startTurn(session.id, 'Search the selected directory and read the single returned path; preserve session cwd.');
      outcome = await h.runtime.runTurn(session.id, turn.id, new AbortController().signal);
      events = await h.events.list(session.id);
      assert.equal(outcome.status, 'completed');
      assert.equal(requests.length, 3);
      assert.equal(returnedPath, expectedPath);
      assert.equal(selectedReadPath, returnedPath);
      assert.equal(toolDecisions[1]?.args.path, returnedPath);
      assert.equal(readBody, expectedBody);
      const successful = events.filter(event => event.type === 'tool.completed' && event.payload.status === 'success');
      assert.equal(successful.filter(event => event.payload.tool === 'search_files').length, 1);
      assert.equal(successful.filter(event => event.payload.tool === 'read_file').length, 1);
      assert.equal(events.filter(event => event.type === 'model.completed').length, 3);
    } catch (failure) {
      error = { name: failure.name, message: failure.message, stack: failure.stack };
    } finally {
      const observation = [...operations];
      if (h) await h.close();
      await fs.rm(dataDir, { recursive: true, force: true });
      const rawFile = `${name}.json`;
      const raw = { cwd, searchArgs, expectedPath, expectedBody, requests, emittedModelEvents, toolDecisions, returnedPath, selectedReadPath, readBody, outcome, events, operations: observation, error };
      writeFileSync(join(out, rawFile), JSON.stringify(raw, null, 2) + '\n', { flag: 'wx' });
      record(name, { status: 'completed', requests: 3, searchDispatches: 1, readDispatches: 1, readBody: expectedBody, returnedPathUsedExactly: true }, { returnedPath, selectedReadPath, readBody, outcome, requests: requests.length, rawFile, rawSha256: hash(readFileSync(join(out, rawFile))), error }, !error);
    }
  }
  await actualHarness('HARNESS_SCOPED_BASENAME_RETURNED_PATH_READ', root, { pattern: 'root.ts', path: 'src' }, 'src/root.ts', 'SCOPED_TOPLEVEL_SENTINEL');
  await actualHarness('HARNESS_ABSOLUTE_ALIAS_RETURNED_PATH_READ', root, { pattern: 'deep/*.ts', path: join(root, 'src') }, 'src/deep/target.ts', 'SCOPED_TARGET_SENTINEL');
  await actualHarness('HARNESS_NESTED_CWD_RETURNED_PATH_READ', join(root, 'src'), { pattern: '**/*.ts', path: 'deep' }, 'deep/target.ts', 'SCOPED_TARGET_SENTINEL');
  await actualHarness('HARNESS_UNICODE_RETURNED_PATH_READ', root, { pattern: '**/*.ts', path: '代码' }, '代码/深层/目标.ts', 'UNICODE_SCOPED_SENTINEL');

} catch (failure) {
  report.cases.push({ name: 'UNEXPECTED_PROBE_ERROR', status: 'FAIL', error: { name: failure.name, message: failure.message, stack: failure.stack } });
} finally {
  Object.assign(fs, originals);
  syncBuiltinESMExports();
  await fs.rm(root, { recursive: true, force: true });
  await fs.rm(outside, { recursive: true, force: true });
  report.sourceShaAtEnd = git('rev-parse', 'HEAD');
  report.sourceTrackedDirtyAtEnd = git('status', '--porcelain=v1', '--untracked-files=no') !== '';
  report.sourceFingerprintsAfter = fingerprints();
  report.sourceUnchanged = JSON.stringify(before) === JSON.stringify(report.sourceFingerprintsAfter) && report.sourceSha === report.sourceShaAtEnd;
  report.summary = { cases: report.cases.length, passed: report.cases.filter(c => c.status === 'PASS').length, failed: report.cases.filter(c => c.status === 'FAIL').map(c => c.name) };
  report.status = report.sourceUnchanged && report.cases.length > 0 && report.summary.failed.length === 0 ? 'PASS' : 'FAIL';
  writeFileSync(join(out, 'result.json'), `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx' });
  process.stdout.write(`${JSON.stringify({ status: report.status, sourceUnchanged: report.sourceUnchanged, ...report.summary })}\n`);
  process.exitCode = report.status === 'PASS' ? 0 : 1;
}
