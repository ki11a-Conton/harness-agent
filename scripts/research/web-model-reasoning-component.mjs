// Generated from the retained upstream MIT component at 22ddee3792402c3e70ec5f86a63c3e3e895a2f60.
// See third_party/deepseek-model-reasoning/{LICENSE,PROVENANCE.json}.
// Regenerate: node scripts/research/generate-model-reasoning.mjs
// This runtime module requires no TypeScript, filesystem, or development package.
export function createModelReasoningEditor(react, jsx, primitives, modelDrafts, styles) {
  // Copyright (c) 2026 DeepSeek; MIT, retained in /deepseek/licenses/upstream-source-reference/LICENSE.
  const { useState } = react;
  const { jsx: _jsx, jsxs: _jsxs, Fragment: _Fragment } = jsx;
  const { IconPlusOutlineRegular, IconTrashOutlineRegular, Switch, Tooltip } = primitives;
/** Reasoning-level declarations for a model on a hand-declared pi-ai route. */
/** Levels a model offers when the switch is turned on, where the schema lists them: Off plus the common OpenAI-compatible trio. */
const INITIAL_LEVELS = ['off', 'low', 'medium', 'high'];
/** The wire value a level sends unless its row says otherwise; `null` is the Off entry that sends nothing. */
function defaultValue(level) {
    return level === 'off' ? null : level;
}
/**
 * Whether pi-ai accepts a stored value: a non-empty string, or nothing for Off.
 * @param level - the declared level.
 * @param wire - the value stored for it.
 * @returns whether the adapter would resolve the entry.
 */
function acceptedValue(level, wire) {
    return typeof wire === 'string' ? wire.length > 0 : wire === null && level === 'off';
}
/**
 * Read the declared levels from a row in their stored order, including a key
 * the offered levels do not name, so an edit never drops it.
 * @param model - model row as drafted.
 * @returns the entries; empty for a valueless field, which pi-ai refuses, and
 * `undefined` when the field is absent or `false`.
 */
function readEfforts(model) {
    const value = model['reasoningEfforts'];
    if (value === null)
        return [];
    if (typeof value !== 'object' || Array.isArray(value))
        return undefined;
    return Object.entries(value);
}
/**
 * Replace a row's declared levels, preserving every other field.
 * @param model - model row as drafted.
 * @param entries - the levels to write in row order, or `undefined` to remove the field.
 * @returns the replacement row.
 */
function withEfforts(model, entries) {
    const next = { ...model };
    if (entries === undefined) {
        // Absent is how a hand-declared model says it does not reason.
        Reflect.deleteProperty(next, 'reasoningEfforts');
        return next;
    }
    next['reasoningEfforts'] = Object.fromEntries(entries);
    return next;
}
/**
 * Mirror the pi-ai refusals of a hand-declared `reasoningEfforts`, so a card
 * names the row instead of failing at the write.
 * @param value - drafted `models` value, or `undefined` while inherited.
 * @returns the first refused row, or `undefined` when the adapter will accept every row.
 */
function validateReasoningEfforts(value) {
    for (const [index, model] of modelDrafts(value).entries()) {
        const entries = readEfforts(model);
        if (entries === undefined)
            continue;
        if (entries.some(([level, wire]) => !acceptedValue(level, wire)))
            return { index, key: 'modelReasoningValueRequired' };
        if (!entries.some(([level]) => level !== 'off'))
            return { index, key: 'modelReasoningNeedsLevel' };
    }
    return undefined;
}
/**
 * Edit the `reasoningEfforts` a hand-declared pi-ai model offers: a switch,
 * then one row per level pairing the level with the value sent for it. Every
 * row is read from the model, so a reused instance shows its new model.
 * @param props - model declaration and row replacement action.
 * @returns the reasoning-level group.
 */
function ModelReasoningEfforts({ model, levels, position, disabled, t, onChange }) {
    const entries = readEfforts(model);
    // Only the focused field keeps its own text, so a field cleared while typing
    // stays empty although its level's name is stored. Leaving the field drops
    // it, and deleting a model, resetting the list, or folding these options all
    // move focus first, so no text outlives the field it was typed into.
    const [typing, setTyping] = useState(undefined);
    const label = `${t('modelReasoning')} ${String(position)}`;
    const used = entries?.map(([level]) => level) ?? [];
    const write = (next) => { onChange(withEfforts(model, next)); };
    const replaceAt = (current, index, entry) => current.map((existing, at) => at === index ? entry : existing);
    const changeLevel = (current, index, from, wire, to) => {
        // Only a custom spelling between two thinking levels carries over; a value
        // still spelled as its old level, or one crossing to or from Off, resets.
        const carried = typeof wire === 'string' && wire.length > 0 && wire !== from && from !== 'off' && to !== 'off';
        write(replaceAt(current, index, [to, carried ? wire : defaultValue(to)]));
    };
    const addLevel = (current) => {
        const highest = Math.max(-1, ...used.map(level => levels.indexOf(level)));
        const level = levels.find((candidate, index) => index > highest && !used.includes(candidate))
            ?? levels.find(candidate => !used.includes(candidate));
        /* v8 ignore next -- the add button is disabled once every level has a row */
        if (level === undefined)
            return;
        write([...current, [level, defaultValue(level)]]);
    };
    const editValue = (current, index, level, text) => {
        setTyping({ level, text });
        const trimmed = text.trim();
        write(replaceAt(current, index, [level, trimmed.length === 0 ? defaultValue(level) : trimmed]));
    };
    const leaveValue = (current, index, level, wire) => {
        setTyping(undefined);
        // Leaving a field whose stored value the adapter refuses repairs it with the level name.
        if (!acceptedValue(level, wire))
            write(replaceAt(current, index, [level, defaultValue(level)]));
    };
    // A stored key the offered levels do not name stays selectable in its own row.
    const choicesFor = (level) => [
        ...levels.includes(level) ? [] : [level],
        ...levels.filter(choice => choice === level || !used.includes(choice)),
    ];
    const initialEntries = INITIAL_LEVELS.filter(level => levels.includes(level)).map(level => [level, defaultValue(level)]);
    const refused = entries?.some(([level, wire]) => !acceptedValue(level, wire)) === true;
    const missingLevel = entries !== undefined && !used.some(level => level !== 'off');
    return (_jsxs("div", { className: styles['modelReasoning'], role: "group", "aria-label": label, children: [_jsxs("div", { className: styles['modelReasoningHead'], children: [_jsxs("span", { className: `${styles['modelFieldLabel']} ${styles['modelReasoningLabel']}`, children: [t('modelReasoning'), _jsx(Tooltip, { label: t('modelReasoningHelpText'), side: "right", delayMs: 0, focusDelayMs: 0, portal: true, openOnClick: true, children: _jsx("button", { type: "button", className: styles['helpButton'], "aria-label": t('modelReasoningHelp'), children: "?" }) })] }), _jsx(Switch, { checked: entries !== undefined, label: label, disabled: disabled, onChange: (on) => { write(on ? initialEntries : undefined); } })] }), entries === undefined
                ? null
                : (_jsxs(_Fragment, { children: [entries.length > 0
                            ? (_jsxs("div", { className: styles['modelReasoningRow'], "aria-hidden": "true", children: [_jsx("span", { className: styles['modelFieldLabel'], children: t('modelReasoningLevel') }), _jsx("span", { className: styles['modelFieldLabel'], children: t('modelReasoningValue') })] }))
                            : null, entries.map(([level, wire], index) => (_jsxs("div", { className: styles['modelReasoningRow'], children: [_jsx("select", { className: `${styles['input']} ${styles['selectInput']}`, value: level, "aria-label": `${t('modelReasoningLevel')} ${String(index + 1)}`, disabled: disabled, onChange: (event) => { changeLevel(entries, index, level, wire, event.target.value); }, children: choicesFor(level).map(choice => (_jsx("option", { value: choice, children: choice }, choice))) }), _jsx("input", { className: `${styles['input']} ${styles['modelReasoningValueInput']}`, type: "text", value: typing?.level === level ? typing.text : typeof wire === 'string' ? wire : '', placeholder: level === 'off' ? t('modelReasoningOffValuePlaceholder') : level, "aria-label": `${level} ${t('modelReasoningValue')}`, "aria-invalid": !acceptedValue(level, wire),
                                    // Off only turns reasoning off; a value stored in cordis.patch.yml is shown and kept.
                                    disabled: disabled || level === 'off', onChange: (event) => { editValue(entries, index, level, event.target.value); }, onBlur: () => { leaveValue(entries, index, level, wire); } }), _jsx("button", { type: "button", className: `${styles['iconButton']} ${styles['iconButtonDanger']}`, "aria-label": `${t('modelReasoningRemove')} ${level}`, title: t('modelReasoningRemove'), disabled: disabled, onClick: () => { write(entries.filter((_entry, at) => at !== index)); }, children: _jsx(IconTrashOutlineRegular, { size: 14 }) })] }, index))), refused
                            ? _jsx("p", { className: styles['error'], children: t('modelReasoningValueRequired') })
                            : missingLevel ? _jsx("p", { className: styles['error'], children: t('modelReasoningNeedsLevel') }) : null, _jsxs("button", { type: "button", className: styles['addModelButton'], disabled: disabled || levels.every(level => used.includes(level)), onClick: () => { addLevel(entries); }, children: [_jsx(IconPlusOutlineRegular, { size: 14 }), t('modelReasoningAdd')] })] }))] }));
}

  return { Editor: ModelReasoningEfforts, validate: validateReasoningEfforts };
}
export const modelReasoningCss = "/* MIT; selected original rules from ModelsSection.module.css at the recorded revision. */\n.modelReasoning {\n  grid-column: 1 / -1;\n  display: flex;\n  flex-direction: column;\n  gap: 6px;\n  min-width: 0;\n}\n\n.modelReasoningLabel {\n  display: inline-flex;\n  align-items: center;\n  gap: 6px;\n}\n\n.modelReasoningHead {\n  display: flex;\n  align-items: center;\n  justify-content: space-between;\n  gap: 8px;\n}\n\n.modelReasoningRow {\n  display: grid;\n  grid-template-columns: minmax(0, 1fr) minmax(0, 1fr) auto;\n  align-items: center;\n  gap: 6px;\n}\n\n.modelReasoningRow .selectInput {\n  max-width: none;\n}\n\n.modelReasoningValueInput {\n  font-family: var(--ds-font-family-code);\n  font-size: 13px;\n}\n\n.helpButton {\n  width: 16px;\n  height: 16px;\n  padding: 0;\n  border: 0.5px solid var(--dsw-alias-border-l3);\n  border-radius: 50%;\n  corner-shape: round;\n  background: transparent;\n  color: var(--dsw-alias-label-tertiary);\n  font: inherit;\n  font-size: 11px;\n  line-height: 15px;\n  text-align: center;\n  cursor: help;\n}\n\n.helpButton:focus-visible {\n  color: var(--dsw-alias-label-primary);\n  border-color: var(--dsw-alias-label-tertiary);\n}\n";
export const modelReasoningLocales = {
  "en": {
    "modelReasoning": "Reasoning levels",
    "modelReasoningLevel": "Level",
    "modelReasoningValue": "API value",
    "modelReasoningHelp": "About reasoning levels",
    "modelReasoningHelpText": "The API value is sent in the request's reasoning-effort field, such as OpenAI's reasoning_effort. It defaults to the level name; where the model provider's API documentation specifies a different value, follow it. Off turns reasoning off and needs no value; a value already written in the configuration is kept and sent.",
    "modelReasoningNeedsLevel": "Add at least one level besides Off, or turn reasoning levels off.",
    "modelReasoningValueRequired": "Every level besides Off needs an API value, and no value can be empty.",
    "modelReasoningAdd": "Add level",
    "modelReasoningRemove": "Delete level",
    "modelReasoningOffValuePlaceholder": "Turns reasoning off"
  },
  "zh": {
    "modelReasoning": "推理等级",
    "modelReasoningLevel": "档位",
    "modelReasoningValue": "API 参数值",
    "modelReasoningHelp": "推理等级说明",
    "modelReasoningHelpText": "API 参数值会写入请求的推理强度字段（如 OpenAI 的 reasoning_effort），默认与档位名相同；如有不同，以模型提供商的 API 文档为准。Off 表示关闭思考，不需要填写参数值；配置中已写入的值会保留并发送。",
    "modelReasoningNeedsLevel": "至少添加一个 Off 以外的档位；不需要思考请关闭推理等级。",
    "modelReasoningValueRequired": "Off 以外的档位都需要填写 API 参数值，且参数值不能为空字符串。",
    "modelReasoningAdd": "添加档位",
    "modelReasoningRemove": "删除档位",
    "modelReasoningOffValuePlaceholder": "关闭思考"
  }
};
