import { readFile } from "node:fs/promises";
import vm from "node:vm";
import { expect, it } from "vitest";

async function controller() {
  const source = await readFile(new URL("../../public/deepseek/harness-brand/plugins/dsh-api-terminal-controller/client.js", import.meta.url), "utf8");
  const start = source.indexOf("var RemoteError = class extends Error {"), model = source.indexOf("var TerminalView = class {");
  const end = source.indexOf("\n\t\t//#endregion", model);
  expect(start).toBeGreaterThan(0); expect(end).toBeGreaterThan(model);
  return vm.runInNewContext(source.slice(start, end) + ";({TerminalView,TerminalViewError,RemoteError})", {
    AbortController,
    _deepseek_ai_dsh_client_store: { createSnapshotStore: (initial: unknown) => { let state = initial; return { getSnapshot: () => state, set: (next: unknown) => { state = next; } }; } },
    _deepseek_ai_dsh_api_gateway_client: { RemoteStreamCarrierError: class extends Error {} },
  });
}

it("a real terminal allocation denial remains an actionable failure with its original confinement diagnostic", async () => {
  const api = await controller(), reason = "Verified sandbox self-test failed; execution refused";
  const error = new api.RemoteError("terminal/unavailable", reason, { code: "SANDBOX_BACKEND_DENIED" });
  const view = new api.TerminalView("session-a", { create: async () => ({ ok: false, error }) }, {}, "new-terminal");
  await view.create({ maxCols: 80, maxRows: 24 });
  expect(view.state.getSnapshot()).toMatchObject({ phase: "failed", writable: false, error: reason });
  expect(view.state.getSnapshot().issue).toBeUndefined(); expect(view.creation).toBeUndefined();
});

it("an explicit missing-view issue still offers the separate new-terminal recovery", async () => {
  const api = await controller(), view = new api.TerminalView("session-a", {}, {}, "old-terminal", false);
  view.fail(new api.TerminalViewError("missingTerminal"));
  expect(view.state.getSnapshot()).toMatchObject({ phase: "failed", issue: "missingTerminal", writable: false });
});

it("a missing shell keeps its actual failure and a terminal limit keeps its scoped recovery issue", async () => {
  const api = await controller(), view = new api.TerminalView("session-a", {}, {}, "terminal");
  view.fail(new api.RemoteError("terminal/unavailable", "Requested shell is not installed", {}));
  expect(view.state.getSnapshot()).toMatchObject({ error: "Requested shell is not installed", phase: "failed" });
  expect(view.state.getSnapshot().issue).toBeUndefined();
  view.fail(new api.RemoteError("terminal/limit-reached", "Session terminal limit reached", {}));
  expect(view.state.getSnapshot().issue).toBe("terminalLimit");
});
