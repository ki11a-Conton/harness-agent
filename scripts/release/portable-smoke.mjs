#!/usr/bin/env node
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { digest, verifyPortable } from './portable-lib.mjs';
import { run, verifyArchive } from './portable.mjs';
import { runCodingAcceptance } from '../research/coding-audit-20261007/acceptance.mjs';

const { values } = parseArgs({ options: { archive: { type: 'string' }, out: { type: 'string' }, version: { type: 'string' }, 'source-sha': { type: 'string' } } });
if (!values.archive || !values.out || !values.version || !/^[a-f0-9]{40}$/.test(values['source-sha'] ?? '')) throw new Error('usage: portable-smoke.mjs --archive FILE --out EVIDENCE_DIR --version V --source-sha SHA');
const output = resolve(values.out); await mkdir(output, { recursive: true });
const cleanroom = await mkdtemp(join(tmpdir(), 'harness-portable-cleanroom-'));
const saved = { NODE_OPTIONS: process.env.NODE_OPTIONS, NODE_PATH: process.env.NODE_PATH };
delete process.env.NODE_OPTIONS; delete process.env.NODE_PATH;
try {
  const archive = resolve(values.archive); const bytes = await readFile(archive);
  const checksums = await readFile(join(resolve(archive, '..'), 'SHA256SUMS'), 'utf8');
  assert.ok(checksums.split('\n').includes(`${digest(bytes)}  ${basename(archive)}`), 'published checksum matches the archive');
  const { root, manifest, sha256 } = await verifyArchive({ archive, out: join(cleanroom, 'extracted'), version: values.version, sourceSha: values['source-sha'] });
  const cwd = join(cleanroom, 'consumer project with spaces'); await mkdir(cwd);
  const environment = { ...process.env, OPENAI_API_KEY: '', OPENAI_MODEL: '', OPENAI_BASE_URL: '', HARNESS_DATA_DIR: join(cleanroom, 'doctor-data'), HARNESS_MEMORY: '0', HARNESS_AGENT_PROMPT: 'coding-v1' };
  const launcher = join(root, 'agent.mjs');
  const version = run(process.execPath, [launcher, '--version'], { cwd, env: environment });
  assert.ok(version.includes(`harness-agent ${values.version} source=${values['source-sha']}`));
  const doctor = run(process.execPath, [launcher, 'doctor'], { cwd, env: environment });
  assert.ok(doctor.includes('0 error(s)'), 'installed doctor has no errors');
  await writeFile(join(output, 'version.log'), version); await writeFile(join(output, 'doctor.log'), doctor);
  // The shared runner invokes only extracted application entries, plain Node,
  // a fresh project and a local HTTP scripted model. No workspace links, tsx,
  // NODE_PATH or paid provider can stand in for the distributed application.
  const previousPrompt = process.env.HARNESS_AGENT_PROMPT;
  let coding;
  try {
    process.env.HARNESS_AGENT_PROMPT = 'coding-v1';
    coding = await runCodingAcceptance(join(output, 'coding'), {
      cli: launcher, web: join(root, 'node_modules/@ar/web/dist/main.js'),
      sourceSha: manifest.sourceSha, sourceTreeClean: true,
    });
  } finally {
    if (previousPrompt === undefined) delete process.env.HARNESS_AGENT_PROMPT;
    else process.env.HARNESS_AGENT_PROMPT = previousPrompt;
  }
  const requests = JSON.parse(await readFile(join(output, 'coding/requests.json'), 'utf8'));
  const { createCodingPromptPolicy } = await import(pathToFileURL(join(root, 'node_modules/@ar/harness/dist/index.js')).href);
  const primary = createCodingPromptPolicy().primary;
  assert.ok(requests.every(request => request.body.messages.some(message => message.role === 'system' && message.content.includes(primary))), 'installed CLI and Web use the exact coding-v1 primary prompt');
  const target = join(root, 'node_modules/@ar/web/public/index.html');
  const original = await readFile(target); await writeFile(target, Buffer.concat([original, Buffer.from('\ntampered\n')]));
  let tamperRejected = false;
  try { await verifyPortable(root); } catch { tamperRejected = true; }
  assert.ok(tamperRejected, 'payload tampering is rejected');
  const tamperedStartup = spawnSync(process.execPath, [launcher, '--version'], { cwd, env: environment, encoding: 'utf8', windowsHide: true });
  assert.equal(tamperedStartup.status, 1, 'actual startup refuses altered assets');
  assert.ok(tamperedStartup.stderr.includes('portable digest mismatch'), 'startup names the integrity failure');
  await writeFile(target, original);
  await verifyPortable(root, { version: values.version, sourceSha: values['source-sha'] });
  const receipt = { schemaVersion: 1, kind: 'harness-agent-portable-cleanroom', status: 'PASS', version: manifest.version,
    sourceSha: manifest.sourceSha, sourceTree: manifest.sourceTree, archiveSha256: sha256, platform: process.platform, node: process.version,
    files: manifest.files.length, cleanroomOutsideRepository: true, workspaceLinks: 0, doctorErrors: 0,
    codingAssertions: coding.assertions.length, requests: coding.requests, actualSelectedPromptSha256: digest(Buffer.from(primary)),
    tamperRejected, tamperedStartupRejected: true, paidModelCalls: 0, realModelQuality: 'NOT_PROVEN' };
  await writeFile(join(output, 'result.json'), JSON.stringify(receipt, null, 2) + '\n');
  console.log(JSON.stringify(receipt));
} finally {
  for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  await rm(cleanroom, { recursive: true, force: true });
}
