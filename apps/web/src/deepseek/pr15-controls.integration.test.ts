import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { afterEach, expect, it, onTestFailed } from 'vitest';
import { createHarness } from '@ar/harness';
import { ScriptedModelProvider } from '@ar/model';
import type { SessionId } from '@ar/contracts';
import { createDeepseekComposition } from './composition.js';
import { projectSessionHistory } from './projections.js';
import { allocateAvailableLeaseFixture } from './test-support/lease-fixture.js';
import { sessionMetadataTool } from './session.js';

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
const signal = () => new AbortController().signal;
// This is a coarse hang guard for fixture allocation, durable setup and cleanup
// as well as the business assertions. The narrower 30s / 10s / 15s polling
// deadlines below remain unchanged. In particular, 10s + 15s + 1.2s cannot fit
// inside the old 20s outer guard, even before Windows durable IO and leases.
const goalIntegrationTimeoutMs = 120_000;
function goalStages(test: string): (stage: string) => void {
  const started = performance.now();
  const stages: Array<{ stage: string; elapsedMs: number }> = [];
  const mark = (stage: string) => { stages.push({ stage, elapsedMs: Math.round(performance.now() - started) }); };
  mark('fixture:start');
  // Keep diagnostics synchronous: an async read of a stalled store could hide
  // the very await that caused the timeout. No project/user content is logged.
  // The existing CI reporter publishes Error: headlines. Put the last business
  // stage first so its short public annotation survives a blocked log download.
  onTestFailed(() => console.error('Error: goal-acceptance-stages', JSON.stringify({ test,
    stage: stages.findLast(item => !item.stage.startsWith('cleanup:'))?.stage,
    last: stages.at(-1)?.stage, elapsedMs: Math.round(performance.now() - started), stages })));
  return mark;
}
async function fixture(profile: 'test' | 'interactive' = 'test', tool: { name: string; args: Record<string, unknown> } | null = { name: 'write_file', args: { path: 'proof.txt', content: 'real bytes' } }, mark: (stage: string) => void = () => {}) {
  return allocateAvailableLeaseFixture(async () => {
    mark('fixture:lease-attempt');
    const root = await mkdtemp(join(tmpdir(), 'pr15-controls-')); cleanup.push(() => rm(root, { recursive: true, force: true, maxRetries: 8 }));
    const cwd = join(root, 'work'); await mkdir(cwd);
    const provider = new ScriptedModelProvider([...(tool ? [ScriptedModelProvider.toolCall(tool.name, tool.args)] : []), ScriptedModelProvider.text('Plan: write proof.txt, then verify its contents.')]);
    const config = { cwd, dataDir: join(root, 'data'), profile, modelProvider: provider, model: { providerId: provider.id, modelId: 'test' } };
    mark('fixture:harness-open'); const base = await createHarness(config); mark('fixture:harness-ready');
    cleanup.push(async () => { mark('cleanup:harness-start'); await base.close(); mark('cleanup:harness-finished'); });
    const composition = await createDeepseekComposition(base, join(root, 'data'));
    cleanup.push(async () => { mark('cleanup:composition-start'); await composition.close(); mark('cleanup:composition-finished'); });
    mark('fixture:composition-ready');
    const { sessionId } = await composition.sessions.call('session/create', { request: {} }, signal()) as { sessionId: string }; mark('fixture:session-ready');
    const command = (line: string) => composition.activity.call('commands/execute', { agentId: sessionId, line, submittedAttachments: [] }, signal());
    const run = async (id = sessionId) => { const owner = await composition.owners.ownerOf(id); const actor = await owner.sessions.load(composition.owners.nativeSessionId(id));
      const turn = await actor.createTurn({ sessionId: composition.owners.nativeSessionId(id), text: 'Write a proof and describe the plan.' }); return actor.runTurn(turn.id); };
    return { root, cwd, base, composition, sessionId, command, run, config };
  }, cleanup);
}

