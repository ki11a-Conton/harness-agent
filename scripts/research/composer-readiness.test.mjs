import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { fillTypedCommand, waitForPlainComposer } from './composer-readiness.mjs';

const source = await readFile(new URL('../../apps/web/public/deepseek/harness-brand/plugins/dsh-client-ui-conversation/client.js', import.meta.url), 'utf8');
const start = source.indexOf('function isComposingEvent(');
const end = source.indexOf('\n\t\t//#endregion', start);
assert(start >= 0 && end > start, 'the actual shipped keymap boundary exists');

function fixture() {
  let now = 1000, submits = 0, fills = 0, paints = 0;
  const callbacks = new Map(), listeners = new Map(), attrs = new Map();
  const element = { innerText: '', dataset: { phase: 'plain' }, isConnected: true, isContentEditable: true,
    hasAttribute: name => attrs.has(name) };
  const root = { addEventListener: (name, cb) => listeners.set(name, cb), removeEventListener() {},
    removeAttribute: name => attrs.delete(name), toggleAttribute: (name, on) => on ? attrs.set(name, true) : attrs.delete(name) };
  const native = { isComposing: () => false, update(fn, options) { fn(); options.onUpdate?.(); },
    registerRootListener(cb) { cb(root, null); return () => {}; }, registerUpdateListener: () => () => {},
    registerCommand(key, cb) { callbacks.set(key, cb); return () => {}; } };
  const names = Object.fromEntries(['sn$2', 'ln$2', 'hn$2', 'fn$1', 'an$1', 'cn$1', 'Je$2'].map(name => [name, name]));
  const register = vm.runInNewContext(source.slice(start, end) + '; registerComposerKeymap',
    { ...names, Date: { now: () => now }, Eu: () => () => {} });
  register(native, { arbitrate: () => 'pass', dismissPopup() {}, canSubmit: () => true, submit() { submits++; }, space: () => false });
  const enter = () => callbacks.get('cn$1')({ isComposing: false, keyCode: 13, altKey: false, ctrlKey: false,
    metaKey: false, shiftKey: false, repeat: false, getModifierState: () => false, preventDefault() {} });
  const editor = { async fill(text) { fills++; element.innerText = text; }, async evaluate(fn) {
    return vm.runInNewContext('(' + fn.toString() + ')(element)', { element,
      requestAnimationFrame(cb) { paints++; now += 8; cb(now); } });
  } };
  const until = async (predicate, label) => assert(await predicate(), label);
  const compositionEnd = () => { listeners.get('compositionstart')(); listeners.get('compositionend')(); };
  return { element, editor, until, enter, compositionEnd, counts: () => ({ submits, fills, paints }) };
}

test('the real keymap consumes immediate post-IME Enter even after its DOM marker clears', () => {
  const f = fixture(); f.compositionEnd();
  assert.equal(f.element.hasAttribute('data-composer-composing'), false);
  assert.equal(f.enter(), true);
  assert.equal(f.counts().submits, 0, 'DOM-only readiness cannot promise a command RPC');
});

test('typed-command preparation waits for native paints, then one Enter produces one submission', async () => {
  const f = fixture(); f.compositionEnd();
  await fillTypedCommand(f.editor, '/plan', f.until);
  assert.deepEqual(f.counts(), { submits: 0, fills: 1, paints: 2 });
  f.enter(); assert.equal(f.counts().submits, 1);
});

test('a stale claim, busy editor, different text, or detached owner is not declared ready', async () => {
  for (const changes of [{ dataset: { phase: 'claimed' } }, { dataset: { phase: 'submitting' } },
    { innerText: 'other' }, { isConnected: false }, { isContentEditable: false }]) {
    const f = fixture(); f.element.innerText = '/plan'; Object.assign(f.element, changes);
    await assert.rejects(waitForPlainComposer(f.editor, '/plan', f.until), /not committed/);
    assert.equal(f.counts().submits, 0); assert.equal(f.counts().paints, 0);
  }
});
