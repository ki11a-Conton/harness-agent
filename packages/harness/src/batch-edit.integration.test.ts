import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import type { ModelProvider, ModelRequest } from '@ar/contracts';
import { ScriptedModelProvider } from '@ar/model';
import { createHarness } from './create-harness.js';

it('a real runtime recovers from batch preflight failure without partial writes and verifies the repaired file', async () => {
  const cwd = await realpath(await mkdtemp(join(tmpdir(), 'batch-runtime-')));
  const before = 'exports.first = 1;\nexports.second = 2;\nexports.third = 3;\n';
  const edits = [1, 2, 3].map((n, i) => ({ oldText: `= ${n};`, newText: `= ${[10, 20, 30][i]};` }));
  const requests: ModelRequest[] = []; let version = '';
  await writeFile(join(cwd, 'values.cjs'), before);
  await writeFile(join(cwd, 'check.cjs'), "const assert=require('node:assert/strict');assert.deepEqual(require('./values.cjs'),{first:10,second:20,third:30});console.log('BATCH_CHECK_PASSED');\n");
  await writeFile(join(cwd, 'package.json'), JSON.stringify({ scripts: { test: 'node check.cjs' } }));
  const provider: ModelProvider = { id: 'batch-runtime-replay',
    listModels: async () => [{ id: 'replay', capabilities: { contextWindowTokens: 128000 } }],
    createClient: () => ({ async *generate(request) {
      requests.push(structuredClone(request));
      const data = request.messages.filter(m => m.role === 'tool').map(m => m.content).join('\n');
      if (requests.length === 1) {
        expect(JSON.stringify(request.tools)).toContain('edits');
        yield* ScriptedModelProvider.toolCall('read_file', { path: 'values.cjs', versioned: true });
      } else if (requests.length === 2) {
        version = /"sha256"\s*:\s*"([a-f0-9]{64})"/.exec(data)![1]!;
        yield* ScriptedModelProvider.toolCall('edit_file', { path: 'values.cjs', expectedSha256: version,
          edits: [edits[0], { oldText: 'missing anchor', newText: 'changed' }] });
      } else if (requests.length === 3) {
        expect(data).toContain('[failed]'); expect(data).toContain('original snapshot');
        expect(await readFile(join(cwd, 'values.cjs'), 'utf8')).toBe(before);
        yield* ScriptedModelProvider.toolCall('edit_file', { path: 'values.cjs', expectedSha256: version, edits });
      } else if (requests.length === 4) {
        expect(data).toContain('"replacements":3');
        yield* ScriptedModelProvider.toolCall('exec', { command: process.execPath, args: ['check.cjs'] });
      } else {
        expect(data).toContain('BATCH_CHECK_PASSED');
        yield* ScriptedModelProvider.text('Repaired all three values and checked the actual file.');
      }
    } }),
  };
  const h = await createHarness({ cwd, dataDir: join(cwd, 'state'), profile: 'test', modelProvider: provider,
    model: { providerId: provider.id, modelId: 'replay' }, task: { id: 'batch-code', goal: 'Repair and verify the three values' },
    featureFlags: { skills: false, mcp: false, memory: false, delegation: false, learning: false },
    sandboxPolicy: { filesystem: { mode: 'workspace-write', allowedPaths: [cwd] }, network: { mode: 'deny' }, process: { timeoutMs: 15000 } },
  });
  try {
    const session = await h.runtime.createSession({ agent: h.agents[0]!, cwd });
    const turn = await h.runtime.startTurn(session.id, 'Repair all three values and verify.');
    const result = await h.runtime.runTurn(session.id, turn.id, new AbortController().signal);
    expect(result.status).toBe('completed'); expect(result.terminationReason).toBe('verified_complete');
    expect(requests).toHaveLength(5);
    expect(await readFile(join(cwd, 'values.cjs'), 'utf8')).toBe('exports.first = 10;\nexports.second = 20;\nexports.third = 30;\n');
    const events = await h.events.list(session.id);
    expect(events.some(e => e.type === 'tool.completed' && e.payload.status === 'failed')).toBe(true);
    expect(events.some(e => e.type === 'verification.completed')).toBe(true);
  } finally { await h.close(); await rm(cwd, { recursive: true, force: true, maxRetries: process.platform === 'win32' ? 8 : 0, retryDelay: 50 }); }
}, 30000);
