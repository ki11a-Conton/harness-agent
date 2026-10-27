import { test } from 'node:test';
import assert from 'node:assert/strict';
import { receiptFromReport, annotationPackets, caseRecordPublication, failureAnnotations } from './windows-acceptance-report.mjs';
import { gunzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';

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
