import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { access, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const argv = process.argv.slice(2);
function option(name, fallback) { const index = argv.indexOf(name); return index < 0 ? fallback : argv[index + 1]; }
const repo = resolve(option('--repo', resolve(dirname(fileURLToPath(import.meta.url)), '../../..')));
const out = resolve(option('--out', join(repo, '.ci/agent-round2-20261004/verification')));
await mkdir(out, { recursive: true });
const fixtureRoot = await mkdtemp(join(out, 'fixtures-'));
const { createHarness } = await import(pathToFileURL(join(repo, 'packages/harness/dist/index.js')));
const { createVerificationPlanner } = await import(pathToFileURL(join(repo, 'packages/harness/dist/verification-planner.js')));
const { CommandDiscoveryService } = await import(pathToFileURL(join(repo, 'packages/harness/dist/command-discovery-service.js')));
const { TaskVerifier, ProcessExecutor, discoverCommands, summarize, planToVerificationSpecs, buildVerificationPlan } = await import(pathToFileURL(join(repo, 'packages/tools/dist/index.js')));
const sourceSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim();
const dirty = execFileSync('git', ['status', '--porcelain'], { cwd: repo, encoding: 'utf8' }).trim().length > 0;
const sourceFiles = ['packages/tools/src/verification/plan-builder.ts', 'packages/tools/src/verification/task-verifier.ts', 'packages/tools/src/command-discovery.ts', 'packages/harness/src/verification-planner.ts', 'packages/harness/src/command-discovery-service.ts', 'packages/harness/src/compose/compose-verification.ts', 'packages/harness/src/verification-trust.regressions.test.ts', 'packages/harness/src/command-discovery-cache.regressions.test.ts'];
const distFiles = ['packages/tools/dist/verification/plan-builder.js', 'packages/tools/dist/verification/task-verifier.js', 'packages/tools/dist/command-discovery.js', 'packages/harness/dist/verification-planner.js', 'packages/harness/dist/command-discovery-service.js'];
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const fingerprints = {};
for (const path of [...sourceFiles, ...distFiles]) {
  try { fingerprints[path] = hash(await readFile(join(repo, path))); }
  catch (error) { if (error.code !== 'ENOENT' || !path.endsWith('.test.ts')) throw error; }
}
const probeSha256 = hash(await readFile(fileURLToPath(import.meta.url)));
const fixtureHashes = {};
const executor = new ProcessExecutor(), verifier = new TaskVerifier();
const receipts = [];
const context = cwd => ({ sessionId: 'verification-measurement', cwd, changedPaths: [], transcript: '', runStartedAt: Date.now() });
const exists = path => access(path).then(() => true, () => false);
async function fixture(name, scripts, files = {}) {
  const cwd = join(fixtureRoot, name); await mkdir(cwd, { recursive: true });
  files = { ...files, 'package.json': JSON.stringify({ name, private: true, scripts }, null, 2) + '\n' };
  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(cwd, path)), { recursive: true }); await writeFile(join(cwd, path), content);
    fixtureHashes[`${name}/${path}`] = hash(content);
  }
  return cwd;
}
async function run(name, cwd, verification, planner) {
  let scriptedCalls = 0;
  const provider = { id: 'offline-verification-probe', async listModels() { return [{ id: 'stop', name: 'stop', capabilities: { contextWindowTokens: 128000 } }]; }, createClient() { return { async *generate() {
    scriptedCalls++; yield { type: 'completed', timestamp: 0, result: { finishReason: 'stop', text: 'done' } };
  } }; } };
  const harness = await createHarness({ cwd, dataDir: join(out, 'sessions', name), profile: 'test', modelProvider: provider, model: { providerId: provider.id, modelId: 'stop' }, task: { id: name, goal: 'finish the task', ...(verification !== undefined ? { verification } : {}) }, ...(planner !== undefined ? { verification: { planner } } : {}) });
  try {
    const session = await harness.runtime.createSession({ agent: harness.agents[0], cwd });
    const turn = await harness.runtime.startTurn(session.id, 'finish the task');
    const outcome = await harness.runtime.runTurn(session.id, turn.id, new AbortController().signal);
    const events = await harness.events.list(session.id);
    const eventFile = `${name}-events.json`; const bytes = JSON.stringify(events, null, 2) + '\n';
    await writeFile(join(out, eventFile), bytes);
    return { outcome, scriptedCalls, paidCalls: 0, toolRequests: events.filter(event => event.type === 'tool.requested').length, verificationEvents: events.filter(event => event.type.startsWith('verification.')), eventArtifact: { path: eventFile, bytes: Buffer.byteLength(bytes), sha256: hash(bytes) } };
  } finally { await harness.close(); }
}
function failedGate(result) {
  return result.outcome.status === 'failed' && result.outcome.terminationReason === 'verification_failed'
    && result.verificationEvents.some(event => event.type === 'verification.failed')
    && !result.verificationEvents.some(event => event.type === 'verification.completed' && event.payload.passed === true)
    && result.toolRequests === 0;
}
function passedGate(result) {
  return result.outcome.status === 'completed' && result.outcome.terminationReason === 'verified_complete'
    && result.verificationEvents.some(event => event.type === 'verification.completed' && event.payload.passed === true)
    && result.toolRequests === 0;
}
async function recipeCase(name, command, files, expectedExit) {
  const cwd = await fixture(name, { test: command }, files);
  const discovery = await discoverCommands(cwd), plan = buildVerificationPlan({ root: cwd, filesChanged: [], commands: summarize(discovery.discovered) });
  const specs = planToVerificationSpecs(plan);
  const rawOutcome = await executor.run({ command, cwd, timeoutMs: 5000 });
  const convertedResult = await verifier.verify({ id: name, goal: 'check', verification: specs }, context(cwd));
  const harness = await run(name, cwd);
  const marker = files?.['test suite/required-check.cjs'] !== undefined ? await exists(join(cwd, 'checker-ran.txt')) : undefined;
  receipts.push({ name, originalRecipe: command, discovery, plan, specs, rawOutcome, convertedResult, harness, independentMarker: marker, passed: rawOutcome.exitCode === expectedExit && convertedResult.passed === (expectedExit === 0) && (expectedExit === 0 ? passedGate(harness) : failedGate(harness)) && (marker === undefined || marker) });
}
await recipeCase('quoted-required-failure', 'node -e "process.exit(7)"', {}, 7);
await recipeCase('compound-required-failure', 'node pass.cjs && node required-fail.cjs', { 'pass.cjs': 'console.log("FIRST_COMMAND_RAN");\n', 'required-fail.cjs': 'console.log("REQUIRED_TEST_RAN");process.exit(9);\n' }, 9);
await recipeCase('quoted-space-path', 'node "test suite/required-check.cjs"', { 'test suite/required-check.cjs': 'require("node:fs").writeFileSync("checker-ran.txt","ORIGINAL_CHECKER_RAN");\n' }, 0);
await recipeCase('ordinary-passing-recipe', 'node -e "process.exit(0)"', {}, 0);

