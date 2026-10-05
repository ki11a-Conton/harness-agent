import fs from 'node:fs/promises';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { syncBuiltinESMExports } from 'node:module';

const repo = resolve(process.argv[2]);
const out = resolve(process.argv[3]);
mkdirSync(out);
const root = mkdtempSync(join(tmpdir(), 'ar-read-fifo-audit-'));
const git = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const tracked = ['packages/tools/src/tools/read-file.ts', 'packages/tools/src/file-coordination.ts', 'packages/tools/src/orchestrator.ts', 'packages/tools/dist/tools/read-file.js', 'packages/tools/dist/file-coordination.js'];
const fingerprints = () => Object.fromEntries(tracked.map(p => [p, hash(readFileSync(join(repo, p)))]));
const report = { sourceSha: git('rev-parse', 'HEAD'), trackedDirtyAtStart: git('status', '--porcelain=v1', '--untracked-files=no') !== '', before: fingerprints(), profile: 'production registry/orchestrator/permission/sandbox on native FIFO with bounded rescue writers', paidCalls: 0, cases: [], nativeReads: [] };
const readFile = fs.readFile;
fs.readFile = async (...args) => {
  const observation = { path: String(args[0]), signalPassed: !!args[1]?.signal, startedAt: Date.now(), settledAt: null };
  report.nativeReads.push(observation);
  try { return await readFile(...args); } finally { observation.settledAt = Date.now(); }
};
syncBuiltinESMExports();
try {
  const tools = await import(pathToFileURL(join(repo, 'packages/tools/dist/index.js')).href);
  const coordination = await import(pathToFileURL(join(repo, 'packages/tools/dist/file-coordination.js')).href);
  const ids = await import(pathToFileURL(join(repo, 'packages/contracts/dist/ids.js')).href);
  const registry = new tools.ToolRegistry();
  for (const tool of tools.createProductionTools({ networkMode: 'deny', availableTools: () => registry.names() })) registry.register(tool);
  const orchestrator = new tools.ToolOrchestrator({ registry, workspaceRoot: root });
  const sessionId = ids.newSessionId(), agentId = ids.newAgentId(), turnId = ids.newTurnId();
  const invoke = async (path, timeoutMs, signal = new AbortController().signal) => {
    const context = { sessionId, agentId, turnId, cwd: root, signal, permissions: { rules: [{ action: 'read', resource: 'file', pattern: '**/*', effect: 'allow' }] }, sandboxPolicy: { filesystem: { mode: 'workspace-write' }, network: { mode: 'deny' }, process: { timeoutMs, maxOutputBytes: 1024 } } };
    const startedAt = Date.now();
    const result = await orchestrator.execute({ id: ids.newToolCallId(), sessionId, agentId, turnId, call: { id: ids.newToolCallId(), name: 'read_file', args: { path } } }, context);
    return { startedAt, elapsedMs: Date.now() - startedAt, result, liveLockEntriesAtReturn: coordination.fileLockEntryCount() };
  };
  if (process.platform !== 'win32') {
    const blocked = join(root, 'blocked.pipe');
    execFileSync('mkfifo', [blocked]);
    let rescueDone;
    const rescued = new Promise(resolve => { rescueDone = resolve; });
    const timer = setTimeout(async () => { try { await fs.writeFile(blocked, 'bounded rescue'); rescueDone(); } catch (error) { rescueDone({ error: error.message }); } }, 350);
    const first = await invoke('blocked.pipe', 60);
    const queued = await invoke('blocked.pipe', 40);
    const beforeRescue = { liveLockEntries: coordination.fileLockEntryCount(), nativeReadPending: report.nativeReads.filter(r => r.settledAt === null).length };
    await rescued;
    clearTimeout(timer);
    await new Promise(resolve => setTimeout(resolve, 20));
    const afterRescue = { liveLockEntries: coordination.fileLockEntryCount(), nativeReadPending: report.nativeReads.filter(r => r.settledAt === null).length };
    report.cases.push({ id: 'FIFO_TIMEOUT_RETAINS_BACKGROUND_READ_AND_FILE_LOCK', first, queued, beforeRescue, afterRescue, status: first.result.status === 'timeout' && first.liveLockEntriesAtReturn === 1 && queued.result.status === 'timeout' && beforeRescue.nativeReadPending === 1 && afterRescue.liveLockEntries === 0 ? 'REPRODUCED_DEFECT' : 'UNEXPECTED' });
    const cancelled = join(root, 'cancelled.pipe');
    execFileSync('mkfifo', [cancelled]);
    const controller = new AbortController();
    const abortTimer = setTimeout(() => controller.abort(), 20);
    const cancelRescueTimer = setTimeout(() => { void fs.writeFile(cancelled, 'cancellation rescue'); }, 180);
    const second = await invoke('cancelled.pipe', 1000, controller.signal);
    clearTimeout(abortTimer);
    clearTimeout(cancelRescueTimer);
    report.cases.push({ id: 'FIFO_CALLER_CANCEL_WAITS_UNTIL_EXTERNAL_WRITER', abortAtMs: 20, writerScheduledAtMs: 180, observed: second, status: second.result.status === 'cancelled' && second.elapsedMs >= 150 && second.liveLockEntriesAtReturn === 0 ? 'REPRODUCED_DEFECT' : 'UNEXPECTED' });
  } else report.cases.push({ id: 'FIFO_NATIVE_WINDOWS', status: 'NOT_RUN' });
  await fs.writeFile(join(root, 'regular.txt'), 'REGULAR_CONTROL');
  const regular = await invoke('regular.txt', 1000);
  report.cases.push({ id: 'REGULAR_FILE_CONTROL', observed: regular, status: regular.result.status === 'success' && regular.result.output === 'REGULAR_CONTROL' && regular.liveLockEntriesAtReturn === 0 ? 'PASS' : 'FAIL' });
} finally {
  fs.readFile = readFile;
  syncBuiltinESMExports();
  await fs.rm(root, { recursive: true, force: true });
  report.sourceShaAtEnd = git('rev-parse', 'HEAD');
  report.trackedDirtyAtEnd = git('status', '--porcelain=v1', '--untracked-files=no') !== '';
  report.after = fingerprints();
  report.sourceUnchanged = JSON.stringify(report.before) === JSON.stringify(report.after) && report.sourceSha === report.sourceShaAtEnd;
  report.status = report.cases.some(c => c.status === 'REPRODUCED_DEFECT') ? 'REPRODUCED_DEFECT' : 'NO_DEFECT';
  writeFileSync(join(out, 'result.json'), JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
  process.stdout.write(JSON.stringify({ status: report.status, sourceUnchanged: report.sourceUnchanged, cases: report.cases.map(({ id, status }) => ({ id, status })) }) + '\n');
}
