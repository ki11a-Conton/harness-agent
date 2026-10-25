import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { digest, makeArchive } from './portable-lib.mjs';

const script = fileURLToPath(new URL('./candidate-export.mjs', import.meta.url));
const repository = 'ki11a-Conton/harness-agent';
const version = '1.13.0';
const actualCli = Object.fromEntries(await Promise.all(['linux', 'win32'].map(async platform => [platform,
  JSON.parse(await readFile(new URL(`../../docs/evidence/release-v112-platform-20261023/actual-${platform}.json`, import.meta.url), 'utf8')),
])));
async function scenario(change, expected, expectedUploads = expected ? 0 : 4) {
  const root = await mkdtemp(join(tmpdir(), 'qualified-candidate-export-'));
  try {
    await writeFile(join(root, 'README'), 'candidate source\n');
    await writeFile(join(root, '.gitignore'), '.ci\n*.json\n*.mjs\n');
    const git = args => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    git(['init']); git(['add', 'README', '.gitignore']);
    git(['-c', 'user.name=Candidate Test', '-c', 'user.email=candidate-test@example.invalid', 'commit', '-m', 'fixture']);
    const sha = git(['rev-parse', 'HEAD']), tree = git(['rev-parse', 'HEAD^{tree}']);
    const base = join(root, '.ci/candidate'); await mkdir(join(base, 'assets'), { recursive: true });
    const paths = ['agent.mjs', 'node_modules/@ar/cli/dist/main.js', 'node_modules/@ar/web/dist/main.js', 'node_modules/@ar/web/public/index.html', 'PROJECT-LICENSE-NOTICE.txt'];
    const files = paths.map(path => ({ path, bytes: Buffer.byteLength(path), sha256: digest(Buffer.from(path)), mode: 0o644 }));
    const manifest = { schemaVersion: 2, kind: 'harness-agent-portable', version, sourceSha: sha, sourceTree: tree, files };
    const filename = `harness-agent-${version}-portable.tar.gz`;
    const archive = makeArchive([...paths.map(path => ({ path: `harness-agent-${version}/${path}`, bytes: Buffer.from(path), mode: 0o644 })),
      { path: `harness-agent-${version}/PORTABLE-MANIFEST.json`, bytes: Buffer.from(JSON.stringify(manifest)), mode: 0o644 }]);
    const hash = digest(archive);
    await writeFile(join(base, 'assets', filename), archive);
    await writeFile(join(base, 'assets/SHA256SUMS'), `${hash}  ${filename}\n`);
    await writeFile(join(base, 'assets/BUILD-RECEIPT.json'), JSON.stringify({ version, sourceSha: sha, sourceTree: tree, filename, sha256: hash }));
    for (const [name, platform] of [['web-linux', 'linux'], ['web-windows', 'win32'], ['cli-linux', 'linux'], ['cli-windows', 'win32']]) {
      await mkdir(join(base, name));
      await writeFile(join(base, name, 'result.json'), JSON.stringify({ status: 'PASS', version, sourceSha: sha, sourceTree: tree,
        archiveSha256: hash, platform, workspaceLinks: 0, paidModelCalls: 0,
        kind: name.startsWith('web') ? 'harness-official-ui-installed' : 'harness-agent-portable-cleanroom',
        ...name.startsWith('web') ? { installedApplication: true, cases: 30, assertions: 75,
          pr15Controls: 10, dailyScenarios: 42, dailyAssertions: 120, connectionScenarios: 2, connectionAssertions: 10,
          workspaceKeyboardScenarios: 3, workspaceKeyboardAssertions: 45, modelReasoningChecks: 22,
          composerModeChecks: 24, managedCommandChecks: 9 }
          : { doctorErrors: 0, tamperRejected: true, tamperedStartupRejected: true,
            codingAssertions: actualCli[platform].assertions.length, requests: actualCli[platform].requests,
            cleanroomOutsideRepository: true } }));
    }
    const fixture = { run: { head_sha: sha, head_branch: 'main', status: 'completed', conclusion: 'success', path: '.github/workflows/deepseek-ui-installed.yml' },
      jobs: { jobs: ['archive', 'installed (ubuntu-24.04)', 'installed (windows-latest)'].map(name => ({ name, status: 'completed', conclusion: 'success' })) },
      release: { id: 2, tag_name: `v${version}`, draft: true, target_commitish: sha, assets: [] } };
    await change?.({ root, base, fixture });
    await writeFile(join(root, 'responses.json'), JSON.stringify(fixture));
    await writeFile(join(root, 'mock.mjs'), `
import {readFileSync,appendFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
const f=JSON.parse(readFileSync('responses.json','utf8'));
let uploads=0;
globalThis.fetch=async (url,options)=>{
 const path=new URL(url).pathname;
 appendFileSync('requests.json',JSON.stringify({url,method:options.method??'GET'})+'\\n');
 if(path.endsWith('/actions/runs/1'))return Response.json(f.run);
 if(path.endsWith('/actions/runs/1/jobs'))return Response.json(f.jobs);
 if(path.endsWith('/releases/2'))return Response.json(uploads>0&&f.releaseAfterFirstUpload?f.releaseAfterFirstUpload:f.release);
 if(new URL(url).hostname==='uploads.github.com'&&options.method==='POST'){
  uploads++;
  return Response.json({id:3,name:new URL(url).searchParams.get('name'),size:options.body.length,digest:'sha256:'+createHash('sha256').update(options.body).digest('hex')});
 }
 throw new Error('Unexpected network request');
};
`);
    const result = spawnSync(process.execPath, ['--import', join(root, 'mock.mjs'), script], { cwd: root, encoding: 'utf8',
      env: { ...process.env, GITHUB_REPOSITORY: repository, GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_REF: 'refs/heads/main',
        GITHUB_SHA: sha, GITHUB_TOKEN: 'unit-test-only', CANDIDATE_ACCEPTANCE_RUN_ID: '1', CANDIDATE_RELEASE_ID: '2' } });
    const requests = (await readFile(join(root, 'requests.json'), 'utf8')).trim().split('\n').map(JSON.parse);
    const uploads = requests.filter(r => r.method === 'POST');
    if (expected) {
      assert.equal(result.status, 1, JSON.stringify({ exitCode: result.status, uploads: uploads.length,
        names: uploads.map(request => new URL(request.url).searchParams.get('name')) }));
      assert.match(result.stderr, expected); assert.equal(uploads.length, expectedUploads);
    }
    else {
      assert.equal(result.status, 0, result.stderr); assert.equal(uploads.length, expectedUploads);
      assert.ok(requests.every(r => ['GET', 'POST'].includes(r.method)));
      const receipt = JSON.parse(await readFile(join(base, 'export-result.json'), 'utf8'));
      assert.equal(receipt.published, false); assert.equal(receipt.archiveSha256, hash);
    }
  } finally { await rm(root, { recursive: true, force: true }); }
}

