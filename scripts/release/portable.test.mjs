import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { gunzipSync, gzipSync } from 'node:zlib';
import { digest, extractArchive, makeArchive, safePath, verifyPortable } from './portable-lib.mjs';
import { copyPackageNotices, run, sourceSnapshot, workspacePackages } from './portable.mjs';

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
