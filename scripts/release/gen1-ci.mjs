#!/usr/bin/env node
// One cross-platform entry: every stage uses the fixed workflow source and
// real exits. A failed interaction/build/installed run prevents a PASS receipt.
import { spawnSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const source = spawnSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' });
const sha = source.stdout.trim();
if (source.status !== 0 || !/^[a-f0-9]{40}$/.test(sha) || sha !== process.env.GITHUB_SHA) throw new Error('GEN1_SOURCE_SHA_MISMATCH');
const directory = resolve('.ci/gen1');
await mkdir(directory, { recursive: true });
const steps = [];
function run(name, script, args = []) {
  const result = spawnSync(process.execPath, [script, ...args], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, windowsHide: true });
  steps.push({ name, argv: [process.execPath, script, ...args], exitCode: result.status, error: result.error?.message ?? null });
  process.stdout.write(result.stdout ?? ''); process.stderr.write(result.stderr ?? '');
  if (result.error || result.status !== 0) {
    const detail = result.error?.message ?? `exit=${result.status}; signal=${result.signal ?? 'none'}`;
    const annotation = `${name}: ${detail}`.replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
    console.error(`::error title=Gen1 stage failure::${annotation}`);
    throw new Error(`GEN1_STAGE_FAILED: ${name}: ${detail}`);
  }
}
try {
  run('portable unit/security', '--test', ['scripts/release/portable.test.mjs']);
  run('real multi-turn interaction', 'scripts/research/gen1-20261008/interaction-acceptance.mjs', ['--out', join(directory, 'interaction')]);
  run('actual product host ownership', 'scripts/research/gen1-20261008/host-lease-acceptance.mjs', ['--out', join(directory, 'host-lease')]);
  run('fixed-source portable build', 'scripts/release/portable.mjs', ['build', '--out', join(directory, 'assets'), '--version', '1.9.0', '--source-sha', sha]);
  run('installed coding and tamper controls', 'scripts/release/portable-smoke.mjs', ['--archive', join(directory, 'assets/harness-agent-1.9.0-portable.tar.gz'), '--out', join(directory, 'installed'), '--version', '1.9.0', '--source-sha', sha]);
  await writeFile(join(directory, 'result.json'), JSON.stringify({ status: 'PASS', sourceSha: sha, platform: process.platform,
    node: process.version, steps, paidModelCalls: 0, realModelQuality: 'NOT_PROVEN' }, null, 2) + '\n');
} catch (error) {
  await writeFile(join(directory, 'result.json'), JSON.stringify({ status: 'FAIL', sourceSha: sha, platform: process.platform,
    node: process.version, steps, error: error.message }, null, 2) + '\n');
  throw error;
}
