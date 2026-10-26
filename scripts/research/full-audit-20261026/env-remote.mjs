import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
const root = process.argv[2];
const output = process.argv[3];
const { createHarness } = await import(pathToFileURL(join(root, 'packages/harness/dist/index.js')));
const { ScriptedModelProvider } = await import(pathToFileURL(join(root, 'packages/model/dist/index.js')));
const cwd = await mkdtemp('/tmp/harness-env-remote-');
const secret = 'fixtureOpaqueCredential9q';
const remote = `https://build-user:${secret}@example.invalid/project/repo.git`;
const git = args => execFileSync('git', ['-C', cwd, ...args], { stdio: 'pipe' });
let harness;
try {
  git(['init', '-q']);
  git(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--allow-empty', '-qm', 'fixture']);
  git(['remote', 'add', 'origin', remote]);
  const requests = [];
  const provider = {
    id: 'env-remote-offline',
    listModels: async () => [{ id: 'scripted', capabilities: { contextWindowTokens: 128000 } }],
    createClient: () => ({ async *generate(request) {
      requests.push(structuredClone(request));
      yield* requests.length === 1
        ? ScriptedModelProvider.toolCall('env_snapshot', { probeLimit: 0 })
        : ScriptedModelProvider.text('Inspected environment.');
    } }),
  };
  harness = await createHarness({ cwd, dataDir: join(cwd, 'state'), profile: 'test', modelProvider: provider,
    model: { providerId: provider.id, modelId: 'scripted' },
    featureFlags: { skills: false, mcp: false, memory: false, delegation: false, learning: false } });
  const session = await harness.runtime.createSession({ agent: harness.agents[0], cwd });
  const turn = await harness.runtime.startTurn(session.id, 'Inspect the selected workspace environment.');
  const outcome = await harness.runtime.runTurn(session.id, turn.id, new AbortController().signal);
  const modelToolText = requests.at(-1)?.messages.filter(m => m.role === 'tool').map(m => m.content).join('\n') ?? '';
  const events = await harness.events.list(session.id);
  const report = { sourceRoot: root, sourceSha: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(), sourceDirty: execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' }).trim() !== '', turnStatus: outcome.status, requests: requests.length,
    toolMessagePresent: modelToolText.includes('"git"'),
    modelReceivedRemotePassword: modelToolText.includes(secret),
    modelReceivedRemoteUsername: modelToolText.includes('build-user'),
    repositoryIdentityPreserved: modelToolText.includes('example.invalid/project/repo.git'),
    eventStreamContainsCredential: JSON.stringify(events).includes(secret),
    paidModelCalls: 0 };
  await writeFile(output, JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report));
} finally { await harness?.close(); await rm(cwd, { recursive: true, force: true }); }
