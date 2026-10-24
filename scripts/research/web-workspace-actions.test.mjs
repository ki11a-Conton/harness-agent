import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';
import { deriveBrandModule } from './web-branding-lib.mjs';
import { addWorkspaceActionsUi } from './web-workspace-actions-ui.mjs';

const stem = 'dsh-client-ui-workspace';
const original = await readFile(new URL(`../../apps/web/public/deepseek/plugins/${stem}/client.js`, import.meta.url));
const derived = deriveBrandModule(stem, original).toString();
const start = derived.indexOf('function activateWorkspaceRow(event) {');
const end = derived.indexOf('function ProjectRowItem(', start);
const activate = vm.runInNewContext(derived.slice(start, end) + '; activateWorkspaceRow');

function keyEvent(overrides = {}) {
  const calls = { click: 0, preventDefault: 0, stopPropagation: 0 };
  const row = { click() { calls.click++; } };
  return { calls, event: {
    key: 'Enter', target: row, currentTarget: row, nativeEvent: {},
    preventDefault() { calls.preventDefault++; },
    stopPropagation() { calls.stopPropagation++; }, ...overrides,
  } };
}

test('row Enter and Space dispatch exactly one original row click and consume the key', () => {
  for (const key of ['Enter', ' ']) {
    const { calls, event } = keyEvent({ key });
    activate(event);
    assert.deepEqual(calls, { click: 1, preventDefault: 1, stopPropagation: 1 });
  }
});

test('held row activation keys are consumed without repeating the original click', () => {
  for (const key of ['Enter', ' ']) {
    const { calls, event } = keyEvent({ key, repeat: true });
    activate(event);
    assert.deepEqual(calls, { click: 0, preventDefault: 1, stopPropagation: 1 });
  }
});

test('native child controls, composition, handled keys and shortcuts stay with their owner', () => {
  for (const override of [
    { target: { tagName: 'BUTTON' } }, { defaultPrevented: true },
    { nativeEvent: { isComposing: true } },
    { altKey: true }, { ctrlKey: true }, { metaKey: true }, { shiftKey: true },
    { key: 'Tab' }, { key: 'ArrowDown' }, { key: 'Escape' }, { key: 'a' },
  ]) {
    const { calls, event } = keyEvent(override);
    activate(event);
    assert.deepEqual(calls, { click: 0, preventDefault: 0, stopPropagation: 0 }, JSON.stringify(override));
  }
});

test('all three original tree rows receive the guarded keyboard entry without changing click handlers', () => {
  assert.equal((derived.match(/onKeyDown: activateWorkspaceRow/g) ?? []).length, 3);
  assert.equal((derived.match(/tabIndex: 0,/g) ?? []).length, 3);
  for (const handler of ['onClick: onToggle,', 'onOpen(result.id);', 'onOpen(node.id);']) {
    assert.equal(derived.split(handler).length, original.toString().split(handler).length);
  }
  for (const kind of ['project', 'session', 'searchResult']) {
    assert.ok(derived.includes(`.YDXeBa_${kind}Row:focus-within .YDXeBa_rowActions`));
    assert.ok(derived.includes(`.YDXeBa_${kind}Row:focus-visible`));
  }
  assert.ok(derived.includes('.YDXeBa_sessionRow.YDXeBa_selected .YDXeBa_rowActions'));
  assert.ok(derived.includes('.YDXeBa_searchResultRow.YDXeBa_selected .YDXeBa_rowActions'));
});

test('workspace transformation refuses drifted or already transformed source', () => {
  assert.throws(() => addWorkspaceActionsUi(original.toString().replace('function ProjectRowItem(', 'function ProjectRowItemChanged(')), /source boundary changed/);
  assert.throws(() => addWorkspaceActionsUi(derived), /source boundary changed/);
});
