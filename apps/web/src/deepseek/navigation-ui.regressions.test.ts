import { readFile } from "node:fs/promises";
import vm from "node:vm";
import { expect, it } from "vitest";

// Execute the actual generated browser controller, with its transport/store
// dependencies controlled. Real Chromium tests separately cover the composer.
async function controller() {
  const source = await readFile(new URL("../../public/deepseek/harness-brand/plugins/dsh-client-ui-workspace/client.js", import.meta.url), "utf8");
  const start = source.indexOf("var UiWorkspaceService = class extends");
  const end = source.indexOf("\n\t\t};", start) + "\n\t\t};".length;
  expect(start).toBeGreaterThan(0); expect(end).toBeGreaterThan(start);
  const snapshots = (initial: unknown) => { let value = initial; return { getSnapshot: () => value, set: (next: unknown) => { value = next; } }; };
  const ctor = vm.runInNewContext(source.slice(start, end) + ";UiWorkspaceService", {
    AbortController, AbortSignal,
    _deepseek_ai_cordis: { Service: class { ctx: unknown; constructor(ctx: unknown) { this.ctx = ctx; } } },
    _deepseek_ai_dsh_client_store: { createSnapshotStore: snapshots },
    creationFailureMessage: (error: Error) => error.message,
  });
  let navigation = new AbortController(); const notices: unknown[] = [];
  const ctx = { effect: () => {}, layout: { beginNavigation: () => { navigation.abort(); navigation = new AbortController(); return navigation.signal; }, selectPanel: () => navigation.abort() } };
  const sessions = { retain: (id: string) => ({ sessionId: id, release: () => {} }), subagentAddress: () => undefined };
  const service = new ctor(ctx, {}, {}, sessions, {}, (notice: unknown) => notices.push(notice));
  service.mainReference = sessions.retain("old"); service.selection.set({ sessionId: "old" });
  return { service, notices };
}
function deferred<T>() { let resolve!: (value: T) => void, reject!: (error: Error) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }

it("the actual new-session controller blocks its old composer until the selected session is ready", async () => {
  const { service } = await controller(), opening = deferred<string>(); service.connectWorkspace = () => opening.promise;
  const task = service.openWorkspace("workspace");
  expect(service.navigationPending.getSnapshot()).toBe(true); expect(service.selection.getSnapshot().sessionId).toBe("old");
  opening.resolve("new"); await task;
  // selectPanel aborts the navigation signal in the real layout too. Cleanup
  // must use the intent identity, rather than leaving pending stuck on abort.
  expect(service.navigationPending.getSnapshot()).toBe(false); expect(service.selection.getSnapshot().sessionId).toBe("new");
});

it("failed session creation restores editability without replacing the existing session", async () => {
  const { service, notices } = await controller(), opening = deferred<string>(); service.connectWorkspace = () => opening.promise;
  const task = service.openWorkspace("workspace"); opening.reject(new Error("Actual host refused creation"));
  await expect(task).rejects.toThrow("Actual host refused creation");
  expect(service.navigationPending.getSnapshot()).toBe(false); expect(service.selection.getSnapshot().sessionId).toBe("old");
  expect(notices).toHaveLength(1);
});

it("a late first navigation cannot replace or unblock the newer navigation", async () => {
  const { service } = await controller(), a = deferred<string>(), b = deferred<string>();
  service.connectWorkspace = (id: string) => id === "a" ? a.promise : b.promise;
  const first = service.openWorkspace("a"), second = service.openWorkspace("b");
  a.resolve("late-a"); await first;
  expect(service.navigationPending.getSnapshot()).toBe(true); expect(service.selection.getSnapshot().sessionId).toBe("old");
  b.resolve("selected-b"); await second;
  expect(service.navigationPending.getSnapshot()).toBe(false); expect(service.selection.getSnapshot().sessionId).toBe("selected-b");
});

it("an explicit existing-session click cancels pending creation and unlocks that actual destination", async () => {
  const { service } = await controller(), opening = deferred<string>(); service.connectWorkspace = () => opening.promise;
  const task = service.openWorkspace("workspace"); service.openSession("explicit");
  expect(service.navigationPending.getSnapshot()).toBe(false); expect(service.selection.getSnapshot().sessionId).toBe("explicit");
  opening.resolve("stale"); await task;
  expect(service.selection.getSnapshot().sessionId).toBe("explicit");
});

async function sidebarView() {
  const source = await readFile(new URL("../../public/deepseek/harness-brand/plugins/dsh-client-ui-sidebar-right/client.js", import.meta.url), "utf8");
  const start = source.indexOf("var SidebarSessionView = class {");
  const end = source.indexOf("\n\t\t};", start) + "\n\t\t};".length;
  expect(start).toBeGreaterThan(0); expect(end).toBeGreaterThan(start);
  const errors: unknown[][] = [], readiness = deferred<void>(); let released = 0;
  const View = vm.runInNewContext(source.slice(start, end) + ";SidebarSessionView", { console: { error: (...args: unknown[]) => errors.push(args) } });
  const view = new View("session-a", { retain: () => ({ ready: readiness.promise, release: () => { released++; readiness.reject(new Error("Released own view")); } }) }, () => {}, () => {});
  return { view, readiness, errors, releases: () => released };
}

it("retiring an opening actual sidebar view releases its reference once without reporting that cancellation as a failure", async () => {
  const s = await sidebarView(); s.view.retire(); s.view.dispose(); await Promise.resolve();
  expect(s.releases()).toBe(1); expect(s.errors).toEqual([]);
});

it("an actual sidebar readiness failure in a live view still reports its error", async () => {
  const s = await sidebarView(), error = new Error("Actual session open failed");
  s.readiness.reject(error); await Promise.resolve();
  expect(s.errors).toEqual([["Sidebar Session opening failed:", error]]);
});
