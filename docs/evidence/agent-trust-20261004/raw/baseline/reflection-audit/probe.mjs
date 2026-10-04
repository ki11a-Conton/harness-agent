import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';

const repo = resolve(process.argv[2] ?? '/workspace/harness-agent');
const out = resolve(process.argv[3] ?? join(repo, '.ci/agent-round2-20261004/reflection-audit'));
await mkdir(out, { recursive: true });
const importBuilt = async (path) => import(pathToFileURL(join(repo, path)).href);
const { PostTurnReflector, REFLECTION_FILE_NAME } = await importBuilt('packages/harness/dist/reflection-runner.js');
const { JsonlCandidateStore } = await importBuilt('packages/harness/dist/candidate-store.js');
const { JSONLEventStore } = await importBuilt('packages/events/dist/index.js');
const { newEventId, newSessionId, newTurnId } = await importBuilt('packages/contracts/dist/index.js');
const inputFiles = ['packages/harness/src/reflection-runner.ts', 'packages/harness/dist/reflection-runner.js', 'packages/memory/src/reflection.ts', 'packages/memory/dist/reflection.js', 'packages/harness/src/candidate-store.ts', 'packages/harness/dist/candidate-store.js', 'packages/events/src/event-store.ts', 'packages/events/dist/event-store.js'];
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
let tick = 0;
async function append(events, sessionId, turnId, type, payload = {}) {
  return events.appendNew({ id: newEventId(), sessionId, ...(turnId === undefined ? {} : { turnId }), timestamp: ++tick, type, payload });
}
async function state(label) {
  const dataDir = join(out, 'fixtures', label);
  await mkdir(dataDir, { recursive: true });
  const events = new JSONLEventStore({ dataDir: join(dataDir, 'events') });
  const candidateStore = new JsonlCandidateStore({ dataDir });
  const reflector = new PostTurnReflector({ events, candidateStore, dataDir });
  return { dataDir, events, candidateStore, reflector };
}
async function failure(s, sessionId, turnId, { mcp = false, legacy = false, error = 'PROCESS_ERROR' } = {}) {
  await append(s.events, sessionId, turnId, 'turn.started', { turnId });
  const tool = mcp ? 'mcp_remote_query' : 'read_file';
  const toolId = legacy ? undefined : turnId;
  const callId = `call-${turnId}`;
  await append(s.events, sessionId, toolId, 'tool.requested', { toolCallId: callId, name: tool, args: { path: 'src/main.ts' } });
  await append(s.events, sessionId, toolId, 'tool.failed', { toolCallId: callId, name: tool, error: { code: error, message: 'reproducer failure' } });
  await append(s.events, sessionId, turnId, 'turn.failed', { error: { code: error, message: 'reproducer failure' } });
}
async function clean(s, sessionId, turnId) {
  await append(s.events, sessionId, turnId, 'turn.started', { turnId });
  await append(s.events, sessionId, turnId, 'model.completed', { finishReason: 'stop' });
  await append(s.events, sessionId, turnId, 'turn.completed');
}
const cases = [];
for (const legacy of [false, true]) {
  const s = await state(`old-mcp-new-clean-${legacy ? 'legacy' : 'tagged'}`);
  const sessionId = newSessionId(), oldTurn = newTurnId(), newTurn = newTurnId();
  await failure(s, sessionId, oldTurn, { mcp: true, legacy });
  const oldResult = await s.reflector.reflect({ sessionId, turnId: oldTurn, outcome: { status: 'failed', state: { goal: 'old MCP task' } } });
  await clean(s, sessionId, newTurn);
  const newResult = await s.reflector.reflect({ sessionId, turnId: newTurn, outcome: { status: 'completed', state: { goal: 'new clean task' } } });
  const candidates = await s.candidateStore.list(), journal = await s.reflector.listJournal(), events = await s.events.list(sessionId);
  assert.equal(oldResult.candidates, 1);
  assert.equal(newResult.candidates, 1);
  assert.equal(candidates.length, 2);
  assert.equal(candidates[0].sourceCandidate.promotionState, 'quarantined');
  assert.equal(candidates[1].sourceCandidate.promotionState, legacy ? 'quarantined' : 'pending');
  assert.equal(candidates[1].sourceCandidate.sourceTurn, newTurn);
  assert.deepEqual(candidates[1].sourceCandidate.structured.evidenceRefs, candidates[0].sourceCandidate.structured.evidenceRefs);
  assert.equal(journal[1].turnId, newTurn);
  assert.match(journal[1].reflection.evidence, /new clean task/);
  const receipt = { label: `old-mcp-new-clean-${legacy ? 'legacy' : 'tagged'}`, legacy, sessionId, oldTurn, newTurn, oldResult, newResult, candidates, journal, events };
  cases.push(receipt);
  await writeFile(join(out, `${receipt.label}.json`), JSON.stringify(receipt, null, 2) + '\n');
}

