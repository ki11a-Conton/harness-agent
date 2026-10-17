import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';
import { expect, it } from 'vitest';
import type { ModelProvider, ModelRequest } from '@ar/contracts';
import { ScriptedModelProvider } from '@ar/model';
import { createHarness } from './create-harness.js';

const require = createRequire(import.meta.url);
const compiler = join(dirname(require.resolve('typescript/package.json')), 'bin', 'tsc');
const cases = [
  { name: 'typescript', file: 'broken.ts', content: 'const total: number = "wrong";\n', args: [compiler, '--noEmit', '--skipLibCheck', '--locale', 'en', 'broken.ts'], needle: 'error TS2322' },
  { name: 'syntax', file: 'broken.cjs', content: 'const total = ;\n', args: ['--check', 'broken.cjs'], needle: 'SyntaxError:' },
  { name: 'test', file: 'broken.test.cjs', content: 'Error.stackTraceLimit=0;const{test}=require("node:test");const assert=require("node:assert/strict");test("real assertion",()=>assert.equal(2,3,"DIAGNOSTIC_ASSERT_TAIL"));\n', args: ['--test', 'broken.test.cjs'], needle: 'DIAGNOSTIC_ASSERT_TAIL' },
];

it.each(cases)('$name: real failed command diagnostics reach the next actual provider request', async sample => {
  const cwd = await realpath(await mkdtemp(join(tmpdir(), 'exec-diagnostic-')));
  const requests: ModelRequest[] = [];
  const runner = `const{spawnSync}=require('node:child_process');const fs=require('node:fs');
const noise='normal build output\\n'.repeat(5000);
Promise.all([new Promise(r=>process.stdout.write(noise,r)),new Promise(r=>process.stderr.write(noise,r))]).then(()=>{
const result=spawnSync(process.execPath,JSON.parse(process.argv[2]),{encoding:'utf8',maxBuffer:8*1024*1024});
if(result.error)throw result.error;fs.writeFileSync('command-status.json',JSON.stringify({exitCode:result.status,stdout:result.stdout,stderr:result.stderr}));
process.stdout.write(result.stdout??'');process.stderr.write(result.stderr??'');process.exitCode=result.status??1;});`;
  await writeFile(join(cwd, 'run-check.cjs'), runner);
  await writeFile(join(cwd, sample.file), sample.content);
  const provider: ModelProvider = { id: 'exec-diagnostic-replay',
    listModels: async () => [{ id: 'replay', capabilities: { contextWindowTokens: 128000 } }],
    createClient: () => ({ async *generate(request) {
      requests.push(structuredClone(request));
      yield* requests.length === 1
        ? ScriptedModelProvider.toolCall('exec', { command: process.execPath, args: ['run-check.cjs', JSON.stringify(sample.args)] })
        : ScriptedModelProvider.text('Command failed; inspected available diagnostics.');
    } }),
  };
  const h = await createHarness({ cwd, dataDir: join(cwd, 'state'), profile: 'test', modelProvider: provider,
    model: { providerId: provider.id, modelId: 'replay' },
    featureFlags: { skills: false, mcp: false, memory: false, delegation: false, learning: false },
    sandboxPolicy: { filesystem: { mode: 'workspace-write', allowedPaths: [cwd] }, network: { mode: 'deny' }, process: { timeoutMs: 15000, maxOutputBytes: 40 * 1024 } },
  });
  try {
    const session = await h.runtime.createSession({ agent: h.agents[0]!, cwd });
    const turn = await h.runtime.startTurn(session.id, 'Run the configured project check and inspect its actual diagnostic.');
    const result = await h.runtime.runTurn(session.id, turn.id, new AbortController().signal);
    expect(result.status).toBe('completed');
    expect(requests).toHaveLength(2);
    const receipt = JSON.parse(await readFile(join(cwd, 'command-status.json'), 'utf8'));
    expect(receipt.exitCode).not.toBe(0);
    expect(receipt.stdout + receipt.stderr, 'The actual child must fail for the intended compiler/test reason').toContain(sample.needle);
    const events = await h.events.list(session.id);
    expect(events.some(event => event.type === 'tool.completed' && event.payload.status === 'failed')).toBe(true);
    const toolMessage = requests[1]!.messages.filter(message => message.role === 'tool').map(message => message.content).join('\n');
    const visible = toolMessage.includes(sample.needle);
    console.log('EXEC_DIAGNOSTIC_REPLAY', JSON.stringify({ case: sample.name, exitCode: receipt.exitCode, providerRequests: requests.length, diagnosticVisible: visible, toolMessageBytes: Buffer.byteLength(toolMessage), paidCalls: 0 }));
    const evidence = process.env.HARNESS_EXEC_DIAGNOSTIC_EVIDENCE_DIR;
    if (evidence) {
      await mkdir(evidence, { recursive: true });
      await writeFile(join(evidence, sample.name + '.json'), JSON.stringify({ case: sample.name, expectedDiagnostic: sample.needle,
        child: receipt, diagnosticVisible: visible, providerRequests: requests.length, toolMessages: requests[1]!.messages.filter(message => message.role === 'tool'), paidCalls: 0 }, null, 2) + '\n');
    }
    expect(toolMessage).toContain('[failed]');
    expect(visible, 'The real process error was discarded before the provider could inspect it').toBe(true);
  } finally { await h.close(); await rm(cwd, { recursive: true, force: true }); }
}, 30000);
