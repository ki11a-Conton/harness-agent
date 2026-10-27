// Read the exact original job through GitHub's own Actions API. This does not
// execute a test, change an original verdict, or publish a replacement PASS.
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { annotationPackets } from './windows-acceptance-report.mjs';

const [jobId, runId, sourceSha] = process.argv.slice(2);
const repository = process.env.GITHUB_REPOSITORY;
if (process.argv.length !== 5 || !/^\d+$/.test(jobId ?? '') || !/^\d+$/.test(runId ?? '') ||
    !/^[a-f0-9]{40}$/.test(sourceSha ?? '') || !/^[\w.-]+\/[\w.-]+$/.test(repository ?? '')) throw new Error('Expected job, run, SHA and repository identity');
if (!process.env.GITHUB_TOKEN) throw new Error('Read-only Actions credential missing');
const headers = { Authorization: `Bearer ${process.env.GITHUB_TOKEN}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' };
const endpoint = `https://api.github.com/repos/${repository}/actions/jobs/${jobId}`;
const identityResponse = await fetch(endpoint, { headers, signal: AbortSignal.timeout(30000) });
if (!identityResponse.ok) throw new Error(`Original job identity HTTP ${identityResponse.status}`);
const identity = await identityResponse.json();
if (identity.head_sha !== sourceSha || String(identity.run_id) !== runId || identity.conclusion !== 'failure') {
  throw new Error('Original failed job identity mismatch');
}
const redirect = await fetch(endpoint + '/logs', { headers, redirect: 'manual', signal: AbortSignal.timeout(30000) });
if (redirect.status !== 302 || !redirect.headers.get('location')) throw new Error(`Original log redirect HTTP ${redirect.status}`);
const location = new URL(redirect.headers.get('location'));
if (location.protocol !== 'https:' || !location.hostname.endsWith('.blob.core.windows.net')) throw new Error('Unexpected original log service');
// Do not forward the Actions credential to the signed log download service.
const response = await fetch(location, { signal: AbortSignal.timeout(30000) });
if (!response.ok || !response.body) throw new Error(`Original log download HTTP ${response.status}`);
const chunks = []; let size = 0;
for await (const chunk of response.body) {
  size += chunk.length;
  if (size > 32 * 1024 * 1024) throw new Error('Original log exceeds forensic byte budget');
  chunks.push(Buffer.from(chunk));
}
const raw = Buffer.concat(chunks);
const directory = join('.ci/original-windows', jobId);
await mkdir(directory, { recursive: true });
await writeFile(join(directory, 'job.log'), raw);
const text = raw.toString('utf8').replace(/\u001b\[[0-9;]*m/g, '');
const marker = text.lastIndexOf('Failed Tests');
let excerpt = marker >= 0 ? text.slice(Math.max(0, marker - 250), marker + 16000) : text.slice(-16000);
const receipt = { schemaVersion: 'original-windows-job-failure-v1', originalSourceSha: sourceSha,
  originalJobId: jobId, originalRunId: runId, originalAttempt: identity.run_attempt,
  originalConclusion: identity.conclusion, observedBy: process.env.GITHUB_SHA,
  rawLogBytes: raw.length, rawLogSha256: createHash('sha256').update(raw).digest('hex'),
  excerpt, truncated: false, originalCommandsRerun: false, paidCalls: 0 };
let packets = annotationPackets([receipt]);
while (packets.length > 9) {
  excerpt = excerpt.slice(0, Math.floor(excerpt.length * 0.75));
  receipt.excerpt = excerpt; receipt.truncated = true;
  packets = annotationPackets([receipt]);
}
await writeFile(join(directory, 'receipt.json'), JSON.stringify(receipt, null, 2));
for (const packet of packets) console.log(`::notice title=Original Windows job ${jobId} ${packet.index + 1}/${packet.total}::${JSON.stringify(packet)}`);
