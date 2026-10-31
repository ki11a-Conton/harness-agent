import { constants, promises as fs } from "node:fs";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { newAgentId, newSessionId, newToolCallId, newTurnId, type ToolExecutionContext } from "@ar/contracts";
import { editFileTool } from "./tools/edit-file.js";
import { writeFileTool } from "./tools/write-file.js";
import { ToolRegistry } from "./registry.js";
import { ToolOrchestrator } from "./orchestrator.js";
import { fileLockEntryCount } from "./file-coordination.js";

vi.mock("node:fs/promises", async original => ({
  ...await original<typeof import("node:fs/promises")>(),
  open: (...args: Parameters<typeof fs.open>) => fs.open(...args),
}));
let root: string;
let handles: Awaited<ReturnType<typeof fs.open>>[];
beforeEach(async () => { root = await fs.mkdtemp(join(tmpdir(), "ar-edit-resource-")); handles = []; });
afterEach(async () => {
  vi.restoreAllMocks();
  for (const handle of handles) if (handle.fd >= 0) await handle.close();
  await fs.rm(root, { recursive: true, force: true });
});
const digest = (value: string) => createHash("sha256").update(value).digest("hex");
function setup(signal = new AbortController().signal, timeoutMs = 2000, allow = true) {
  const registry = new ToolRegistry(); registry.register(editFileTool); registry.register(writeFileTool);
  const orchestrator = new ToolOrchestrator({ registry, workspaceRoot: root });
  const context: ToolExecutionContext = {
    cwd: root, sessionId: newSessionId(), turnId: newTurnId(), agentId: newAgentId(), signal,
    permissions: { rules: [{ action: "*", resource: "*", effect: allow ? "allow" : "deny" }] },
    sandboxPolicy: { filesystem: { mode: "workspace-write", allowedPaths: [root] }, network: { mode: "deny" }, process: { timeoutMs } },
  };
  return { context, invoke(name = "edit_file", path = "source.ts", versioned = false) {
    const id = newToolCallId();
    return orchestrator.execute({ id, sessionId: context.sessionId, turnId: context.turnId, agentId: context.agentId,
      call: { id, name, args: { path, oldText: "old", newText: "new", content: "new", ...(versioned ? { expectedSha256: digest("old") } : {}) } } }, context);
  } };
}
function observe(transform?: (handle: Awaited<ReturnType<typeof fs.open>>, index: number, close: () => Promise<void>) => void) {
  const open = fs.open.bind(fs);
  return vi.spyOn(fs, "open").mockImplementation(async (...args) => {
    const handle = await open(...args), close = handle.close.bind(handle); handles.push(handle); vi.spyOn(handle, "close"); transform?.(handle, handles.length - 1, close); return handle;
  });
}

it("uses and closes owned regular descriptors for both the snapshot and pre-write version check", async () => {
  const target = join(root, "source.ts"); await fs.writeFile(target, "old"); const opened = observe();
  const result = await setup().invoke();
  expect(result.status).toBe("success"); expect(await fs.readFile(target, "utf8")).toBe("new");
  expect(opened).toHaveBeenCalledTimes(3);
  for (const call of opened.mock.calls.slice(0, 2)) expect(call[1]).toBe(constants.O_RDONLY | (process.platform === "win32" ? 0 : constants.O_NONBLOCK));
  expect(opened.mock.calls[2]![1]).toBe(constants.O_WRONLY | constants.O_CREAT | (process.platform === "win32" ? 0 : constants.O_NONBLOCK));
  for (const handle of handles) { expect(handle.close).toHaveBeenCalledTimes(1); expect(handle.fd).toBe(-1); }
  expect(fileLockEntryCount()).toBe(0);
});

it.each(["open", "stat", "read", "version-read"])("cancels at the %s boundary without writing and closes ownership", async boundary => {
  const target = join(root, "source.ts"); await fs.writeFile(target, "old"); const controller = new AbortController();
  observe((handle, index) => {
    if (boundary === "open" && index === 0) controller.abort();
    if (boundary === "stat" && index === 0) {
      const stat = handle.stat.bind(handle); vi.spyOn(handle, "stat").mockImplementation(async () => { const value = await stat(); controller.abort(); return value; });
    }
    if ((boundary === "read" && index === 0) || (boundary === "version-read" && index === 1)) {
      const read = handle.readFile.bind(handle); vi.spyOn(handle, "readFile").mockImplementation(async options => { const bytes = await read(options); controller.abort(); return bytes; });
    }
  });
  const result = await setup(controller.signal).invoke();
  expect(result.status).toBe("cancelled"); expect(result.output).toBeUndefined(); expect(result.evidence).toBeUndefined();
  expect(await fs.readFile(target, "utf8")).toBe("old"); expect(handles.length).toBeGreaterThan(0);
  for (const handle of handles) { expect(handle.close).toHaveBeenCalledTimes(1); expect(handle.fd).toBe(-1); }
  expect(fileLockEntryCount()).toBe(0);
});

