import { constants, promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { newAgentId, newSessionId, newToolCallId, newTurnId, type ToolExecutionContext } from "@ar/contracts";
import { writeFileTool } from "./tools/write-file.js";
import { ToolRegistry } from "./registry.js";
import { ToolOrchestrator } from "./orchestrator.js";
import { fileLockEntryCount } from "./file-coordination.js";
let root: string, ws: string, outside: string;
beforeEach(async () => { root = await fs.mkdtemp(join(tmpdir(), "file-create-integrity-")); ws = join(root, "workspace"); outside = join(root, "outside"); await fs.mkdir(ws); await fs.mkdir(outside); });
afterEach(async () => { vi.restoreAllMocks(); await fs.rm(root, { recursive: true, force: true }); });
function invoke(path: string, append = false, signal = new AbortController().signal) {
  const registry = new ToolRegistry(); registry.register(writeFileTool);
  const orchestrator = new ToolOrchestrator({ registry, workspaceRoot: ws });
  const context: ToolExecutionContext = { cwd: ws, sessionId: newSessionId(), turnId: newTurnId(), agentId: newAgentId(), signal,
    permissions: { rules: [{ action: "*", resource: "*", effect: "allow" }] },
    sandboxPolicy: { filesystem: { mode: "workspace-write", allowedPaths: [ws] }, network: { mode: "deny" }, process: { timeoutMs: 2000 } } };
  const id = newToolCallId(); return orchestrator.execute({ id, sessionId: context.sessionId, turnId: context.turnId, agentId: context.agentId, call: { id, name: "write_file", args: { path, append, content: "complete requested bytes" } } }, context);
}
it.each([false, true])("denies creating an external file through a dangling leaf symlink, append=%s", async append => {
  const target = join(outside, "new.ts"), link = join(ws, "alias.ts"); await fs.symlink(target, link, "file");
  const result = await invoke(link, append); expect(result.status).toBe("denied"); expect(result.error?.code).toBe("SANDBOX_FILESYSTEM_DENIED");
  await expect(fs.stat(target)).rejects.toMatchObject({ code: "ENOENT" }); expect(fileLockEntryCount()).toBe(0);
});
it("denies creating external directories through a dangling directory alias", async () => {
  const target = join(outside, "newdir"), link = join(ws, "alias"); await fs.symlink(target, link, process.platform === "win32" ? "junction" : "dir");
  expect((await invoke(join(link, "new.ts"))).status).toBe("denied"); await expect(fs.stat(target)).rejects.toMatchObject({ code: "ENOENT" });
});
it("resolves relative chained dangling aliases before authorizing writes", async () => {
  const target = join(outside, "new.ts"), first = join(ws, "first"), second = join(ws, "second");
  await fs.symlink(relative(ws, target), second, "file"); await fs.symlink("second", first, "file");
  expect((await invoke(first)).status).toBe("denied"); await expect(fs.stat(target)).rejects.toMatchObject({ code: "ENOENT" });
});
it.each([false, true])("finishes an admitted new-file create when abort arrives after open, append=%s", async append => {
  const path = join(ws, "new.ts"), controller = new AbortController(), open = fs.open.bind(fs); const handles: Awaited<ReturnType<typeof fs.open>>[] = [];
  vi.spyOn(fs, "open").mockImplementation(async (...args) => { const handle = await open(...args); handles.push(handle); controller.abort(); return handle; });
  const result = await invoke(path, append, controller.signal); expect(result.status).toBe("success");
  await vi.waitFor(() => { expect(handles.every(h => h.fd === -1)).toBe(true); expect(fileLockEntryCount()).toBe(0); });
  expect(await fs.readFile(path, "utf8")).toBe("complete requested bytes");
});
it.each([false, true])("preserves authorized dangling symlink identity, append=%s", async append => {
  const target = join(ws, "real.ts"), alias = join(ws, "alias.ts"); await fs.symlink("real.ts", alias, "file");
  expect((await invoke(alias, append)).status).toBe("success"); expect((await fs.lstat(alias)).isSymbolicLink()).toBe(true);
  expect(await fs.readFile(target, "utf8")).toBe("complete requested bytes");
});
it("does not create a new file when already cancelled", async () => {
  const path = join(ws, "new.ts"), controller = new AbortController(); controller.abort();
  expect((await invoke(path, false, controller.signal)).status).toBe("cancelled"); await expect(fs.stat(path)).rejects.toMatchObject({ code: "ENOENT" });
});

it("keeps new-file bytes complete if cancellation arrives during owned stat", async () => {
  const path = join(ws, "new.ts"), controller = new AbortController(), open = fs.open.bind(fs);
  vi.spyOn(fs, "open").mockImplementation(async (...args) => {
    const handle = await open(...args), stat = handle.stat.bind(handle);
    vi.spyOn(handle, "stat").mockImplementation(async () => { const result = await stat(); controller.abort(); return result; });
    return handle;
  });
  expect((await invoke(path, false, controller.signal)).status).toBe("success");
  expect(await fs.readFile(path, "utf8")).toBe("complete requested bytes"); expect(fileLockEntryCount()).toBe(0);
});

it("does not treat a competing creation as its own irreversible write", async () => {
  const path = join(ws, "new.ts"), controller = new AbortController(), open = fs.open.bind(fs); let competed = false;
  vi.spyOn(fs, "open").mockImplementation(async (...args) => {
    if (typeof args[1] === "number" && (args[1] & constants.O_EXCL)) {
      competed = true; await fs.writeFile(path, "another writer's bytes"); throw Object.assign(new Error("exists"), { code: "EEXIST" });
    }
    const handle = await open(...args); if (competed) controller.abort(); return handle;
  });
  expect((await invoke(path, false, controller.signal)).status).toBe("cancelled"); expect(competed).toBe(true);
  expect(await fs.readFile(path, "utf8")).toBe("another writer's bytes"); expect(fileLockEntryCount()).toBe(0);
});
