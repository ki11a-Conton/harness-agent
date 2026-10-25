import assert from 'node:assert/strict';

// A mounted InputBar can still be the native workspace-picker trigger while
// the workspace/session projections catch up with session/create. Its resident
// contenteditable is not yet a coding input, even though it is visible.
export const editableComposer = '[data-composer-input=true][contenteditable=true]:not([aria-haspopup="menu"])';

/** One native New session action, its real admission, and its ready UI owner.
 * No extra workspace selection, mutation RPC, fixed sleep, or action retry. */
export async function createReadyWorkspaceSession(page, rpc, { timeout = 30000 } = {}) {
  const until = async (action, label) => {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) { if (await action()) return; await page.waitForTimeout(40); }
    throw new Error(label);
  };
  await page.locator(editableComposer).filter({ visible: true }).waitFor({ timeout });
  const admissions = () => rpc.results.filter(item => item.endpoint === 'session/create');
  const calls = () => rpc.calls.filter(item => item.endpoint === 'session/create');
  await until(() => calls().length === admissions().length, 'Initial session admissions did not settle');
  const before = admissions().length;
  await page.getByRole('button', { name: /^(New session|新会话)$/, exact: true }).filter({ visible: true }).last().click();
  let sessionId;
  await until(async () => {
    const receipts = admissions().slice(before);
    for (const receipt of receipts.filter(item => !item.ok)) {
      assert.equal(receipt.error?.code, 'session/writer-held', 'Unexpected native session admission refusal');
    }
    if (calls().length !== admissions().length) return false;
    const owners = page.locator('[data-conversation-content][data-conversation-session]').filter({ visible: true });
    if (await owners.count() !== 1) return false;
    const id = await owners.getAttribute('data-conversation-session');
    if (!receipts.some(item => item.ok && item.value?.sessionId === id)) return false;
    if (!await owners.locator(editableComposer).isVisible()) return false;
    sessionId = id; return true;
  }, 'The admitted session did not become the actual editable workspace owner');
  assert(sessionId);
  const owner = page.locator(`[data-conversation-content][data-conversation-session="${sessionId}"]`).filter({ visible: true });
  assert.equal(await owner.count(), 1);
  assert.equal(await owner.locator(editableComposer).count(), 1);
  return { sessionId, owner, admissionCount: admissions().length - before };
}
