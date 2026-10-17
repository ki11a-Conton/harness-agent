/** Reviewed Harness UI changes. The pinned upstream bundles stay unmodified. */
function replaceOnce(source, before, after) {
  if (source.split(before).length !== 2) throw new Error('Workspace UI source boundary changed: ' + before.slice(0, 70));
  return source.replace(before, after);
}

function trackNavigation(source, signature) {
  const marker = '\n\t\t\t' + signature + ' {';
  if (source.split(marker).length !== 2) throw new Error('Workspace navigation method changed: ' + signature);
  const start = source.indexOf(marker) + marker.length;
  const end = source.indexOf('\n\t\t\t}', start);
  if (end < start) throw new Error('Workspace navigation method has no closing boundary');
  return source.slice(0, start) + `
                const intent = ++this.navigationIntent;
                this.navigationPending.set(true);
                try {` + source.slice(start, end) + `
                } finally {
                    if (intent === this.navigationIntent) this.navigationPending.set(false);
                }` + source.slice(end);
}

/** An editable old composer must not accept input for a pending new task. */
export function guardWorkspaceNavigation(source) {
  source = replaceOnce(source,
    'selection = (0, _deepseek_ai_dsh_client_store.createSnapshotStore)({}, { persist: { name: "dsh.sessions.current" } });',
    'selection = (0, _deepseek_ai_dsh_client_store.createSnapshotStore)({}, { persist: { name: "dsh.sessions.current" } });\n            navigationPending = (0, _deepseek_ai_dsh_client_store.createSnapshotStore)(false);\n            navigationIntent = 0;');
  source = trackNavigation(source, 'async restoreSelection(workspaces, sessions)');
  source = trackNavigation(source, 'async openWorkspace(workspaceId, beforeOpen)');
  for (const method of ['openSession(target)', 'clearMain()']) source = replaceOnce(source,
    method + ' {', method + ' {\n                ++this.navigationIntent;\n                this.navigationPending.set(false);');
  return source;
}

export function guardConversationNavigation(source) {
  source = replaceOnce(source, 'useInput, useComposerBlock, renderSlot', 'useInput, useComposerBlock, useWorkspaceNavigation, renderSlot');
  source = replaceOnce(source, 'const composerBlock = useComposerBlock((block) => block);',
    'const composerBlock = useComposerBlock((block) => block);\n            const navigationPending = useWorkspaceNavigation((pending) => pending);');
  source = replaceOnce(source,
    'hooks: { composerBlock: sessionId === void 0 ? ABSENT_BLOCK : composerBlocks.storeFor(sessionId) },',
    'hooks: { composerBlock: sessionId === void 0 ? ABSENT_BLOCK : composerBlocks.storeFor(sessionId), workspaceNavigation: workspaceNavigation.navigationPending },');
  return replaceOnce(source, 'const inert = workspaceSelectionPending ||', 'const inert = navigationPending || workspaceSelectionPending ||');
}