async function monorepo(name, reverse) {
  const files = { 'required-fail.cjs': 'console.log("ROOT_REQUIRED_TEST_RAN");process.exit(11);\n', 'smoke.cjs': 'console.log("UNRELATED_SMOKE_RAN");\n' };
  const ids = Array.from({ length: 61 }, (_, index) => index);
  for (const index of reverse ? ids.reverse() : ids) files[`packages/p${String(index).padStart(2, '0')}/package.json`] = JSON.stringify({ name: `p${index}`, scripts: { test: 'node smoke.cjs' } }) + '\n';
  return fixture(name, { 'test:watch': 'node smoke.cjs', test: 'node required-fail.cjs', build: 'node required-fail.cjs', typecheck: 'node smoke.cjs' }, files);
}
const capCwd = await monorepo('discovery-root-truncated', false), capDiscovery = await discoverCommands(capCwd), capSummary = summarize(capDiscovery.discovered);
const capRaw = await executor.run({ command: 'node required-fail.cjs', cwd: capCwd, timeoutMs: 5000 });
const capHarness = await run('discovery-root-truncated', capCwd);
const reverseDiscovery = await discoverCommands(await monorepo('discovery-reverse-order', true));
const canonicalRetained = ['test', 'build', 'typecheck'].every(name => capDiscovery.discovered.some(command => command.file === 'package.json' && command.scriptName === name));
receipts.push({ name: 'discovery-root-truncated', originalRequiredTest: 'node required-fail.cjs', discovery: capDiscovery, summary: capSummary, canonicalRetained, rawOutcome: capRaw, harness: capHarness, passed: capRaw.exitCode === 11 && canonicalRetained && capDiscovery.discovered.length === 60 && capSummary.test === 'node required-fail.cjs' && failedGate(capHarness) });
receipts.push({ name: 'discovery-order-stability', forward: capDiscovery.discovered, reverse: reverseDiscovery.discovered, summaryReversed: summarize([...capDiscovery.discovered].reverse()), passed: JSON.stringify(capDiscovery.discovered) === JSON.stringify(reverseDiscovery.discovered) && JSON.stringify(capSummary) === JSON.stringify(summarize([...capDiscovery.discovered].reverse())) });

