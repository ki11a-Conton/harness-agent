import { test } from 'node:test';
import assert from 'node:assert/strict';
import { receiptFromReport } from './windows-acceptance-report.mjs';

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
