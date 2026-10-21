import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { newPromptId, type SessionId } from '@ar/contracts';
import { createHarness } from '@ar/harness';
import { ScriptedModelProvider } from '@ar/model';
import { createDeepseekComposition } from './composition.js';
import { sessionMetadataTool } from './session.js';
import { allocateAvailableLeaseFixture } from './test-support/lease-fixture.js';

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
const signal = () => new AbortController().signal;
function barrier() {
  let release!: () => void;
  const promise = new Promise<void>(done => { release = done; });
  return { promise, release };
}
async function open(config: Parameters<typeof createHarness>[0], dataDir: string) {
  const base = await createHarness(config); cleanup.push(() => base.close());
  const composition = await createDeepseekComposition(base, dataDir); cleanup.push(() => composition.close());
  return { base, composition };
}
async function fixture(scripts: ConstructorParameters<typeof ScriptedModelProvider>[0]) {
  return allocateAvailableLeaseFixture(async () => {
    const root = await mkdtemp(join(tmpdir(), 'goal-revision-'));
    cleanup.push(() => rm(root, { recursive: true, force: true, maxRetries: 8 }));
    const cwd = join(root, 'work'); await mkdir(cwd); await writeFile(join(cwd, 'proof.txt'), 'actual readable proof');
    const provider = new ScriptedModelProvider(scripts), dataDir = join(root, 'data');
    const config = { cwd, dataDir, profile: 'test' as const, modelProvider: provider, model: { providerId: provider.id, modelId: 'test' } };
    const stack = await open(config, dataDir);
    const { sessionId } = await stack.composition.sessions.call('session/create', { request: {} }, signal()) as { sessionId: SessionId };
    return { ...stack, root, cwd, dataDir, config, provider, sessionId };
  }, cleanup);
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
type Ref = { id: string; revision: number };
async function createGoal(f: Fixture, maxGoalRounds = 3): Promise<Ref> {
  const created = await f.composition.activity.call('goals/create', { agentId: f.sessionId,
    request: { objective: 'Read the proof and report the remaining work', maxGoalRounds } }, signal()) as { ref: Ref };
  return created.ref;
}
async function command(f: Pick<Fixture, 'composition' | 'sessionId'>, line: string) {
  return f.composition.activity.call('commands/execute', { agentId: f.sessionId, line, submittedAttachments: [] }, signal());
}
async function snapshot(f: Pick<Fixture, 'composition' | 'sessionId'>) {
  return f.composition.sessions.call('session/projections', { request: { sessionId: f.sessionId } }, signal()) as Promise<{
    asOfSeq: number; values: { harnessGoal: { id: string; revision: number; roundsStarted: number } };
  }>;
}
async function mutateLegacy(f: Fixture, change: Parameters<typeof sessionMetadataTool>[1]) {
  const tool = sessionMetadataTool(f.composition.sessions.metadata, change);
  expect((await f.composition.tools.executeHostTool(f.sessionId, tool, {
    path: f.composition.sessions.metadata.path!, sessionId: f.sessionId,
  }, signal())).status).toBe('success');
}
const readThenStop = () => [ScriptedModelProvider.toolCall('read_file', { path: 'proof.txt' }), ScriptedModelProvider.text('Read the actual proof; remaining work still needs verification.')];

it('automatic round progress advances projections without invalidating a rendered pause ref', async () => {
  const f = await fixture(readThenStop()), gate = barrier();
  const owner = await f.composition.owners.ownerOf(f.sessionId), execute = owner.orchestrator.executeBound.bind(owner.orchestrator);
  let entered = false;
  owner.orchestrator.executeBound = async (request, context) => {
    if (request.binding.definition.name === 'read_file') { entered = true; await gate.promise; }
    return execute(request, context);
  };
  try {
    // Hold automatic admission until the rendered ref and projection cursor
    // are captured; a slow filesystem must not turn this into a timing race.
    await command(f, '/plan on');
    const rendered = await createGoal(f), before = await snapshot(f);
    await command(f, '/plan off');
    await expect.poll(() => entered, { timeout: 10000 }).toBe(true);
    const after = await snapshot(f), goal = (await f.composition.controls.read(f.sessionId)).goal!;
    expect(goal.roundsStarted).toBe(1); expect(goal.revision).toBe(rendered.revision);
    expect(after.values.harnessGoal).toMatchObject({ revision: rendered.revision, roundsStarted: 1 });
    expect(after.asOfSeq).toBeGreaterThan(before.asOfSeq);
    expect(f.provider.calls).toHaveLength(1);
    await expect(f.composition.activity.call('goals/pause', { agentId: f.sessionId, ref: rendered }, signal())).resolves.toMatchObject({ phase: 'paused' });
    gate.release();
    await expect.poll(async () => (await f.composition.harness.inbox.listAll(f.sessionId)).map(row => row.status), { timeout: 15000 }).toEqual(['consumed']);
    expect((await f.composition.harness.store.listTurns(f.sessionId)).map(turn => turn.status)).toEqual(['completed']);
    await new Promise(done => setTimeout(done, 1200));
    expect((await f.composition.controls.read(f.sessionId)).goal).toMatchObject({ phase: 'paused', roundsStarted: 1 });
    expect(f.provider.calls).toHaveLength(2);
  } finally { gate.release(); }
}, 120000);

it('pausing a newly named goal prompt still denies a write before its controlled effect', async () => {
  const f = await fixture([ScriptedModelProvider.toolCall('write_file', { path: 'late-write.txt', content: 'must not land' }), ScriptedModelProvider.text('The write was denied.')]);
  const gate = barrier(), owner = await f.composition.owners.ownerOf(f.sessionId), execute = owner.orchestrator.executeBound.bind(owner.orchestrator);
  let entered = false;
  owner.orchestrator.executeBound = async (request, context) => {
    // Hold before the production controlled() wrapper checks the current goal.
    if (request.binding.definition.name === 'write_file') { entered = true; await gate.promise; }
    return execute(request, context);
  };
  try {
    const rendered = await createGoal(f);
    await expect.poll(() => entered, { timeout: 10000 }).toBe(true);
    const goal = (await f.composition.controls.read(f.sessionId)).goal!;
    expect(goal.pending?.requestId).toBe(`goal-${rendered.id}-round-1`);
    await f.composition.activity.call('goals/pause', { agentId: f.sessionId, ref: rendered }, signal());
    gate.release();
    await expect.poll(async () => (await f.composition.harness.inbox.listAll(f.sessionId)).map(row => row.status), { timeout: 15000 }).toEqual(['consumed']);
    await expect(readFile(join(f.cwd, 'late-write.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect((await owner.events.list(f.sessionId)).some(event => event.type === 'security.permission_denied' && event.payload.tool === 'write_file')).toBe(true);
    expect((await f.composition.controls.read(f.sessionId)).goal).toMatchObject({ phase: 'paused', roundsStarted: 1 });
    expect(f.provider.calls).toHaveLength(2);
  } finally { gate.release(); }
}, 120000);

it('a human edit still invalidates the old pause ref and cannot be overwritten by stale controls', async () => {
  const f = await fixture(readThenStop()); await command(f, '/plan on');
  const rendered = await createGoal(f);
  const edited = await f.composition.activity.call('goals/edit', { agentId: f.sessionId, ref: rendered,
    request: { objective: 'Human revised objective' } }, signal()) as { revision: number };
  expect(edited.revision).toBe(rendered.revision + 1);
  await expect(f.composition.activity.call('goals/pause', { agentId: f.sessionId, ref: rendered }, signal())).rejects.toMatchObject({ code: 'goal/conflict' });
  expect((await f.composition.controls.read(f.sessionId)).goal).toMatchObject({ phase: 'active', objective: 'Human revised objective', roundsStarted: 0 });
  expect(await f.composition.harness.inbox.listAll(f.sessionId)).toHaveLength(0);
});

it('a consumed legacy numeric claim survives reopen without colliding with the next round id', async () => {
  const f = await fixture([...readThenStop(), ...readThenStop()]); await command(f, '/plan on');
  const rendered = await createGoal(f, 2), legacyId = `goal-${rendered.id}-2`, text = 'Legacy admitted round one: read proof';
  await mutateLegacy(f, row => {
    const goal = row.controls!.goal!; goal.roundsStarted = 1; goal.revision = 2; goal.pending = { requestId: legacyId, text };
  });
  await f.composition.sessions.call('session/prompt', { request: { sessionId: f.sessionId, requestId: legacyId, mode: 'queue', content: [{ type: 'text', text }] } }, signal());
  await expect.poll(async () => (await f.composition.harness.inbox.listAll(f.sessionId)).map(row => row.status), { timeout: 15000 }).toEqual(['consumed']);
  const first = (await f.composition.harness.inbox.listAll(f.sessionId))[0]!;
  expect(first.promotedTurnId).toBeDefined(); expect(f.provider.calls).toHaveLength(2);
  await f.composition.close(); await f.base.close();
  const next = await open(f.config, f.dataDir), restored = { ...f, ...next }, gate = barrier();
  const owner = await next.composition.owners.ownerOf(f.sessionId), execute = owner.orchestrator.executeBound.bind(owner.orchestrator);
  let entered = false;
  owner.orchestrator.executeBound = async (request, context) => {
    if (request.binding.definition.name === 'read_file') { entered = true; await gate.promise; }
    return execute(request, context);
  };
  try {
    expect((await next.composition.sessions.metadata.read(f.sessionId)).requests[legacyId]?.promptId).toBe(first.id);
    await command(restored, '/plan off');
    await expect.poll(() => entered, { timeout: 10000 }).toBe(true);
    const goal = (await next.composition.controls.read(f.sessionId)).goal!;
    expect(goal.roundsStarted).toBe(2); expect(goal.pending?.requestId).toBe(`goal-${rendered.id}-round-2`);
    expect(goal.pending?.requestId).not.toBe(legacyId);
    await expect.poll(async () => (await next.composition.sessions.metadata.read(f.sessionId)).requests[goal.pending!.requestId]?.promptId,
      { timeout: 10000 }).toBeDefined();
    const metadata = await next.composition.sessions.metadata.read(f.sessionId);
    expect(metadata.requests[legacyId]?.promptId).toBe(first.id);
    expect(metadata.requests[goal.pending!.requestId]?.promptId).not.toBe(first.id);
    gate.release();
    await expect.poll(async () => (await next.composition.harness.inbox.listAll(f.sessionId)).map(row => row.status), { timeout: 15000 }).toEqual(['consumed', 'consumed']);
    await expect.poll(async () => (await next.composition.controls.read(f.sessionId)).goal?.phase, { timeout: 10000 }).toBe('blocked');
    const inbox = await next.composition.harness.inbox.listAll(f.sessionId);
    expect(inbox[0]!.id).toBe(first.id); expect(inbox[0]!.promotedTurnId).toBe(first.promotedTurnId);
    expect(inbox[1]!.promotedTurnId).not.toBe(first.promotedTurnId);
    expect(await next.composition.harness.store.listTurns(f.sessionId)).toHaveLength(2);
    expect(f.provider.calls).toHaveLength(4);
  } finally { gate.release(); }
}, 120000);

it('an admitted legacy numeric pending claim reopens with the same prompt and executes once', async () => {
  const f = await fixture([ScriptedModelProvider.toolCall('write_file', { path: 'restored-proof.txt', content: 'one real write' }), ScriptedModelProvider.text('The admitted legacy task ran once.')]);
  await command(f, '/plan on'); const rendered = await createGoal(f, 1);
  await f.composition.controls.close(); // Stop the host driver before seeding the pre-upgrade durable claim.
  const nativeId = f.composition.owners.nativeSessionId(f.sessionId), owner = await f.composition.owners.ownerOf(f.sessionId);
  const promptId = newPromptId(), admittedAt = Date.now(), text = 'Legacy admitted pending proof', requestId = `goal-${rendered.id}-2`;
  await owner.inbox.admit({ id: promptId, sessionId: nativeId, text, kind: 'followup', status: 'pending', admittedAt });
  await mutateLegacy(f, row => {
    const goal = row.controls!.goal!; goal.roundsStarted = 1; goal.revision = 2; goal.pending = { requestId, text }; row.controls!.plan.status = 'off';
    row.requests[requestId] = { fingerprint: createHash('sha256').update(JSON.stringify({ content: [{ type: 'text', text }], mode: 'queue' })).digest('hex'),
      text, mode: 'queue', startedAt: admittedAt, beforePromptIds: [], status: 'accepted', promptId };
  });
  expect(f.provider.calls).toHaveLength(0);
  await f.composition.close(); await f.base.close();
  const next = await open(f.config, f.dataDir);
  await expect.poll(() => readFile(join(f.cwd, 'restored-proof.txt'), 'utf8').catch(() => ''), { timeout: 15000 }).toBe('one real write');
  await expect.poll(async () => (await next.composition.harness.inbox.listAll(f.sessionId)).map(row => row.status), { timeout: 15000 }).toEqual(['consumed']);
  await expect.poll(async () => (await next.composition.controls.read(f.sessionId)).goal?.phase, { timeout: 10000 }).toBe('blocked');
  const inbox = await next.composition.harness.inbox.listAll(f.sessionId);
  expect(inbox).toHaveLength(1); expect(inbox[0]!.id).toBe(promptId); expect(inbox[0]!.promotedTurnId).toBeDefined();
  expect((await next.composition.sessions.metadata.read(f.sessionId)).requests[requestId]?.promptId).toBe(promptId);
  expect(await next.composition.harness.store.listTurns(f.sessionId)).toHaveLength(1);
  expect((await next.composition.harness.events.list(f.sessionId)).filter(event => event.type === 'tool.requested' && event.payload.name === 'write_file')).toHaveLength(1);
  expect(f.provider.calls).toHaveLength(2);
}, 120000);
