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
const version = '1.10.0';
async function scenario(change, expected) {
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
        installedApplication: true, cases: 30, assertions: 75, doctorErrors: 0, tamperRejected: true, tamperedStartupRejected: true, codingAssertions: 50 }));
    }
    const fixture = { run: { head_sha: sha, head_branch: 'main', status: 'completed', conclusion: 'success', path: '.github/workflows/deepseek-ui-installed.yml' },
      jobs: { jobs: ['archive', 'installed (ubuntu-latest)', 'installed (windows-latest)'].map(name => ({ name, status: 'completed', conclusion: 'success' })) },
      release: { id: 2, tag_name: `v${version}`, draft: true, target_commitish: sha, assets: [] } };
    await change?.({ root, base, fixture });
    await writeFile(join(root, 'responses.json'), JSON.stringify(fixture));
    await writeFile(join(root, 'mock.mjs'), `
import {readFileSync,appendFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
const f=JSON.parse(readFileSync('responses.json','utf8'));
globalThis.fetch=async (url,options)=>{
 const path=new URL(url).pathname;
 appendFileSync('requests.json',JSON.stringify({url,method:options.method??'GET'})+'\\n');
 if(path.endsWith('/actions/runs/1'))return Response.json(f.run);
 if(path.endsWith('/actions/runs/1/jobs'))return Response.json(f.jobs);
 if(path.endsWith('/releases/2'))return Response.json(f.release);
 if(new URL(url).hostname==='uploads.github.com'&&options.method==='POST')return Response.json({id:3,name:new URL(url).searchParams.get('name'),size:options.body.length,digest:'sha256:'+createHash('sha256').update(options.body).digest('hex')});
 throw new Error('Unexpected network request');
};
`);
    const result = spawnSync(process.execPath, ['--import', join(root, 'mock.mjs'), script], { cwd: root, encoding: 'utf8',
      env: { ...process.env, GITHUB_REPOSITORY: repository, GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_REF: 'refs/heads/main',
        GITHUB_SHA: sha, GITHUB_TOKEN: 'unit-test-only', CANDIDATE_ACCEPTANCE_RUN_ID: '1', CANDIDATE_RELEASE_ID: '2' } });
    const requests = (await readFile(join(root, 'requests.json'), 'utf8')).trim().split('\n').map(JSON.parse);
    const uploads = requests.filter(r => r.method === 'POST');
    if (expected) { assert.equal(result.status, 1); assert.match(result.stderr, expected); assert.equal(uploads.length, 0); }
    else {
      assert.equal(result.status, 0, result.stderr); assert.equal(uploads.length, 4);
      assert.ok(requests.every(r => ['GET', 'POST'].includes(r.method)));
      const receipt = JSON.parse(await readFile(join(base, 'export-result.json'), 'utf8'));
      assert.equal(receipt.published, false); assert.equal(receipt.archiveSha256, hash);
    }
  } finally { await rm(root, { recursive: true, force: true }); }
}

test('exports exact qualified bytes to the existing draft without publishing', () => scenario());
test('rejects a published release before any upload', () => scenario(({ fixture }) => { fixture.release.draft = false; }, /EXISTING_DRAFT_SOURCE_REQUIRED/));
test('rejects a failed Windows job despite passing local receipts', () => scenario(({ fixture }) => { fixture.jobs.jobs[2].conclusion = 'failure'; }, /REQUIRED_JOB_REJECTED/));
test('rejects Windows receipts from different archive bytes', () => scenario(async ({ base }) => {
  const path = join(base, 'cli-windows/result.json'); const receipt = JSON.parse(await readFile(path, 'utf8')); receipt.archiveSha256 = '0'.repeat(64); await writeFile(path, JSON.stringify(receipt));
}, /INSTALLED_RECEIPT_REJECTED/));
test('rejects tampered archive bytes before any upload', () => scenario(async ({ base }) => {
  await writeFile(join(base, `assets/harness-agent-${version}-portable.tar.gz`), 'altered');
}, /ARCHIVE_CHECKSUM_REJECTED/));
