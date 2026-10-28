import { test } from 'node:test';
import assert from 'node:assert/strict';
import { receiptFromReport, receiptPublication, annotationPackets, caseRecordPublication, failureAnnotations } from './windows-acceptance-report.mjs';
import { gunzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync, spawnSync } from 'node:child_process';

const host = { platform: 'win32', osType: 'Windows_NT', sourceSha: 'a'.repeat(40), workflowSha: 'a'.repeat(40), treeClean: true };
const report = { success: true, numFailedTests: 0, numFailedTestSuites: 0, numPassedTests: 1, numTotalTests: 1,
  testResults: [{ name: 'C:\\work\\harness-agent\\test.ts', assertionResults: [{ fullName: 'required native case', status: 'passed' }] }] };

test('parser accepts a consistent final result and binds its complete case records', () => {
  const result = receiptFromReport(report, host, ['required native case']);
  assert.equal(result.receipt.outcome, 'PASS'); assert.equal(result.receipt.passed, 1);
  assert.equal(result.files[0].file, 'test.ts'); assert.match(result.receipt.caseRecordsSha256, /^[a-f0-9]{64}$/);
});
test('parser refuses a skipped native case despite a self-reported successful suite', () => {
  const altered = structuredClone(report); altered.testResults[0].assertionResults[0].status = 'pending'; altered.numPassedTests = 0;
  const { receipt } = receiptFromReport(altered, host, ['required native case']);
  assert.equal(receipt.outcome, 'FAIL'); assert(receipt.issues.some(issue => issue.startsWith('REQUIRED_TEST_NOT_EXECUTED')));
});
test('parser refuses Linux, dirty trees, source drift, duplicate required cases and fabricated counts', () => {
  for (const override of [{ platform: 'linux' }, { treeClean: false }, { workflowSha: 'b'.repeat(40) }]) {
    assert.equal(receiptFromReport(report, { ...host, ...override }, ['required native case']).receipt.outcome, 'FAIL');
  }
  const duplicate = structuredClone(report); duplicate.testResults[0].assertionResults.push(duplicate.testResults[0].assertionResults[0]);
  assert.equal(receiptFromReport(duplicate, host, ['required native case']).receipt.outcome, 'FAIL');
  const counts = { ...report, numPassedTests: 2 };
  assert(receiptFromReport(counts, host, ['required native case']).receipt.issues.includes('REPORT_COUNTS_MISMATCH'));
});
test('annotation packets reconstruct Unicode final states without per-step or message truncation', () => {
  const files = Array.from({ length: 13 }, (_, file) => ({ file: `packages/test-${file}.ts`, assertions: Array.from({ length: 40 }, (_, test) => ({ name: `中文 assertion ${file}:${test}`, status: 'passed', durationMs: file * test })) }));
  const packets = annotationPackets(files);
  assert(packets.length <= 9); assert(packets.every(packet => JSON.stringify(packet).length < 3000));
  const decoded = gunzipSync(Buffer.from(packets.map(packet => packet.data).join(''), 'base64')).toString();
  assert.deepEqual(JSON.parse(decoded), files);
});

const largeFiles = () => [{ file: 'packages/large.test.ts', assertions: Array.from({ length: 1000 }, (_, index) => ({
  name: createHash('sha256').update(`native-case-${index}`).digest('hex'), status: 'passed', durationMs: index,
})) }];
test('large suites retain all lossless case records beyond one step annotation budget', () => {
  const files = largeFiles();
  const packets = annotationPackets(files);
  assert(packets.length > 9);
  assert.deepEqual(JSON.parse(gunzipSync(Buffer.from(packets.map(packet => packet.data).join(''), 'base64'))), files);
});

