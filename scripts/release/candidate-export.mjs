// Transfers the exact qualified CI archive; this entry cannot create or publish a release.
import { readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { digest, verifyPortable } from './portable-lib.mjs';
import { verifyArchive } from './portable.mjs';

const repository = 'ki11a-Conton/harness-agent';
const version = '1.10.0';
const sha = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
const sourceTree = execFileSync('git', ['rev-parse', 'HEAD^{tree}'], { encoding: 'utf8' }).trim();
const runId = process.env.CANDIDATE_ACCEPTANCE_RUN_ID;
const releaseId = process.env.CANDIDATE_RELEASE_ID;
if (process.env.GITHUB_REPOSITORY !== repository || process.env.GITHUB_EVENT_NAME !== 'workflow_dispatch'
  || process.env.GITHUB_REF !== 'refs/heads/main' || process.env.GITHUB_SHA !== sha
  || !/^[a-f0-9]{40}$/.test(sha) || !/^\d{1,20}$/.test(runId ?? '') || !/^\d{1,20}$/.test(releaseId ?? '')
  || !process.env.GITHUB_TOKEN) throw new Error('CANDIDATE_EXPORT_CONTEXT_REJECTED');
const api = `https://api.github.com/repos/${repository}`;
async function request(url, options = {}) {
  const response = await fetch(url, { ...options, redirect: 'error', signal: AbortSignal.timeout(120_000),
    headers: { Accept: 'application/vnd.github+json', ...options.headers, Authorization: `Bearer ${process.env.GITHUB_TOKEN}` } });
  if (!response.ok) throw new Error(`CANDIDATE_EXPORT_HTTP_${response.status}`);
  return response;
}
const run = await (await request(`${api}/actions/runs/${runId}`)).json();
if (run.head_sha !== sha || run.head_branch !== 'main' || run.status !== 'completed' || run.conclusion !== 'success'
  || run.path !== '.github/workflows/deepseek-ui-installed.yml') throw new Error('CANDIDATE_ACCEPTANCE_RUN_REJECTED');
const jobs = await (await request(`${api}/actions/runs/${runId}/jobs?per_page=100`)).json();
for (const name of ['archive', 'installed (ubuntu-latest)', 'installed (windows-latest)']) {
  const matches = jobs.jobs.filter(job => job.name === name);
  if (matches.length !== 1 || matches[0].status !== 'completed' || matches[0].conclusion !== 'success') throw new Error('CANDIDATE_REQUIRED_JOB_REJECTED');
}
const release = await (await request(`${api}/releases/${releaseId}`)).json();
if (String(release.id) !== releaseId || release.tag_name !== `v${version}` || release.draft !== true
  || release.target_commitish !== sha) throw new Error('CANDIDATE_EXISTING_DRAFT_SOURCE_REQUIRED');
const base = resolve('.ci/candidate');
const filename = `harness-agent-${version}-portable.tar.gz`;
const archive = await readFile(join(base, 'assets', filename));
if (archive.length > 64 * 1024 * 1024) throw new Error('CANDIDATE_ARCHIVE_TOO_LARGE');
const archiveSha256 = digest(archive);
const checksums = await readFile(join(base, 'assets', 'SHA256SUMS'));
if (!checksums.toString('utf8').split('\n').includes(`${archiveSha256}  ${filename}`)) throw new Error('CANDIDATE_ARCHIVE_CHECKSUM_REJECTED');
const { root, manifest } = await verifyArchive({ archive: join(base, 'assets', filename), out: join(base, 'verified'), version, sourceSha: sha });
if (manifest.sourceTree !== sourceTree) throw new Error('CANDIDATE_SOURCE_TREE_REJECTED');
await verifyPortable(root, { version, sourceSha: sha });
const buildBytes = await readFile(join(base, 'assets', 'BUILD-RECEIPT.json'));
const build = JSON.parse(buildBytes);
if (build.version !== version || build.sourceSha !== sha || build.sourceTree !== sourceTree || build.filename !== filename
  || build.sha256 !== archiveSha256) throw new Error('CANDIDATE_BUILD_RECEIPT_REJECTED');
const installed = {};
for (const [name, platform, kind] of [
  ['web-linux', 'linux', 'harness-official-ui-installed'], ['web-windows', 'win32', 'harness-official-ui-installed'],
  ['cli-linux', 'linux', 'harness-agent-portable-cleanroom'], ['cli-windows', 'win32', 'harness-agent-portable-cleanroom'],
]) {
  const receipt = JSON.parse(await readFile(join(base, name, 'result.json'), 'utf8'));
  if (receipt.status !== 'PASS' || receipt.kind !== kind || receipt.platform !== platform || receipt.version !== version
    || receipt.sourceSha !== sha || receipt.sourceTree !== manifest.sourceTree || receipt.archiveSha256 !== archiveSha256
    || receipt.workspaceLinks !== 0 || receipt.paidModelCalls !== 0) throw new Error('CANDIDATE_INSTALLED_RECEIPT_REJECTED');
  if (name.startsWith('cli') && (receipt.doctorErrors !== 0 || receipt.tamperRejected !== true || receipt.tamperedStartupRejected !== true
    || !(receipt.codingAssertions > 0))) throw new Error('CANDIDATE_CLI_CONTROLS_REJECTED');
  if (name.startsWith('web') && (receipt.installedApplication !== true || receipt.cases !== 30 || !(receipt.assertions > 0))) throw new Error('CANDIDATE_WEB_CONTROLS_REJECTED');
  installed[name] = receipt;
}
const evidence = Buffer.from(JSON.stringify({ schemaVersion: 1, status: 'ACCEPTED_NOT_PUBLISHED', version, sourceSha: sha,
  sourceTree: manifest.sourceTree, archiveSha256, acceptanceRunId: runId, run, jobs, installed, paidModelCalls: 0, realModelQuality: 'NOT_PROVEN' }, null, 2) + '\n');
const assets = new Map([[filename, archive], ['SHA256SUMS', checksums],
  ['BUILD-RECEIPT.json', buildBytes], ['SOURCE-ACCEPTANCE.json', evidence]]);
const uploaded = [];
for (const [name, bytes] of assets) {
  const existing = release.assets.find(asset => asset.name === name);
  if (existing) {
    if (existing.digest !== `sha256:${digest(bytes)}` || existing.size !== bytes.length) throw new Error('CANDIDATE_EXISTING_ASSET_DIFFERS');
    uploaded.push({ name, id: existing.id, bytes: bytes.length, sha256: digest(bytes), reused: true });
    continue;
  }
  const asset = await (await request(`https://uploads.github.com/repos/${repository}/releases/${releaseId}/assets?name=${encodeURIComponent(name)}`,
    { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: bytes })).json();
  if (asset.name !== name || asset.size !== bytes.length || asset.digest !== `sha256:${digest(bytes)}`) throw new Error('CANDIDATE_UPLOADED_ASSET_REJECTED');
  uploaded.push({ name, id: asset.id, bytes: bytes.length, sha256: digest(bytes) });
}
const receipt = { status: 'EXPORTED_TO_EXISTING_DRAFT', version, sourceSha: sha, archiveSha256, releaseId, uploaded, published: false };
await writeFile(join(base, 'export-result.json'), JSON.stringify(receipt, null, 2) + '\n');
console.log(`::notice title=Qualified candidate export::${JSON.stringify(receipt)}`);
