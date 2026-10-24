/** Keyboard access for the reviewed workspace derivative; upstream stays frozen. */
function replaceOnce(source, before, after) {
  if (source.split(before).length !== 2) throw new Error('Workspace actions UI source boundary changed: ' + before.slice(0, 70));
  return source.replace(before, after);
}

export function addWorkspaceActionsUi(source) {
  const declaration = 'function ProjectRowItem(';
  const keyboard = `function activateWorkspaceRow(event) {
            // Native child buttons own their Enter/Space activation. Dispatch only
            // from the row itself so their bubbling key events cannot navigate.
            if (event.target !== event.currentTarget || event.defaultPrevented ||
                event.nativeEvent.isComposing || event.altKey ||
                event.ctrlKey || event.metaKey || event.shiftKey ||
                (event.key !== "Enter" && event.key !== " ")) return;
            event.preventDefault();
            event.stopPropagation();
            // A held activation key must neither repeat navigation nor scroll.
            if (event.repeat) return;
            event.currentTarget.click();
        }
        `;
  source = replaceOnce(source, declaration, keyboard + declaration);
  for (const marker of [
    '"data-row-key": `workspace:${group.key}`,\n\t\t\t\trole: "treeitem",',
    'className: clsx(Rows_module_css_default.searchResultRow, selected && Rows_module_css_default.selected, result.archived && Rows_module_css_default.archived),\n\t\t\t\trole: "treeitem",',
    'className: clsx(Rows_module_css_default.sessionRow, selected && Rows_module_css_default.selected, menuOpen && Rows_module_css_default.menuOpen, row.archived && Rows_module_css_default.archived, drag?.marker === "before" && Rows_module_css_default.dropBefore, drag?.marker === "after" && Rows_module_css_default.dropAfter),\n\t\t\t\t\trole: "treeitem",',
  ]) {
    source = replaceOnce(source, marker, marker + '\n                tabIndex: 0,\n                onKeyDown: activateWorkspaceRow,');
  }
  const visible = '.YDXeBa_projectRow:hover .YDXeBa_rowActions,.YDXeBa_sessionRow:hover .YDXeBa_rowActions,.YDXeBa_searchResultRow:hover .YDXeBa_rowActions,.YDXeBa_projectRow.YDXeBa_menuOpen .YDXeBa_rowActions,.YDXeBa_sessionRow.YDXeBa_menuOpen .YDXeBa_rowActions';
  source = replaceOnce(source, visible + '{display:inline-flex}', visible + ',.YDXeBa_projectRow:focus-within .YDXeBa_rowActions,.YDXeBa_sessionRow:focus-within .YDXeBa_rowActions,.YDXeBa_searchResultRow:focus-within .YDXeBa_rowActions,.YDXeBa_sessionRow.YDXeBa_selected .YDXeBa_rowActions,.YDXeBa_searchResultRow.YDXeBa_selected .YDXeBa_rowActions{display:inline-flex}.YDXeBa_projectRow:focus-visible,.YDXeBa_sessionRow:focus-visible,.YDXeBa_searchResultRow:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:-2px}');
  return source;
}