test('large-suite publication is bounded and indexes the complete artifact without weakening the verdict', () => {
  const files = largeFiles();
  const publication = caseRecordPublication(files);
  assert.equal(publication.mode, 'artifact');
  assert.equal(publication.packets.length, 0);
  assert.equal(publication.index.assertions, 1000);
  assert.equal(publication.index.artifactPath, '.ci/windows-acceptance/receipt.json');
  assert.equal(publication.index.caseRecordsSha256, createHash('sha256').update(JSON.stringify(files)).digest('hex'));
  assert(publication.index.losslessPackets > 9);
  assert.equal(receiptFromReport({ ...report, success: false }, host, []).receipt.outcome, 'FAIL');
});
test('small-suite publication still includes every reconstructible record in public annotations', () => {
  const { files } = receiptFromReport(report, host, ['required native case']);
  assert.deepEqual(failureAnnotations(files), []);
  const publication = caseRecordPublication(files);
  assert.equal(publication.mode, 'annotations');
  assert.deepEqual(JSON.parse(gunzipSync(Buffer.from(publication.packets.map(packet => packet.data).join(''), 'base64'))), files);
});

test('failed assertions remain visible when complete records exceed the annotation budget', () => {
  const files = largeFiles();
  files[0].assertions[17] = { name: 'native refusal still respects its deadline', status: 'failed', failureMessages: ['expected a bounded refusal, got a pending worker'] };
  const original = JSON.stringify(files);
  const failures = failureAnnotations(files);
  assert.equal(failures.length, 1);
  assert.equal(failures[0].file, files[0].file);
  assert.equal(failures[0].name, 'native refusal still respects its deadline');
  assert.match(failures[0].failure, /pending worker/);
  const publication = caseRecordPublication(files, 8 - failures.length);
  assert.equal(publication.mode, 'artifact');
  assert.equal(publication.index.caseRecordsSha256, createHash('sha256').update(original).digest('hex'));
  assert.equal(JSON.stringify(files), original);
});

test('Unicode failure summaries fit message and step budgets while raw failures stay intact', () => {
  const files = [{ file: '中文路径'.repeat(2000), assertions: Array.from({ length: 11 }, (_, index) => ({
    name: `${index}: 中文用例`.repeat(2000), status: 'failed', failureMessages: ['中文错误\n%0A::error::'.repeat(2000)],
  })) }];
  const original = JSON.stringify(files);
  const failures = failureAnnotations(files);
  assert.equal(failures.length, 8);
  for (const failure of failures) {
    assert(Buffer.byteLength(JSON.stringify(failure), 'utf8') <= 3500);
    assert.equal(failure.omittedFailures, 3);
    assert.equal(failure.truncated, true);
  }
  const publication = caseRecordPublication(files, 8 - failures.length);
  assert.equal(publication.mode, 'artifact');
  assert(1 + failures.length + 1 <= 10);
  assert.equal(JSON.stringify(files), original);
});