it('PR15 read-only selection persists and denies a real model write through the original orchestrator', async () => {
  const f = await fixture(); expect(await f.command('/permission read-only')).toMatchObject({ result: { kind: 'success' } });
  await f.run(); await expect(readFile(join(f.cwd, 'proof.txt'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  const projected = await f.composition.sessions.call('session/projections', { request: { sessionId: f.sessionId } }, signal());
  expect(JSON.stringify(projected)).toContain('read-only');
});

it('PR15 controls are session-scoped and do not mutate frozen agent policy', async () => {
  const f = await fixture(); const before = JSON.stringify(await f.composition.harness.runtime.getSessionAgent(f.sessionId as SessionId));
  await f.command('/permission read-only');
  const second = await f.composition.sessions.call('session/create', { request: {} }, signal()) as { sessionId: string };
  expect((await f.composition.controls.read(second.sessionId)).permission).toBe('workspace-write');
  expect(JSON.stringify(await f.composition.harness.runtime.getSessionAgent(f.sessionId as SessionId))).toBe(before);
  const denied = await f.composition.tools.executeTool(f.sessionId, 'web_workspace_mkdir', { path: f.cwd, name: 'denied-dir' }, signal());
  expect(denied.status).toBe('denied');
  await expect(f.composition.terminal.call('terminal/close', { agentId: f.sessionId, id: 'not-created' }, signal())).resolves.toBeUndefined();
  const persisted = JSON.parse(await readFile(join(f.root, 'data/deepseek/session-metadata.json'), 'utf8'));
  expect(persisted.sessions[f.sessionId].controls.permission).toBe('read-only');
});

it('PR15 a committed control-only mutation advances the native projection watermark', async () => {
  const f = await fixture(); await f.command('/plan on'); // Keep the goal driver inactive.
  const snapshot = () => f.composition.sessions.call('session/projections', { request: { sessionId: f.sessionId } }, signal()) as Promise<{ asOfSeq: number; values: Record<string, unknown> }>;
  const before = await snapshot(); expect(before.asOfSeq).toBeGreaterThanOrEqual(0);
  await f.composition.activity.call('goals/create', { agentId: f.sessionId, request: { objective: 'CONTROL_PROJECTION_PRIVATE_GOAL' } }, signal());
  const after = await snapshot(); expect(JSON.stringify(after.values.goal)).toContain('CONTROL_PROJECTION_PRIVATE_GOAL');
  // The retained native store rejects seq <= its current row, even if the
  // value changed. A real post-commit fence must advance the wire cursor.
  expect(after.asOfSeq).toBeGreaterThan(before.asOfSeq);
  const page = await f.composition.sessions.call('session/page', { request: { address: { kind: 'session', sessionId: f.sessionId }, throughSeq: after.asOfSeq } }, signal()) as { records: Array<{ event: { seq: number; type: string; ignorable?: boolean } }> };
  const fence = page.records.find(record => record.event.seq === after.asOfSeq)!;
  expect(fence.event).toMatchObject({ type: 'harness/tool.completed', ignorable: true });
  expect(JSON.stringify(fence)).not.toContain('CONTROL_PROJECTION_PRIVATE_GOAL');
  expect(await f.composition.harness.inbox.listAll(f.sessionId as SessionId)).toHaveLength(0);
});

it('PR15 mode guidance is included in the actual context budget without promoting the user goal to system authority', async () => {
  const f = await fixture();
  const owner = await f.composition.owners.ownerOf(f.sessionId), nativeId = f.composition.owners.nativeSessionId(f.sessionId);
  const frozenBefore = JSON.stringify(await owner.runtime.getSessionAgent(nativeId));
  const build = () => owner.context.pipeline.build({ cwd: f.cwd, telemetrySessionId: nativeId, systemPrompt: 'Base policy.', priorBlocks: [], messages: [],
    budget: { maxTokens: 2000, reserved: { system: 0, task: 0, output: 0 }, dynamic: 2000 } });
  const initial = await build();
  await f.command('/plan on');
  const objective = ('GOAL_DATA_ONLY_' + 'user-supplied objective '.repeat(500)).trim();
  await f.command('/goal ' + objective);
  const planned = await build(), system = planned.blocks.find(block => block.source === 'system')!;
  expect(system.content).toContain('PLAN MODE');
  expect(system.content).not.toContain('GOAL_DATA_ONLY_');
  expect(system.tokens).toBeGreaterThan(initial.blocks.find(block => block.source === 'system')!.tokens);
  expect(planned.report.used).toBe(planned.blocks.reduce((sum, block) => sum + block.tokens, 0));
  expect(planned.report.used).toBeLessThan(500);
  expect((await f.composition.controls.read(f.sessionId)).goal?.objective).toBe(objective);
  await f.command('/goal pause'); await f.command('/plan off');
  expect((await build()).blocks.find(block => block.source === 'system')!.content).toBe('Base policy.');
  expect(JSON.stringify(await owner.runtime.getSessionAgent(nativeId))).toBe(frozenBefore);
});

it('PR15 read-only guidance is budgeted and isolated from another session', async () => {
  const f = await fixture(); await f.command('/permission read-only');
  const second = await f.composition.sessions.call('session/create', { request: {} }, signal()) as { sessionId: string };
  const build = async (id: string) => (await f.composition.owners.ownerOf(id)).context.pipeline.build({ cwd: f.cwd,
    telemetrySessionId: f.composition.owners.nativeSessionId(id), systemPrompt: 'Base policy.', priorBlocks: [], messages: [],
    budget: { maxTokens: 2000, reserved: { system: 0, task: 0, output: 0 }, dynamic: 2000 } });
  expect((await build(f.sessionId)).blocks.find(block => block.source === 'system')!.content).toContain('human selected read-only');
  expect((await build(second.sessionId)).blocks.find(block => block.source === 'system')!.content).toBe('Base policy.');
});

it('PR15 goal continuation uses a real durable inbox and stops at its round budget', async () => {
  const mark = goalStages('goal-round-budget');
  const f = await fixture('test', undefined, mark);
  const owner = await f.composition.owners.ownerOf(f.sessionId), execute = owner.orchestrator.executeBound.bind(owner.orchestrator);
  let delayed = false;
  owner.orchestrator.executeBound = async (request, context) => {
    if (!delayed && request.binding.definition.name === 'write_file') {
      delayed = true;
      mark('tool:slow-write-start');
      // One legitimate slow operation exceeds the old six-second assertion.
      // Still use the real binding, permission engine, sandbox and file tool.
      await new Promise(resolve => setTimeout(resolve, 7200));
      mark('tool:slow-write-released');
    }
    return execute(request, context);
  };
  mark('goal:admission-start');
  await f.composition.activity.call('goals/create', { agentId: f.sessionId, request: { objective: 'Write the proof and verify', maxGoalRounds: 1 } }, signal());
  mark('goal:admitted');
  // Include the deliberate 7.2s operation, durable admission/settlement and the
  // next driver tick. Six seconds rejected legal progress on native Windows.
  await expect.poll(async () => (await f.composition.controls.read(f.sessionId)).goal?.phase, { timeout: 30000 }).toBe('blocked');
  mark('goal:blocked');
  expect(delayed).toBe(true);
  const goal = (await f.composition.controls.read(f.sessionId)).goal!;
  expect(goal.roundsStarted).toBe(1); expect(goal.blockedReason?.code).toBe('round-limit');
  const inbox = await f.composition.harness.inbox.listAll(f.sessionId as SessionId);
  expect(inbox).toHaveLength(1); expect(inbox[0]!.status).toBe('consumed');
  expect(await readFile(join(f.cwd, 'proof.txt'), 'utf8')).toBe('real bytes');
  mark('assertions:complete');
}, goalIntegrationTimeoutMs);

it('PR15 pausing a goal lets its admitted read round settle without starting another round', async () => {
  const mark = goalStages('goal-pause');
  const f = await fixture('test', { name: 'read_file', args: { path: 'proof.txt' } }, mark);
  await writeFile(join(f.cwd, 'proof.txt'), 'An actual readable proof');
  const owner = await f.composition.owners.ownerOf(f.sessionId), execute = owner.orchestrator.executeBound.bind(owner.orchestrator);
  let entered = false, release!: () => void;
  const blocked = new Promise<void>(done => { release = done; });
  owner.orchestrator.executeBound = async (request, context) => {
    if (request.binding.definition.name === 'read_file') { entered = true; mark('tool:read-entered'); await blocked; }
    return execute(request, context);
  };
  try {
    mark('goal:admission-start');
    await f.composition.activity.call('goals/create', { agentId: f.sessionId, request: { objective: 'Read the proof and explain it' } }, signal());
    mark('goal:admitted');
    await expect.poll(() => entered, { timeout: 10000 }).toBe(true);
    const goal = (await f.composition.controls.read(f.sessionId)).goal!;
    expect(goal.roundsStarted).toBe(1); expect(f.config.modelProvider.calls).toHaveLength(1);
    mark('goal:pause-start');
    await f.composition.activity.call('goals/pause', { agentId: f.sessionId, ref: { id: goal.id, revision: goal.revision } }, signal());
    mark('goal:paused');
    release();
    await expect.poll(async () => (await f.composition.harness.store.listTurns(f.sessionId as SessionId)).map(turn => turn.status), { timeout: 15000 }).toEqual(['completed']);
    mark('turn:completed');
    // The second model request consumes this admitted round's real read result;
    // counting every HTTP/model request as a new goal round is incorrect.
    expect(f.config.modelProvider.calls).toHaveLength(2);
    await new Promise(done => setTimeout(done, 1200));
    expect((await f.composition.controls.read(f.sessionId)).goal).toMatchObject({ phase: 'paused', roundsStarted: 1 });
    expect(await f.composition.harness.inbox.listAll(f.sessionId as SessionId)).toHaveLength(1);
    expect(f.config.modelProvider.calls).toHaveLength(2);
    mark('assertions:complete');
  } finally { release(); }
}, goalIntegrationTimeoutMs);

it('PR15 manual compression emits an actual context event and retains the full transcript', async () => {
  const f = await fixture(); await f.command('/permission read-only'); await f.command('/compact');
  expect((await f.composition.controls.read(f.sessionId)).compaction?.pending).toBe(true);
  await f.run();
  await expect.poll(async () => (await f.composition.controls.read(f.sessionId)).compaction?.pending).toBe(false);
  const events = await f.composition.harness.events.list(f.sessionId as SessionId);
  expect(events.some(event => event.type === 'context.compacted' && event.payload.manual === true)).toBe(true);
  expect((await f.composition.harness.store.listMessages(f.sessionId as SessionId)).some(message => message.role === 'user' && message.content.includes('Write a proof'))).toBe(true);
});

it('PR15 downgrading permission cancels an already waiting write approval', async () => {
  const f = await fixture('interactive'); const owner = await f.composition.owners.ownerOf(f.sessionId);
  const running = f.run();
  await expect.poll(() => owner.approvalStore.listPending().length).toBe(1);
  const original = owner.approvalStore.listPending()[0]!;
  await f.command('/permission read-only');
  await running;
  expect(owner.approvalStore.listPending()).toHaveLength(0);
  expect(() => owner.approvalStore.resolve(original.id, 'allow')).toThrow();
  await expect(readFile(join(f.cwd, 'proof.txt'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
});

it.each(['/plan on', '/permission read-only'])('PR15 an existing child cannot bypass the parent restriction %s', async mode => {
  const f = await fixture(); const owner = await f.composition.owners.ownerOf(f.sessionId);
  const parentId = f.composition.owners.nativeSessionId(f.sessionId);
  const child = await owner.runtime.createSession({ agent: await owner.runtime.getSessionAgent(parentId), parentId, cwd: f.cwd });
  await f.command(mode);
  const actor = await owner.sessions.load(child.id), turn = await actor.createTurn({ sessionId: child.id, text: 'Write proof.txt from the existing child' });
  await actor.runTurn(turn.id);
  await expect(readFile(join(f.cwd, 'proof.txt'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
});

it('PR15 completed goals cannot be resumed into duplicate work', async () => {
  const f = await fixture(); await f.command('/plan on'); await f.command('/goal A human reviewed goal');
  const goal = (await f.composition.controls.read(f.sessionId)).goal!;
  await f.composition.activity.call('goals/complete', { agentId: f.sessionId, ref: { id: goal.id, revision: goal.revision } }, signal());
  const complete = (await f.composition.controls.read(f.sessionId)).goal!;
  await expect(f.composition.activity.call('goals/resume', { agentId: f.sessionId, ref: { id: complete.id, revision: complete.revision } }, signal())).rejects.toMatchObject({ code: 'goal/invalid-phase' });
  expect(await f.composition.harness.inbox.listAll(f.sessionId as SessionId)).toHaveLength(0);
});

it.each(['/permission read-only', '/plan on'])('PR15 blocks real process effects for %s', async mode => {
  const f = await fixture('test', { name: 'exec', args: { command: process.execPath, args: ['-e', "require('node:fs').writeFileSync('exec-proof.txt', 'must not run')"] } });
  await f.command('/permission danger-full-access --confirmed'); await f.command(mode); await f.run();
  await expect(readFile(join(f.cwd, 'exec-proof.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
  expect((await f.composition.harness.events.list(f.sessionId as SessionId)).some(event => event.type === 'security.permission_denied' && event.payload.tool === 'exec')).toBe(true);
});

it.each(['workspace-write', 'danger-full-access'] as const)('PR15 enforces actual filesystem scope for %s', async preset => {
  const f = await fixture('test', { name: 'write_file', args: { path: '../outside-proof.txt', content: 'explicit full access bytes' } });
  await f.command('/permission ' + preset + (preset === 'danger-full-access' ? ' --confirmed' : '')); await f.run();
  if (preset === 'workspace-write') await expect(readFile(join(f.root, 'outside-proof.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
  else expect(await readFile(join(f.root, 'outside-proof.txt'), 'utf8')).toBe('explicit full access bytes');
});

it('manual compaction in a fresh production session never rewrites a published history prefix', async () => {
  const f = await fixture('test', null); await f.command('/compact'); await f.run();
  const session = (await f.composition.harness.store.getSession(f.sessionId as SessionId))!;
  const messages = await f.composition.harness.store.listMessages(f.sessionId as SessionId);
  const events = await f.composition.harness.events.list(f.sessionId as SessionId);
  let prefix: ReturnType<typeof projectSessionHistory>['records'] = [];
  for (let count = 1; count <= events.length; count++) {
    const snapshot = projectSessionHistory({ session, messages, events: events.slice(0, count) });
    expect(snapshot.records.slice(0, prefix.length), `Projection changed at source event ${events[count - 1]!.type}`).toEqual(prefix);
    prefix = snapshot.records;
  }
});

it('PR15 a restarted production composition restores controls and still denies actual project writes', async () => {
  const f = await fixture(); await f.command('/permission read-only'); await f.command('/plan on');
  await f.command('/goal Preserve the reviewed objective');
  await f.command('/compact');
  await f.composition.close(); await f.base.close();
  const base = await createHarness(f.config); cleanup.push(() => base.close());
  const restored = await createDeepseekComposition(base, f.config.dataDir); cleanup.push(() => restored.close());
  const state = await restored.controls.read(f.sessionId);
  expect(state.permission).toBe('read-only'); expect(state.plan.status).toBe('draft'); expect(state.goal?.objective).toBe('Preserve the reviewed objective');
  const owner = await restored.owners.ownerOf(f.sessionId), nativeId = restored.owners.nativeSessionId(f.sessionId);
  const actor = await owner.sessions.load(nativeId), turn = await actor.createTurn({ sessionId: nativeId, text: 'Try writing after restart' });
  await actor.runTurn(turn.id);
  await expect(readFile(join(f.cwd, 'proof.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
  await expect.poll(async () => (await restored.controls.read(f.sessionId)).compaction?.pending).toBe(false);
});

it('PR15 resumes the same admitted goal inbox after restart without inventing another prompt', async () => {
  const f = await fixture(); await f.command('/plan on'); await f.command('/goal Resume the actual proof');
  await f.composition.controls.close(); // Fault window: host driver stopped before inbox drain.
  const owner = await f.composition.owners.ownerOf(f.sessionId), nativeId = f.composition.owners.nativeSessionId(f.sessionId);
  const text = 'Continue the actual admitted goal proof after restart', requestId = `goal-${(await f.composition.controls.read(f.sessionId)).goal!.id}-2`;
  const actor = await owner.sessions.load(nativeId); await actor.inputQueue.enqueueFollowup({ sessionId: nativeId, text });
  const prompt = (await owner.inbox.listAll(nativeId))[0]!;
  const tool = sessionMetadataTool(f.composition.sessions.metadata, row => {
    const goal = row.controls!.goal!; goal.pending = { requestId, text }; goal.roundsStarted = 1; goal.maxGoalRounds = 1; goal.revision++;
    row.controls!.plan.status = 'off';
    row.requests[requestId] = { fingerprint: createHash('sha256').update(JSON.stringify({ content: [{ type: 'text', text }], mode: 'queue' })).digest('hex'),
      text, mode: 'queue', startedAt: prompt.admittedAt, beforePromptIds: [], status: 'accepted', promptId: prompt.id };
  });
  expect((await f.composition.tools.executeHostTool(f.sessionId, tool, { path: f.composition.sessions.metadata.path!, sessionId: f.sessionId }, signal())).status).toBe('success');
  await f.composition.close(); await f.base.close();
  const base = await createHarness(f.config); cleanup.push(() => base.close());
  const restored = await createDeepseekComposition(base, f.config.dataDir); cleanup.push(() => restored.close());
  await expect.poll(() => readFile(join(f.cwd, 'proof.txt'), 'utf8').catch(() => ''), { timeout: 5000 }).toBe('real bytes');
  await expect.poll(async () => (await restored.harness.inbox.listAll(f.sessionId as SessionId))[0]?.status).toBe('consumed');
  const inbox = await restored.harness.inbox.listAll(f.sessionId as SessionId);
  expect(inbox).toHaveLength(1); expect(inbox[0]!.id).toBe(prompt.id); expect(inbox[0]!.promotedTurnId).toBeDefined();
});

it('PR15 workspace permission retains the real allowed file execution', async () => {
  const f = await fixture(); expect(await f.command('/permission workspace-write')).toMatchObject({ result: { kind: 'success' } });
  await f.run(); expect(await readFile(join(f.cwd, 'proof.txt'), 'utf8')).toBe('real bytes');
});

it('PR15 an idle host with no active goal does not poll session metadata', async () => {
  const f = await fixture(), store = f.composition.sessions.metadata, read = store.read.bind(store); let reads = 0;
  store.read = async id => { reads++; return read(id); };
  try { await new Promise(done => setTimeout(done, 1150)); expect(reads).toBe(0); }
  finally { store.read = read; }
});

it('PR15 ordinary custom request ids beginning with goal are not treated as background claims', async () => {
  const f = await fixture();
  await f.composition.sessions.call('session/prompt', { request: { sessionId: f.sessionId, requestId: 'goal-human-task', mode: 'queue', content: [{ type: 'text', text: 'Write the proof normally' }] } }, signal());
  await expect.poll(() => readFile(join(f.cwd, 'proof.txt'), 'utf8').catch(() => '')).toBe('real bytes');
});

it('PR15 full access requires explicit confirmation and is owned by this session', async () => {
  const f = await fixture(); await expect(f.command('/permission danger-full-access')).rejects.toMatchObject({ code: 'permission/confirmation-required' });
  expect(await f.command('/permission danger-full-access --confirmed')).toMatchObject({ result: { kind: 'success' } });
  expect(JSON.stringify(await f.composition.sessions.call('session/projections', { request: { sessionId: f.sessionId } }, signal()))).toContain('danger-full-access');
});

it('PR15 an unconfirmed plan denies actual writes even after full access was selected', async () => {
  const f = await fixture(); await f.command('/permission danger-full-access --confirmed');
  expect(await f.command('/plan on')).toMatchObject({ result: { kind: 'success' } }); await f.run();
  await expect(readFile(join(f.cwd, 'proof.txt'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  await expect.poll(async () => JSON.stringify(await f.composition.sessions.call('session/projections', { request: { sessionId: f.sessionId } }, signal()))).toContain('Plan: write proof.txt');
});

it('PR15 goal create pause edit resume and clear use revisioned durable state', async () => {
  const f = await fixture(); await f.command('/plan on'); expect(await f.command('/goal Create a proof')).toMatchObject({ result: { kind: 'success' } });
  const read = () => f.composition.activity.call('goals/get', { agentId: f.sessionId }, signal()) as Promise<{ id: string; revision: number; objective: string; phase: string }>;
  const created = await read(); expect(created.objective).toBe('Create a proof');
  await f.composition.activity.call('goals/pause', { agentId: f.sessionId, ref: { id: created.id, revision: created.revision } }, signal());
  expect((await read()).phase).toBe('paused');
  const paused = await read(); await f.composition.activity.call('goals/edit', { agentId: f.sessionId, ref: { id: paused.id, revision: paused.revision }, request: { objective: 'Updated proof' } }, signal());
  const edited = await read(); expect(edited.objective).toBe('Updated proof');
  await expect(f.composition.activity.call('goals/resume', { agentId: f.sessionId, ref: { id: paused.id, revision: paused.revision } }, signal())).rejects.toMatchObject({ code: 'goal/conflict' });
  await f.composition.activity.call('goals/resume', { agentId: f.sessionId, ref: { id: edited.id, revision: edited.revision } }, signal());
  const resumed = await read(); expect(resumed.phase).toBe('active');
  await f.composition.activity.call('goals/clear', { agentId: f.sessionId, ref: { id: resumed.id, revision: resumed.revision } }, signal());
  expect(await read()).toBeUndefined();
});
