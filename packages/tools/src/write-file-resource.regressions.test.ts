import { constants, promises as fs, openSync, readSync, closeSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { newAgentId, newSessionId, newToolCallId, newTurnId, type ToolExecutionContext } from "@ar/contracts";
import { writeFileTool } from "./tools/write-file.js";
import { editFileTool } from "./tools/edit-file.js";
import { ToolRegistry } from "./registry.js";
import { ToolOrchestrator } from "./orchestrator.js";
import { fileLockEntryCount } from "./file-coordination.js";

vi.mock("node:fs/promises", async original => ({
  ...await original<typeof import("node:fs/promises")>(),
  open: (...args: Parameters<typeof fs.open>) => fs.open(...args),
}));
let root: string;
const timeoutMs = 2000;
beforeEach(async () => { root = await fs.mkdtemp(join(tmpdir(), "ar-write-resource-")); });
afterEach(async () => { vi.restoreAllMocks(); await fs.rm(root, { recursive: true, force: true }); });
function invoke(name: "write_file" | "edit_file", path: string, append = false, signal = new AbortController().signal) {
  const registry = new ToolRegistry(); registry.register(writeFileTool); registry.register(editFileTool);
  const orchestrator = new ToolOrchestrator({ registry, workspaceRoot: root });
  const context: ToolExecutionContext = {
    cwd: root, sessionId: newSessionId(), turnId: newTurnId(), agentId: newAgentId(), signal,
    permissions: { rules: [{ action: "*", resource: "*", effect: "allow" }] },
    sandboxPolicy: { filesystem: { mode: "workspace-write", allowedPaths: [root] }, network: { mode: "deny" }, process: { timeoutMs } },
  };
  const id = newToolCallId();
  return orchestrator.execute({ id, sessionId: context.sessionId, turnId: context.turnId, agentId: context.agentId,
    call: { id, name, args: { path, content: "unexpected late bytes", append, oldText: "old", newText: "new" } } }, context);
}
async function withFifoRescue(path: string, operation: () => ReturnType<typeof invoke>) {
  let rescueDone!: () => void;
  const rescued = new Promise<void>(resolve => { rescueDone = resolve; });
  let bytesWrittenAfterTimeout = 0;
  const timer = setTimeout(() => {
    const fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK);
    setTimeout(() => {
      try { bytesWrittenAfterTimeout = readSync(fd, Buffer.alloc(128), 0, 128, null); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "EAGAIN") throw error; }
      finally { closeSync(fd); rescueDone(); }
    }, 50);
  }, timeoutMs + 100);
  const result = await operation(), live = fileLockEntryCount();
  if (live) { await rescued; await vi.waitFor(() => expect(fileLockEntryCount()).toBe(0), { timeout: 2000, interval: 5 }); }
  else clearTimeout(timer);
  return { result, live, bytesWrittenAfterTimeout };
}
it.skipIf(process.platform === "win32").each([false, true])("rejects an unversioned FIFO write, append=%s, before side effects or timeout", async append => {
  const path = join(root, "pipe"); execFileSync("mkfifo", [path]);
  const { result, live, bytesWrittenAfterTimeout } = await withFifoRescue(path, () => invoke("write_file", path, append));
  expect(result.status).toBe("failed"); expect(result.error?.message).toMatch(/regular file|ENXIO/);
  expect(live).toBe(0); expect(bytesWrittenAfterTimeout).toBe(0); expect(fileLockEntryCount()).toBe(0);
});
it.skipIf(process.platform === "win32")("rejects an edit target replaced by a FIFO after its version read closes", async () => {
  const target = join(root, "source.ts"), pipe = join(root, "pipe"); await fs.writeFile(target, "old"); execFileSync("mkfifo", [pipe]);
  const open = fs.open.bind(fs); let reads = 0;
  vi.spyOn(fs, "open").mockImplementation(async (...args) => {
    const file = await open(...args);
    if (String(args[0]) === target && args[1] === (constants.O_RDONLY | constants.O_NONBLOCK) && ++reads === 2) {
      const close = file.close.bind(file);
      vi.spyOn(file, "close").mockImplementation(async () => { await close(); await fs.unlink(target); await fs.rename(pipe, target); });
    }
    return file;
  });
  const { result, live, bytesWrittenAfterTimeout } = await withFifoRescue(target, () => invoke("edit_file", target));
  expect(reads).toBe(2); expect(result.status).toBe("failed"); expect(result.error?.message).toMatch(/regular file|ENXIO/);
  expect(live).toBe(0); expect(bytesWrittenAfterTimeout).toBe(0); expect(fileLockEntryCount()).toBe(0);
});

