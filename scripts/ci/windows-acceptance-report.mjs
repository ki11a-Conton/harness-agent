import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { release, type, arch } from 'node:os';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { gzipSync } from 'node:zlib';

export function receiptFromReport(report, host, requiredNames) {
  const files = (report.testResults ?? []).map(file => ({
    file: file.name.replace(/\\/g, '/').slice(file.name.replace(/\\/g, '/').lastIndexOf('/harness-agent/') + '/harness-agent/'.length),
    assertions: (file.assertionResults ?? []).map(test => ({ name: test.fullName, status: test.status, durationMs: test.duration ?? null,
      ...(test.status === 'failed' ? { failureMessages: test.failureMessages ?? [] } : {}) })),
  }));
  const assertions = files.flatMap(file => file.assertions);
  const required = requiredNames.map(name => ({ name, observed: assertions.filter(test => test.name === name).map(test => test.status) }));
  const issues = [];
  if (host.platform !== 'win32' || host.osType !== 'Windows_NT') issues.push('GENUINE_WINDOWS_REQUIRED');
  if (!/^[a-f0-9]{40}$/.test(host.sourceSha) || host.sourceSha !== host.workflowSha) issues.push('SOURCE_SHA_MISMATCH');
  if (!host.treeClean) issues.push('CLEAN_TREE_REQUIRED');
  if (!files.length || !assertions.length || !report.success || report.numFailedTests !== 0 || report.numFailedTestSuites !== 0 || assertions.some(test => test.status === 'failed')) issues.push('TEST_SUITE_NOT_PASSED');
  for (const test of required) if (test.observed.length !== 1 || test.observed[0] !== 'passed') issues.push('REQUIRED_TEST_NOT_EXECUTED: ' + test.name);
  const passed = assertions.filter(test => test.status === 'passed').length;
  const failed = assertions.filter(test => test.status === 'failed').length;
  const skipped = assertions.filter(test => test.status !== 'passed' && test.status !== 'failed').length;
  if (passed !== report.numPassedTests || failed !== report.numFailedTests || assertions.length !== report.numTotalTests) issues.push('REPORT_COUNTS_MISMATCH');
  const receipt = { schemaVersion: 'genuine-windows-acceptance-v1', ...host,
    outcome: issues.length ? 'FAIL' : 'PASS', issues,
    files: files.length, passed, failed, skipped, required,
    caseRecordsSha256: createHash('sha256').update(JSON.stringify(files)).digest('hex'),
    paidModelExperiment: 'NOT_RUN',
  };
  return { receipt, files };
}

export function annotationPackets(files) {
  const encoded = gzipSync(Buffer.from(JSON.stringify(files))).toString('base64');
  const total = Math.ceil(encoded.length / 2500);
  return Array.from({ length: total }, (_, index) => ({ encoding: 'gzip+base64', index, total, data: encoded.slice(index * 2500, (index + 1) * 2500) }));
}

export function caseRecordPublication(files) {
  const packets = annotationPackets(files);
  // One of the ten notices is reserved for the verdict. Large suites keep
  // their complete records in receipt.json, uploaded by the always() step.
  // Publish a verifiable index instead of throwing after a valid verdict or
  // silently allowing GitHub to truncate the records.
  if (packets.length <= 9) return { mode: 'annotations', packets };
  return { mode: 'artifact', packets: [], index: {
    artifactPath: '.ci/windows-acceptance/receipt.json',
    caseRecordsSha256: createHash('sha256').update(JSON.stringify(files)).digest('hex'),
    files: files.length, assertions: files.reduce((count, file) => count + file.assertions.length, 0),
    losslessPackets: packets.length, reason: 'PER_STEP_ANNOTATION_BUDGET',
  } };
}

function main() {
  const input = process.argv[2]; const output = process.argv[3];
  if (!input || !output) throw new Error('usage: node windows-acceptance-report.mjs <vitest.json> <receipt.json>');
  const raw = readFileSync(input);
  const skipped = JSON.parse(readFileSync('docs/evidence/source-audit-fixes-20261007/evidence/final-skipped-tests.json', 'utf8'));
  const required = skipped.filter(test => test.file.startsWith('packages/tools/src/process/')).map(test => test.test);
  for (const mode of ['cancel', 'timeout']) required.push(`Windows native process-tree completion boundary ${mode} waits for both the child and its real grandchild to terminate`);
  for (const delay of [0, 11000]) required.push(`C7 actual commands, edits and verification remain separate in the browser status (command delay ${delay} ms)`);
  for (const name of [
    'a busy initial fixture is replaced before assertions while its actual owner stays locked',
    'non-busy owner startup failures propagate without reallocating a fixture',
    'unavailable owner fixture allocation is bounded and never writes durable data',
  ]) required.push(`single local product host per persistent data directory ${name}`);
  for (const name of ["an ENOENT observed while the real writer owns the claim lock is not an unclaimed approval", "transient EPERM creating the claim anchor lock still updates one established approval", "persistent claim lock EPERM fails within the original deadline without changing approval"]) required.push(name);
  required.push('actual format-only capture waits for committed completion beyond the old polling budget');
  required.push('batch edit preserves BOM and mixed line endings with one real write',
    'two concurrent batches with one read version commit only one whole result',
    'scoped repository map preserves root and nested ignores and refuses symlink escape',
    'a real runtime recovers from batch preflight failure without partial writes and verifies the repaired file');
  required.push('a busy derived owner replaces the complete fixture before assertions and leaves the genuine blocker locked',
    'complete owner fixture admission remains bounded when every derived lease is occupied',
    'a genuinely busy later model owner reallocates setup without changing the original stable journal',
    'a genuinely busy initial workspace owner reallocates setup before attachment assertions and preserves the blocker');
  required.push('bounded indexed source reads bounds bytes actually read when a file grows after opening and closes the handle',
    'bounded lexical index caching evicts old scopes by content weight before the 64-entry count limit',
    'large source read concurrency limits simultaneous distinct large reads and starts the next when a scan finishes',
    'symbol index scan coverage is visible to the caller stops a huge directory at the entry budget, closes it, and avoids an unbounded fallback',
    'delivers skipped-source coverage to the next real model request');
  const host = { platform: process.platform, osType: type(), osRelease: release(), arch: arch(), nodeVersion: process.version,
    sourceSha: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), workflowSha: process.env.GITHUB_SHA ?? '',
    treeClean: execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).trim() === '',
    runId: process.env.GITHUB_RUN_ID, runAttempt: process.env.GITHUB_RUN_ATTEMPT,
    workflow: process.env.GITHUB_WORKFLOW_REF, job: process.env.GITHUB_JOB,
    rawReportSha256: createHash('sha256').update(raw).digest('hex'), rawReportBytes: raw.length };
  const { receipt, files } = receiptFromReport(JSON.parse(raw), host, required);
  writeFileSync(output, JSON.stringify({ ...receipt, caseRecords: files }, null, 2) + '\n');
  const escape = text => text.replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
  // Public checks preserve the verdict; case records use lossless annotations
  // when they fit, or an explicit artifact index bound to the full-record hash.
  console.log(`::notice title=Windows acceptance receipt::${escape(JSON.stringify(receipt))}`);
  const publication = caseRecordPublication(files);
  if (publication.mode === 'artifact') console.log(`::notice title=Windows case records artifact index::${escape(JSON.stringify(publication.index))}`);
  for (const packet of publication.packets) console.log(`::notice title=Windows case records chunk ${packet.index + 1}/${packet.total}::${escape(JSON.stringify(packet))}`);
  if (receipt.outcome !== 'PASS') process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main();
