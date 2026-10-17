import { expect, it, vi } from 'vitest';
import { newEventId, newSessionId, type AgentEvent } from '@ar/contracts';
import { setup, signal } from './test-support/pr8-fixtures.js';

async function replacedDraft() {
  const stack = await setup(true), oldOwner = await stack.manager!.ownerOf(stack.id);
  await oldOwner.events.appendNew({ id: newEventId(), sessionId: stack.id, type: 'session.resumed', timestamp: Date.now(), payload: {} });
  const prefix = await oldOwner.events.list(stack.id);
  await stack.manager!.selectModel(stack.id, { providerKey: 'selected', modelId: 'new-model' }, signal());
  return { ...stack, oldOwner, prefix };
}

it.each(['missing', 'short', 'gap', 'wrong-session', 'duplicate-id', 'extra'] as const)('owner reads reject a %s retired prefix before exposing any live suffix', async fault => {
  const stack = await replacedDraft(), original = stack.oldOwner.events.list.bind(stack.oldOwner.events);
  const damaged: AgentEvent[] = stack.prefix.map(event => ({ ...event }));
  if (fault === 'missing') damaged.splice(0);
  if (fault === 'short') damaged.pop();
  if (fault === 'gap') damaged[0]!.sequence = 1;
  if (fault === 'wrong-session') damaged[0]!.sessionId = newSessionId();
  if (fault === 'duplicate-id') damaged[1]!.id = damaged[0]!.id;
  if (fault === 'extra') damaged.push({ ...damaged.at(-1)!, id: newEventId(), sequence: damaged.length });
  vi.spyOn(stack.oldOwner.events, 'list').mockImplementation(async (id, options) => id === stack.id ? damaged : original(id, options));
  await expect(stack.harness.events.list(stack.id)).rejects.toMatchObject({ code: 'session/alias-corrupt' });
  await expect(stack.call('session/projections', { sessionId: stack.id })).rejects.toMatchObject({ code: 'session/alias-corrupt' });
});

it('ordinary sessions cannot self-declare a missing first event as their baseline', async () => {
  const stack = await setup();
  const original = stack.harness.events.list.bind(stack.harness.events);
  vi.spyOn(stack.harness.events, 'list').mockImplementation(async (id, options) => (await original(id, options)).map(event => ({ ...event, sequence: event.sequence + 1 })));
  await expect(stack.call('session/projections', { sessionId: stack.id })).rejects.toThrow(/not contiguous/);
});

it('healthy alias reads preserve full and paginated global coordinates and the native fork inverse', async () => {
  const stack = await replacedDraft();
  const all = await stack.harness.events.list(stack.id), prefix = stack.prefix.length;
  expect(all.map(event => event.sequence)).toEqual(all.map((_, index) => index));
  expect(await stack.harness.events.list(stack.id, { afterSequence: 0, limit: 1 })).toEqual([all[1]]);
  expect(await stack.manager!.journalCoordinate(stack.id, prefix)).toEqual({ sessionId: stack.manager!.nativeSessionId(stack.id), sequence: 0 });
  await expect(stack.call('session/projections', { sessionId: stack.id })).resolves.toBeDefined();
});