const artifactOf = ({ receipt, files }) => Buffer.from(JSON.stringify({ ...receipt, caseRecords: files }, null, 2) + '\n');
const noticeBytes = value => Buffer.byteLength(JSON.stringify(value).replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A'), 'utf8');
const decodeReceipt = publication => publication.mode === 'gzip'
  ? JSON.parse(gunzipSync(Buffer.from(publication.value.data, 'base64'))) : publication.value;
const reportFor = names => ({ ...report, numPassedTests: names.length, numTotalTests: names.length,
  testResults: [{ ...report.testResults[0], assertionResults: names.map(fullName => ({ fullName, status: 'passed' })) }] });

test('small verdict notices preserve the original receipt JSON vocabulary', () => {
  const result = receiptFromReport(report, host, ['required native case']);
  const original = JSON.stringify(result);
  const publication = receiptPublication(result.receipt, artifactOf(result));
  assert.equal(publication.mode, 'json');
  assert.deepEqual(publication.value, result.receipt);
  assert(noticeBytes(publication.value) < 3500);
  assert.equal(JSON.stringify(result), original);
});

test('growing required-case receipts fit one lossless compressed verdict notice', () => {
  const names = Array.from({ length: 40 }, (_, index) => `required native coding boundary ${index}: real commands, incremental managed process observations and verification remain separate in the browser status with original admission and cleanup limits`);
  const result = receiptFromReport(reportFor(names), host, names);
  assert(Buffer.byteLength(JSON.stringify(result.receipt), 'utf8') > 4096);
  const original = JSON.stringify(result);
  const publication = receiptPublication(result.receipt, artifactOf(result));
  assert.equal(publication.mode, 'gzip');
  assert.equal(publication.value.encoding, 'gzip+base64');
  assert(noticeBytes(publication.value) < 3500);
  assert.deepEqual(decodeReceipt(publication), result.receipt);
  assert.equal(JSON.stringify(result), original);
  const cases = caseRecordPublication(result.files);
  assert(1 + cases.packets.length + (cases.mode === 'artifact' ? 1 : 0) <= 10);
});

test('Unicode and workflow-command escaping count toward the verdict byte budget', () => {
  const names = Array.from({ length: 38 }, (_, index) => `中文原生编码边界 ${index}：🙂保留完整验证记录和原始失败；百分号%与换行\n不可成为工作流指令`.repeat(3));
  const result = receiptFromReport(reportFor(names), host, names);
  const publication = receiptPublication(result.receipt, artifactOf(result));
  assert.equal(publication.mode, 'gzip');
  assert(noticeBytes(publication.value) < 3500);
  assert.deepEqual(decodeReceipt(publication), result.receipt);
  const escaped = { ...receiptFromReport(report, host, []).receipt, workflow: '%'.repeat(1100) };
  assert(Buffer.byteLength(JSON.stringify(escaped), 'utf8') < 3500);
  assert(noticeBytes(escaped) >= 3500);
  const escapedPublication = receiptPublication(escaped, Buffer.from(JSON.stringify(escaped)));
  assert.equal(escapedPublication.mode, 'gzip');
  assert(noticeBytes(escapedPublication.value) < 3500);
  assert.deepEqual(decodeReceipt(escapedPublication), escaped);
});

test('an incompressible FAIL verdict indexes the actual complete artifact without hiding its outcome', () => {
  const names = Array.from({ length: 1400 }, (_, index) => createHash('sha512').update(`required boundary ${index}`).digest('hex'));
  const altered = reportFor(names);
  altered.success = false; altered.numFailedTests = 1; altered.numPassedTests--;
  altered.testResults[0].assertionResults[17] = { fullName: names[17], status: 'failed', failureMessages: ['actual original failure'] };
  const result = receiptFromReport(altered, host, names);
  const original = JSON.stringify(result);
  const artifact = artifactOf(result);
  const publication = receiptPublication(result.receipt, artifact);
  assert.equal(result.receipt.outcome, 'FAIL');
  assert.equal(publication.mode, 'artifact');
  assert.equal(publication.value.outcome, 'FAIL');
  assert.equal(publication.value.reason, 'PER_MESSAGE_ANNOTATION_BUDGET');
  assert.equal(publication.value.artifactPath, '.ci/windows-acceptance/receipt.json');
  assert.equal(publication.value.receiptSha256, createHash('sha256').update(artifact).digest('hex'));
  assert.equal(publication.value.receiptBytes, artifact.length);
  assert.equal(publication.value.summary.sourceSha, host.sourceSha);
  assert.equal(publication.value.summary.workflowSha, host.workflowSha);
  assert.equal(publication.value.summary.required, names.length);
  assert.equal(publication.value.summary.issues, result.receipt.issues.length);
  assert.equal(publication.value.summary.failed, 1);
  assert(noticeBytes(publication.value) < 3500);
  assert.equal(JSON.stringify(result), original);
  assert.equal(JSON.parse(artifact).caseRecords[0].assertions[17].failureMessages[0], 'actual original failure');
});

test('compressed FAIL receipts preserve every issue and required-case observation', () => {
  const names = Array.from({ length: 40 }, (_, index) => `required actual native deadline, ownership, process completion and browser verification boundary ${index}`);
  const result = receiptFromReport({ ...reportFor(names), success: false }, { ...host, treeClean: false }, names);
  const publication = receiptPublication(result.receipt, artifactOf(result));
  assert.equal(publication.mode, 'gzip');
  const decoded = decodeReceipt(publication);
  assert.equal(decoded.outcome, 'FAIL');
  assert.deepEqual(decoded, result.receipt);
  assert(decoded.issues.includes('CLEAN_TREE_REQUIRED'));
  assert(decoded.issues.includes('TEST_SUITE_NOT_PASSED'));
  assert(noticeBytes(publication.value) < 3500);
});

test('artifact index bounds long Unicode host fields and declares their truncation', () => {
  const names = Array.from({ length: 400 }, (_, index) => createHash('sha512').update(String(index)).digest('hex'));
  const longFields = Object.fromEntries(['platform', 'osType', 'arch', 'nodeVersion', 'sourceSha', 'workflowSha', 'runId', 'runAttempt'].map(name => [name, '\u0000中文🙂%'.repeat(500)]));
  const result = receiptFromReport(reportFor(names), { ...host, ...longFields }, names);
  const publication = receiptPublication(result.receipt, artifactOf(result));
  assert.equal(publication.mode, 'artifact');
  assert.equal(publication.value.outcome, 'FAIL');
  assert(noticeBytes(publication.value) < 3500);
  assert.deepEqual(publication.value.truncatedFields.sort(), Object.keys(longFields).sort());
});

test('CLI keeps its failed exit and complete receipt while publishing a bounded artifact verdict', () => {
  const directory = mkdtempSync(join(tmpdir(), 'windows-receipt-notice-'));
  try {
    const cwd = directory;
    const skippedDirectory = join(cwd, 'docs/evidence/source-audit-fixes-20261007/evidence');
    mkdirSync(skippedDirectory, { recursive: true });
    writeFileSync(join(skippedDirectory, 'final-skipped-tests.json'), JSON.stringify(Array.from({ length: 5 }, (_, index) =>
      ({ file: 'packages/tools/src/process/fixture.test.ts', test: `fixture native process ${index}` }))));
    execFileSync('git', ['init', '-q'], { cwd });
    const hooks = join(directory, 'empty-hooks'); mkdirSync(hooks);
    execFileSync('git', ['-c', 'user.name=receipt-fixture', '-c', 'user.email=receipt-fixture@example.test',
      '-c', 'commit.gpgsign=false', '-c', `core.hooksPath=${hooks}`, 'commit', '--allow-empty', '-qm', 'receipt fixture'], { cwd });
    mkdirSync(join(cwd, '.ci/windows-acceptance'), { recursive: true });
    const input = join(directory, 'report.json'), output = join(cwd, '.ci/windows-acceptance/receipt.json');
    writeFileSync(input, JSON.stringify(report));
    const sourceSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd, encoding: 'utf8' }).trim();
    const workflow = Array.from({ length: 80 }, (_, index) => createHash('sha512').update(`workflow fixture ${index}`).digest('hex')).join('');
    const child = spawnSync(process.execPath, [fileURLToPath(new URL('./windows-acceptance-report.mjs', import.meta.url)), input, output],
      { cwd, encoding: 'utf8', env: { ...process.env, GITHUB_SHA: sourceSha, GITHUB_WORKFLOW_REF: workflow } });
    assert.equal(child.error, undefined);
    assert.equal(child.status, 1, child.stderr);
    const artifact = readFileSync(output), receipt = JSON.parse(artifact);
    assert.equal(receipt.outcome, 'FAIL');
    assert.equal(receipt.workflow, workflow);
    assert(receipt.required.length >= 35);
    assert.equal(receipt.caseRecords[0].assertions[0].name, 'required native case');
    const annotations = child.stdout.trim().split('\n').filter(line => /^::(?:notice|error) /.test(line));
    assert(annotations.length <= 10);
    const verdictLines = annotations.filter(line => line.startsWith('::notice title=Windows acceptance receipt::'));
    assert.equal(verdictLines.length, 1);
    const value = verdictLines[0].split('::').slice(2).join('::');
    assert(Buffer.byteLength(value, 'utf8') < 3500);
    const index = JSON.parse(value);
    assert.equal(index.schemaVersion, 'genuine-windows-acceptance-index-v1');
    assert.equal(index.outcome, 'FAIL');
    assert.equal(index.receiptSha256, createHash('sha256').update(artifact).digest('hex'));
    assert.equal(index.receiptBytes, artifact.length);
    assert.equal(index.summary.issues, receipt.issues.length);
    assert.equal(index.summary.sourceSha, sourceSha);
  } finally { rmSync(directory, { recursive: true, force: true, maxRetries: process.platform === 'win32' ? 8 : 0, retryDelay: 50 }); }
});
