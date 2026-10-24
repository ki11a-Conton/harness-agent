/** MIT ModelReasoningEfforts adoption; original published plugins stay frozen. */
import { createModelReasoningEditor, modelReasoningCss, modelReasoningLocales } from './web-model-reasoning-component.mjs';

export const modelReasoningLevels = Object.freeze(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']);
const classes = Object.freeze({ modelReasoning: 'harness-model-reasoning', modelReasoningLabel: 'harness-model-reasoning-label',
  modelReasoningHead: 'harness-model-reasoning-head', modelReasoningRow: 'harness-model-reasoning-row',
  modelReasoningValueInput: 'harness-model-reasoning-value', helpButton: 'harness-model-reasoning-help' });
function replaceOnce(source, before, after) {
  if (source.split(before).length !== 2) throw new Error('Model reasoning source boundary changed: ' + before.slice(0, 70));
  return source.replace(before, after);
}

export function addModelReasoningUi(source) {
  const styleStart = source.indexOf('var ModelsSection_module_css_default = {');
  const styleEnd = source.indexOf('\n\t\t};', styleStart);
  if (styleStart < 0 || styleEnd < 0) throw new Error('Missing reviewed model style map');
  const select = source.slice(styleStart, styleEnd).match(/"selectInput": "([A-Za-z0-9_-]+)"/);
  if (!select) throw new Error('Missing reviewed native model select style');
  const css = source.match(/const css\$3 = ("(?:[^"\\]|\\.)*");/);
  if (!css) throw new Error('Missing reviewed model CSS');
  const adoptedCss = modelReasoningCss.replace(/\.(modelReasoningValueInput|modelReasoningLabel|modelReasoningHead|modelReasoningRow|modelReasoning|helpButton)\b/g,
    (_whole, key) => '.' + classes[key]).replaceAll('.selectInput', '.' + select[1]);
  source = replaceOnce(source, css[0], 'const css$3 = ' + JSON.stringify(JSON.parse(css[1]) + '\n' + adoptedCss) + ';');

  // The current Web Host model schema accepts text input only. Keep the
  // upstream layout, but do not offer Image and then reject the user's save.
  source = replaceOnce(source, 'disabled: disabled || selected.length === 1 && selected.includes(modality),',
    'disabled: disabled || modality === "image" || selected.length === 1 && selected.includes(modality),');

  const rowStart = source.indexOf('function ModelRow(props) {');
  const rowEnd = source.indexOf('\n\t\t//#endregion', rowStart);
  if (rowStart < 0 || rowEnd < 0) throw new Error('Missing reviewed model row');
  const row = source.slice(rowStart, rowEnd);
  const changed = replaceOnce(row, 'onChange: props.onChange\n\t\t\t\t\t})]',
    'onChange: props.onChange\n\t\t\t\t\t}), (0, react_jsx_runtime.jsx)(HarnessModelReasoning.Editor, { model, levels: ' + JSON.stringify(modelReasoningLevels) + ', position, disabled, t, onChange: props.onChange })]');
  source = source.slice(0, rowStart) + changed + source.slice(rowEnd);
  source = replaceOnce(source, 'function ModelRow(props) {',
    'const HarnessModelReasoning = (' + createModelReasoningEditor.toString() + ')(react, react_jsx_runtime, _deepseek_ai_dsh_client_ui_primitives, modelDrafts, { ...ModelsSection_module_css_default, ...' + JSON.stringify(classes) + ' });\n\t\tfunction ModelRow(props) {');

  const validation = 'const maxTokens = model["maxTokens"];';
  source = replaceOnce(source, validation, `const efforts = model.reasoningEfforts;
      if (efforts !== undefined && efforts !== false) {
        if (typeof efforts !== "object" || efforts === null || Array.isArray(efforts)) return { index, key: "modelReasoningInvalid" };
        const refusal = HarnessModelReasoning.validate([model]);
        if (refusal) return { index, key: refusal.key };
        if (Object.entries(efforts).some(([key, wire]) => !${JSON.stringify(modelReasoningLevels)}.includes(key) ||
          !(key === "off" && wire === null) && (typeof wire !== "string" || !/^[A-Za-z0-9_-]{1,100}$/.test(wire)))) return { index, key: "modelReasoningInvalid" };
      }
      ` + validation);
  for (const [locale, marker] of [['en', 'contextWindow: "Context window",'], ['zh', 'contextWindow: "上下文窗口",']]) {
    const entries = { ...modelReasoningLocales[locale], modelReasoningInvalid: locale === 'zh' ? '推理档位或 API 参数值无效' : 'Invalid reasoning level or API value' };
    source = replaceOnce(source, marker, Object.entries(entries).map(([key, value]) => key + ': ' + JSON.stringify(value) + ',').join('\n') + '\n' + marker);
  }
  return source;
}
