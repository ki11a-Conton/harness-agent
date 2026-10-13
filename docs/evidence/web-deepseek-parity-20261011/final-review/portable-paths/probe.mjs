// Scoped real-public-asset archive reproducer, not a complete product build.
import assert from 'node:assert/strict';
import { lstat, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { digest, extractArchive, filesIn, makeArchive } from '../../../../../scripts/release/portable-lib.mjs';

const project = fileURLToPath(new URL('../../../../../', import.meta.url));
const publicRoot = join(project, 'apps/web/public');
const paths = await filesIn(publicRoot);
const oldAlgorithm = ['1.9.1', '1.9.1-test'].map(version => {
  const rejectedPaths = paths.map(path => `harness-agent-${version}/node_modules/@ar/web/public/${path}`).filter(path => {
    const last = path.lastIndexOf('/');
    return Buffer.byteLength(path) > 100 && (Buffer.byteLength(path.slice(0, last)) > 155 || Buffer.byteLength(path.slice(last + 1)) > 100);
  });
  return { version, historicalFinalSlashAlgorithmRejectedPaths: rejectedPaths };
});
const records = await Promise.all(paths.map(async path => {
  const bytes = await readFile(join(publicRoot, path));
  return { path: `harness-agent-1.9.1-test/node_modules/@ar/web/public/${path}`, bytes, mode: 0o644 };
}));
const archive = makeArchive(records);
const temp = await realpath(await mkdtemp(join(tmpdir(), 'harness-portable-public-asset-probe-')));
try {
  const root = await extractArchive(archive, join(temp, 'consumer'));
  for (const record of records) {
    const target = join(root, record.path.slice('harness-agent-1.9.1-test/'.length));
    assert.deepEqual(await readFile(target), record.bytes, record.path);
    if (process.platform !== 'win32') assert.equal((await lstat(target)).mode & 0o7777, record.mode, record.path);
  }
  const report = { kind: 'independent-real-public-asset-archive-roundtrip', status: 'PASS', timestamp: new Date().toISOString(),
    node: process.version, platform: process.platform, scopedFixtureOnly: true, completeProductPortableBuilt: false,
    nativeWindowsExecuted: false, paidModelCalls: 0,
    sourceFileSha256: digest(await readFile(join(project, 'scripts/release/portable-lib.mjs'))),
    oldAlgorithm, originalPublicFiles: records.length, originalPublicBytes: records.reduce((n, record) => n + record.bytes.length, 0),
    archivedFileCount: records.length, archiveBytes: archive.length, archiveSha256: digest(archive),
    extractedBytesVerified: true, declaredModesVerified: true,
    files: records.map(record => ({ path: record.path, bytes: record.bytes.length, sha256: digest(record.bytes), mode: record.mode })) };
  await writeFile(fileURLToPath(new URL('public-assets-roundtrip-green.json', import.meta.url)), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ status: report.status, files: report.originalPublicFiles, originalPublicBytes: report.originalPublicBytes,
    archiveBytes: report.archiveBytes, archiveSha256: report.archiveSha256, completeProductPortableBuilt: false }));
} finally { await rm(temp, { recursive: true, force: true }); }
