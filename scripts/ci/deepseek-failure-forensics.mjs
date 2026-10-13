#!/usr/bin/env node
// Read existing exact-source CI artifacts; never rerun or reclassify failures.
import { createHash } from 'node:crypto';
import { readFile, readdir, lstat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { gzipSync } from 'node:zlib';

const root = resolve(process.argv[2]);
const originalSourceSha = process.argv[3] ?? 'f763403477da9d4cc798954abbc6b8ca63c93ded';
if (!/^[a-f0-9]{40}$/.test(originalSourceSha)) throw new Error('Expected original source SHA');
const files = [];
async function walk(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const file = join(directory, entry.name), info = await lstat(file);
    if (info.isSymbolicLink()) throw new Error('Forensic artifact link rejected');
    if (entry.isDirectory()) { await walk(file); continue; }
    if (!entry.isFile() || info.size > 4 * 1024 * 1024 || !/^(?:result|results|receipt|commands|coding-run|test-report|test|coverage|browser|host-stderr|.*\.stdout|.*\.stderr|.*phase.*)\.(?:json|log)$/.test(entry.name)) continue;
    const bytes = await readFile(file), text = bytes.toString('utf8');
    let detail;
    if (entry.name.endsWith('.json')) {
      const report = JSON.parse(text);
      if (report.sourceSha && report.sourceSha !== originalSourceSha) throw new Error('Forensic source mismatch');
      if (Array.isArray(report.results)) detail = report.results.filter(row => row.status !== 'PASS').map(row => ({ name: row.name, viewport: row.viewport,
        status: row.status, failure: row.failure, errors: row.errors, failedHttp: row.failedHttp,
        failedCalls: row.calls?.filter(call => call.ok === false) }));
      else detail = report;
    } else {
      const marker = text.lastIndexOf('Failed Tests');
      detail = (marker >= 0 ? text.slice(Math.max(0, marker - 150)) : text).slice(-48_000);
    }
    files.push({ path: file.slice(root.length + 1).replaceAll('\\', '/'), bytes: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex'), detail });
  }
}
await walk(root);
if (!files.length) throw new Error('Forensic evidence files missing');
const receipt = { schemaVersion: 1, originalSourceSha, observedBy: process.env.GITHUB_SHA,
  purpose: 'Existing exact-source CI artifacts and job logs, original byte hashes and bounded excerpts; no rerun or status substitution', files };
const data = gzipSync(Buffer.from(JSON.stringify(receipt))).toString('base64'), size = 2500, total = Math.ceil(data.length / size);
if (total > 40) throw new Error('Forensic receipt exceeds bounded packet budget');
for (let index = 0; index < total; index++) console.log(`::notice title=DeepSeek Windows failure ${index + 1}/${total}::${JSON.stringify({ encoding: 'gzip+base64', index, total, data: data.slice(index * size, (index + 1) * size) })}`);
