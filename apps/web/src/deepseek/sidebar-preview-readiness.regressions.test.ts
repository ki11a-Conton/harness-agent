import { expect, it, vi } from "vitest";

type Tab = "demo" | "readme";
interface Locator { waitFor(options: { state: "visible" }): Promise<void>; count(): Promise<number> }
interface Page { getByRole(role: "tab", options: { name: RegExp }): Locator }
const { assertRestoredPreviewTabs } = await import(new URL("../../../../scripts/research/web-daily-20261016/sidebar-preview-readiness.mjs", import.meta.url).href) as {
  assertRestoredPreviewTabs(page: Page, panes: 1 | 2): Promise<void>;
};
function gate() { let release!: () => void; const promise = new Promise<void>(resolve => { release = resolve; }); return { promise, release }; }
function page(counts: Record<Tab, number>, wait: (tab: Tab) => Promise<void> = async () => {}) {
  const waited = vi.fn(async (tab: Tab, options: { state: "visible" }) => { expect(options).toEqual({ state: "visible" }); await wait(tab); });
  const counted = vi.fn(async (tab: Tab) => counts[tab]);
  const value: Page = { getByRole(role, options) {
    expect(role).toBe("tab"); const tab: Tab = options.name.test("demo.js") ? "demo" : "readme";
    return { waitFor: options => waited(tab, options), count: () => counted(tab) };
  } };
  return { value, waited, counted };
}

it("waits for both actual visible tab frames before taking either exact count", async () => {
  const demo = gate(), readme = gate(), demoEntered = gate(), readmeEntered = gate(), demoReady = gate();
  const h = page({ demo: 1, readme: 1 }, async tab => {
    if (tab === "demo") { demoEntered.release(); await demo.promise; demoReady.release(); }
    else { readmeEntered.release(); await readme.promise; }
  });
  const pending = assertRestoredPreviewTabs(h.value, 2);
  try {
    // Both waits must start before either frame is released; fail promptly if
    // a future implementation serializes them into two independent budgets.
    expect(h.waited).toHaveBeenCalledTimes(2);
    await Promise.all([demoEntered.promise, readmeEntered.promise]);
    expect(h.counted).not.toHaveBeenCalled();
    demo.release(); await demoReady.promise; expect(h.counted).not.toHaveBeenCalled();
    readme.release(); await pending;
    expect(h.counted.mock.calls).toEqual([["demo"], ["readme"]]);
  } finally { demo.release(); readme.release(); await pending; }
});

it.each(["demo", "readme"] as const)("keeps a permanently missing %s tab as a failed acceptance", async missing => {
  const failure = new Error("actual visible-frame deadline expired");
  const h = page({ demo: missing === "demo" ? 0 : 1, readme: missing === "readme" ? 0 : 1 }, async tab => { if (tab === missing) throw failure; });
  await expect(assertRestoredPreviewTabs(h.value, 2)).rejects.toBe(failure);
  expect(h.counted).not.toHaveBeenCalled();
});

it.each(["demo", "readme"] as const)("rejects duplicate %s tabs after visible-frame readiness", async duplicate => {
  const h = page({ demo: duplicate === "demo" ? 2 : 1, readme: duplicate === "readme" ? 2 : 1 });
  await expect(assertRestoredPreviewTabs(h.value, 2)).rejects.toThrow(/2 !== 1/);
});

it("a one-pane preview still requires one demo and zero README tabs", async () => {
  const h = page({ demo: 1, readme: 0 });
  await assertRestoredPreviewTabs(h.value, 1);
  expect(h.waited.mock.calls).toEqual([["demo", { state: "visible" }]]);
  expect(h.counted.mock.calls).toEqual([["demo"], ["readme"]]);
  const extra = page({ demo: 1, readme: 1 });
  await expect(assertRestoredPreviewTabs(extra.value, 1)).rejects.toThrow(/1 !== 0/);
});
