import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { createHarness } from "@ar/harness";
import { ScriptedModelProvider } from "@ar/model";
import { createRuntimeRpc } from "@ar/gateway";
import { createHostTools } from "./host-tools.js";
import { createSessionService } from "./session.js";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const action of cleanup.splice(0).reverse()) await action(); });

it("the official desktop path DTOs expose headless capability without executing a launcher or mutating files and reject malformed carriers", async () => {
  const root = await mkdtemp(join(tmpdir(), "dsh-desktop-official-dto-")); cleanup.push(() => rm(root, { recursive: true, force: true }));
  const cwd = join(root, "project"), dataDir = join(root, "data"); await mkdir(cwd); const path = join(cwd, "proof.txt"); await writeFile(path, "Unchanged original bytes\n");
  const provider = new ScriptedModelProvider([ScriptedModelProvider.text("Unused")]);
  const harness = await createHarness({ cwd, dataDir, profile: "interactive", modelProvider: provider, model: { providerId: provider.id, modelId: "scripted-model" } }); cleanup.push(() => harness.close());
  const host = { harness, cwd, dataDir, rpc: createRuntimeRpc(harness.runtime, { sessionService: harness.sessionService, sessions: harness.sessions, events: harness.events, approvalStore: harness.approvalStore }), ...createHostTools(harness, cwd, dataDir) };
  const service = createSessionService(host), signal = new AbortController().signal;
  expect(service.endpoints).toEqual(expect.arrayContaining(["session/canOpenWorkspacePath", "session/workspacePathApplications", "session/openWorkspacePath"]));
  expect(await service.call("session/canOpenWorkspacePath", {}, signal)).toBe(false);
  expect(await service.call("session/workspacePathApplications", { request: { path } }, signal)).toEqual([]);
  for (const request of [{ path }, { path, action: "reveal" }, { path, application: "/fake/application" }]) {
    await expect(service.call("session/openWorkspacePath", { request }, signal)).rejects.toMatchObject({ code: "gateway/unavailable" });
  }
  for (const [endpoint, args] of [
    ["session/canOpenWorkspacePath", { request: {} }],
    ["session/workspacePathApplications", { request: { path, extra: true } }],
    ["session/workspacePathApplications", { path }],
    ["session/openWorkspacePath", { request: { path, action: "execute" } }],
    ["session/openWorkspacePath", { request: { path, application: 1 } }],
    ["session/openWorkspacePath", { request: { path, command: "touch unexpected" } }],
  ] as const) await expect(service.call(endpoint, args, signal)).rejects.toMatchObject({ code: "gateway/bad-request" });
  await expect(service.call("session/notARealDesktopMethod", { request: { path } }, signal)).rejects.toMatchObject({ code: "gateway/not-found" });
  expect(await readFile(path, "utf8")).toBe("Unchanged original bytes\n"); expect(await readdir(cwd)).toEqual(["proof.txt"]); expect(await harness.store.listSessions()).toEqual([]);
  const aborted = new AbortController(); aborted.abort(); await expect(service.call("session/canOpenWorkspacePath", {}, aborted.signal)).rejects.toThrow();
});
