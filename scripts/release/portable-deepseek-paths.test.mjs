import assert from 'node:assert/strict';
import { lstat, mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { digest, extractArchive, makeArchive, verifyPortable } from './portable-lib.mjs';

const publicRoot = fileURLToPath(new URL('../../apps/web/public/', import.meta.url));
const noticeRoot = 'deepseek/licenses/shell-reference/notice-files/node_modules/';
// These are the actual unchanged notices which blocked the complete UI archive.
const blockedNotices = [
  'ast-kit/node_modules/@babel/helper-string-parser/LICENSE',
  'ast-kit/node_modules/@babel/helper-validator-identifier/LICENSE',
  'micromark-util-decode-numeric-character-reference/license',
  'rolldown/node_modules/@rolldown/pluginutils/LICENSE',
  'rolldown-plugin-dts/node_modules/@babel/generator/LICENSE',
  'rolldown-plugin-dts/node_modules/@babel/helper-string-parser/LICENSE',
  'rolldown-plugin-dts/node_modules/@babel/helper-validator-identifier/LICENSE',
  'rolldown-plugin-dts/node_modules/@babel/parser/LICENSE',
  'rolldown-plugin-dts/node_modules/@babel/types/LICENSE',
  'rolldown-plugin-dts/node_modules/@babel/types/node_modules/@babel/helper-validator-identifier/LICENSE',
];

test('complete DeepSeek UI keeps all ten previously blocked notices byte for byte in a verified schema 2 archive', async () => {
  const destination = await realpath(await mkdtemp(join(tmpdir(), 'harness-portable-notice-paths-')));
  try {
    const version = '1.9.1-test';
    const records = await Promise.all(blockedNotices.map(async notice => ({
      path: `node_modules/@ar/web/public/${noticeRoot}${notice}`,
      bytes: await readFile(join(publicRoot, noticeRoot, notice)), mode: 0o644,
    })));
    for (const path of ['agent.mjs', 'node_modules/@ar/cli/dist/main.js', 'node_modules/@ar/web/dist/main.js',
      'node_modules/@ar/web/public/index.html', 'PROJECT-LICENSE-NOTICE.txt']) {
      records.push({ path, bytes: Buffer.from(`archive-path fixture: ${path}`), mode: 0o644 });
    }
    const manifest = { schemaVersion: 2, kind: 'harness-agent-portable', version,
      sourceSha: 'a'.repeat(40), sourceTree: 'b'.repeat(40),
      files: records.map(record => ({ path: record.path, bytes: record.bytes.length, sha256: digest(record.bytes), mode: record.mode })) };
    const entries = records.map(record => ({ ...record, path: `harness-agent-${version}/${record.path}` }));
    entries.push({ path: `harness-agent-${version}/PORTABLE-MANIFEST.json`, bytes: Buffer.from(JSON.stringify(manifest)), mode: 0o644 });
    const archive = makeArchive(entries);
    const root = await extractArchive(archive, join(destination, 'consumer'));
    await verifyPortable(root, { version, sourceSha: manifest.sourceSha });
    for (const record of records.slice(0, blockedNotices.length)) {
      assert.deepEqual(await readFile(join(root, record.path)), record.bytes, record.path);
      if (process.platform !== 'win32') assert.equal((await lstat(join(root, record.path))).mode & 0o7777, record.mode, record.path);
    }
  } finally { await rm(destination, { recursive: true, force: true }); }
});

test('ustar accepts the exact prefix/name field limits without changing payload bytes or executable modes', async () => {
  const destination = await realpath(await mkdtemp(join(tmpdir(), 'harness-portable-ustar-limit-')));
  try {
    const root = 'harness-agent-1.9.1-test';
    const prefix = `${root}/${'a'.repeat(155 - root.length - 1)}`;
    const path = `${prefix}/${'b'.repeat(100)}`;
    assert.equal(Buffer.byteLength(prefix), 155);
    const bytes = Buffer.from([0, 255, 10, 13, 195, 169]);
    const extracted = await extractArchive(makeArchive([{ path, bytes, mode: 0o755 }]), join(destination, 'consumer'));
    const file = join(extracted, path.slice(root.length + 1));
    assert.deepEqual(await readFile(file), bytes);
    if (process.platform !== 'win32') assert.equal((await lstat(file)).mode & 0o7777, 0o755);
  } finally { await rm(destination, { recursive: true, force: true }); }
});

test('ustar still rejects paths with no split fitting both fields', () => {
  const root = 'harness-agent-1.9.1-test';
  for (const path of [`${root}/${'x'.repeat(101)}`, `${root}/${'a'.repeat(156 - root.length - 1)}/f`]) {
    assert.throws(() => makeArchive([{ path, bytes: Buffer.from('notice') }]), /tar path too long/);
  }
});
