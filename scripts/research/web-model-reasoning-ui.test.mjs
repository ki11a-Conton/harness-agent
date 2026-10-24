import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createModelReasoningEditor, modelReasoningLocales } from './web-model-reasoning-component.mjs';
import { addModelReasoningUi, modelReasoningLevels } from './web-model-reasoning-ui.mjs';

const jsx = (type, props) => ({ type, props });
function view(initial, disabled = false) {
  let model = initial, cursor = 0; const state = [];
  const react = { useState(value) { const slot = cursor++; if (!(slot in state)) state[slot] = value;
    return [state[slot], next => { state[slot] = typeof next === 'function' ? next(state[slot]) : next; }]; } };
  const component = createModelReasoningEditor(react, { jsx, jsxs: jsx, Fragment: 'Fragment' },
    { Switch: 'Switch', Tooltip: 'Tooltip', IconPlusOutlineRegular: 'Plus', IconTrashOutlineRegular: 'Trash' },
    value => Array.isArray(value) ? value : [], {});
  return { get model() { return model; }, set model(value) { model = value; }, validate: component.validate,
    render() { cursor = 0; return component.Editor({ model, levels: modelReasoningLevels, position: 1, disabled,
      t: key => modelReasoningLocales.en[key] ?? key, onChange: next => { model = next; } }); } };
}
function elements(node, predicate) {
  if (!node || typeof node !== 'object') return [];
  if (Array.isArray(node)) return node.flatMap(child => elements(child, predicate));
  return [...(predicate(node) ? [node] : []), ...elements(node.props?.children, predicate)];
}
const toggle = tree => elements(tree, element => element.type === 'Switch')[0];
const select = (tree, level) => elements(tree, element => element.type === 'select' && element.props.value === level)[0];
const value = (tree, level) => elements(tree, element => element.type === 'input' && element.props['aria-label'] === level + ' API value')[0];
const button = (tree, label) => elements(tree, element => element.type === 'button' && (element.props['aria-label'] === label ||
  Array.isArray(element.props.children) && element.props.children.includes(label)))[0];

test('enabling uses upstream Off/null and low/medium/high, while preserving other model fields', () => {
  const initial = { id: 'm', name: 'Model', contextWindow: 1048576, maxTokens: 128000, extra: { retained: true } };
  const ui = view(initial); assert.equal(toggle(ui.render()).props.checked, false);
  toggle(ui.render()).props.onChange(true);
  assert.deepEqual(ui.model, { ...initial, reasoningEfforts: { off: null, low: 'low', medium: 'medium', high: 'high' } });
  assert(!('reasoningEfforts' in initial)); assert.equal(value(ui.render(), 'off').props.disabled, true);
});

test('disabling removes only the declaration and hides rows; old false remains readable', () => {
  const ui = view({ id: 'm', contextWindow: 8192, reasoningEfforts: false });
  assert.equal(toggle(ui.render()).props.checked, false);
  toggle(ui.render()).props.onChange(true); toggle(ui.render()).props.onChange(false);
  assert.deepEqual(ui.model, { id: 'm', contextWindow: 8192 });
  assert.equal(elements(ui.render(), item => item.type === 'select').length, 0);
});

test('max can send xhigh and editing one row preserves every other row', () => {
  const ui = view({ id: 'm', reasoningEfforts: { off: null, low: 'low', high: 'high' } });
  select(ui.render(), 'high').props.onChange({ target: { value: 'max' } });
  value(ui.render(), 'max').props.onChange({ target: { value: 'xhigh' } });
  assert.deepEqual(ui.model.reasoningEfforts, { off: null, low: 'low', max: 'xhigh' });
  assert.equal(value(ui.render(), 'max').props.value, 'xhigh');
  assert.deepEqual(elements(select(ui.render(), 'max').props.children, item => item.type === 'option').map(item => item.props.value), ['minimal', 'medium', 'high', 'xhigh', 'max']);
});

test('changing between thinking levels preserves a custom wire spelling; Off resets it', () => {
  const ui = view({ id: 'm', reasoningEfforts: { max: 'xhigh' } });
  select(ui.render(), 'max').props.onChange({ target: { value: 'high' } });
  assert.deepEqual(ui.model.reasoningEfforts, { high: 'xhigh' });
  select(ui.render(), 'high').props.onChange({ target: { value: 'off' } });
  assert.deepEqual(ui.model.reasoningEfforts, { off: null });
  select(ui.render(), 'off').props.onChange({ target: { value: 'low' } });
  assert.deepEqual(ui.model.reasoningEfforts, { low: 'low' });
});

