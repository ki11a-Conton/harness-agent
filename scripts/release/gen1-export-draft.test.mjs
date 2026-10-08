import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdir, mkdtemp, readFile, rm, symlink, truncate, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { gunzipSync } from 'node:zlib';
import { digest } from './portable-lib.mjs';
import { exportDraft } from './gen1-export-draft.mjs';

const SHA = 'a'.repeat(40);
const TREE = 'b'.repeat(40);
const ENV = { GITHUB_REPOSITORY: 'ki11a-Conton/harness-agent', GITHUB_REF: 'refs/heads/validation/gen1-export', GITHUB_SHA: SHA,
  GITHUB_RUN_ID: '123456', GITHUB_RUN_ATTEMPT: '1', GITHUB_TOKEN: 'unit-test-only-never-network' };
const NAMES = ['portable unit/security', 'real multi-turn interaction', 'actual product host ownership', 'fixed-source portable build', 'installed coding and tamper controls'];
const ARCHIVE = 'harness-agent-1.9.0-portable.tar.gz';
async function temporary(fn) {
  const root = await mkdtemp(join(tmpdir(), 'gen1-draft-export-'));
  try { await fn(root); } finally { await rm(root, { recursive: true, force: true }); }
}
async function put(root, path, document) {
  await mkdir(join(root, path, '..'), { recursive: true });
  await writeFile(join(root, path), Buffer.isBuffer(document) ? document : JSON.stringify(document));
}
async function fixture(root) {
  for (const [origin, platform] of [['ubuntu', 'linux'], ['windows', 'win32']]) {
    await put(root, `${origin}/result.json`, { status: 'PASS', sourceSha: SHA, platform, paidModelCalls: 0, realModelQuality: 'NOT_PROVEN',
      steps: NAMES.map(name => ({ name, exitCode: 0, error: null })) });
    const bytes = Buffer.from(`${origin}-archive-bytes`); const hash = digest(bytes);
    await put(root, `${origin}/assets/${ARCHIVE}`, bytes);
    await put(root, `${origin}/assets/SHA256SUMS`, Buffer.from(`${hash}  ${ARCHIVE}\n`));
    await put(root, `${origin}/assets/BUILD-RECEIPT.json`, { version: '1.9.0', sourceSha: SHA, sourceTree: TREE, filename: ARCHIVE, sha256: hash });
    await put(root, `${origin}/installed/result.json`, smoke(platform, hash));
  }
  await put(root, 'same-archive-windows/result.json', smoke('win32', digest(Buffer.from('ubuntu-archive-bytes'))));
}
function smoke(platform, archiveSha256) {
  return { schemaVersion: 1, kind: 'harness-agent-portable-cleanroom', status: 'PASS', version: '1.9.0', sourceSha: SHA, sourceTree: TREE,
    platform, archiveSha256, cleanroomOutsideRepository: true, workspaceLinks: 0, doctorErrors: 0, tamperRejected: true,
    tamperedStartupRejected: true, paidModelCalls: 0, realModelQuality: 'NOT_PROVEN', codingAssertions: 10 };
}
function github(overrides = {}) {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    assert.equal(options.redirect, 'error');
    assert.equal(options.headers.Authorization, `Bearer ${ENV.GITHUB_TOKEN}`);
    assert.equal(url.includes(ENV.GITHUB_TOKEN), false);
    if (options.method === 'POST') {
      assert.match(url, /^https:\/\/uploads\.github\.com\/repos\/ki11a-Conton\/harness-agent\/releases\/406478808\/assets\?name=/);
      const name = new URL(url).searchParams.get('name');
      return Response.json({ name, size: options.body.length, digest: `sha256:${digest(options.body)}`, id: 1000 });
    }
    assert.equal(url, 'https://api.github.com/repos/ki11a-Conton/harness-agent/releases/406478808');
    return Response.json({ id: 406478808, tag_name: 'v1.9.0', target_commitish: SHA, draft: true, assets: [], ...overrides });
  };
  return { calls, fetchImpl, writes: () => calls.filter(call => call.options.method === 'POST') };
}

