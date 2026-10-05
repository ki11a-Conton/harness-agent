import fs from 'node:fs/promises';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';

const repo = resolve(process.argv[2] ?? process.cwd());
const out = resolve(process.argv[3]);
mkdirSync(out); // Refuse to overwrite baseline evidence.
const git = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const sourcePaths = ['packages/tools/src/tools/search-files.ts', 'packages/tools/src/tools/read-file.ts', 'packages/tools/src/orchestrator.ts', 'packages/security/src/permission.ts', 'packages/security/src/sandbox.ts', 'tasks/P0/VS-001.md', 'packages/tools/dist/tools/search-files.js', 'packages/tools/dist/tools/read-file.js'];
const fingerprints = () => Object.fromEntries(sourcePaths.map(p => [p, hash(readFileSync(join(repo, p)))]));
const before = fingerprints();
const report = { sourceSha: git('rev-parse', 'HEAD'), trackedDirtyAtStart: git('status', '--porcelain=v1', '--untracked-files=no') !== '', profile: 'production ToolRegistry -> ToolOrchestrator -> DeterministicPermissionEngine -> SandboxManager -> unchanged native filesystem tools', paidCalls: 0, contract: 'tasks/P0/VS-001.md: search_files returns workspace-relative POSIX paths', observedAt: new Date().toISOString(), before, cases: [] };
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
  const record = (id, expected, observed, pass) => report.cases.push({ id, expected, observed, status: pass ? 'PASS' : 'FAIL' });
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
} finally {
  Object.assign(fs, originals);
  syncBuiltinESMExports();
  await fs.rm(root, { recursive: true, force: true });
  await fs.rm(outside, { recursive: true, force: true });
  report.sourceShaAtEnd = git('rev-parse', 'HEAD');
  report.trackedDirtyAtEnd = git('status', '--porcelain=v1', '--untracked-files=no') !== '';
  report.after = fingerprints();
  report.sourceUnchanged = JSON.stringify(before) === JSON.stringify(report.after) && report.sourceSha === report.sourceShaAtEnd;
  report.summary = { cases: report.cases.length, passed: report.cases.filter(c => c.status === 'PASS').length, failed: report.cases.filter(c => c.status === 'FAIL').map(c => c.id) };
  report.status = report.summary.failed.length === 0 ? 'PASS' : 'REPRODUCED_DEFECT';
  writeFileSync(join(out, 'result.json'), `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx' });
  process.stdout.write(`${JSON.stringify({ status: report.status, sourceUnchanged: report.sourceUnchanged, ...report.summary })}\n`);
}