// An upgrade must invalidate old discovery results, otherwise loadPersisted
// bypasses the repaired discovery path. New-generation warm caching remains.
const legacyHints = { cwd: capCwd, commands: { test: 'node smoke.cjs' }, summary: { test: 'node smoke.cjs' }, discoveredAt: 1000 };
const legacyLine = JSON.stringify(legacyHints) + '\n';
const cacheDataDir = join(out, 'cache-upgrade'); await mkdir(cacheDataDir, { recursive: true });
await writeFile(join(cacheDataDir, 'command-hints.jsonl'), legacyLine);
const cacheService = new CommandDiscoveryService({ dataDir: cacheDataDir, now: () => 2000 });
await cacheService.loadPersisted(); const hintsBeforeDiscovery = cacheService.hints(capCwd);
const rediscoveredHints = await cacheService.maybeDiscover(capCwd);
const warmService = new CommandDiscoveryService({ dataDir: cacheDataDir, now: () => 3000 });
await warmService.loadPersisted(); const warmHints = await warmService.maybeDiscover(capCwd);
const legacyHarnessDir = join(out, 'sessions', 'legacy-cache-harness'); await mkdir(legacyHarnessDir, { recursive: true });
await writeFile(join(legacyHarnessDir, 'command-hints.jsonl'), legacyLine);
const legacyHarness = await run('legacy-cache-harness', capCwd);
receipts.push({ name: 'legacy-cache-upgrade', originalLegacyLine: legacyLine, originalLegacySha256: hash(legacyLine), hintsBeforeDiscovery, rediscoveredHints, harness: legacyHarness, passed: hintsBeforeDiscovery === undefined && rediscoveredHints.commands.test === 'node required-fail.cjs' && rediscoveredHints.discoveredAt === 2000 && rediscoveredHints.discoveryVersion === 'root-entrypoints-v1' && failedGate(legacyHarness) });
receipts.push({ name: 'current-cache-warm-control', rediscoveredHints, warmHints, persistedLines: (await readFile(join(cacheDataDir, 'command-hints.jsonl'), 'utf8')).trim().split('\n'), passed: warmHints.commands.test === 'node required-fail.cjs' && warmHints.discoveredAt === 2000 && warmHints.discoveryVersion === 'root-entrypoints-v1' });