it.skipIf(process.platform === "win32").each([false, true])("inspects an opened FIFO with a reader before writing, append=%s", async append => {
  const path = join(root, "pipe"); execFileSync("mkfifo", [path]); const reader = openSync(path, constants.O_RDWR | constants.O_NONBLOCK);
  try {
    const result = await invoke("write_file", path, append); expect(result.status).toBe("failed"); expect(result.error?.message).toMatch(/regular file/);
    expect(() => readSync(reader, Buffer.alloc(128), 0, 128, null)).toThrowError(expect.objectContaining({ code: "EAGAIN" })); expect(fileLockEntryCount()).toBe(0);
  } finally { closeSync(reader); }
});

it.each(["open", "stat"])("does not truncate existing bytes when cancellation occurs at writer %s", async boundary => {
  const path = join(root, "source.ts"); await fs.writeFile(path, "old"); const controller = new AbortController();
  const open = fs.open.bind(fs); const handles: Awaited<ReturnType<typeof fs.open>>[] = [];
  vi.spyOn(fs, "open").mockImplementation(async (...args) => {
    const handle = await open(...args); handles.push(handle);
    if (boundary === "open") controller.abort();
    else { const stat = handle.stat.bind(handle); vi.spyOn(handle, "stat").mockImplementation(async () => { const value = await stat(); controller.abort(); return value; }); }
    return handle;
  });
  const result = await invoke("write_file", path, false, controller.signal); expect(result.status).toBe("cancelled");
  await vi.waitFor(() => { expect(handles).toHaveLength(1); expect(handles[0]!.fd).toBe(-1); expect(fileLockEntryCount()).toBe(0); }, { timeout: 2000, interval: 5 });
  expect(await fs.readFile(path, "utf8")).toBe("old");
});

it("never truncates before the owned writer's stat succeeds", async () => {
  const path = join(root, "source.ts"); await fs.writeFile(path, "old"); const open = fs.open.bind(fs); let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
  vi.spyOn(fs, "open").mockImplementation(async (...args) => {
    handle = await open(...args); vi.spyOn(handle, "stat").mockRejectedValue(new Error("writer-stat-failed")); return handle;
  });
  const result = await invoke("write_file", path); expect(result.status).toBe("failed"); expect(result.error?.message).toContain("writer-stat-failed");
  expect(await fs.readFile(path, "utf8")).toBe("old"); expect(handle?.fd).toBe(-1); expect(fileLockEntryCount()).toBe(0);
});

it.each([false, true])("retains existing hard-link identity and complete overwrite/append behavior, append=%s", async append => {
  const target = join(root, "source.ts"), alias = join(root, "alias.ts"); await fs.writeFile(target, "old"); await fs.link(target, alias);
  const before = await fs.stat(target); const result = await invoke("write_file", alias, append); expect(result.status).toBe("success");
  const after = await fs.stat(target); expect(after.ino).toBe(before.ino); expect(after.mode).toBe(before.mode);
  expect(await fs.readFile(target, "utf8")).toBe((append ? "old" : "") + "unexpected late bytes"); expect(fileLockEntryCount()).toBe(0);
});

it("completes an admitted overwrite when cancellation arrives after irreversible truncation", async () => {
  const path = join(root, "source.ts"); await fs.writeFile(path, "old"); const controller = new AbortController(); const open = fs.open.bind(fs);
  vi.spyOn(fs, "open").mockImplementation(async (...args) => {
    const handle = await open(...args), truncate = handle.truncate.bind(handle);
    vi.spyOn(handle, "truncate").mockImplementation(async length => { await truncate(length); controller.abort(); });
    return handle;
  });
  expect((await invoke("write_file", path, false, controller.signal)).status).toBe("success"); expect(controller.signal.aborted).toBe(true);
  await vi.waitFor(() => expect(fileLockEntryCount()).toBe(0), { timeout: 2000, interval: 5 });
  expect(await fs.readFile(path, "utf8")).toBe("unexpected late bytes");
});

it("completes an admitted append even when cancellation arrives as its write starts", async () => {
  const path = join(root, "source.ts"); await fs.writeFile(path, "old"); const controller = new AbortController(); const open = fs.open.bind(fs);
  vi.spyOn(fs, "open").mockImplementation(async (...args) => {
    const handle = await open(...args), write = handle.writeFile.bind(handle);
    vi.spyOn(handle, "writeFile").mockImplementation(async (...options: Parameters<typeof handle.writeFile>) => {
      controller.abort(); return write(...options);
    });
    return handle;
  });
  expect((await invoke("write_file", path, true, controller.signal)).status).toBe("success"); expect(controller.signal.aborted).toBe(true);
  await vi.waitFor(() => expect(fileLockEntryCount()).toBe(0), { timeout: 2000, interval: 5 });
  expect(await fs.readFile(path, "utf8")).toBe("oldunexpected late bytes");
});
