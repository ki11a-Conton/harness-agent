import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { resolve, join, relative } from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';

const [sourceArg, outputArg] = process.argv.slice(2);
const source = resolve(sourceArg), output = resolve(outputArg);
await fs.mkdir(output, { recursive: true });
const actualRead = fs.readFile;
const trace = [];
let active;
fs.readFile = async function (...args) {
  const path = String(args[0]);
  if (!active || !path.startsWith(active.root) || !path.endsWith('.ts')) return actualRead.apply(this, args);
  const mode = active;
  mode.reads++;
  trace.push({ mode: mode.name, path: relative(mode.root, path), event: 'source-read', signal: typeof args[1] === 'object' && !!args[1]?.signal });
  const data = await actualRead.apply(this, args);
  if (mode.reads === 1 && mode.cancel) {
    // A fixed input coordination barrier, not a fake filesystem result. Allow
    // both original ToolOrchestrator calls to subscribe before cancelling.
    await new Promise(done => setTimeout(done, 15));
    mode.controllers[0].abort();
    if (mode.cancel === 'all') mode.controllers[1]?.abort();
    trace.push({ mode: mode.name, event: 'cancel-after-real-first-read' });
  }
  return data;
};
syncBuiltinESMExports();
const load = name => import(pathToFileURL(join(source, 'packages/tools/dist', name + '.js')));
const { ToolRegistry } = await load('registry');
const { ToolOrchestrator } = await load('orchestrator');
const { symbolSearchTool } = await load('tools/navigation-tools');
let id = 0;
function invoke(root, signal) {
  const registry = new ToolRegistry(); registry.register(symbolSearchTool);
  const orch = new ToolOrchestrator({ registry, workspaceRoot: root });
  const ctx = { cwd: root, signal, sessionId: 's-' + ++id, turnId: 't-' + id, agentId: 'a-' + id,
    permissions: { rules: [{ action: 'read', resource: 'file', pattern: '**/*', effect: 'allow' }] },
    sandboxPolicy: { filesystem: { mode: 'workspace-write', allowedPaths: [root] }, network: { mode: 'deny' }, process: { timeoutMs: 10000, maxOutputBytes: 4096 } } };
  return orch.execute({ id: 'e-' + id, sessionId: ctx.sessionId, turnId: ctx.turnId, agentId: ctx.agentId,
    call: { id: 'c-' + id, name: 'symbol_search', args: { symbol: 'SharedSymbol' } } }, ctx);
}
const modes = [];
try {
  for (const [name, cancel, calls] of [['normal', null, 1], ['single-cancel', 'first', 1], ['shared-one-cancel', 'first', 2], ['shared-all-cancel', 'all', 2]]) {
    const root = join(output, name, 'selected-project'); await fs.mkdir(root, { recursive: true });
    for (let i = 0; i < 36; i++) await fs.writeFile(join(root, `file-${String(i).padStart(2, '0')}.ts`), `export const SharedSymbol = ${i};\n`);
    const controllers = Array.from({ length: calls }, () => new AbortController());
    active = { name, root, cancel, controllers, reads: 0 };
    const start = performance.now();
    const outcomes = await Promise.all(controllers.map(c => invoke(root, c.signal)));
    const readsAtReturn = active.reads;
    await new Promise(done => setTimeout(done, 50));
    const readsAfterReturn = active.reads;
    const row = { name, calls, statuses: outcomes.map(r => r.status), hits: outcomes.map(r => r.output?.hits?.length ?? null), readsAtReturn, readsAfterReturn, elapsedMs: performance.now() - start };
    assert.deepEqual(row.statuses, cancel === 'all' ? ['cancelled', 'cancelled'] : cancel === 'first' ? (calls === 2 ? ['cancelled', 'success'] : ['cancelled']) : ['success']);
    if (cancel === null || name === 'shared-one-cancel') { assert.equal(row.readsAfterReturn, 36); assert.equal(row.hits.at(-1), 36); }
    modes.push(row);
  }
} finally { fs.readFile = actualRead; syncBuiltinESMExports(); }
const fixed = modes.filter(m => ['single-cancel', 'shared-all-cancel'].includes(m.name)).every(m => m.readsAtReturn === 1 && m.readsAfterReturn === 1);
const result = { status: fixed ? 'PASS' : 'REPRODUCED_CANCELLED_CALL_CONTINUES_INDEX_IO', sourceSha: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: source, encoding: 'utf8' }).trim(), sourceStatus: execFileSync('git', ['status', '--porcelain'], { cwd: source, encoding: 'utf8' }).trim(), modes, modelRequests: 0, paidModelCalls: 0,
  scope: 'Actual ToolOrchestrator, permissions and sandbox, real 36-file TS workspace. Builtin filesystem observer preserves actual reads and results; same 15ms first-read coordination and 50ms post-return observation in both arms. I/O counts, not wall-time or model quality, are acceptance criteria.' };
await fs.writeFile(join(output, 'trace.json'), JSON.stringify(trace, null, 2) + '\n');
await fs.writeFile(join(output, 'result.json'), JSON.stringify(result, null, 2) + '\n');
process.stdout.write(JSON.stringify(result) + '\n');