const changedPaths = ['src/a.test.ts;node marker.cjs;tail.test.ts', 'src/space name.test.ts', 'src/quoted"name.test.ts'];
const changedCwd = await fixture('changed-path-no-interpolation', {}, { 'pass.cjs': 'console.log("TEST_ENTRYPOINT_RAN");\n', 'marker.cjs': 'require("node:fs").writeFileSync("injected.txt","bad");\n' });
const changedPlan = buildVerificationPlan({ root: changedCwd, filesChanged: changedPaths, commands: { test: 'node pass.cjs' } });
const defaultPlanner = createVerificationPlanner({ commands: { cwd: changedCwd, commands: { test: 'node pass.cjs' }, summary: { test: 'node pass.cjs' }, discoveredAt: 0 } });
const changedHarness = await run('changed-path-no-interpolation', changedCwd, undefined, input => defaultPlanner({ ...input, changedPaths }));
const changedMarker = await exists(join(changedCwd, 'injected.txt'));
receipts.push({ name: 'changed-path-no-interpolation', changedPaths, plan: changedPlan, harness: changedHarness, unexpectedMarker: changedMarker, passed: passedGate(changedHarness) && !changedMarker && changedPlan.steps.length === 1 && changedPlan.steps[0].command === 'node pass.cjs' && changedPlan.steps[0].cwd === undefined });

const explicitCwd = await fixture('explicit-argv-failure', { test: 'node -e "process.exit(0)"' });
const explicitSpec = { kind: 'command', command: process.execPath, args: ['-e', 'process.exit(7)'] };
const explicitHarness = await run('explicit-argv-failure', explicitCwd, [explicitSpec]);
receipts.push({ name: 'explicit-argv-failure', spec: explicitSpec, harness: explicitHarness, passed: failedGate(explicitHarness) });
const literal = 'a&node marker.cjs|; $literal "quoted"';
const argvCwd = await fixture('explicit-argv-literal', {}, { 'check.cjs': `if(process.argv[2]!==${JSON.stringify(literal)})process.exit(12);console.log("ARGV_EXACT");\n`, 'marker.cjs': 'require("node:fs").writeFileSync("injected.txt","bad");\n' });
const argvSpec = { kind: 'command', command: process.execPath, args: ['check.cjs', literal] };
const argvHarness = await run('explicit-argv-literal', argvCwd, [argvSpec]);
const argvMarker = await exists(join(argvCwd, 'injected.txt'));
receipts.push({ name: 'explicit-argv-literal', spec: argvSpec, harness: argvHarness, unexpectedMarker: argvMarker, passed: passedGate(argvHarness) && !argvMarker });
const emptyHarness = await run('empty-verification', await fixture('empty-verification', {}));
receipts.push({ name: 'empty-verification', harness: emptyHarness, passed: failedGate(emptyHarness) });

const result = { schema: 'agent-trust-verification.v1', sourceSha, dirty, node: process.version, platform: process.platform, probeSha256, fingerprints, fixtureHashes, fixtureRoot, scope: 'Built production Harness/planner/TaskVerifier and actual local file/process results; frozen scripted stop provider never repairs or runs tools; original verification gate and its retry policy unchanged.', paidCalls: 0, liveModelQuality: 'NOT_RUN', promotion: 'NOT_RUN', verificationIntegrityPass: receipts.every(receipt => receipt.passed), receipts };
await writeFile(join(out, 'verification-measurement.json'), JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify({ sourceSha, dirty, verificationIntegrityPass: result.verificationIntegrityPass, receipts: receipts.map(receipt => ({ name: receipt.name, passed: receipt.passed, rawExitCode: receipt.rawOutcome?.exitCode, convertedPassed: receipt.convertedResult?.passed, harnessTermination: receipt.harness?.outcome.terminationReason, scriptedCalls: receipt.harness?.scriptedCalls })) }, null, 2));
if (!result.verificationIntegrityPass) process.exitCode = 1;
