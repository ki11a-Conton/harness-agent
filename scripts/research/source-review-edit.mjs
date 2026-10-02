import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { newAgentId, newSessionId, newToolCallId, newTurnId } from '../../packages/contracts/dist/index.js';
import { ToolRegistry } from '../../packages/tools/dist/registry.js';
import { ToolOrchestrator } from '../../packages/tools/dist/orchestrator.js';
import { readFileTool } from '../../packages/tools/dist/tools/read-file.js';
import { writeFileTool } from '../../packages/tools/dist/tools/write-file.js';
import { editFileTool } from '../../packages/tools/dist/tools/edit-file.js';

const ws = await fsp.mkdtemp(join(tmpdir(), 'harness-source-edit-'));
const registry = new ToolRegistry();
for (const tool of [readFileTool, writeFileTool, editFileTool]) registry.register(tool);
const orch = new ToolOrchestrator({ registry, workspaceRoot: ws });
const context = (sessionId = newSessionId()) => ({ sessionId, turnId: newTurnId(), agentId: newAgentId(), cwd: ws,
  signal: new AbortController().signal,
  permissions: { rules: [{ action: 'read', resource: 'file', pattern: '**/*', effect: 'allow' }, { action: 'edit', resource: 'file', pattern: '**/*', effect: 'allow' }] },
  sandboxPolicy: { filesystem: { mode: 'workspace-write', allowedPaths: [ws] }, network: { mode: 'deny' }, process: { timeoutMs: 2000, maxOutputBytes: 100000 } },
});
const first = context();
const second = context();
const invoke = (ctx, name, args) => {
  const callId = newToolCallId();
  return orch.execute({ id: callId, sessionId: ctx.sessionId, turnId: ctx.turnId, agentId: ctx.agentId, call: { id: callId, name, args } }, ctx);
};
const reports = {};
const originalReadFile = fsp.readFile;
try {
  await invoke(first, 'write_file', { path: 'range.txt', content: 'A\nB\nC' });
  const observed = await invoke(first, 'read_file', { path: 'range.txt' });
  await invoke(second, 'write_file', { path: 'range.txt', content: 'HEADER\nA\nB\nC' });
  const staleEdit = await invoke(first, 'edit_file', { path: 'range.txt', lineStart: 2, lineEnd: 2, replacement: 'FIXED_B' });
  const actual = await invoke(first, 'read_file', { path: 'range.txt' });
  reports.staleRange = { observed: observed.output, status: staleEdit.status, actual: actual.output,
    intendedTargetUnchanged: actual.output.includes('\nB\n'), wrongLineChanged: !actual.output.includes('\nA\n') };
  assert.equal(reports.staleRange.status, 'success');
  assert.equal(reports.staleRange.intendedTargetUnchanged, true);
  assert.equal(reports.staleRange.wrongLineChanged, true);

  await invoke(first, 'write_file', { path: 'race.txt', content: 'A=0\nB=0\n' });
  let readers = 0;
  let release;
  const rendezvous = new Promise((resolve) => { release = resolve; });
  const deadline = setTimeout(release, 1500);
  fsp.readFile = async (...args) => {
    const snapshot = await originalReadFile(...args);
    if (args[0] === join(ws, 'race.txt')) {
      readers += 1;
      if (readers === 2) release();
      await rendezvous;
    }
    return snapshot;
  };
  syncBuiltinESMExports();
  const edits = await Promise.all([
    invoke(first, 'edit_file', { path: 'race.txt', oldText: 'A=0', newText: 'A=1' }),
    invoke(second, 'edit_file', { path: 'race.txt', oldText: 'B=0', newText: 'B=1' }),
  ]);
  clearTimeout(deadline);
  fsp.readFile = originalReadFile;
  syncBuiltinESMExports();
  const raceOutput = await invoke(first, 'read_file', { path: 'race.txt' });
  reports.concurrentIndependentEdits = { readers, statuses: edits.map((result) => result.status), actual: raceOutput.output,
    bothEditsPresent: raceOutput.output.includes('A=1') && raceOutput.output.includes('B=1') };
  assert.equal(readers, 2);
  assert.deepEqual(reports.concurrentIndependentEdits.statuses, ['success', 'success']);
  assert.equal(reports.concurrentIndependentEdits.bothEditsPresent, false);
  console.log(JSON.stringify(reports, null, 2));
} finally {
  fsp.readFile = originalReadFile;
  syncBuiltinESMExports();
  await fsp.rm(ws, { recursive: true, force: true });
}
