import fs from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';
const [sourceArg, outputArg] = process.argv.slice(2);
const source = resolve(sourceArg), output = resolve(outputArg), root = join(output, 'selected-project');
await fs.mkdir(root, { recursive: true });
await fs.writeFile(join(root, 'long.ts'), '// actual source filler\n'.repeat(199999) + '// actual source filler');
const load = name => import(pathToFileURL(join(source, 'packages/tools/dist', name + '.js')));
const { getSymbolIndex } = await load('symbol-index');
const { ToolRegistry } = await load('registry');
const { ToolOrchestrator } = await load('orchestrator');
const { symbolSearchTool } = await load('tools/navigation-tools');
const index = await getSymbolIndex(root), lines = index.files.get('long.ts').lines;
const first = lines[0], last = lines.at(-1);
const ac = new AbortController(); let timer, timerFired = false, tailVisited = false, firstVisited = false;
// Observers preserve the exact text already read from the real source. The
// timer is scheduled only when matching begins, not during async validation.
Object.defineProperty(lines, 0, { get() { firstVisited = true; timer ??= setTimeout(() => { timerFired = true; ac.abort(); }, 0); return first; } });
Object.defineProperty(lines, lines.length - 1, { get() { tailVisited = true; return last; } });
const registry = new ToolRegistry(); registry.register(symbolSearchTool);
const orch = new ToolOrchestrator({ registry, workspaceRoot: root });
const ctx = { cwd: root, signal: ac.signal, sessionId: 'hot-s', turnId: 'hot-t', agentId: 'hot-a',
 permissions: { rules: [{ action: 'read', resource: 'file', pattern: '**/*', effect: 'allow' }] },
 sandboxPolicy: { filesystem: { mode: 'workspace-write', allowedPaths: [root] }, network: { mode: 'deny' }, process: { timeoutMs: 10000 } } };
let outcome;
try { outcome = await orch.execute({ id: 'hot-e', sessionId: ctx.sessionId, turnId: ctx.turnId, agentId: ctx.agentId,
 call: { id: 'hot-c', name: 'symbol_search', args: { symbol: 'TargetAbsent' } } }, ctx); }
finally { clearTimeout(timer); }
assert.equal(firstVisited, true); assert.equal(timerFired, true); assert.equal(outcome.status, 'cancelled');
const result = { status: tailVisited ? 'REPRODUCED_HOT_QUERY_BLOCKS_CANCEL_TIMER' : 'PASS',
 sourceSha: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: source, encoding: 'utf8' }).trim(), sourceStatus: execFileSync('git', ['status', '--porcelain'], { cwd: source, encoding: 'utf8' }).trim(),
 actualSourceLines: 200000, firstVisited, tailVisited, timerFired, toolStatus: outcome.status, modelRequests: 0, paidModelCalls: 0,
 scope: 'Actual ToolOrchestrator with real warmed source index. Getter observers preserve original source line values. Same timer scheduled at first actual matching access. Acceptance is cancellation before final line, not elapsed time or model quality.' };
await fs.writeFile(join(output, 'result.json'), JSON.stringify(result, null, 2) + '\n');
process.stdout.write(JSON.stringify(result) + '\n');
