import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';

// This publishes the existing gate's decision; it never turns a failed gate
// into a pass. The upstream release CLI remains the job's acceptance gate.
const path = process.argv[2];
if (!path) throw new Error('usage: node coverage-acceptance-report.mjs <gate-evidence.json>');
const escape = text => text.replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
const evidence = JSON.parse(readFileSync(path, 'utf8'));
const record = Object.fromEntries(['schemaVersion', 'gate', 'gitSha', 'cleanBefore', 'cleanAfter', 'exitCode', 'passed', 'state', 'summary', 'errorSummary', 'logRef'].map(key => [key, evidence[key]]));
console.log(`::notice title=Coverage gate record::${escape(JSON.stringify(record))}`);
if (evidence.passed !== true && evidence.logRef?.path && evidence.logRef.digest) {
  const log = readFileSync(resolve(dirname(path), evidence.logRef.path));
  if (createHash('sha256').update(log).digest('hex') !== evidence.logRef.digest) throw new Error('coverage log digest mismatch');
  const text = log.toString('utf8');
  const start = text.lastIndexOf('Failed Tests');
  const detail = start >= 0 ? text.slice(start) : evidence.errorSummary ?? '';
  const limit = 24_000;
  const encoded = gzipSync(Buffer.from(JSON.stringify({ truncated: detail.length > limit, text: detail.slice(0, limit) }))).toString('base64');
  const total = Math.ceil(encoded.length / 2500);
  if (total > 9) throw new Error('coverage diagnostic exceeds public annotation budget; full log remains in the artifact');
  for (let index = 0; index < total; index++) {
    console.log(`::notice title=Coverage failure detail ${index + 1}/${total}::${escape(JSON.stringify({ encoding: 'gzip+base64', index, total, data: encoded.slice(index * 2500, (index + 1) * 2500) }))}`);
  }
}
