import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { createHarness } from '../../packages/harness/dist/index.js';
import { ScriptedModelProvider } from '../../packages/model/dist/index.js';
const makeProvider = () => new ScriptedModelProvider([ScriptedModelProvider.text('answer'), ScriptedModelProvider.text('later')]);
const provider = makeProvider();
const cwd = await mkdtemp(join(tmpdir(), 'ar-gen1-stateful-provider-'));
const config = { cwd, dataDir: join(cwd, 'data'), profile: 'test', modelProvider: provider, model: { providerId: provider.id, modelId: 'scripted-model' } };
const describeProvider = (p) => ({ id: p.id, model: config.model, calls: [...p.calls], abortSignalsLength: p.abortSignals.length, index: p.index });
const result = { sourcePaths: ['packages/harness/src/config-resolver.ts', 'packages/harness/src/config-layers.ts', 'packages/harness/src/create-harness.ts', 'packages/model/src/fakes/scripted.ts'], initialProvider: describeProvider(provider) };
let harness;
try {
  harness = await createHarness(config);
  const parent = await harness.runtime.createSession({ agent: harness.agents[0], cwd });
  const actor = await harness.sessions.load(parent.id);
  const handle = await actor.startTurn({sessionId: parent.id, text: 'inspect'});
  result.firstTurnStatus = (await handle.outcome).status;
  result.afterTurnProvider = describeProvider(provider);
  const fork = await harness.sessionService.threadFork(parent.id);
  result.sameHarnessFork = { success: true, parentId: parent.id, branchId: fork.id, status: fork.status };
  const frozen = await harness.store.loadStateSnapshot(parent.id);
  const providerValue = JSON.parse(frozen['p27.configValue']).modelProvider;
  result.frozen = { fingerprint: frozen['p27.configFingerprint'], modelProvider: { id: providerValue.id, calls: providerValue.calls, abortSignalsLength: providerValue.abortSignals.length, index: providerValue.index } };
  await harness.close();
  harness = await createHarness(config);
  result.reusedProviderDrift = await harness.checkSessionConfigDrift(parent.id);
  try { await harness.sessions.load(parent.id); result.reusedProviderResume = { success: true }; }
  catch (error) { result.reusedProviderResume = { success: false, code: error.info?.code ?? error.code, message: error.message }; }
  await harness.close();
  const freshProvider = makeProvider();
  harness = await createHarness({ ...config, modelProvider: freshProvider });
  result.freshProvider = describeProvider(freshProvider);
  result.freshProviderDrift = await harness.checkSessionConfigDrift(parent.id);
  try { await harness.sessions.load(parent.id); result.freshProviderResume = { success: true }; }
  catch (error) { result.freshProviderResume = { success: false, code: error.info?.code ?? error.code, message: error.message }; }
  result.sourceHashes = {};
  for (const path of result.sourcePaths) result.sourceHashes[path] = createHash('sha256').update(await readFile(new URL('../../' + path, import.meta.url))).digest('hex');
} finally { await harness?.close(); await rm(cwd, { recursive: true, force: true }); }
const out = new URL('./stateful-provider-restart.json', import.meta.url);
await writeFile(out, JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify(result, null, 2));
if (result.reusedProviderResume?.success !== false || result.freshProviderResume?.success !== true || result.sameHarnessFork?.success !== true) process.exitCode = 1;
