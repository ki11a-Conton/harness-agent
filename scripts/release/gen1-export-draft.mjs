#!/usr/bin/env node
// Authorized preparation of one existing draft's CI assets. This is not a URL
// proxy: no user-defined endpoints, release creation, patching or publication.
import { lstat, readFile, readdir, realpath } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { digest, makeArchive, safePath } from './portable-lib.mjs';

const REPOSITORY = 'ki11a-Conton/harness-agent';
const RELEASE_ID = 406478808;
const VERSION = '1.9.0';
const LIMIT = 64 * 1024 * 1024;
const API = `https://api.github.com/repos/${REPOSITORY}/releases/${RELEASE_ID}`;
const STAGES = ['portable unit/security', 'real multi-turn interaction', 'actual product host ownership', 'fixed-source portable build', 'installed coding and tamper controls'];
const fail = message => { throw new Error(message); };
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const parse = bytes => { try { return JSON.parse(bytes); } catch { return null; } };

export async function exportDraft({ root = '.ci/gen1-export', env = process.env, fetchImpl = globalThis.fetch } = {}) {
  const sha = env.GITHUB_SHA;
  const runId = env.GITHUB_RUN_ID;
  if (env.GITHUB_REPOSITORY !== REPOSITORY || !/^refs\/heads\/validation\/gen1-[A-Za-z0-9._/-]+$/.test(env.GITHUB_REF ?? '')
    || !/^[a-f0-9]{40}$/.test(sha ?? '') || !/^\d{1,20}$/.test(runId ?? '')
    || !/^\d{1,10}$/.test(env.GITHUB_RUN_ATTEMPT ?? '') || !env.GITHUB_TOKEN) fail('GEN1_EXPORT_CONTEXT_REJECTED');
  async function request(url, options = {}) {
    const response = await fetchImpl(url, { ...options, redirect: 'error', signal: AbortSignal.timeout(30_000), headers: {
      Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28',
      ...options.headers, Authorization: `Bearer ${env.GITHUB_TOKEN}`,
    } });
    // Do not print response bodies: GitHub errors must not disclose credentials.
    if (!response.ok) fail(`GEN1_EXPORT_HTTP_${response.status}`);
    return response;
  }
  async function draft() {
    const release = await (await request(API)).json();
    if (!object(release) || release.id !== RELEASE_ID || release.tag_name !== `v${VERSION}`
      || release.draft !== true || release.target_commitish !== sha) fail('GEN1_EXPORT_EXISTING_DRAFT_SOURCE_REQUIRED');
    return release;
  }
  await draft();
  const base = resolve(root);
  if ((await lstat(base)).isSymbolicLink() || await realpath(base) !== base) fail('GEN1_EXPORT_UNSAFE_ROOT');
  const files = new Map();
  let occupiedBytes = 1024;
  const origins = ['ubuntu', 'windows', 'same-archive-windows'];
  async function collect(directory, prefix) {
    for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name, 'en'))) {
      const path = safePath(`${prefix}/${entry.name}`);
      const full = join(directory, entry.name);
      const stat = await lstat(full);
      if (stat.isSymbolicLink()) fail(`GEN1_EXPORT_SYMLINK: ${path}`);
      if (stat.isDirectory()) await collect(full, path);
      else {
        if (!stat.isFile() || !Number.isSafeInteger(stat.size)) fail(`GEN1_EXPORT_NONREGULAR: ${path}`);
        occupiedBytes += 512 + Math.ceil(stat.size / 512) * 512;
        if (occupiedBytes > LIMIT || files.size >= 10000) fail('GEN1_EXPORT_64MB_LIMIT');
        const bytes = await readFile(full);
        if (bytes.length !== stat.size) fail(`GEN1_EXPORT_FILE_CHANGED: ${path}`);
        files.set(path, bytes);
      }
    }
  }
  for (const origin of origins) {
    const directory = join(base, origin);
    let stat;
    try { stat = await lstat(directory); } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    if (!stat.isDirectory() || stat.isSymbolicLink()) fail(`GEN1_EXPORT_UNSAFE_ARTIFACT_ROOT: ${origin}`);
    await collect(directory, origin);
  }
  if (files.size === 0) fail('GEN1_EXPORT_NO_ACTUAL_ARTIFACTS');
  const reasons = [];
  const document = path => parse(files.get(path)?.toString('utf8') ?? '');
  function mainReceipt(origin, platform) {
    const receipt = document(`${origin}/result.json`);
    const valid = object(receipt) && receipt.status === 'PASS' && receipt.sourceSha === sha && receipt.platform === platform
      && receipt.paidModelCalls === 0 && receipt.realModelQuality === 'NOT_PROVEN'
      && Array.isArray(receipt.steps) && receipt.steps.length === STAGES.length
      && receipt.steps.every((step, index) => object(step) && step.name === STAGES[index] && step.exitCode === 0 && step.error === null);
    if (!valid) reasons.push(`${origin}: missing/failed/invalid exact-source stage receipt`);
    return valid;
  }
  function smokeReceipt(path, platform) {
    const receipt = document(path);
    const valid = object(receipt) && receipt.schemaVersion === 1 && receipt.kind === 'harness-agent-portable-cleanroom'
      && receipt.status === 'PASS' && receipt.sourceSha === sha && receipt.platform === platform && receipt.version === VERSION
      && /^[a-f0-9]{64}$/.test(receipt.archiveSha256 ?? '') && /^[a-f0-9]{40}$/.test(receipt.sourceTree ?? '')
      && receipt.cleanroomOutsideRepository === true && receipt.workspaceLinks === 0 && receipt.doctorErrors === 0
      && receipt.tamperRejected === true && receipt.tamperedStartupRejected === true && receipt.paidModelCalls === 0
      && receipt.realModelQuality === 'NOT_PROVEN' && Number.isSafeInteger(receipt.codingAssertions) && receipt.codingAssertions > 0;
    if (!valid) reasons.push(`${path}: missing/failed/invalid installed receipt`);
    return valid ? receipt : null;
  }
  const linux = mainReceipt('ubuntu', 'linux');
  const windows = mainReceipt('windows', 'win32');
  const installedLinux = smokeReceipt('ubuntu/installed/result.json', 'linux');
  const installedWindows = smokeReceipt('windows/installed/result.json', 'win32');
  const sameArchive = smokeReceipt('same-archive-windows/result.json', 'win32');
  const filename = `harness-agent-${VERSION}-portable.tar.gz`;
  const archive = files.get(`ubuntu/assets/${filename}`);
  const build = document('ubuntu/assets/BUILD-RECEIPT.json');
  const checksums = files.get('ubuntu/assets/SHA256SUMS')?.toString('utf8');
  const archiveHash = archive ? digest(archive) : null;
  const buildValid = archive && object(build) && build.version === VERSION && build.sourceSha === sha
    && build.filename === filename && build.sha256 === archiveHash && /^[a-f0-9]{40}$/.test(build.sourceTree ?? '')
    && checksums === `${archiveHash}  ${filename}\n`;
  if (!buildValid) reasons.push('Ubuntu archive/build/checksum identity not verified');
  const sameBytes = buildValid && installedLinux?.archiveSha256 === archiveHash && sameArchive?.archiveSha256 === archiveHash
    && installedLinux?.sourceTree === build.sourceTree && sameArchive?.sourceTree === build.sourceTree;
  if (!sameBytes) reasons.push('Ubuntu installed and native Windows did not prove identical distributed bytes');
  // The Windows self-built archive can differ; validate its own build identity
  // independently. The same-archive Windows receipt is the cross-platform gate.
  const winArchive = files.get(`windows/assets/${filename}`);
  const winBuild = document('windows/assets/BUILD-RECEIPT.json');
  const winHash = winArchive ? digest(winArchive) : null;
  const winBuildValid = winArchive && object(winBuild) && winBuild.version === VERSION && winBuild.sourceSha === sha
    && winBuild.filename === filename && winBuild.sha256 === winHash && winBuild.sourceTree === build?.sourceTree
    && installedWindows?.archiveSha256 === winHash && installedWindows?.sourceTree === winBuild.sourceTree
    && files.get('windows/assets/SHA256SUMS')?.toString('utf8') === `${winHash}  ${filename}\n`;
  if (!winBuildValid) reasons.push('Windows self-built installed archive identity not verified');
  const eligible = Boolean(linux && windows && installedLinux && installedWindows && sameArchive && sameBytes && winBuildValid);
  const receipt = { schemaVersion: 1, kind: 'harness-agent-gen1-draft-ci-export', sourceSha: sha, runId,
    runAttempt: env.GITHUB_RUN_ATTEMPT, repository: REPOSITORY, releaseId: RELEASE_ID, releaseDraft: true,
    status: eligible ? 'PASS' : 'FAIL', formalAssetsEligible: eligible, reasons, archiveSha256: archiveHash,
    realModelQuality: 'NOT_PROVEN', files: [...files].map(([path, bytes]) => ({ path, bytes: bytes.length, sha256: digest(bytes) })) };
  const receiptBytes = Buffer.from(JSON.stringify(receipt, null, 2) + '\n');
  occupiedBytes += 512 + Math.ceil(receiptBytes.length / 512) * 512;
  if (occupiedBytes > LIMIT) fail('GEN1_EXPORT_64MB_LIMIT');
  const bundle = makeArchive([...files].map(([path, bytes]) => ({ path: `gen1-ci-bundle/${path}`, bytes }))
    .concat([{ path: 'gen1-ci-bundle/export-receipt.json', bytes: receiptBytes }]));
  if (bundle.length > LIMIT) fail('GEN1_EXPORT_64MB_LIMIT');
  async function upload(name, bytes, contentType) {
    // Re-check draft/source immediately before every write, including retries.
    const release = await draft();
    const existing = release.assets?.filter(asset => asset.name === name) ?? [];
    if (existing.length) {
      if (existing.length !== 1 || existing[0].digest !== `sha256:${digest(bytes)}` || existing[0].size !== bytes.length) {
        fail(`GEN1_EXPORT_EXISTING_ASSET_REFUSED: ${name}`);
      }
      return { name, sha256: digest(bytes), bytes: bytes.length, reusedVerifiedDigest: true };
    }
    const url = `https://uploads.github.com/repos/${REPOSITORY}/releases/${RELEASE_ID}/assets?name=${encodeURIComponent(name)}`;
    const asset = await (await request(url, { method: 'POST', headers: { 'Content-Type': contentType }, body: bytes })).json();
    if (asset.name !== name || asset.size !== bytes.length || (asset.digest && asset.digest !== `sha256:${digest(bytes)}`)) fail('GEN1_EXPORT_UPLOAD_RECEIPT_MISMATCH');
    return { name, sha256: digest(bytes), bytes: bytes.length, assetId: asset.id };
  }
  const uploaded = [await upload(`gen1-ci-bundle-${sha}.tar.gz`, bundle, 'application/gzip')];
  if (eligible) {
    uploaded.push(await upload(filename, archive, 'application/gzip'));
    uploaded.push(await upload('SHA256SUMS', files.get('ubuntu/assets/SHA256SUMS'), 'text/plain'));
    uploaded.push(await upload('BUILD-RECEIPT.json', files.get('ubuntu/assets/BUILD-RECEIPT.json'), 'application/json'));
  }
  return { ...receipt, uploaded };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  exportDraft().then(result => console.log(JSON.stringify(result, null, 2))).catch(error => {
    console.error(error.message); process.exitCode = 1;
  });
}
