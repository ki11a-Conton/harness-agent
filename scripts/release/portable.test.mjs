import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { gunzipSync, gzipSync } from 'node:zlib';
import { digest, extractArchive, makeArchive, MAX_PORTABLE_UNCOMPRESSED_BYTES, safePath, verifyPortable } from './portable-lib.mjs';
import { canonicalPayloadModes, copyPackageNotices, copyReviewedExternalNotice, rebuildReviewedNativeDependencies, REVIEWED_NODE_PTY, run, sourceSnapshot, verifyPinnedBuildTools, workspacePackages } from './portable.mjs';

async function temporary(body) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'harness-portable-test-')));
  try { await body(directory); } finally { await rm(directory, { recursive: true, force: true }); }
}
async function workspaceFixture(dir) {
  await writeFile(join(dir, 'package.json'), JSON.stringify({ name: 'portable-fixture', version: '1.0.0', private: true }));
  await writeFile(join(dir, 'pnpm-workspace.yaml'), 'packages:\n  - "apps/*"\n  - "packages/*"\n');
  await writeFile(join(dir, 'tsconfig.json'), JSON.stringify({ references: [{ path: './apps/cli' }] }));
  for (const [path, metadata] of [
    ['apps/cli', { name: '@ar/cli', version: '0.1.0', dependencies: { '@ar/store': 'workspace:*' } }],
    ['packages/store', { name: '@ar/store', version: '0.1.0', dependencies: { '@ar/contracts': 'workspace:*' } }],
    ['packages/contracts', { name: '@ar/contracts', version: '0.1.0' }],
    ['packages/orchestration', { name: '@ar/orchestration', version: '0.1.0', dependencies: { '@ar/contracts': 'workspace:*' } }],
  ]) {
    await mkdir(join(dir, path), { recursive: true });
    await writeFile(join(dir, path, 'package.json'), JSON.stringify(metadata));
    await writeFile(join(dir, path, 'tsconfig.json'), JSON.stringify({ compilerOptions: { composite: true }, files: [] }));
  }
}
test('portable enumerates the actual workspace, including indirect and unreferenced packages', async () => temporary(async dir => {
  await workspaceFixture(dir);
  const packages = await workspacePackages(dir);
  assert.deepEqual(packages.map(pkg => pkg.metadata.name).sort(), ['@ar/cli', '@ar/contracts', '@ar/orchestration', '@ar/store']);
  assert.ok(packages.every(pkg => pkg.directory.startsWith(dir)));
}));
test('workspace identity accepts a root alias and excludes the physical workspace root', async () => temporary(async dir => {
  const root = join(dir, 'real-source'); const alias = join(dir, 'source-alias');
  await mkdir(root); await workspaceFixture(root);
  await symlink(root, alias, process.platform === 'win32' ? 'junction' : 'dir');
  assert.deepEqual((await workspacePackages(alias)).map(pkg => pkg.metadata.name), ['@ar/cli', '@ar/contracts', '@ar/orchestration', '@ar/store']);
}));
test('workspace inventory rejects packages physically outside the pinned source', async () => temporary(async dir => {
  const root = join(dir, 'source'); const outside = join(dir, 'outside/escape');
  await mkdir(root); await workspaceFixture(root); await mkdir(outside, { recursive: true });
  await writeFile(join(outside, 'package.json'), JSON.stringify({ name: '@ar/escape', version: '0.1.0' }));
  await writeFile(join(outside, 'tsconfig.json'), '{}');
  await writeFile(join(root, 'pnpm-workspace.yaml'), 'packages:\n  - "apps/*"\n  - "packages/*"\n  - "../outside/*"\n');
  await assert.rejects(workspacePackages(root), /outside pinned source/);
}));
test('linked production workspace dependencies cannot enter the portable payload', async () => temporary(async dir => {
  await workspaceFixture(dir); const linked = join(dir, 'excluded/linked');
  await mkdir(linked, { recursive: true });
  await writeFile(join(linked, 'package.json'), JSON.stringify({ name: '@ar/linked', version: '0.1.0' }));
  await writeFile(join(linked, 'tsconfig.json'), '{}');
  await symlink(linked, join(dir, 'packages/linked'), process.platform === 'win32' ? 'junction' : 'dir');
  await writeFile(join(dir, 'apps/cli/package.json'), JSON.stringify({ name: '@ar/cli', version: '0.1.0', dependencies: { '@ar/linked': 'workspace:*' } }));
  await assert.rejects(workspacePackages(dir), /symlink|unresolved workspace dependency.*@ar\/linked/);
}));
test('portable rejects missing production workspace dependencies and duplicate package names', async () => temporary(async dir => {
  await workspaceFixture(dir);
  await writeFile(join(dir, 'apps/cli/package.json'), JSON.stringify({ name: '@ar/cli', version: '0.1.0', dependencies: { '@ar/missing': 'workspace:*' } }));
  await assert.rejects(workspacePackages(dir), /unresolved workspace dependency.*@ar\/missing/);
  await writeFile(join(dir, 'apps/cli/package.json'), JSON.stringify({ name: '@ar/store', version: '0.1.0' }));
  await assert.rejects(workspacePackages(dir), /duplicate workspace package.*@ar\/store/);
}));
test('package-local adapted-source licenses and root notices ship byte for byte', async () => temporary(async dir => {
  const source = join(dir, 'source'); const target = join(dir, 'installed'); await mkdir(join(source, 'licenses'), { recursive: true });
  const mit = Buffer.from('MIT License\r\nCopyright (c) 2026 DeepSeek\r\n');
  await writeFile(join(source, 'licenses/deepseek-harness-MIT.txt'), mit);
  await writeFile(join(source, 'LICENSE'), 'project license'); await writeFile(join(source, 'NOTICE.txt'), 'source attribution');
  await copyPackageNotices(source, target);
  assert.deepEqual(await readFile(join(target, 'licenses/deepseek-harness-MIT.txt')), mit);
  assert.equal(await readFile(join(target, 'LICENSE'), 'utf8'), 'project license');
  assert.equal(await readFile(join(target, 'NOTICE.txt'), 'utf8'), 'source attribution');
  const empty = join(dir, 'no-notices'); await mkdir(empty); await copyPackageNotices(empty, join(dir, 'empty-target'));
}));
test('archive round trip preserves exact binary bytes with deterministic output', async () => temporary(async dir => {
  const entries = [{ path: 'harness-agent-1.9.0/nested/content.txt', bytes: Buffer.from([0, 255, 10, 13, 195, 169]) }];
  const first = makeArchive(entries); assert.deepEqual(makeArchive(entries), first);
  const root = await extractArchive(first, join(dir, 'out'));
  assert.deepEqual(await readFile(join(root, 'nested/content.txt')), entries[0].bytes);
}));
test('exact reviewed xterm packages receive the original pinned MIT notice; no generic license fallback', async () => temporary(async dir => {
  await mkdir(join(dir, 'third_party'));
  // Git's native Windows checkout can use CRLF. The actual sourceSnapshot
  // reads Git blobs, whose pinned upstream license bytes remain LF. Model
  // those snapshot bytes here instead of the checkout's materialization.
  const notice = Buffer.from((await readFile(new URL('../../third_party/xtermjs-MIT.txt', import.meta.url), 'utf8')).replace(/\r\n/g, '\n'));
  await writeFile(join(dir, 'third_party/xtermjs-MIT.txt'), notice);
  const target = join(dir, 'installed');
  for (const [name, version] of [['@xterm/headless', '6.0.0'], ['@xterm/addon-serialize', '0.14.0']]) {
    const metadata = { name, version, license: 'MIT', commit: 'f447274f430fd22513f6adbf9862d19524471c04' };
    await copyReviewedExternalNotice(name, metadata, dir, target);
    assert.deepEqual(await readFile(join(target, 'LICENSE.xtermjs-MIT.txt')), notice);
    for (const change of [{ version: '999.0.0' }, { commit: 'unknown' }, { license: 'UNKNOWN' }, { name: 'unreviewed' }]) {
      await assert.rejects(copyReviewedExternalNotice(name, { ...metadata, ...change }, dir, target), /external license missing/);
    }
  }
  await assert.rejects(copyReviewedExternalNotice('unreviewed', { name: 'unreviewed', license: 'MIT' }, dir, target), /external license missing/);
  await writeFile(join(dir, 'third_party/xtermjs-MIT.txt'), 'tampered');
  await assert.rejects(copyReviewedExternalNotice('@xterm/headless', { name: '@xterm/headless', version: '6.0.0', license: 'MIT', commit: 'f447274f430fd22513f6adbf9862d19524471c04' }, dir, target), /digest mismatch/);
}));
test('traversal, absolute paths, Windows separators and duplicate case paths are rejected', () => {
  for (const path of ['../x', '/tmp/x', 'a/../x', 'C:/x', 'a\\x', 'a//x', 'a/./x', 'CON.txt', 'a/NUL', 'a/trailing.']) assert.throws(() => safePath(path), /unsafe/);
  assert.throws(() => makeArchive([{ path: 'harness-agent-1.9.0/a', bytes: Buffer.alloc(0) }, { path: 'harness-agent-1.9.0/A', bytes: Buffer.alloc(0) }]), /duplicate/);
  assert.throws(() => makeArchive([{ path: 'harness-agent-1.9.0/a', bytes: Buffer.alloc(0) }, { path: 'harness-agent-1.9.0/a/b', bytes: Buffer.alloc(0) }]), /collision/);
  assert.throws(() => makeArchive([{ path: 'harness-agent-1.9.0/a/b', bytes: Buffer.alloc(0) }, { path: 'harness-agent-1.9.0/a', bytes: Buffer.alloc(0) }]), /collision/);
});
test('bad tar checksums, symlink entries and missing terminators are rejected before writes', async () => temporary(async dir => {
  const raw = gunzipSync(makeArchive([{ path: 'harness-agent-1.9.0/a', bytes: Buffer.from('x') }]));
  const corrupt = Buffer.from(raw); corrupt[2] ^= 1;
  await assert.rejects(extractArchive(gzipSync(corrupt), join(dir, 'checksum')), /corrupt/);
  const link = Buffer.from(raw); link[156] = 50; link.fill(32, 148, 156);
  const sum = link.subarray(0, 512).reduce((a, b) => a + b, 0); link.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 8);
  await assert.rejects(extractArchive(gzipSync(link), join(dir, 'link')), /unsupported/);
  await assert.rejects(extractArchive(gzipSync(raw.subarray(0, raw.length - 1024)), join(dir, 'truncated')), /truncated/);
}));
test('extraction never overwrites an existing consumer directory', async () => temporary(async dir => {
  await writeFile(join(dir, 'keep.txt'), 'keep');
  await assert.rejects(extractArchive(makeArchive([{ path: 'harness-agent-1.9.0/a', bytes: Buffer.from('x') }]), dir), /empty/);
  assert.equal(await readFile(join(dir, 'keep.txt'), 'utf8'), 'keep');
}));
test('extraction still rejects a link destination and links in its parent path before file writes', async () => temporary(async dir => {
  const physical = join(dir, 'physical'); const alias = join(dir, 'alias');
  await mkdir(physical); await symlink(physical, alias, process.platform === 'win32' ? 'junction' : 'dir');
  const archive = makeArchive([{ path: 'harness-agent-1.9.0/a', bytes: Buffer.from('x') }]);
  await assert.rejects(extractArchive(archive, alias), /empty real directory/);
  assert.deepEqual(await readdir(physical), []);
  await assert.rejects(extractArchive(archive, join(alias, 'nested')), /empty real directory/);
  assert.deepEqual(await readdir(join(physical, 'nested')), []);
}));
async function payload(dir) {
  const paths = ['agent.mjs', 'node_modules/@ar/cli/dist/main.js', 'node_modules/@ar/web/dist/main.js', 'node_modules/@ar/web/public/index.html', 'PROJECT-LICENSE-NOTICE.txt'];
  for (const path of paths) { await mkdir(join(dir, path, '..'), { recursive: true }); await writeFile(join(dir, path), path); }
  const manifest = { schemaVersion: 1, kind: 'harness-agent-portable', version: '1.9.0', sourceSha: 'a'.repeat(40), sourceTree: 'b'.repeat(40), files: paths.map(path => ({ path, bytes: Buffer.byteLength(path), sha256: digest(Buffer.from(path)) })) };
  await writeFile(join(dir, 'PORTABLE-MANIFEST.json'), JSON.stringify(manifest)); return manifest;
}
test('manifest binds every file, exact version and source, and rejects extra files', async () => temporary(async dir => {
  await payload(dir); await verifyPortable(dir, { version: '1.9.0', sourceSha: 'a'.repeat(40) });
  await assert.rejects(verifyPortable(dir, { sourceSha: 'c'.repeat(40) }), /sourceSha mismatch/);
  await assert.rejects(verifyPortable(dir, { version: '1.8.0' }), /version mismatch/);
  await writeFile(join(dir, 'agent.mjs'), 'tampered'); await assert.rejects(verifyPortable(dir), /digest mismatch/);
  await writeFile(join(dir, 'agent.mjs'), 'agent.mjs'); await writeFile(join(dir, 'extra.txt'), 'extra');
  await assert.rejects(verifyPortable(dir), /undeclared/);
}));
test('duplicate manifest paths and parent directory links cannot stand in for payload files', async () => temporary(async dir => {
  const manifest = await payload(dir); manifest.files.push(manifest.files[0]);
  await writeFile(join(dir, 'PORTABLE-MANIFEST.json'), JSON.stringify(manifest)); await assert.rejects(verifyPortable(dir), /duplicate/);
  manifest.files.pop(); await writeFile(join(dir, 'PORTABLE-MANIFEST.json'), JSON.stringify(manifest));
  const modules = join(dir, 'node_modules'); const outside = join(dir, 'outside');
  await mkdir(outside); await rm(modules, { recursive: true });
  await symlink(outside, modules, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(verifyPortable(dir), /symlink/);
}));
test('snapshot uses pinned Git blobs and ignores stale dist or untracked ignored source', async () => temporary(async dir => {
  const repo = join(dir, 'repo'); await mkdir(join(repo, 'packages/a/src'), { recursive: true });
  await workspaceFixture(repo);
  await mkdir(join(repo, 'packages/store/licenses'), { recursive: true });
  await writeFile(join(repo, 'packages/store/licenses/NOTICE.txt'), 'indirect package attribution\r\n');
  await writeFile(join(repo, 'packages/a/src/index.ts'), 'export const pinned = true;\n');
  await writeFile(join(repo, '.gitignore'), '**/dist/\n**/ignored.ts\n');
  run('git', ['init'], { cwd: repo });
  // Windows Git commonly normalizes CRLF on add. Expected release bytes come
  // from the pinned Git object, not from the caller's working-tree encoding.
  run('git', ['config', 'core.autocrlf', 'true'], { cwd: repo });
  run('git', ['add', '.'], { cwd: repo });
  run('git', ['-c', 'user.name=Portable Test', '-c', 'user.email=portable-test@example.invalid', 'commit', '-m', 'pinned fixture'], { cwd: repo });
  const sourceSha = run('git', ['rev-parse', 'HEAD'], { cwd: repo }).trim();
  await mkdir(join(repo, 'packages/a/dist')); await writeFile(join(repo, 'packages/a/dist/index.js'), 'stale');
  await writeFile(join(repo, 'packages/a/src/ignored.ts'), 'ignored injected source');
  const snapshot = join(dir, 'snapshot'); await sourceSnapshot(repo, sourceSha, snapshot);
  assert.equal(await readFile(join(snapshot, 'packages/a/src/index.ts'), 'utf8'), 'export const pinned = true;\n');
  assert.deepEqual((await workspacePackages(snapshot)).map(pkg => pkg.metadata.name), ['@ar/cli', '@ar/contracts', '@ar/orchestration', '@ar/store']);
  const pinnedNotice = run('git', ['show', `${sourceSha}:packages/store/licenses/NOTICE.txt`], { cwd: repo });
  assert.equal(pinnedNotice, 'indirect package attribution\n');
  assert.equal(await readFile(join(snapshot, 'packages/store/licenses/NOTICE.txt'), 'utf8'), pinnedNotice);
  await assert.rejects(readFile(join(snapshot, 'packages/a/dist/index.js')), /ENOENT/);
  await assert.rejects(readFile(join(snapshot, 'packages/a/src/ignored.ts')), /ENOENT/);
  await writeFile(join(repo, 'packages/a/src/index.ts'), 'dirty');
  await assert.rejects(sourceSnapshot(repo, sourceSha, join(dir, 'dirty')), /clean source commit/);
  await assert.rejects(sourceSnapshot(repo, 'c'.repeat(40), join(dir, 'wrong')), /source SHA/);
}));

test('archive retains executable native helpers, independently of their filenames and umask', async () => temporary(async dir => {
  const entries = [
    { path: 'harness-agent-1.9.0/agent.sh', bytes: Buffer.from('#!/bin/sh\n'), mode: 0o755 },
    { path: 'harness-agent-1.9.0/node_modules/node-pty/prebuilds/darwin-arm64/spawn-helper', bytes: Buffer.from([1, 2, 3]), mode: 0o755 },
    { path: 'harness-agent-1.9.0/readme.txt', bytes: Buffer.from('readme'), mode: 0o644 },
  ];
  const saved = process.umask(0o077);
  let root;
  try { root = await extractArchive(makeArchive(entries), join(dir, 'out')); }
  finally { process.umask(saved); }
  for (const entry of entries) {
    const path = join(root, ...entry.path.split('/').slice(1));
    assert.deepEqual(await readFile(path), entry.bytes);
    if (process.platform !== 'win32') assert.equal((await lstat(path)).mode & 0o7777, entry.mode);
  }
}));

function rewriteHeader(raw, offset, width, replacement) {
  const changed = Buffer.from(raw); changed.fill(0, offset, offset + width); changed.write(replacement, offset, width, 'ascii');
  changed.fill(32, 148, 156);
  const sum = changed.subarray(0, 512).reduce((total, value) => total + value, 0);
  changed.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 8);
  return gzipSync(changed);
}
test('tar numeric fields reject privilege bits, writable modes, junk suffixes and nonzero ownership or timestamps before writes', async () => temporary(async dir => {
  const raw = gunzipSync(makeArchive([{ path: 'harness-agent-1.9.0/a', bytes: Buffer.from('x') }]));
  for (const [label, offset, width, value] of [
    ['setuid', 100, 8, '0004755\0'], ['setgid', 100, 8, '0002755\0'], ['sticky', 100, 8, '0001755\0'],
    ['world-write', 100, 8, '0000777\0'], ['mode-junk', 100, 8, '644x\0'],
    ['owner', 108, 8, '0000001\0'], ['group', 116, 8, '0000001\0'],
    ['timestamp', 136, 12, '00000000001\0'], ['timestamp-junk', 136, 12, '0xyz\0'],
    ['size-junk', 124, 12, '1xyz\0'],
  ]) {
    const destination = join(dir, label);
    await assert.rejects(extractArchive(rewriteHeader(raw, offset, width, value), destination), /tar (?:mode|owner|group|timestamp|size)/);
    assert.deepEqual(await readdir(destination), [], label);
  }
  for (const mode of [0o4755, 0o777, 0o600, '0755', NaN]) {
    assert.throws(() => makeArchive([{ path: 'harness-agent-1.9.0/a', bytes: Buffer.from('x'), mode }]), /mode/);
  }
}));

