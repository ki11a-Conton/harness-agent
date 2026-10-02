import assert from 'node:assert/strict';
import { TaskVerifier } from '../../packages/tools/dist/verification/task-verifier.js';
import { RuntimeVerifier } from '../../packages/core/dist/verification/runtime-verifier.js';
import { newSessionId, newTurnId } from '../../packages/contracts/dist/index.js';

const marker = 'AssertionError: src/add.ts:12 expected 3 received 4';
let observedExecutorOutcome;
const executor = {
  async runArgv() {
    observedExecutorOutcome = { status: 'failed', exitCode: 1, stdout: 'FAIL add.test.ts\n', stderr: marker, durationMs: 5, truncated: false };
    return observedExecutorOutcome;
  },
};
const task = { id: 'source-research-verification', goal: 'Correct addition', verification: [{ kind: 'command', command: 'test-runner', args: [], description: 'unit tests' }] };
const verifier = new TaskVerifier({ executor });
const gate = await new RuntimeVerifier(verifier).verifyTurn(task, newSessionId(), newTurnId(), { async listMessages() { return []; } }, { cwd: process.cwd(), runStartedAt: Date.now(), changedPaths: [] });
const report = { executorStderr: observedExecutorOutcome.stderr, gateStatus: gate.status, gateReason: gate.reason,
  failureDetailPreservedInVerificationResult: JSON.stringify(gate.result).includes(marker),
  failureDetailPreservedInModelFeedback: gate.reason.includes(marker) };
assert.equal(gate.status, 'failed');
assert.equal(report.failureDetailPreservedInVerificationResult, false);
assert.equal(report.failureDetailPreservedInModelFeedback, false);
console.log(JSON.stringify(report, null, 2));
