import assert from 'node:assert/strict';

/** A sidebar click acknowledges the action before its next accessible frame.
 * Wait for the real tabs using the page's existing timeout, then retain exact
 * cardinality checks so lost or duplicated panes still fail acceptance. */
export async function assertRestoredPreviewTabs(page, panes) {
  const demo = page.getByRole('tab', { name: /demo\.js/ });
  const readme = page.getByRole('tab', { name: /README\.md/ });
  await Promise.all([
    demo.waitFor({ state: 'visible' }),
    ...(panes === 2 ? [readme.waitFor({ state: 'visible' })] : []),
  ]);
  assert.equal(await demo.count(), 1);
  assert.equal(await readme.count(), panes - 1);
}
