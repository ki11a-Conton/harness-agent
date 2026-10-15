import assert from 'node:assert/strict';
import { readFile, writeFile, mkdtemp, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
const root = resolve(process.argv[2]), output = resolve(process.argv[3]), expectedSha = process.argv[4];
assert(/^[a-f0-9]{40}$/.test(expectedSha));
const { verifyPortable } = await import(pathToFileURL(resolve('scripts/release/portable-lib.mjs')).href);
await verifyPortable(root, { sourceSha: expectedSha });
const { createHarness, createCodingPromptPolicy } = await import(pathToFileURL(join(root, 'node_modules/@ar/harness/dist/index.js')).href);
const { ScriptedModelProvider } = await import(pathToFileURL(join(root, 'node_modules/@ar/model/dist/index.js')).href);
const dir = await mkdtemp(join(tmpdir(), 'coding-installed-syntax-'));
let harness;
try {
  await writeFile(join(dir, 'config.py'), 'def load_config(path):\n    return path.strip()\n');
  await writeFile(join(dir, 'caller.py'), 'from config import load_config\nvalue = load_config("test")\n');
  const provider = new ScriptedModelProvider([
    ScriptedModelProvider.toolCall('symbol_search', { symbol: 'load_config', mode: 'syntax' }),
    ScriptedModelProvider.toolCall('repo_map', { query: 'load_config call sites', maxCodeTokens: 800 }),
    ScriptedModelProvider.toolCall('write_file', { path: 'code%20 #1.ts', content: 'export const actual = true;\n' }),
    ScriptedModelProvider.text('offline installation fixture ended'),
  ]);
  harness = await createHarness({ cwd: dir, dataDir: join(dir, 'state'), profile: 'test', modelProvider: provider,
    model: { providerId: provider.id, modelId: 'scripted-model' }, agentPromptPolicy: createCodingPromptPolicy('coding-v2'),
    contextSummary: { mode: 'structured-v1' }, featureFlags: { skills: false, learning: false } });
  const session = await harness.runtime.createSession({ agent: harness.agents[0], cwd: dir });
  const turn = await harness.runtime.startTurn(session.id, 'Locate the Python configuration helper and caller in this installed distribution.');
  const result = await harness.runtime.runTurn(session.id, turn.id, AbortSignal.timeout(20000)); assert.equal(result.status, 'completed');
  const tools = (await harness.store.listMessages(session.id)).filter(m => m.role === 'tool').map(m => JSON.parse(m.content));
  assert.equal(tools[0].indexer, 'tree-sitter-wasm-v1');
  assert(tools[0].hits.some(hit => hit.file === 'config.py' && hit.role === 'definition' && hit.line === 1));
  assert(tools[0].hits.some(hit => hit.file === 'caller.py'));
  assert.equal(tools[1].relevantCode.indexer, 'tree-sitter-wasm-v1');
  assert(tools[1].relevantCode.files.some(file => file.path === 'config.py'));
  const { projectSessionHistory } = await import(pathToFileURL(join(root, 'node_modules/@ar/web/dist/deepseek/projections.js')).href);
  const { codingStatusOf } = await import(pathToFileURL(join(root, 'node_modules/@ar/web/dist/deepseek/coding-status.js')).href);
  const status = codingStatusOf(projectSessionHistory({ session: await harness.store.getSession(session.id),
    events: await harness.events.list(session.id), messages: await harness.store.listMessages(session.id) }));
  const edited = status.files.find(file => file.path === 'code%20 #1.ts'); assert(edited);
  assert(decodeURIComponent(new URL(edited.editorUri).pathname).endsWith('/code%20 #1.ts:1'));
  assert.equal(await readFile(join(dir, 'code%20 #1.ts'), 'utf8'), 'export const actual = true;\n');
  const manifest = JSON.parse(await readFile(join(root, 'PORTABLE-MANIFEST.json'), 'utf8'));
  const receipt = { status: 'PASS', sourceSha: manifest.sourceSha, paidModelCalls: 0, installedModules: true,
    policy: harness.config.agentPromptPolicy.version, checks: ['Actual installed Runtime executed syntax symbol_search',
      'Installed WASM grammar returned Python definition and caller', 'Installed repo_map returned the actual query graph', 'Installed editor URI preserves the actual percent/space/hash filename'], modelQuality: 'NOT_PROVEN' };
  await writeFile(output, JSON.stringify(receipt, null, 2) + '\n'); console.log(JSON.stringify(receipt));
} finally { await harness?.close(); await rm(dir, { recursive: true, force: true }); }
