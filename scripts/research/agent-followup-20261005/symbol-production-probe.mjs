import fs from 'node:fs/promises';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';

// Run against the built, real production profile. Only filesystem observation
// is wrapped: outputs still come from registry -> orchestrator -> permission
// and sandbox -> production navigation implementations on actual files.
const workspace = resolve(process.argv[2] ?? process.cwd());
if (!process.argv[3]) throw new Error('usage: node symbol-production-probe.mjs <repo> <fresh-output-dir>');
const output = resolve(process.argv[3]);
mkdirSync(dirname(output), { recursive: true });
mkdirSync(output); // EEXIST is deliberate: never overwrite earlier evidence.
const git = (...args) => execFileSync('git', args, { cwd: workspace, encoding: 'utf8' }).trim();
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const sourcePaths = [
  'packages/tools/src/navigate.ts',
  'packages/tools/src/symbol-index.ts',
  'packages/tools/src/tools/navigation-tools.ts',
  'packages/tools/src/orchestrator.ts',
  'packages/tools/src/registry.ts',
  'packages/tools/src/symbol-scope.regressions.test.ts',
  'packages/security/src/permission.ts',
  'packages/security/src/sandbox.ts',
  'packages/tools/dist/navigate.js',
  'packages/tools/dist/symbol-index.js',
  'packages/tools/dist/tools/navigation-tools.js',
  'packages/tools/dist/orchestrator.js',
  'packages/tools/dist/registry.js',
  'scripts/research/agent-followup-20261005/symbol-production-probe.mjs',
];
const fingerprints = () => Object.fromEntries(sourcePaths.map((path) => [path, sha256(readFileSync(join(workspace, path)))]));
const report = {
  schema: 'HARNESS_SYMBOL_SCOPE_PRODUCTION_V2',
  sourceSha: git('rev-parse', 'HEAD'),
  sourceTrackedDirtyAtStart: git('status', '--porcelain=v1', '--untracked-files=no') !== '',
  sourceDirtAtStart: git('status', '--porcelain=v1'),
  sourceFingerprintsBefore: fingerprints(),
  probeSha256: sha256(readFileSync(new URL(import.meta.url))),
  profile: 'built production tools through ToolRegistry/ToolOrchestrator/PermissionEngine/SandboxManager with actual source read/list/stat observations',
  observedAt: new Date().toISOString(),
  paidCalls: 0,
  realModelQuality: 'NOT_RUN',
  windowsRuntime: 'NOT_RUN',
  cases: [],
};
const root = mkdtempSync(join(tmpdir(), 'ar-symbol-production-'));
const outside = mkdtempSync(join(tmpdir(), 'ar-symbol-production-outside-'));
const rootAlias = `${root}-alias`;
const operations = [];
const originals = Object.fromEntries(['readFile', 'readdir', 'stat', 'lstat'].map((name) => [name, fs[name]]));
const pathWithin = (path, base) => path === base || path.startsWith(`${base}/`) || path.startsWith(`${base}\\`);
const observedPath = (path) => {
  const absolute = resolve(String(path));
  if (pathWithin(absolute, rootAlias)) return relative(rootAlias, absolute).split('\\').join('/') || '.';
  if (pathWithin(absolute, root)) return relative(root, absolute).split('\\').join('/') || '.';
  if (pathWithin(absolute, outside)) return `@outside/${relative(outside, absolute).split('\\').join('/')}`;
  return null;
};
for (const name of Object.keys(originals)) {
  fs[name] = async function(path, ...args) {
    const selected = observedPath(path);
    if (selected !== null) operations.push({ operation: name, path: selected });
    return originals[name].call(this, path, ...args);
  };
}
syncBuiltinESMExports();

const record = (id, expected, actual, pass) => report.cases.push({ id, expected, actual, status: pass ? 'PASS' : 'FAIL' });
const hits = (actual) => actual.result.output?.hits ?? [];
const named = (actual, file, name) => actual.result.status === 'success' && hits(actual).some((hit) => hit.file === file && hit.name === name);
const sourceOperations = (actual) => actual.operations.filter((operation) => operation.operation !== 'lstat');
const within = (actual, scope) => sourceOperations(actual).every(({ path }) => path === scope || path.startsWith(`${scope}/`));
const noSourceIO = (actual) => sourceOperations(actual).length === 0;
const reads = (actual) => actual.operations.filter((operation) => operation.operation === 'readFile');

