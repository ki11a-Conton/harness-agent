import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { caseFiles, inputManifest, pilotCases, sha256 } from './pilot-data.mjs';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repository = resolve(scriptDir, '../../..');
const args = process.argv.slice(2);
const value = flag => {
  const next = args[args.indexOf(flag) + 1];
  if (next === undefined || next.startsWith('--')) throw new Error(`${flag} requires a value`);
  return next;
};
const out = args.includes('--out') ? resolve(value('--out')) : undefined;
if (out === undefined) throw new Error('Usage: node prepare-pilot.mjs --out <directory> [--check] [--self-test] [--dry-run] [--provider openai --model <id>]');
const repoFromOut = relative(out, repository);
if (repoFromOut === '' || (!isAbsolute(repoFromOut) && repoFromOut !== '..' && !repoFromOut.startsWith(`..${sep}`))) {
  throw new Error('--out must not be the repository or an ancestor');
}
const manifest = inputManifest();
const pinned = JSON.parse(await readFile(join(scriptDir, 'input-manifest.json'), 'utf8'));
assert.deepEqual(manifest, pinned, 'pilot inputs changed; review and explicitly update the pinned input manifest');
const generated = pilotCases();

for (const caseDef of generated) {
  const caseDir = join(out, 'cases', caseDef.strategy, caseDef.id);
  for (const [path, content] of Object.entries(caseFiles(caseDef))) {
    const target = join(caseDir, path);
    if (args.includes('--check')) assert.equal(await readFile(target, 'utf8'), content, `prepared input changed: ${caseDef.id}/${path}`);
    else { await mkdir(dirname(target), { recursive: true }); await writeFile(target, content, 'utf8'); }
  }
}
await mkdir(out, { recursive: true });
if (args.includes('--check')) assert.deepEqual(JSON.parse(await readFile(join(out, 'input-manifest.json'), 'utf8')), manifest);
else await writeFile(join(out, 'input-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);

const report = { schemaVersion: 'agent-measurement-pilot-preparation-v1', inputDigest: manifest.inputDigest,
  preparedInputHashesVerified: true, paidCalls: 0, promotion: 'NOT_RUN', cases: [] };
const { loadBenchmarkCases, getArmFactory, buildPairedPlan } = await import('../../../packages/evaluation/dist/index.js');
for (const caseDef of generated) {
  const [loaded] = await loadBenchmarkCases(join(out, 'cases', caseDef.strategy));
  assert.equal(loaded.id, caseDef.id);
  assert.deepEqual(loaded.fixture, caseDef.fixture);
  assert.equal(loaded.verification[0].args[1], caseDef.metadata.verification[0].args[1]);
  const row = { caseId: caseDef.id, candidate: caseDef.candidate, formalCaseSchema: 'PASS', checker: {}, dryRun: 'NOT_RUN' };
  row.pairOrders = buildPairedPlan({ suite: 'regression', cases: [caseDef.id], repetitions: 2, orderSeed: 19 }).pairs.map(pair => pair.order);
  assert.deepEqual(row.pairOrders, ['BA', 'AB']);
  if (args.includes('--self-test')) {
    const scratch = await mkdtemp(join(tmpdir(), 'harness-pilot-checker-'));
    try {
      for (const [path, content] of Object.entries(caseDef.fixture)) {
        await mkdir(dirname(join(scratch, path)), { recursive: true });
        await writeFile(join(scratch, path), content, 'utf8');
      }
      const check = async scenario => {
        const result = spawnSync(process.execPath, loaded.verification[0].args,
          { cwd: scratch, encoding: 'utf8', timeout: 10000, maxBuffer: 131072 });
        const receiptPath = join('checker-self-test', caseDef.id, `${scenario}.json`);
        const receipt = { caseId: caseDef.id, scenario, checkerSha256: sha256(loaded.verification[0].args[1]),
          status: result.status, signal: result.signal, error: result.error?.message ?? null,
          stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
        await mkdir(dirname(join(out, receiptPath)), { recursive: true });
        const serialized = `${JSON.stringify(receipt, null, 2)}\n`;
        await writeFile(join(out, receiptPath), serialized);
        (row.checkerReceipts ??= []).push({ scenario, status: result.status, path: receiptPath, sha256: sha256(serialized) });
        return result;
      };
      assert.notEqual((await check('original-fixture')).status, 0, 'the broken original fixture must fail');
      row.checker.originalFixture = 'FAIL_EXPECTED';
      await writeFile(join(scratch, caseDef.targetPath), caseDef.solution, 'utf8');
      const solved = await check('correct-repair');
      assert.equal(solved.status, 0, solved.stderr);
      row.checker.correctRepair = 'PASS';
      const immutablePath = Object.keys(caseDef.fixture).find(path => path !== caseDef.targetPath);
      await writeFile(join(scratch, immutablePath), `${caseDef.fixture[immutablePath]}\n// tampered\n`, 'utf8');
      assert.notEqual((await check('non-target-tamper')).status, 0, 'immutable fixture tamper must fail');
      await writeFile(join(scratch, immutablePath), caseDef.fixture[immutablePath], 'utf8');
      row.checker.nonTargetTamper = 'FAIL_EXPECTED';
      await writeFile(join(scratch, caseDef.targetPath),
        `import { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(immutablePath)}, 'changed during module execution');\n${caseDef.solution}`, 'utf8');
      assert.notEqual((await check('module-time-non-target-tamper')).status, 0, 'module-time immutable fixture tamper must fail after behavior checks');
      await writeFile(join(scratch, immutablePath), caseDef.fixture[immutablePath], 'utf8');
      row.checker.moduleTimeNonTargetTamper = 'FAIL_EXPECTED';
      await writeFile(join(scratch, caseDef.targetPath),
        `import checkerAssert from 'node:assert/strict';\ncheckerAssert.equal = () => {};\n${caseDef.solution}`, 'utf8');
      assert.notEqual((await check('assert-monkeypatch')).status, 0, 'module must not disable checker assertions');
      row.checker.assertMonkeypatch = 'FAIL_EXPECTED';
      await writeFile(join(scratch, caseDef.targetPath), caseDef.solution, 'utf8');
      const rulePath = Object.keys(caseDef.fixture).find(path => path.endsWith('SKILL.md') || path.endsWith('AGENTS.md'));
      if (rulePath !== undefined) {
        await writeFile(join(scratch, rulePath), `${caseDef.fixture[rulePath]}\nmodified rule\n`, 'utf8');
        assert.notEqual((await check('rule-tamper')).status, 0, 'rule document tamper must fail');
        await writeFile(join(scratch, rulePath), caseDef.fixture[rulePath], 'utf8');
        row.checker.ruleTamper = 'FAIL_EXPECTED';
      }
      await writeFile(join(scratch, caseDef.targetPath), 'process.exit(0);\n', 'utf8');
      assert.notEqual((await check('early-exit-bypass')).status, 0, 'early module exit must not bypass the parent checker');
      row.checker.earlyExitBypass = 'FAIL_EXPECTED';
    } finally { await rm(scratch, { recursive: true, force: true }); }
  }
  const preflight = getArmFactory().preflight(caseDef.candidate);
  row.candidateRegistration = preflight.ok ? 'PASS' : preflight.reasonCode;
  if (args.includes('--dry-run')) {
    const provider = args.includes('--provider') ? value('--provider') : 'openai';
    const model = args.includes('--model') ? value('--model') : 'gpt-4o-mini';
    const cliArgs = ['apps/cli/dist/main.js', 'benchmark', '--dry-run', '--cases', join(out, 'cases', caseDef.strategy),
      '--candidate', caseDef.candidate, '--limit', '1', '--repeat', '2', '--seed', '19',
      '--provider', provider, '--model', model, '--max-model-calls', '40', '--max-logical-runs', '4'];
    const result = spawnSync(process.execPath, cliArgs, { cwd: repository, encoding: 'utf8', timeout: 30000,
      maxBuffer: 1048576, env: { ...process.env, RUN_PAID_BENCHMARKS: '0', OPENAI_MAX_RETRIES: '0' } });
    await writeFile(join(out, `${caseDef.strategy}-dry-run.stdout.log`), result.stdout ?? '');
    await writeFile(join(out, `${caseDef.strategy}-dry-run.stderr.log`), result.stderr ?? '');
    assert.equal(result.status, 0, `${caseDef.candidate} dry-run failed: ${result.stdout}\n${result.stderr}`);
    row.dryRun = 'PASS';
    row.dryRunArgv = cliArgs;
    row.dryRunStdoutSha256 = sha256(result.stdout);
  }
  report.cases.push(row);
}
await writeFile(join(out, args.includes('--check') ? 'preparation-check-report.json' : 'preparation-report.json'), `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(report, null, 2));