test('legacy string-valued Off remains visible, read-only and unchanged', () => {
  const ui = view({ id: 'm', reasoningEfforts: { off: 'none', high: 'high' } });
  assert.equal(value(ui.render(), 'off').props.value, 'none'); assert(value(ui.render(), 'off').props.disabled);
  assert.equal(ui.validate([ui.model]), undefined);
});

test('adding a level chooses an unused entry and an exhausted catalog disables Add', () => {
  const ui = view({ id: 'm', reasoningEfforts: { off: null, low: 'low', medium: 'medium', high: 'high' } });
  button(ui.render(), 'Add level').props.onClick();
  assert.deepEqual(ui.model.reasoningEfforts, { off: null, low: 'low', medium: 'medium', high: 'high', xhigh: 'xhigh' });
  ui.model = { id: 'all', reasoningEfforts: Object.fromEntries(modelReasoningLevels.map(id => [id, id === 'off' ? null : id])) };
  assert(button(ui.render(), 'Add level').props.disabled);
});

test('removing the last thinking level reports the upstream validation error', () => {
  const ui = view({ id: 'm', reasoningEfforts: { off: null, high: 'high' } });
  button(ui.render(), 'Delete level high').props.onClick();
  assert.deepEqual(ui.model.reasoningEfforts, { off: null });
  assert.deepEqual(ui.validate([ui.model]), { index: 0, key: 'modelReasoningNeedsLevel' });
});

test('clearing a wire field keeps typing stable and restores the level default on blur', () => {
  const ui = view({ id: 'm', reasoningEfforts: { high: 'custom' } });
  value(ui.render(), 'high').props.onChange({ target: { value: '' } });
  assert.equal(value(ui.render(), 'high').props.value, ''); assert.equal(ui.model.reasoningEfforts.high, 'high');
  value(ui.render(), 'high').props.onBlur(); assert.equal(value(ui.render(), 'high').props.value, 'high');
});

test('read-only/saving blocks switches, row controls and Add', () => {
  const ui = view({ id: 'm', reasoningEfforts: { off: null, high: 'high' } }, true), tree = ui.render();
  assert(toggle(tree).props.disabled);
  assert(elements(tree, item => item.type === 'input' || item.type === 'select').every(item => item.props.disabled));
  assert(button(tree, 'Add level').props.disabled); assert(button(tree, 'Delete level high').props.disabled);
});

test('derivative appends the real component after input types and leaves capacities as the first two grid fields', async () => {
  const original = await readFile(new URL('../../apps/web/public/deepseek/plugins/dsh-client-ui-settings-models/client.js', import.meta.url), 'utf8');
  const result = addModelReasoningUi(original), row = result.slice(result.indexOf('function ModelRow(props)'), result.indexOf('//#region lib/types/client/DeepSeekModelsEditor.js'));
  assert(row.includes('children: [["contextWindow", "maxTokens"].map'));
  assert(row.indexOf('ModelInputTypes') < row.indexOf('HarnessModelReasoning.Editor'));
  assert(!result.includes('Supported reasoning levels (JSON'));
  assert(result.includes('.harness-model-reasoning{') || result.includes('.harness-model-reasoning {'));
  assert(result.includes('modelReasoning: "推理等级"'));
  assert.throws(() => addModelReasoningUi(original.replace('function ModelRow(props)', 'function ChangedRow(props)')), /source boundary|reviewed model row/);
});

test('the text-only host keeps Image unavailable instead of offering a rejected settings write', async () => {
  const original = await readFile(new URL('../../apps/web/public/deepseek/plugins/dsh-client-ui-settings-models/client.js', import.meta.url), 'utf8');
  const source = addModelReasoningUi(original);
  const start = source.indexOf('function ModelInputTypes('), end = source.indexOf('\n\t\t//#endregion', start);
  assert(start >= 0 && end > start);
  const render = new Function('react_jsx_runtime', '_deepseek_ai_dsh_client_ui_primitives', 'ModelsSection_module_css_default',
    'return (' + source.slice(start, end) + ')')({ jsx, jsxs: jsx }, { Checkbox: 'Checkbox' }, {});
  const tree = render({ model: { id: 'text-only' }, field: 'input', position: 1, disabled: false,
    t: key => key, onChange: () => assert.fail('Unsupported input must not be offered') });
  const text = elements(tree, item => item.type === 'Checkbox' && item.props.label === 'modelInputText')[0];
  const image = elements(tree, item => item.type === 'Checkbox' && item.props.label === 'modelInputImage')[0];
  assert.equal(text.props.checked, true); assert.equal(image.props.checked, false);
  assert.equal(image.props.disabled, true);
});
