import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { createHarness } from '@ar/harness';
import { ScriptedModelProvider } from '@ar/model';
import { createRuntimeRpc } from '@ar/gateway';
import { newEventId, type SessionId } from '@ar/contracts';
import { createSessionService } from '../session.js';
import { createHostTools } from '../host-tools.js';
import { createOwnerManager } from '../owners.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { vi.restoreAllMocks(); for (const close of cleanups.splice(0).reverse()) await close(); });
export const signal = (): AbortSignal => new AbortController().signal;
export async function setup(alias = false) {
  const cwd = await realpath(await mkdtemp(join(tmpdir(), 'pr8-review-')));
  cleanups.push(() => rm(cwd, { recursive: true, force: true }));
  const provider = new ScriptedModelProvider([ScriptedModelProvider.text('verified answer')]);
  const base = await createHarness({ cwd, profile: 'interactive', modelProvider: provider, model: { providerId: provider.id, modelId: 'old-model' } });
  cleanups.push(() => base.close());
  const baseTools = createHostTools(base, cwd);
  const manager = alias ? await createOwnerManager(base, { ...baseTools, newSessionsUseChildren: true,
    workspace: async () => ({ path: cwd, workspaceId: 'workspace' }),
    resolveSelection: async selected => ({ modelProvider: provider, model: { providerId: provider.id, modelId: selected.modelId } }),
  }) : undefined;
  if (manager) cleanups.push(() => manager.close());
  const harness = manager?.harnessFacade ?? base;
  const tools = createHostTools(harness, cwd, undefined, manager?.ownerOf, manager?.nativeSessionId);
  const rpc = manager?.rpcFacade ?? createRuntimeRpc(harness.runtime, { sessionService: harness.sessionService, sessions: harness.sessions, events: harness.events, approvalStore: harness.approvalStore });
  const service = createSessionService({ harness, rpc, cwd, ...tools, pollDelayMs: 1, withSessionLock: manager?.withSessionLock });
  cleanups.push(() => service.close());
  const id = manager ? (await manager.createSession('workspace', signal())).id : (await service.call('session/create', { request: {} }, signal()) as { sessionId: SessionId }).sessionId;
  const call = (endpoint: string, request: Record<string, unknown>) => service.call(endpoint, { request }, signal());
  return { base, harness, manager, service, id, call };
}
