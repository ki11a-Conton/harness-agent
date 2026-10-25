import assert from 'node:assert/strict';

const stateOf = editor => editor.evaluate(element => ({
  text: element.innerText,
  phase: element.dataset.phase,
  composing: element.hasAttribute('data-composer-composing'),
  connected: element.isConnected,
  editable: element.isContentEditable,
}));

/** Observe the native editor commit and its composition handoff before a new
 * typed command. DOM text alone does not acknowledge the editor/IME lifecycle.
 * This neither submits nor retries a command and leaves the RPC deadline alone. */
export async function waitForPlainComposer(editor, text, until) {
  let state;
  const matches = value => value.connected && value.editable && value.phase === 'plain'
    && !value.composing && value.text.trim() === text.trim();
  await until(async () => matches(state = await stateOf(editor)),
    'Native composer has not committed the plain draft: ' + JSON.stringify({ expected: text }));
  // The shipped keymap deliberately suppresses Enter briefly after compositionend,
  // even after its DOM composing marker clears. Await actual browser paints.
  await editor.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  state = await stateOf(editor);
  assert(matches(state), 'Native composer changed during input handoff: ' + JSON.stringify(state));
}

export async function fillTypedCommand(editor, text, until) {
  await editor.fill(text);
  await waitForPlainComposer(editor, text, until);
}