test('exports exact qualified bytes to the existing draft without publishing', () => scenario());
test('accepts the actual Windows 49-assertion 18-request coding receipt', async () => {
  const windows = actualCli.win32;
  assert.equal(windows.status, 'PASS');
  assert.equal(windows.platform, 'win32');
  assert.equal(windows.sourceSha, 'b1c4c982d4c3a7bc7270815b90a3a91267045f22');
  assert.equal(windows.assertions.length, 49);
  assert.equal(windows.requests, 18);
  assert.deepEqual(windows.skipped, ['POSIX SIGINT CLI case; native Windows tree cancellation is exercised by windows-acceptance regressions']);
  await scenario();
});
test('rejects a published release before any upload', () => scenario(({ fixture }) => { fixture.release.draft = false; }, /EXISTING_DRAFT_SOURCE_REQUIRED/));
test('rejects the historical v1.11.0 tag before any upload', () => scenario(({ fixture }) => { fixture.release.tag_name = 'v1.11.0'; }, /EXISTING_DRAFT_SOURCE_REQUIRED/));
test('stops before another upload if the draft is published after the first asset', () => scenario(({ fixture }) => {
  fixture.releaseAfterFirstUpload = { ...fixture.release, draft: false };
}, /EXISTING_DRAFT_SOURCE_REQUIRED/, 1));
test('stops before another upload if the draft source changes after the first asset', () => scenario(({ fixture }) => {
  fixture.releaseAfterFirstUpload = { ...fixture.release, target_commitish: '0'.repeat(40) };
}, /EXISTING_DRAFT_SOURCE_REQUIRED/, 1));
test('rejects an incompatible next asset that appears after the first upload', () => scenario(({ fixture }) => {
  fixture.releaseAfterFirstUpload = { ...fixture.release,
    assets: [{ id: 99, name: 'SHA256SUMS', size: 1, digest: 'sha256:' + '0'.repeat(64) }] };
}, /EXISTING_ASSET_DIFFERS/, 1));
test('reuses a matching next asset that appears after the first upload', () => scenario(async ({ base, fixture }) => {
  const bytes = await readFile(join(base, 'assets/SHA256SUMS'));
  fixture.releaseAfterFirstUpload = { ...fixture.release,
    assets: [{ id: 99, name: 'SHA256SUMS', size: bytes.length, digest: 'sha256:' + digest(bytes) }] };
}, undefined, 3));
test('rejects a failed Windows job despite passing local receipts', () => scenario(({ fixture }) => { fixture.jobs.jobs[2].conclusion = 'failure'; }, /REQUIRED_JOB_REJECTED/));
test('rejects Windows receipts from different archive bytes', () => scenario(async ({ base }) => {
  const path = join(base, 'cli-windows/result.json'); const receipt = JSON.parse(await readFile(path, 'utf8')); receipt.archiveSha256 = '0'.repeat(64); await writeFile(path, JSON.stringify(receipt));
}, /INSTALLED_RECEIPT_REJECTED/));
for (const [field, value] of [['assertions', 74], ['pr15Controls', 9], ['dailyScenarios', 41],
  ['dailyAssertions', 119], ['connectionScenarios', 1], ['connectionAssertions', 9], ['assertions', '75'], ['workspaceKeyboardScenarios', 2],
  ['workspaceKeyboardAssertions', 44], ['modelReasoningChecks', 21], ['composerModeChecks', 23],
  ['managedCommandChecks', 8], ['managedCommandChecks', '9']]) {
  test(`rejects incomplete or nonnumeric Web evidence: ${field}=${JSON.stringify(value)}`, () => scenario(async ({ base }) => {
    const path = join(base, 'web-windows/result.json');
    const receipt = JSON.parse(await readFile(path, 'utf8')); receipt[field] = value;
    await writeFile(path, JSON.stringify(receipt));
  }, /WEB_CONTROLS_REJECTED/));
}
for (const [name, field, value] of [
  ['cli-linux', 'codingAssertions', 49], ['cli-linux', 'requests', 18],
  ['cli-windows', 'codingAssertions', 48], ['cli-windows', 'requests', 17],
  ['cli-windows', 'cleanroomOutsideRepository', false], ['cli-windows', 'requests', '18'],
  ['cli-windows', 'codingAssertions', 49.5], ['cli-windows', 'requests', true],
  ['cli-windows', 'requests', Number.MAX_SAFE_INTEGER + 1],
]) {
  test(`rejects incomplete or nonnumeric ${name} evidence: ${field}=${JSON.stringify(value)}`, () => scenario(async ({ base }) => {
    const path = join(base, name, 'result.json');
    const receipt = JSON.parse(await readFile(path, 'utf8')); receipt[field] = value;
    await writeFile(path, JSON.stringify(receipt));
  }, /CLI_CONTROLS_REJECTED/));
}
test('rejects tampered archive bytes before any upload', () => scenario(async ({ base }) => {
  await writeFile(join(base, `assets/harness-agent-${version}-portable.tar.gz`), 'altered');
}, /ARCHIVE_CHECKSUM_REJECTED/));

// v1.12 artifacts and the previous runner label cannot qualify this release.
test('rejects the previous v1.12.0 release before any upload', () => scenario(({ fixture }) => {
  fixture.release.tag_name = 'v1.12.0';
}, /EXISTING_DRAFT_SOURCE_REQUIRED/));
test('rejects stale Ubuntu job naming instead of exporting unrelated receipts', () => scenario(({ fixture }) => {
  fixture.jobs.jobs[1].name = 'installed (ubuntu-latest)';
}, /REQUIRED_JOB_REJECTED/));