try {
  const { ToolRegistry, ToolOrchestrator, createProductionTools } = await import(pathToFileURL(join(workspace, 'packages/tools/dist/index.js')).href);
  const { newAgentId, newSessionId, newTurnId, newToolCallId } = await import(pathToFileURL(join(workspace, 'packages/contracts/dist/index.js')).href);
  const registry = new ToolRegistry();
  for (const tool of createProductionTools({ networkMode: 'deny', availableTools: () => registry.names() })) registry.register(tool);
  const orchestrator = new ToolOrchestrator({ registry, workspaceRoot: root });
  const sessionId = newSessionId(), agentId = newAgentId(), turnId = newTurnId();
  const context = (cwd = root) => ({
    sessionId, agentId, turnId, cwd, signal: new AbortController().signal,
    permissions: { rules: [{ action: 'read', resource: 'file', pattern: '**/*', effect: 'allow' }] },
    sandboxPolicy: {
      filesystem: { mode: 'workspace-write', allowedPaths: [cwd] }, network: { mode: 'deny' },
      process: { timeoutMs: 5000, maxOutputBytes: 65536 },
    },
  });
  const request = (args) => ({ id: newToolCallId(), sessionId, agentId, turnId, call: { id: newToolCallId(), name: 'symbol_search', args } });
  const run = async (args, ctx = context(), toolOrchestrator = orchestrator) => {
    operations.length = 0;
    const result = await toolOrchestrator.execute(request(args), ctx);
    return { args, result, operations: [...operations] };
  };
  const write = async (path, body) => {
    await fs.mkdir(dirname(join(root, path)), { recursive: true });
    await fs.writeFile(join(root, path), body);
  };
  await write('public-ts/a.ts', 'export function TsOnly() {}\nexport const SharedSymbol = 1;\n');
  await write('public-ts/b.ts', 'export const SiblingOnly = 1;\n');
  await write('public-tsx/a.ts', 'export const PrefixOnly = 1;\n');
  await write('public-py/logic.py', 'def PyOnly():\n    return 1\n\ndef SharedSymbol():\n    return 2\n');
  await write('private/secret.ts', 'export const OffScopeMarker = 1;\n');
  for (const skipped of ['.git', 'dist', 'build', 'coverage', 'node_modules']) await write(`${skipped}/secret.ts`, 'export const IgnoredOnly = 1;\n');
  await fs.writeFile(join(outside, 'external.ts'), 'export const ExternalOnly = 1;\n');

  const cold = await run({ symbol: 'TsOnly', path: 'public-ts' });
  record('COLD_DIRECTORY_SCOPE', { hit: 'public-ts/a.ts', sourceIOWithin: 'public-ts' }, cold,
    named(cold, 'public-ts/a.ts', 'TsOnly') && within(cold, 'public-ts') && cold.result.output.filesIndexed === 2);
  const warm = await run({ symbol: 'TsOnly', path: 'public-ts' });
  record('WARM_SCOPED_REUSE', { sameHits: true, fileReads: 0, sourceIOWithin: 'public-ts' }, warm,
    JSON.stringify(hits(warm)) === JSON.stringify(hits(cold)) && reads(warm).length === 0 && within(warm, 'public-ts'));
  for (const [id, path] of [['RELATIVE_ALIAS', './public-ts/../public-ts/'], ['ABSOLUTE_DIRECTORY_ALIAS', join(root, 'public-ts')]]) {
    const actual = await run({ symbol: 'TsOnly', path });
    record(id, { sameHits: true, sourceIOWithin: 'public-ts' }, actual,
      JSON.stringify(hits(actual)) === JSON.stringify(hits(cold)) && within(actual, 'public-ts'));
  }
  const py = await run({ symbol: 'PyOnly', path: 'public-py' });
  record('PYTHON_DIRECTORY_FALLBACK', { hit: 'public-py/logic.py', fallback: true, sourceIOWithin: 'public-py' }, py,
    named(py, 'public-py/logic.py', 'PyOnly') && py.result.output.fallback === true && within(py, 'public-py'));
  const mixed = await run({ symbol: 'PyOnly' });
  record('MIXED_ROOT_INDEX_MISS_FALLS_BACK', { hit: 'public-py/logic.py', fallback: true }, mixed,
    named(mixed, 'public-py/logic.py', 'PyOnly') && mixed.result.output.fallback === true);
  const preferred = await run({ symbol: 'SharedSymbol' });
  record('TS_HITS_RETAIN_PRIORITY', { fallback: false, files: ['public-ts/a.ts'] }, preferred,
    preferred.result.status === 'success' && preferred.result.output.fallback === false &&
    JSON.stringify(hits(preferred).map((hit) => hit.file)) === JSON.stringify(['public-ts/a.ts']));
  for (const [language, symbol, path] of [['PYTHON', 'PyOnly', 'public-py/logic.py'], ['TS', 'TsOnly', 'public-ts/a.ts']]) {
    const selected = await run({ symbol, path });
    record(`${language}_SINGLE_FILE_SCOPE`, { hit: path, sourceIOWithin: path }, selected, named(selected, path, symbol) && within(selected, path));
    const absolute = await run({ symbol, path: join(root, path) });
    record(`${language}_ABSOLUTE_FILE_ALIAS`, { sameHits: true, sourceIOWithin: path }, absolute,
      named(absolute, path, symbol) && JSON.stringify(hits(absolute)) === JSON.stringify(hits(selected)) && within(absolute, path));
  }
  const rootToDirectory = await run({ symbol: 'TsOnly', path: 'public-ts' });
  record('ROOT_FILE_DIRECTORY_CACHES_ISOLATED', { hit: 'public-ts/a.ts', sourceIOWithin: 'public-ts' }, rootToDirectory,
    named(rootToDirectory, 'public-ts/a.ts', 'TsOnly') && within(rootToDirectory, 'public-ts'));
  for (const [id, symbol] of [['OFF_SCOPE_NOT_READ', 'OffScopeMarker'], ['PREFIX_SIBLING_EXCLUDED', 'PrefixOnly']]) {
    const actual = await run({ symbol, path: 'public-ts' });
    record(id, { hits: [], sourceIOWithin: 'public-ts' }, actual, actual.result.status === 'success' && hits(actual).length === 0 && within(actual, 'public-ts'));
  }
  await write('public-ts/a.ts', 'export function ChangedOnly() {}\n');
  const changed = await run({ symbol: 'ChangedOnly', path: 'public-ts/a.ts' });
  record('SCOPED_FILE_EDIT_REFRESH', { hit: 'public-ts/a.ts', sourceIOWithin: 'public-ts/a.ts' }, changed,
    named(changed, 'public-ts/a.ts', 'ChangedOnly') && within(changed, 'public-ts/a.ts'));
  const removedDefinition = await run({ symbol: 'TsOnly', path: 'public-ts/a.ts' });
  record('NO_STALE_SCOPED_DEFINITION', { hits: [], sourceIOWithin: 'public-ts/a.ts' }, removedDefinition,
    removedDefinition.result.status === 'success' && hits(removedDefinition).length === 0 && within(removedDefinition, 'public-ts/a.ts'));
  await write('public-ts/new.ts', 'export const AddedOnly = 1;\n');
  const added = await run({ symbol: 'AddedOnly', path: 'public-ts' });
  record('SCOPED_DIRECTORY_ADD_REFRESH', { hit: 'public-ts/new.ts', sourceIOWithin: 'public-ts' }, added,
    named(added, 'public-ts/new.ts', 'AddedOnly') && within(added, 'public-ts'));
  await fs.rm(join(root, 'public-ts/new.ts'));
  const vanished = await run({ symbol: 'AddedOnly', path: 'public-ts/new.ts' });
  record('VANISHED_SCOPE_RETURNS_NO_STALE_CONTENT', { hits: [], sourceIO: 0 }, vanished,
    vanished.result.status === 'success' && hits(vanished).length === 0 && noSourceIO(vanished));

  operations.length = 0;
  const concurrentArgs = [{ symbol: 'ChangedOnly', path: 'public-ts' }, { symbol: 'PyOnly', path: 'public-py' }];
  const concurrentResults = await Promise.all(concurrentArgs.map((args) => orchestrator.execute(request(args), context())));
  const concurrent = { args: concurrentArgs, results: concurrentResults, operations: [...operations] };
  record('CONCURRENT_SCOPES_ISOLATED', { files: ['public-ts/a.ts', 'public-py/logic.py'], sourceIOWithinSelectedScopes: true }, concurrent,
    concurrentResults.every((result, i) => result.status === 'success' && result.output.hits.some((hit) => hit.file === (i ? 'public-py/logic.py' : 'public-ts/a.ts'))) &&
    sourceOperations(concurrent).every(({ path }) => ['public-ts', 'public-py'].some((scope) => path === scope || path.startsWith(`${scope}/`))));
  await write('concurrent/new.ts', 'export const ConcurrentOnly = 1;\n');
  operations.length = 0;
  const sameScopeArgs = Array.from({ length: 16 }, (_, i) => ({ symbol: 'ConcurrentOnly', path: i % 2 ? join(root, 'concurrent') : './concurrent/' }));
  const sameScopeResults = await Promise.all(sameScopeArgs.map((args) => orchestrator.execute(request(args), context())));
  const coalesced = { args: sameScopeArgs, results: sameScopeResults, operations: [...operations] };
  record('CONCURRENT_NORMALIZED_SCOPE_ONE_READ', { allHit: true, fileReads: 1, sourceIOWithin: 'concurrent' }, coalesced,
    sameScopeResults.every((result) => result.status === 'success' && result.output.hits.length === 1 && result.output.hits[0].file === 'concurrent/new.ts') &&
    reads(coalesced).length === 1 && within(coalesced, 'concurrent'));

  await write('public-py/other.py', 'def PyOnly():\n    return 3\n');
  for (const [id, args] of [['FALLBACK_RESULT_CAP', { symbol: 'PyOnly', path: 'public-py', maxResults: 1 }], ['INDEX_RESULT_CAP', { symbol: 'export', path: 'public-ts', maxResults: 1 }]]) {
    const capped = await run(args);
    record(id, { hits: 1 }, capped, capped.result.status === 'success' && hits(capped).length === 1);
  }
  const invalid = await run({ symbol: 'ChangedOnly', path: 'public-ts', maxResults: 0 });
  record('SCHEMA_REJECTION_ZERO_SOURCE_IO', { status: 'failed', code: 'TOOL_SCHEMA_ERROR', sourceIO: 0 }, invalid,
    invalid.result.status === 'failed' && invalid.result.error?.code === 'TOOL_SCHEMA_ERROR' && noSourceIO(invalid));
  const restricted = context();
  restricted.permissions = { rules: [{ action: 'read', resource: 'file', pattern: 'public-ts', effect: 'allow' }], defaultEffect: 'deny' };
  const allowed = await run({ symbol: 'ChangedOnly', path: 'public-ts' }, restricted);
  record('PERMISSION_ALLOW_SELECTED_SCOPE_ONLY', { hit: 'public-ts/a.ts', sourceIOWithin: 'public-ts' }, allowed,
    named(allowed, 'public-ts/a.ts', 'ChangedOnly') && within(allowed, 'public-ts'));
  const deniedContext = context(); deniedContext.permissions = { rules: [], defaultEffect: 'deny' };
  const denied = await run({ symbol: 'ChangedOnly', path: 'public-ts' }, deniedContext);
  record('PERMISSION_DENIAL_ZERO_SOURCE_IO', { status: 'denied', sourceIO: 0 }, denied, denied.result.status === 'denied' && noSourceIO(denied));
  const outsideDenied = await run({ symbol: 'ExternalOnly', path: outside });
  record('SANDBOX_OUTSIDE_DENIAL_ZERO_SOURCE_IO', { status: 'denied', sourceIO: 0 }, outsideDenied,
    outsideDenied.result.status === 'denied' && noSourceIO(outsideDenied));
  const ignored = await run({ symbol: 'IgnoredOnly' });
  record('VCS_DEPENDENCY_GENERATED_IGNORES', { hits: [], ignoredSourceIO: 0 }, ignored,
    ignored.result.status === 'success' && hits(ignored).length === 0 && !sourceOperations(ignored).some(({ path }) =>
      ['.git', 'dist', 'build', 'coverage', 'node_modules'].some((scope) => path === scope || path.startsWith(`${scope}/`))));
  await fs.symlink(join(root, 'private'), join(root, 'public-ts', 'discovered-link'), process.platform === 'win32' ? 'junction' : 'dir');
  const discoveredLink = await run({ symbol: 'OffScopeMarker', path: 'public-ts' });
  record('DISCOVERED_DIRECTORY_SYMLINK_SKIPPED', { hits: [], sourceIOWithin: 'public-ts', linkSourceIO: 0 }, discoveredLink,
    discoveredLink.result.status === 'success' && hits(discoveredLink).length === 0 && within(discoveredLink, 'public-ts') &&
    !sourceOperations(discoveredLink).some(({ path }) => path.includes('discovered-link')));
  await fs.symlink(join(root, 'private'), join(root, 'selected-link'), process.platform === 'win32' ? 'junction' : 'dir');
  for (const [id, path] of [['SELECTED_DIRECTORY_SYMLINK_REFUSED', 'selected-link'], ['ANCESTRY_DIRECTORY_SYMLINK_REFUSED', 'selected-link/secret.ts']]) {
    const selectedLink = await run({ symbol: 'OffScopeMarker', path });
    record(id, { hits: [], sourceIO: 0 }, selectedLink,
      selectedLink.result.status === 'success' && hits(selectedLink).length === 0 && noSourceIO(selectedLink));
  }
  await fs.symlink(join(root, 'private', 'secret.ts'), join(root, 'selected-file-link.ts'));
  const fileLink = await run({ symbol: 'OffScopeMarker', path: 'selected-file-link.ts' });
  record('SELECTED_FILE_SYMLINK_REFUSED', { hits: [], sourceIO: 0 }, fileLink,
    fileLink.result.status === 'success' && hits(fileLink).length === 0 && noSourceIO(fileLink));
  await fs.symlink(root, rootAlias, process.platform === 'win32' ? 'junction' : 'dir');
  const aliasOrchestrator = new ToolOrchestrator({ registry, workspaceRoot: rootAlias });
  const trustedAlias = await run({ symbol: 'ChangedOnly', path: 'public-ts/a.ts' }, context(rootAlias), aliasOrchestrator);
  record('TRUSTED_ROOT_ALIAS_RETAINED', { hit: 'public-ts/a.ts', sourceIOWithin: 'public-ts/a.ts' }, trustedAlias,
    named(trustedAlias, 'public-ts/a.ts', 'ChangedOnly') && within(trustedAlias, 'public-ts/a.ts'));
} catch (error) {
  report.error = { name: error.name, message: error.message, stack: error.stack };
  record('UNEXPECTED_PROBE_ERROR', { error: null }, report.error, false);
} finally {
  for (const [name, original] of Object.entries(originals)) fs[name] = original;
  syncBuiltinESMExports();
  await fs.rm(rootAlias, { force: true });
  await fs.rm(root, { recursive: true, force: true });
  await fs.rm(outside, { recursive: true, force: true });
  report.sourceShaAtEnd = git('rev-parse', 'HEAD');
  report.sourceTrackedDirtyAtEnd = git('status', '--porcelain=v1', '--untracked-files=no') !== '';
  report.sourceDirtAtEnd = git('status', '--porcelain=v1');
  report.sourceFingerprintsAfter = fingerprints();
  const unchanged = report.sourceSha === report.sourceShaAtEnd && JSON.stringify(report.sourceFingerprintsBefore) === JSON.stringify(report.sourceFingerprintsAfter);
  report.status = unchanged && report.cases.length > 0 && report.cases.every(({ status }) => status === 'PASS') ? 'PASS' : 'FAIL';
  writeFileSync(join(output, 'result.json'), `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx' });
  process.stdout.write(`${JSON.stringify({ status: report.status, cases: report.cases.length, failed: report.cases.filter(({ status }) => status !== 'PASS').map(({ id }) => id), result: join(output, 'result.json') })}\n`);
  process.exitCode = report.status === 'PASS' ? 0 : 1;
}
