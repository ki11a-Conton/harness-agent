import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import { deriveBrandModule } from './web-branding-lib.mjs';

const stem = 'dsh-client-ui-workspace';
const original = await readFile(new URL(`../../apps/web/public/deepseek/plugins/${stem}/client.js`, import.meta.url));
function navigation(bytes) {
  const source = bytes.toString('utf8');
  const start = source.indexOf('var UiWorkspaceService = class extends ');
  const end = source.indexOf('\n\t\t};', start);
  assert(start >= 0 && end > start, 'the actual pinned navigation class is present');
  const Service = runInNewContext(source.slice(start, end + 6) + '\nUiWorkspaceService;', {
    AbortController, AbortSignal,
    _deepseek_ai_cordis: { Service: class { constructor(ctx) { this.ctx = ctx; } } },
    _deepseek_ai_dsh_client_store: { createSnapshotStore: value => ({ getSnapshot: () => value, set: next => { value = next; } }) },
    recentWorkspace: () => 'workspace',
  });
  let current = new AbortController();
  const layout = { beginNavigation() { current.abort(); current = new AbortController(); return current.signal; }, selectPanel() {} };
  const released = [];
  const sessions = { retain: sessionId => ({ sessionId, release: () => released.push(sessionId) }), subagentAddress() {} };
  const ctx = { layout, effect() {} };
  const instance = new Service(ctx, {}, {}, sessions, {}, () => {});
  let resume;
  instance.connectWorkspace = () => new Promise(done => { resume = done; });
  const restoring = instance.restoreSelection({ items: [{ workspaceId: 'workspace' }], archivedSessionIds: [] }, { byId: {}, ids: [] });
  return { instance, restoring, resume: () => resume('initial-draft'), released };
}

for (const operation of ['open', 'clear']) {
  test(`original late initialization overwrites a newer ${operation} action`, async () => {
    const stack = navigation(original);
    if (operation === 'open') stack.instance.openSession('chosen-session'); else stack.instance.clearMain();
    stack.resume(); await stack.restoring;
    assert.equal(stack.instance.mainReference.sessionId, 'initial-draft', 'deterministic original defect');
  });
  test(`reviewed actual UI navigation preserves a newer ${operation} action`, async () => {
    const stack = navigation(deriveBrandModule(stem, original));
    if (operation === 'open') stack.instance.openSession('chosen-session'); else stack.instance.clearMain();
    stack.resume(); await stack.restoring;
    assert.equal(stack.instance.mainReference?.sessionId, operation === 'open' ? 'chosen-session' : undefined);
    assert(!stack.released.includes('chosen-session'), 'the chosen session scope and its pending send stay retained');
  });
}