test('exact-source two platforms and same distributed bytes only prepare four existing draft assets', async () => temporary(async root => {
  await fixture(root);const remote = github();const result = await exportDraft({ root, env: ENV, fetchImpl: remote.fetchImpl });
  assert.equal(result.status, 'PASS');assert.equal(result.formalAssetsEligible, true);assert.equal(remote.writes().length, 4);
  assert.deepEqual(result.uploaded.map(item => item.name), [`gen1-ci-bundle-${SHA}.tar.gz`, ARCHIVE, 'SHA256SUMS', 'BUILD-RECEIPT.json']);
  assert.equal(result.runId, ENV.GITHUB_RUN_ID);assert.equal(result.sourceSha, SHA);
  const tar = gunzipSync(remote.writes()[0].options.body);assert.ok(tar.includes(Buffer.from('export-receipt.json')));
  assert.ok(tar.includes(Buffer.from('NOT_PROVEN')));assert.equal(result.files.length, 11);
}));
for (const overrides of [{ draft: false }, { target_commitish: 'main' }, { target_commitish: 'c'.repeat(40) }, { tag_name: 'v2.0.0' }]) {
  test(`refuses non-exact existing draft ${JSON.stringify(overrides)}`, async () => temporary(async root => {
    await fixture(root);const remote=github(overrides);
    await assert.rejects(exportDraft({ root, env: ENV, fetchImpl: remote.fetchImpl }), /EXISTING_DRAFT_SOURCE_REQUIRED/);
    assert.equal(remote.writes().length, 0);
  }));
}
test('main and mismatched repository cannot execute the authorized export', async () => temporary(async root => {
  const remote=github();
  for (const env of [{ ...ENV,GITHUB_REF:'refs/heads/main' },{ ...ENV,GITHUB_REPOSITORY:'other/repository' }]) {
    await assert.rejects(exportDraft({root,env,fetchImpl:remote.fetchImpl}),/CONTEXT_REJECTED/);
  }
  assert.equal(remote.calls.length,0);
}));
for (const [name, mutation] of [
  ['failed stages', { status: 'FAIL' }],
  ['fake PASS with missing stages', { steps: [] }],
  ['wrong source', { sourceSha: 'd'.repeat(40) }],
]) {
  test(`${name} archive diagnostics but never formal assets`, async () => temporary(async root => {
    await fixture(root);const path='windows/result.json';const data=JSON.parse(await readFile(join(root,path),'utf8'));await put(root,path,{...data,...mutation});
    const remote=github();const result=await exportDraft({root,env:ENV,fetchImpl:remote.fetchImpl});
    assert.equal(result.status,'FAIL');assert.equal(result.formalAssetsEligible,false);assert.equal(remote.writes().length,1);
    assert.equal(result.uploaded[0].name,`gen1-ci-bundle-${SHA}.tar.gz`);
  }));
}
test('same-source Windows receipt with different archive hash refuses formal bytes', async () => temporary(async root => {
  await fixture(root);await put(root,'same-archive-windows/result.json',smoke('win32','e'.repeat(64)));
  const remote=github();const result=await exportDraft({root,env:ENV,fetchImpl:remote.fetchImpl});
  assert.equal(result.formalAssetsEligible,false);assert.equal(remote.writes().length,1);
  assert.ok(result.reasons.some(reason=>reason.includes('identical distributed bytes')));
}));
test('failed-only evidence is exportable without an archive or successful installed receipt', async () => temporary(async root => {
  await put(root,'windows/result.json',{status:'FAIL',sourceSha:SHA,platform:'win32',error:'native Windows failed',steps:[{exitCode:1}]});
  const remote=github();const result=await exportDraft({root,env:ENV,fetchImpl:remote.fetchImpl});
  assert.equal(result.status,'FAIL');assert.equal(result.files.length,1);assert.equal(remote.writes().length,1);
}));
test('existing differently hashed asset is never overwritten or deleted', async () => temporary(async root => {
  await fixture(root);const remote=github({assets:[{name:`gen1-ci-bundle-${SHA}.tar.gz`,size:1,digest:'sha256:'+'f'.repeat(64)}]});
  await assert.rejects(exportDraft({root,env:ENV,fetchImpl:remote.fetchImpl}),/EXISTING_ASSET_REFUSED/);assert.equal(remote.writes().length,0);
}));
test('input symlinks are rejected before release writes', async () => temporary(async root => {
  await fixture(root);await symlink(join(root,'ubuntu/result.json'),join(root,'windows/alias.json'));
  const remote=github();await assert.rejects(exportDraft({root,env:ENV,fetchImpl:remote.fetchImpl}),/SYMLINK/);assert.equal(remote.writes().length,0);
}));
test('oversized sparse files fail admission without reading or upload', async () => temporary(async root => {
  await fixture(root);const path=join(root,'ubuntu/oversized');await writeFile(path,'');await truncate(path,64*1024*1024+1);
  const remote=github();await assert.rejects(exportDraft({root,env:ENV,fetchImpl:remote.fetchImpl}),/64MB_LIMIT/);assert.equal(remote.writes().length,0);
}));
test('identical existing asset digests are verified and reused without another upload', async () => temporary(async root => {
  await fixture(root);const first=github();await exportDraft({root,env:ENV,fetchImpl:first.fetchImpl});
  const assets=first.writes().map(call=>({name:new URL(call.url).searchParams.get('name'),size:call.options.body.length,digest:`sha256:${digest(call.options.body)}`}));
  const second=github({assets});const result=await exportDraft({root,env:ENV,fetchImpl:second.fetchImpl});
  assert.equal(second.writes().length,0);assert.ok(result.uploaded.every(asset=>asset.reusedVerifiedDigest===true));
}));
test('publication between bundle and formal asset is detected and cannot upload formal files', async () => temporary(async root => {
  await fixture(root);const remote=github();let posts=0;
  const fetchImpl=async(url,options)=>{
    if(options.method==='POST'){posts++;return remote.fetchImpl(url,options);}
    if(posts>0)return Response.json({id:406478808,tag_name:'v1.9.0',target_commitish:SHA,draft:false,assets:[]});
    return remote.fetchImpl(url,options);
  };
  await assert.rejects(exportDraft({root,env:ENV,fetchImpl}),/EXISTING_DRAFT_SOURCE_REQUIRED/);
  assert.equal(posts,1);assert.equal(remote.writes()[0].url.includes('gen1-ci-bundle-'),true);
}));
