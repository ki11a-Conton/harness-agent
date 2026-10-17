import { expect, it, vi } from 'vitest';
import { newEventId } from '@ar/contracts';
import { setup, signal } from '../../src/deepseek/test-support/pr8-fixtures.js';

it('rejects a missing first event in an ordinary native session through the actual session service', async () => {
  const stack = await setup();
  await stack.harness.events.appendNew({ id: newEventId(), sessionId: stack.id, type: 'session.resumed', timestamp: Date.now(), payload: {} });
  const list = stack.harness.events.list.bind(stack.harness.events);
  const original = await list(stack.id); expect(original[0]!.sequence).toBe(0); expect(original.length).toBeGreaterThan(1);
  vi.spyOn(stack.harness.events, 'list').mockImplementation(async (id, options) => {
    const events = await list(id, options); return id === stack.id && options === undefined ? events.slice(1) : events;
  });
  await expect(stack.call('session/projections', { sessionId: stack.id })).rejects.toThrow(/not contiguous/);
});

it('healthy retired owners retain the complete dense prefix and open the actual control stream', async () => {
  const stack = await setup(true), controller = new AbortController();
  await stack.manager!.selectModel(stack.id, { providerKey: 'selected-one', modelId: 'one' }, signal());
  await stack.manager!.selectModel(stack.id, { providerKey: 'selected-two', modelId: 'two' }, signal());
  const events = await stack.harness.events.list(stack.id);
  expect(events.length).toBeGreaterThan(2); expect(events.map(event => event.sequence)).toEqual(events.map((_, index) => index));
  const stream = stack.service.stream('session/control', {}, controller.signal)[Symbol.asyncIterator]();
  try {
    const frame = (await stream.next()).value as { type: string; value: { projections: Record<string, unknown> } };
    expect(frame.type).toBe('baseline'); expect(frame.value.projections[stack.id]).toBeDefined();
  } finally { controller.abort(); await stream.return?.(); }
});

it('rejects a missing retired-owner prefix through the actual owner facade and session service', async () => {
  const stack = await setup(true), oldOwner = await stack.manager!.ownerOf(stack.id);
  await stack.manager!.selectModel(stack.id, { providerKey: 'selected', modelId: 'new-model' }, signal());
  const list = oldOwner.events.list.bind(oldOwner.events);
  expect((await list(stack.id)).length).toBeGreaterThan(0);
  vi.spyOn(oldOwner.events, 'list').mockImplementation(async (id, options) => id === stack.id ? [] : list(id, options));
  const visible = await stack.harness.events.list(stack.id); expect(visible[0]!.sequence).toBeGreaterThan(0);
  await expect(stack.call('session/projections', { sessionId: stack.id })).rejects.toThrow(/not contiguous/);
});

it.each([0, 7])('offset=%i holds an unbound queue promotion until its durable binding', async offset => {
  const stack = await setup();
  const list = stack.harness.events.list.bind(stack.harness.events);
  // The PR newly accepts this coordinate space. Translate actual records, not
  // fake projection results; turn execution and its inbox binding remain real.
  vi.spyOn(stack.harness.events, 'list').mockImplementation(async (id, options) => (await list(id, options)).map(event => ({ ...event, sequence: event.sequence + offset })));
  let enter!: () => void, release!: () => void, bound!: () => void;
  const entered = new Promise<void>(resolve => { enter = resolve; }), gate = new Promise<void>(resolve => { release = resolve; }), binding = new Promise<void>(resolve => { bound = resolve; });
  const bind = stack.harness.inbox.bindPromotion.bind(stack.harness.inbox);
  vi.spyOn(stack.harness.inbox, 'bindPromotion').mockImplementation(async (id, turnId) => { enter(); await gate; await bind(id, turnId); bound(); });
  const controller = new AbortController();
  const stream = stack.service.stream('session/follow', { request: { address: { kind: 'session', sessionId: stack.id } } }, controller.signal)[Symbol.asyncIterator]();
  try {
    const snapshot = (await stream.next()).value as { cursor: number };
    await stack.call('session/prompt', { sessionId: stack.id, requestId: 'review-pr8', mode: 'queue', content: [{ type: 'text', text: 'Bound prompt only' }] });
    await entered;
    const before = await stack.call('session/projections', { sessionId: stack.id }) as { asOfSeq: number };
    const page = (cursor: number) => stack.call('session/page', { address: { kind: 'session', sessionId: stack.id }, throughSeq: cursor }) as Promise<{ records: Array<{ event: { type: string; seq: number; data: { source?: { rpcId?: string } } } }> }>;
    const early = (await page(before.asOfSeq)).records.find(record => record.event.type === 'user/message');
    release(); await binding;
    const after = await stack.call('session/projections', { sessionId: stack.id }) as { asOfSeq: number };
    const late = (await page(after.asOfSeq)).records.find(record => record.event.type === 'user/message');
    expect(late?.event.data.source?.rpcId).toBe('review-pr8');
    console.log('PR8_QUEUE_WITNESS', JSON.stringify({ offset, earlyCursor: before.asOfSeq, snapshotCursor: snapshot.cursor, early: early?.event, late: late?.event }));
    expect(before.asOfSeq, 'Unbound turn must stay behind the prior snapshot cursor').toBe(snapshot.cursor);
  } finally { release(); controller.abort(); await stream.return?.(); }
});
