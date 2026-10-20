import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { addControlsUi } from './web-controls-ui.mjs';
const source = stem => readFile(new URL(`../../apps/web/public/deepseek/plugins/${stem}/client.js`, import.meta.url), 'utf8');

async function permissionRenderer(select) {
  const derived = addControlsUi('dsh-client-ui-permission-presets', await source('dsh-client-ui-permission-presets'));
  const start = derived.indexOf('function PermissionSelect('), end = derived.indexOf('\n\t\t//#endregion', start);
  const state = []; let cursor = 0;
  const selection = { currentValue: 'workspace-write' };
  const jsx = (type, props) => ({ type, props });
  const PermissionSelect = vm.runInNewContext('(' + derived.slice(start, end) + ')', {
    Error,
    react: { Fragment: 'Fragment', useEffect() {}, useState(initial) { const index = cursor++; if (!(index in state)) state[index] = initial;
      return [state[index], value => { state[index] = value; }]; } },
    react_jsx_runtime: { jsx, jsxs: jsx }, clsx: () => '', PermissionSelect_module_css_default: {},
    _deepseek_ai_dsh_client_ui_primitives: { Menu: 'Menu', RiskConfirmation: 'RiskConfirmation', IconChevronDownOutlineRegular: 'Chevron' },
    permissionGlyph: () => undefined, permissionLabel: (_id, name) => name, optionBadge: () => undefined, optionDescription: option => option.description,
  });
  const render = () => { cursor = 0; return PermissionSelect({ locked: false, select, useProjection: () => selection,
    usePermissionCatalog: pick => pick({ value: { options: [{ value: 'workspace-write', name: 'Workspace Write' }, { value: 'read-only', name: 'Read Only' }] } }),
    t: (key, args) => key === 'mode' ? 'Access mode, current: ' + args.name : key }); };
  return { render, selection, menu: tree => tree.props.children.find(child => child?.type === 'Menu') };
}

test('permission UI keeps the committed label while the real select promise is pending', async () => {
  let commit; const pending = new Promise(resolve => { commit = resolve; });
  const view = await permissionRenderer(() => pending);
  view.menu(view.render()).props.onSelect('read-only');
  const saving = view.menu(view.render()).props.anchor.props;
  assert.equal(saving['aria-label'], 'Access mode, current: Workspace Write');
  assert.equal(saving['aria-busy'], true); assert.equal(saving.disabled, true);
  commit(true); await new Promise(resolve => setImmediate(resolve));
  view.selection.currentValue = 'read-only';
  assert.equal(view.menu(view.render()).props.anchor.props['aria-label'], 'Access mode, current: Read Only');
});

test('permission UI exposes a rejected save and retains the committed permission', async () => {
  const view = await permissionRenderer(async () => { throw new Error('Permission save rejected'); });
  view.menu(view.render()).props.onSelect('read-only'); await new Promise(resolve => setImmediate(resolve));
  const tree = view.render(), alert = tree.props.children.find(child => child?.props?.role === 'alert');
  assert.equal(alert?.props.children, 'Permission save rejected');
  assert.equal(view.menu(tree).props.anchor.props['aria-label'], 'Access mode, current: Workspace Write');
});

test('permission submission rejects a matched command whose actual result failed', async () => {
  const derived = addControlsUi('dsh-client-ui-permission-presets', await source('dsh-client-ui-permission-presets'));
  const start = derived.indexOf('const submit = async (sessionId, preset) =>'), end = derived.indexOf('const catalog =', start);
  const submit = vm.runInNewContext('(() => {' + derived.slice(start, end) + '; return submit; })()', {
    sessions: { binding() { return { session: { async command() { return { ok: true, value: { matched: true, result: { kind: 'error', text: 'Permission storage denied' } } }; } } }; } },
  });
  await assert.rejects(submit('session-a', 'read-only'), /Permission storage denied/);
});

test('permission submission propagates a host rejection through the actual native session command adapter', async () => {
  const native = await source('dsh-api-session-controller');
  const commandStart = native.indexOf('async command(line) {'), commandEnd = native.indexOf('\n\t\t\t/** First open:', commandStart);
  assert(commandStart >= 0 && commandEnd > commandStart);
  const command = vm.runInNewContext('({' + native.slice(commandStart, commandEnd) + '}).command');
  const calls = [], live = { sessionId: 'session-a', remote: { commands: { async execute(...args) {
    calls.push(args); return { ok: false, error: { code: 'permission/write-failed', message: 'Actual host save rejected' } };
  } } } };
  live.command = command.bind(live);
  const derived = addControlsUi('dsh-client-ui-permission-presets', await source('dsh-client-ui-permission-presets'));
  const start = derived.indexOf('const submit = async (sessionId, preset) =>'), end = derived.indexOf('const catalog =', start);
  const submit = vm.runInNewContext('(() => {' + derived.slice(start, end) + '; return submit; })()', {
    sessions: { binding() { return { session: live }; } },
  });
  await assert.rejects(submit('session-a', 'read-only'), /Actual host save rejected/);
  assert.equal(calls.length, 1); assert.equal(calls[0][0], 'session-a'); assert.equal(calls[0][1], '/permission read-only');
  assert(Array.isArray(calls[0][2]) && calls[0][2].length === 0);
});

test('actual composer registration uses the injected live session instead of an unavailable remote service', async () => {
  const derived = addControlsUi('dsh-client-ui-conversation', await source('dsh-client-ui-conversation'));
  const start = derived.indexOf('ctx.slots.inject("conversation.input.left", () => ctx.slots.register({ name: "conversation.input.left", id: "harness-controls"');
  const end = derived.indexOf('}, HarnessControls));', start) + '}, HarnessControls));'.length;
  assert(start >= 0 && end > start);
  let registration; const calls = [];
  const ctx = { slots: { inject(_slot, callback) { callback(); }, register(options) { registration = options; } },
    sessions: { binding(id) { return { session: { async command(line) { calls.push({ id, line }); return { ok: true, value: { matched: true } }; } } }; } },
    get remote() { throw new Error('remote was not injected'); } };
  vm.runInNewContext(derived.slice(start, end), { ctx, HarnessControls() {} });
  await registration.inject('actual-session').runCommand('/plan on');
  assert.deepEqual(calls, [{ id: 'actual-session', line: '/plan on' }]);
});

test('actual goal CAS ref retains an acknowledged edit while projections catch up, without rebasing third-party conflicts', async () => {
  const derived = addControlsUi('dsh-client-ui-goal', await source('dsh-client-ui-goal'));
  const start = derived.indexOf('const sessions = ctx.sessions;'), end = derived.indexOf('const noCurrentGoal', start);
  let goal = { id: 'goal-a', revision: 1 };
  const ctx = { effect() {}, sessions: { binding() { return { session: { projections: { faceOf() { return { getSnapshot() { return { goal }; } }; } } } }; } } };
  const scope = vm.runInNewContext('(() => {' + derived.slice(start, end) + '; return { refOf, remember }; })()', { ctx });
  scope.remember('s', { ok: true, value: { id: 'goal-a', revision: 2 } });
  assert.equal(scope.refOf('s').revision, 2);
  goal = { id: 'goal-a', revision: 3 }; assert.equal(scope.refOf('s').revision, 3);
  scope.remember('s', { ok: false, error: { code: 'goal/conflict' } }); assert.equal(scope.refOf('s').revision, 3);
  goal = { id: 'goal-b', revision: 1 }; assert.equal(scope.refOf('s').id, 'goal-b'); assert.equal(scope.refOf('s').revision, 1);
});
