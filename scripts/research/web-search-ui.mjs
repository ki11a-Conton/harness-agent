/** Multilingual search adapters over frozen client modules; original published bytes remain intact. */
import { createBrowserTextSearch } from './web-text-search-runtime.mjs';
export const searchUiModules = Object.freeze(['dsh-client-ui-model-selection', 'dsh-client-ui-commands', 'dsh-client-ui-workspace']);

export function addSearchUi(stem, source) {
  if (!searchUiModules.includes(stem)) return source;
  const replace = (before, after) => {
    if (source.split(before).length !== 2) throw new Error('Unreviewed search boundary: ' + stem + ' ' + before.slice(0, 70));
    source = source.replace(before, after);
  };
  let extra = '';
  if (stem === 'dsh-client-ui-model-selection') {
    replace('const filteredGroups = (0, react.useMemo)(() => groups.map((group) => ({\n\t\t\t\t...group,\n\t\t\t\tmodels: (0, _deepseek_ai_dsh_client_ui_primitives.rankByName)(group.models, showSearch ? query.trim() : "")\n\t\t\t})).filter((group) => group.models.length > 0), [\n\t\t\t\tgroups,',
      'const groupIndexes = (0, react.useMemo)(() => groups.map(group => ({ group, index: new harnessTextSearch.TextSearchIndex(group.models, model => ({ fuzzy: [model.name, model.id], substring: [model.description] })) })), [groups]);\n\t\t\tconst filteredGroups = (0, react.useMemo)(() => groupIndexes.map(({ group, index }) => ({ ...group, models: index.search(showSearch ? query : "") })).filter(group => group.models.length > 0), [\n\t\t\t\tgroupIndexes,');
  }
  if (stem === 'dsh-client-ui-commands') {
    replace('const query = search.trim().toLowerCase();', 'const query = search.trim();');
    replace('if (mode === "fuzzy-label") return groups.flatMap((group) => (0, _deepseek_ai_dsh_client_ui_primitives.rankByName)(group.rows.map((option) => ({\n\t\t\t\tname: option.label,\n\t\t\t\toption\n\t\t\t})), query).map((row) => row.option));\n\t\t\treturn ordered.filter((o) => o.label.toLowerCase().includes(query) || (o.detail?.toLowerCase().includes(query) ?? false));',
      'if (mode === "fuzzy-label") return groups.flatMap(group => new harnessTextSearch.TextSearchIndex(group.rows, option => ({ fuzzy: [option.label], substring: [option.detail] })).search(query));\n\t\t\treturn new harnessTextSearch.TextSearchIndex(ordered, option => ({ substring: [option.label, option.detail] })).search(query);');
    replace('return req.query === "" ? sectionRows(visible, this.t) : (0, _deepseek_ai_dsh_client_ui_primitives.rankByName)(visible, req.query);',
      'return req.query === "" ? sectionRows(visible, this.t) : new harnessTextSearch.TextSearchIndex(visible, row => ({ fuzzy: [row.name, row.label], substring: [row.description] })).search(req.query);');
  }
  if (stem === 'dsh-client-ui-workspace') {
    extra = `\nconst harnessWorkspaceIndexes = new WeakMap();
function harnessWorkspaceSearch(list, workspaces, labelOf, query) {
  let cached = harnessWorkspaceIndexes.get(list);
  if (cached === undefined || cached.workspaces !== workspaces) {
    const rows = list.ids.map(id => list.byId[id]).filter(row => row !== undefined && !row.blank);
    cached = { workspaces, index: new harnessTextSearch.TextSearchIndex(rows, row => ({ fuzzy: [sessionTitle(row), labelOf(row)], substring: [row.cwd] })) };
    harnessWorkspaceIndexes.set(list, cached);
  }
  return cached.index.search(query);
}`;
    replace('const q = query.trim().toLowerCase();', 'const q = query.trim();');
    replace('for (const id of list.ids) {\n\t\t\t\tconst summary = list.byId[id];\n\t\t\t\tif (summary === void 0 || summary.blank || !sessionVisible(summary, current, archived, archivedFilter)) continue;\n\t\t\t\tif (sessionTitle(summary).toLowerCase().includes(q) || labelOf(summary).toLowerCase().includes(q)) local.push(summary);\n\t\t\t}',
      'for (const summary of harnessWorkspaceSearch(list, workspaces, labelOf, q)) {\n\t\t\t\tif (!sessionVisible(summary, current, archived, archivedFilter)) continue;\n\t\t\t\tlocal.push(summary);\n\t\t\t}');
  }
  const factory = 'factory: (require) => {';
  replace(factory, factory + '\n\t\tconst harnessTextSearch = (' + createBrowserTextSearch.toString() + ')();' + extra + '\n\t\t// End Harness multilingual search.');
  return source;
}