async function payloadV2(dir) {
  const manifest = await payload(dir);
  await mkdir(join(dir, 'node_modules/node-pty/prebuilds/darwin-arm64'), { recursive: true });
  const helper = 'node_modules/node-pty/prebuilds/darwin-arm64/spawn-helper';
  await writeFile(join(dir, helper), 'native helper'); await chmod(join(dir, helper), 0o755);
  manifest.schemaVersion = 2;
  manifest.files = manifest.files.map(item => ({ ...item, mode: 0o644 }));
  manifest.files.push({ path: helper, bytes: 13, sha256: digest(Buffer.from('native helper')), mode: 0o755 });
  for (const item of manifest.files) await chmod(join(dir, item.path), item.mode);
  await writeFile(join(dir, 'PORTABLE-MANIFEST.json'), JSON.stringify(manifest)); await chmod(join(dir, 'PORTABLE-MANIFEST.json'), 0o644);
  return manifest;
}
test('schema 2 binds regular file permissions and rejects invalid or altered modes while schema 1 remains readable', async () => temporary(async dir => {
  const legacy = join(dir, 'legacy'); await mkdir(legacy); await payload(legacy); await verifyPortable(legacy);
  const current = join(dir, 'current'); await mkdir(current); const manifest = await payloadV2(current);
  await verifyPortable(current);
  if (process.platform !== 'win32') {
    const helper = manifest.files.at(-1);
    await chmod(join(current, helper.path), 0o644);
    await assert.rejects(verifyPortable(current), /mode mismatch/);
    await chmod(join(current, helper.path), 0o755);
  }
  for (const mode of [undefined, 0o4755, 0o777, '0755']) {
    manifest.files[0].mode = mode;
    await writeFile(join(current, 'PORTABLE-MANIFEST.json'), JSON.stringify(manifest));
    await assert.rejects(verifyPortable(current), /invalid.*mode/);
  }
}));
test('schema 2 archive validates declared bytes and modes before extracting any payload', async () => temporary(async dir => {
  const source = join(dir, 'source'); await mkdir(source); const manifest = await payloadV2(source);
  const records = await Promise.all(manifest.files.map(async item => ({ path: `harness-agent-1.9.0/${item.path}`, bytes: await readFile(join(source, item.path)), mode: item.mode })));
  records.push({ path: 'harness-agent-1.9.0/PORTABLE-MANIFEST.json', bytes: await readFile(join(source, 'PORTABLE-MANIFEST.json')), mode: 0o644 });
  const root = await extractArchive(makeArchive(records), join(dir, 'valid')); await verifyPortable(root);
  for (const [label, mutate] of [
    ['mode', list => { list.at(-2).mode = 0o644; }],
    ['bytes', list => { list[0].bytes = Buffer.from('altered'); }],
    ['extra', list => { list.push({ path: 'harness-agent-1.9.0/undeclared', bytes: Buffer.from('x'), mode: 0o644 }); }],
  ]) {
    const changed = records.map(record => ({ ...record })); mutate(changed);
    const destination = join(dir, label);
    await assert.rejects(extractArchive(makeArchive(changed), destination), /mode mismatch|digest mismatch|undeclared/);
    assert.deepEqual(await readdir(destination), [], label);
  }
}));
test('source snapshot retains executable Git modes instead of inheriting the process umask', async () => temporary(async dir => {
  const repo = join(dir, 'repo'); await mkdir(join(repo, 'scripts/release'), { recursive: true });
  await writeFile(join(repo, 'scripts/release/helper.sh'), '#!/bin/sh\nexit 0\n');
  run('git', ['init'], { cwd: repo }); run('git', ['add', '.'], { cwd: repo });
  run('git', ['update-index', '--chmod=+x', 'scripts/release/helper.sh'], { cwd: repo });
  if (process.platform !== 'win32') await chmod(join(repo, 'scripts/release/helper.sh'), 0o755);
  run('git', ['-c', 'user.name=Portable Test', '-c', 'user.email=portable-test@example.invalid', 'commit', '-m', 'executable fixture'], { cwd: repo });
  const sourceSha = run('git', ['rev-parse', 'HEAD'], { cwd: repo }).trim();
  const saved = process.umask(0o077);
  try { await sourceSnapshot(repo, sourceSha, join(dir, 'snapshot')); } finally { process.umask(saved); }
  const path = join(dir, 'snapshot/scripts/release/helper.sh');
  assert.equal(await readFile(path, 'utf8'), '#!/bin/sh\nexit 0\n');
  if (process.platform !== 'win32') assert.equal((await lstat(path)).mode & 0o7777, 0o755);
}));
test('payload canonicalization restores reviewed Darwin helpers even when the package store stripped all execute bits', async () => temporary(async dir => {
  const helper = join(dir, 'node_modules/node-pty/prebuilds/darwin-arm64/spawn-helper');
  const library = join(dir, 'node_modules/node-pty/lib/index.js');
  const pinned = join(dir, 'node_modules/@ar/web/public/pinned-helper.sh');
  for (const file of [helper, library, pinned]) { await mkdir(join(file, '..'), { recursive: true }); await writeFile(file, 'published bytes', { mode: 0o600 }); }
  const modes = await canonicalPayloadModes(dir, new Map([[pinned, 0o755]]));
  assert.equal(modes.get('node_modules/node-pty/prebuilds/darwin-arm64/spawn-helper'), 0o755);
  assert.equal(modes.get('node_modules/@ar/web/public/pinned-helper.sh'), 0o755);
  assert.equal(modes.get('node_modules/node-pty/lib/index.js'), 0o644);
  assert.equal(await readFile(helper, 'utf8'), 'published bytes');
  if (process.platform !== 'win32') assert.equal((await lstat(helper)).mode & 0o7777, 0o755);
}));
test('native rebuild rejects unreviewed versions and lock bytes before executing any lifecycle hook', async () => temporary(async dir => {
  const web = join(dir, 'apps/web'); await mkdir(web, { recursive: true }); let calls = 0;
  const options = { runPnpm: () => { calls++; throw new Error('must not run'); } };
  await writeFile(join(web, 'package.json'), JSON.stringify({ dependencies: { 'node-pty': '1.2.0' } }));
  await assert.rejects(rebuildReviewedNativeDependencies(dir, options), /not been reviewed/);
  await writeFile(join(web, 'package.json'), JSON.stringify({ dependencies: { 'node-pty': REVIEWED_NODE_PTY.version } }));
  await writeFile(join(dir, 'pnpm-lock.yaml'), '  node-pty@1.1.0:\n    resolution: {integrity: sha512-unreviewed}\n');
  await assert.rejects(rebuildReviewedNativeDependencies(dir, options), /lock integrity/);
  assert.equal(calls, 0);
  await writeFile(join(web, 'package.json'), '{}');
  assert.deepEqual(await rebuildReviewedNativeDependencies(dir, options), { log: '', receipt: [] });
  assert.equal(calls, 0);
}));
test('builder refuses an archive larger than the consumer extraction budget before reading or compressing its payload', () => {
  // allocUnsafe reserves virtual memory; the guard must run before touching
  // these bytes or constructing the much larger concatenated tar buffer.
  const bytes = Buffer.allocUnsafe(MAX_PORTABLE_UNCOMPRESSED_BYTES);
  assert.throws(() => makeArchive([{ path: 'harness-agent-1.9.0/too-large', bytes }]), /extraction size limit/);
});
test('executed portable tools must match pinned source so schema 2 cannot ship a stale schema 1 verifier', async () => temporary(async dir => {
  const tools = join(dir, 'scripts/release'); await mkdir(tools, { recursive: true });
  for (const name of ['portable.mjs', 'portable-lib.mjs']) {
    const source = await readFile(fileURLToPath(new URL(name, import.meta.url)), 'utf8');
    await writeFile(join(tools, name), source.replace(/\r?\n/g, '\r\n'));
  }
  await verifyPinnedBuildTools(dir);
  await writeFile(join(tools, 'portable-lib.mjs'), 'export async function verifyPortable() { return { schemaVersion: 1 }; }\n');
  await assert.rejects(verifyPinnedBuildTools(dir), /must match pinned source.*portable-lib/);
}));