it.each(["stat", "read"])("closes after a real descriptor's %s reports failure", async stage => {
  await fs.writeFile(join(root, "source.ts"), "old");
  observe(handle => { if (stage === "stat") vi.spyOn(handle, "stat").mockRejectedValue(new Error("stat-failed")); else vi.spyOn(handle, "readFile").mockRejectedValue(new Error("read-failed")); });
  const result = await setup().invoke(); expect(result.status).toBe("failed"); expect(result.error?.message).toContain(`${stage}-failed`);
  expect(handles).toHaveLength(1); expect(handles[0]!.fd).toBe(-1); expect(fileLockEntryCount()).toBe(0);
  expect(await fs.readFile(join(root, "source.ts"), "utf8")).toBe("old");
});

it.each([
  { name: "edit_file", index: 0 },
  { name: "edit_file", index: 1 },
  { name: "write_file", index: 0 },
])("propagates cancellation into a pending owned read for $name at descriptor $index", async ({ name, index }) => {
  const target = join(root, "source.ts"); await fs.writeFile(target, "old"); const controller = new AbortController();
  let entered!: () => void; const ready = new Promise<void>(resolve => { entered = resolve; });
  let nativeSignal: AbortSignal | undefined;
  observe((handle, current) => {
    if (current !== index) return;
    const read = handle.readFile.bind(handle);
    vi.spyOn(handle, "readFile").mockImplementation(async options => {
      await read(options);
      nativeSignal = options && typeof options === "object" ? options.signal : undefined;
      if (!nativeSignal) throw new Error("owned read must receive the native cancellation signal");
      const signal = nativeSignal;
      return new Promise<never>((_resolve, reject) => {
        const abort = () => reject(Object.assign(new Error("native read aborted"), { name: "AbortError" }));
        signal.addEventListener("abort", abort, { once: true });
        entered();
        if (signal.aborted) abort();
        // Hold the actual owned descriptor until the signal supplied to its
        // real native read cancels this pending operation.
      });
    });
  });
  const running = setup(controller.signal).invoke(name, "source.ts", true);
  await Promise.race([ready, running.then(() => { throw new Error("tool settled before reaching the native read boundary"); })]);
  controller.abort(); expect((await running).status).toBe("cancelled"); expect(nativeSignal?.aborted).toBe(true);
  await vi.waitFor(() => { expect(fileLockEntryCount()).toBe(0); for (const handle of handles) expect(handle.fd).toBe(-1); }, { timeout: 2000, interval: 5 });
  expect(await fs.readFile(target, "utf8")).toBe("old");
});

it("reports a close failure before admitting a write and still releases the file lock", async () => {
  const target = join(root, "source.ts"); await fs.writeFile(target, "old");
  observe((handle, _index, close) => { vi.spyOn(handle, "close").mockImplementation(async () => { await close(); throw new Error("close-failed"); }); });
  const result = await setup().invoke(); expect(result.status).toBe("failed"); expect(result.error?.message).toContain("close-failed");
  expect(await fs.readFile(target, "utf8")).toBe("old"); expect(handles[0]!.fd).toBe(-1); expect(fileLockEntryCount()).toBe(0);
});

it.each(["denied", "pre-aborted", "escape"])("does zero opens when %s", async kind => {
  await fs.writeFile(join(root, "source.ts"), "old"); const controller = new AbortController(); if (kind === "pre-aborted") controller.abort();
  const opened = observe(); const result = await setup(controller.signal, 2000, kind !== "denied").invoke("edit_file", kind === "escape" ? "../outside" : "source.ts");
  expect(result.status).toBe(kind === "pre-aborted" ? "cancelled" : "denied"); expect(opened).not.toHaveBeenCalled(); expect(fileLockEntryCount()).toBe(0);
});

it.skipIf(process.platform === "win32").each(["fifo", "alias", "replacement", "versioned-write"])("rejects native %s without leaving a timed-out reader or lock", async kind => {
  const pipe = join(root, "pipe"); execFileSync("mkfifo", [pipe]); let target = pipe;
  if (kind === "alias") { target = join(root, "alias"); await fs.symlink(pipe, target); }
  if (kind === "replacement") {
    target = join(root, "source.ts"); await fs.writeFile(target, "old"); const open = fs.open.bind(fs);
    vi.spyOn(fs, "open").mockImplementation(async (path, flags, mode) => { await fs.unlink(target); await fs.rename(pipe, target); return open(path, flags, mode); });
  }
  let rescue: Promise<void> | undefined;
  const timeoutMs = 2000;
  const timer = setTimeout(() => { rescue = fs.writeFile(target, "old"); }, timeoutMs + 100);
  const result = await setup(undefined, timeoutMs).invoke(kind === "versioned-write" ? "write_file" : "edit_file", target, kind === "versioned-write");
  const live = fileLockEntryCount();
  if (live) { await new Promise(resolve => setTimeout(resolve, 180)); await rescue; } else clearTimeout(timer);
  expect(result.status).toBe("failed"); expect(result.error?.message).toMatch(/regular file/); expect(live).toBe(0); expect(fileLockEntryCount()).toBe(0);
});

it.skipIf(process.platform === "win32")("continues to edit an authorized in-workspace symbolic link", async () => {
  const target = join(root, "source.ts"), alias = join(root, "alias.ts"); await fs.writeFile(target, "old"); await fs.symlink(target, alias);
  const result = await setup().invoke("edit_file", alias, true); expect(result.status).toBe("success"); expect(await fs.readFile(target, "utf8")).toBe("new"); expect((await fs.lstat(alias)).isSymbolicLink()).toBe(true); expect(fileLockEntryCount()).toBe(0);
});
