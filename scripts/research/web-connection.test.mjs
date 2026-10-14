import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import { deriveBrandModule } from './web-branding-lib.mjs';

const connectionStem = 'dsh-client-connection';
const connection = await readFile(new URL(`../../apps/web/public/deepseek/plugins/${connectionStem}/client.js`, import.meta.url));
function networkWatch(bytes, loopback) {
  const text = bytes.toString();
  const a = text.indexOf('function watchBrowserNetwork('), b = text.indexOf('\n\t\t/**', a);
  assert(a >= 0 && b > a);
  const listeners = new Map(), states = [];
  const browser = { navigator: { onLine: false }, addEventListener: (name, fn) => listeners.set(name, fn), removeEventListener: name => listeners.delete(name) };
  const watch = runInNewContext(`(${text.slice(a, b).trim()})`, { globalThis: { window: browser } });
  const dispose = watch({ setNetworkAvailable: value => states.push(value) }, loopback);
  return { states, listeners, dispose };
}
test('original browser offline hint pauses a reachable loopback carrier', () => {
  assert.deepEqual(networkWatch(connection, true).states, [false]);
});
test('derived loopback carrier uses actual readiness and loss, not interface hints', () => {
  const stack = networkWatch(deriveBrandModule(connectionStem, connection), true);
  assert.deepEqual(stack.states, []); assert.equal(stack.listeners.size, 0); stack.dispose();
});
test('remote authority retains real browser offline/online suspension', () => {
  const stack = networkWatch(deriveBrandModule(connectionStem, connection), false);
  assert.deepEqual(stack.states, [false]); stack.listeners.get('online')();
  assert.deepEqual(stack.states, [false, true]); stack.dispose(); assert.equal(stack.listeners.size, 0);
});

const settingsStem = 'dsh-client-ui-settings-general';
const settings = await readFile(new URL(`../../apps/web/public/deepseek/plugins/${settingsStem}/client.js`, import.meta.url));
function holdAfterClockCorrection(bytes) {
  const text = bytes.toString();
  const prefix = '(0, react.useLayoutEffect)(() => {\n\t\t\t\tif (connectionState === "connecting")';
  const a = text.indexOf(prefix), b = text.indexOf('\n\t\t\t}, [connectionState]);', a);
  assert(a >= 0 && b > a);
  const body = text.slice(a + '(0, react.useLayoutEffect)(() => {'.length, b);
  let wall = 1000, monotonic = 1000, hold = false, delay;
  const ref = { current: undefined };
  const effect = new Function('connectionState', 'connectingShownAt', 'Date', 'performance', 'setHoldConnecting', 'window', 'CONNECTING_MIN_VISIBLE_MS', body);
  const invoke = state => effect(state, ref, { now: () => wall }, { now: () => monotonic }, value => { hold = value; }, { setTimeout: (_fn, ms) => { delay = ms; }, clearTimeout() {} }, 800);
  invoke('connecting'); wall -= 60_000; monotonic += 10; invoke('connected');
  return { hold, delay };
}
test('original healthy recovery holds Reconnecting for over a minute after wall clock correction', () => {
  assert(holdAfterClockCorrection(settings).delay > 60_000);
});
test('derived healthy recovery has a bounded monotonic visibility interval', () => {
  const result = holdAfterClockCorrection(deriveBrandModule(settingsStem, settings));
  assert.equal(result.hold, true); assert.equal(result.delay, 790);
});