const concurrency = [];
for (let round = 0; round < 10; round++) {
  const s = await state(`concurrent-journal-${round}`);
  const inputs = [];
  for (let i = 0; i < 20; i++) {
    const sessionId = newSessionId(), turnId = newTurnId();
    await failure(s, sessionId, turnId);
    inputs.push({ sessionId, turnId, outcome: { status: 'failed', state: { goal: `independent session ${i}` } } });
  }
  const results = await Promise.all(inputs.map(input => s.reflector.reflect(input)));
  const candidates = await s.candidateStore.list(), journal = await s.reflector.listJournal();
  const journalBytes = await readFile(join(s.dataDir, REFLECTION_FILE_NAME));
  const announcedOutputs = results.reduce((sum, x) => sum + x.outputs, 0);
  assert.equal(candidates.length, 20);
  assert.equal(announcedOutputs, 20);
  const receipt = { round, expected: 20, announcedOutputs, candidateCount: candidates.length, journalCount: journal.length, uniqueJournalTurns: new Set(journal.map(x => x.turnId)).size, journalSha256: sha256(journalBytes), inputs, results, journal };
  concurrency.push(receipt);
  await writeFile(join(out, `concurrent-journal-${round}.json`), JSON.stringify(receipt, null, 2) + '\n');
}
assert.ok(concurrency.some(x => x.journalCount !== x.expected), 'baseline race did not reproduce');

const journalFailure = await state('journal-error-compatibility');
await mkdir(join(journalFailure.dataDir, REFLECTION_FILE_NAME));
const badSession = newSessionId(), badTurn = newTurnId();
await failure(journalFailure, badSession, badTurn);
const journalErrorResult = await journalFailure.reflector.reflect({ sessionId: badSession, turnId: badTurn, outcome: { status: 'failed' } });
assert.equal(journalErrorResult.outputs, 1);
assert.equal(journalErrorResult.candidates, 1);
const metadata = {
  schema: 1, mode: 'baseline deterministic defect reproduction using built production modules and actual filesystem stores',
  observedAt: new Date().toISOString(), repo,
  head: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim(),
  trackedStatus: execFileSync('git', ['status', '--short', '--untracked-files=no'], { cwd: repo, encoding: 'utf8' }).trim(),
  sources: await Promise.all(inputFiles.map(async path => ({ path, sha256: sha256(await readFile(join(repo, path))) }))),
  paidModelCalls: 0,
  summary: {
    taggedOldMcpFailureRequeuedForCleanTurn: cases[0].newResult.candidates === 1,
    pollutedOldEvidenceLostQuarantineWhenRelabeledNewTurn: cases[0].candidates[1].sourceCandidate.promotionState === 'pending',
    legacyOldMcpRequestLeaksIntoNewTurnPollution: cases[1].candidates[1].sourceCandidate.promotionState === 'quarantined',
    concurrentRounds: concurrency.length,
    concurrentRoundsLosingJournalRows: concurrency.filter(x => x.journalCount !== x.expected).length,
    concurrentRowsExpected: 200,
    concurrentRowsSurviving: concurrency.reduce((sum, x) => sum + x.journalCount, 0),
    journalErrorResult,
  },
};
await writeFile(join(out, 'summary.json'), JSON.stringify(metadata, null, 2) + '\n');
console.log(JSON.stringify(metadata.summary));
