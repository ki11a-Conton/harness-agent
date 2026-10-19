/** PR #15: remove user-facing surfaces at component registration, not via DOM/CSS. */
export const removedUiModules = Object.freeze([
  'dsh-client-ui-plugin-manager', 'dsh-client-ui-agent-preset',
  'dsh-client-ui-settings-plugins', 'dsh-client-ui-settings-plugin-inventory',
]);

export function removeProductUi(stem, source) {
  if (removedUiModules.includes(stem)) {
    const signature = '\t\tfunction apply(ctx) {';
    const ending = '\n\t\t}\n\t\t//#endregion\n\t\texports.';
    const start = source.indexOf(signature), end = source.indexOf(ending, start);
    if (start < 0 || start !== source.lastIndexOf(signature) || end < start) throw new Error('Unreviewed UI registration boundary: ' + stem);
    return source.slice(0, start) + '\t\tfunction apply(_ctx) { /* Harness end-user surface intentionally has no registration. */ }' + source.slice(end + '\n\t\t}'.length);
  }
  if (stem === 'dsh-client-ui-settings-general') {
    const row = /ctx\.slots\.inject\("settings\.general\.item", \(\) => ctx\.slots\.register\(\{\s*name: "settings\.general\.item",\s*id: "current-version",\s*order: 100,\s*locale: NS\s*\}, CurrentVersionRow\)\);/g;
    if ([...source.matchAll(row)].length !== 1) throw new Error('Unreviewed current-version registration');
    source = source.replace(row, '// The published frontend version is not the host version and is not an end-user setting.');
    source = source.replace('Shows trajectory, code diffs, and all Agent presets', 'Shows trajectory and code diffs');
    source = source.replace('开启后，显示轨迹、本轮代码差异，可选择完整的 Agent 预设切换', '开启后，显示轨迹和本轮代码差异');
  }
  if (stem === 'dsh-client-ui-conversation') {
    const title = /,\s*\(0, react_jsx_runtime\.jsxs\)\("span", \{\s*className: HeroShell_module_css_default\.titleGroup,\s*children: \[\(0, react_jsx_runtime\.jsx\)\("span", \{ children: t\("hero\.headline"\) \}\)\]\s*\}\)/g;
    if ([...source.matchAll(title)].length !== 1) throw new Error('Unreviewed hero headline component');
    source = source.replace(title, '');
  }
  return source;
}
