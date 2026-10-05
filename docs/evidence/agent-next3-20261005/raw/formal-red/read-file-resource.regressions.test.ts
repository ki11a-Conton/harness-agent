import { promises as fs, constants } from "node:fs";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { newAgentId, newSessionId, newToolCallId, newTurnId, type ToolExecutionContext } from "@ar/contracts";
import { ToolRegistry } from "./registry.js";
import { ToolOrchestrator } from "./orchestrator.js";
import { readFileTool } from "./tools/read-file.js";
import { fileLockEntryCount, withFileLock } from "./file-coordination.js";

vi.mock("node:fs/promises", async (original) => ({
  ...await original<typeof import("node:fs/promises")>(),
  open: (...args: Parameters<typeof fs.open>) => fs.open(...args),
}));
let root: string;
let handles: Awaited<ReturnType<typeof fs.open>>[];
beforeEach(async () => { root = await fs.mkdtemp(join(tmpdir(), "ar-read-resource-")); handles = []; });
afterEach(async () => { vi.restoreAllMocks(); for (const h of handles) await h.close(); await fs.rm(root, { recursive: true, force: true }); });
function setup(signal = new AbortController().signal, timeoutMs?: number, allow = true) {
  const registry = new ToolRegistry(); registry.register(readFileTool);
  const orch = new ToolOrchestrator({ registry, workspaceRoot: root });
  const context: ToolExecutionContext = {
    cwd: root, sessionId: newSessionId(), turnId: newTurnId(), agentId: newAgentId(), signal,
    permissions: { rules: [{ action: "read", resource: "file", effect: allow ? "allow" : "deny" }] },
    sandboxPolicy: { filesystem: { mode: "workspace-write" }, network: { mode: "deny" }, process: { timeoutMs, maxOutputBytes: 100000 } },
  };
  return { context, invoke(path: string, versioned = false) {
    const id = newToolCallId();
    return orch.execute({ id, sessionId: context.sessionId, turnId: context.turnId, agentId: context.agentId, call: { id, name: "read_file", args: { path, versioned } } }, context);
  } };
}
function observe(transform?: (h: Awaited<ReturnType<typeof fs.open>>) => void) {
  const open = fs.open.bind(fs);
  const spy = vi.spyOn(fs, "open").mockImplementation(async (...args) => {
    const h = await open(...args); handles.push(h); vi.spyOn(h, "close"); transform?.(h); return h;
  });
  return spy;
}
const digest = (data: Buffer) => createHash("sha256").update(data).digest("hex");

describe("read_file owned descriptors and cancellation", () => {
  it.each([false, true])("closes a successful read, versioned=%s", async versioned => {
    await fs.writeFile(join(root, "ok"), "ok"); const opened = observe();
    const result = await setup().invoke("ok", versioned);
    expect(result.status).toBe("success"); expect(opened).toHaveBeenCalledTimes(1);
    expect(handles[0]!.close).toHaveBeenCalledTimes(1); expect(handles[0]!.fd).toBe(-1); expect(fileLockEntryCount()).toBe(0);
  });
  it.each(["open", "stat", "read"])("cancels at the %s boundary and closes the handle", async boundary => {
    await fs.writeFile(join(root, "ok"), "ok"); const ac = new AbortController();
    observe(h => {
      if (boundary === "open") ac.abort();
      if (boundary === "stat") { const stat = h.stat.bind(h); vi.spyOn(h, "stat").mockImplementation(async () => { const st = await stat(); ac.abort(); return st; }); }
      if (boundary === "read") { const read = h.readFile.bind(h); vi.spyOn(h, "readFile").mockImplementation(async options => { expect(options).toMatchObject({ signal: ac.signal }); ac.abort(); return read(options); }); }
    });
    const result = await setup(ac.signal).invoke("ok"); expect(result.status).toBe("cancelled"); expect(result.output).toBeUndefined(); expect(result.evidence).toBeUndefined();
    expect(handles).toHaveLength(1); expect(handles[0]!.close).toHaveBeenCalledTimes(1); expect(handles[0]!.fd).toBe(-1); expect(fileLockEntryCount()).toBe(0);
  });
  it.each(["stat", "read"])("closes on a native %s failure", async stage => {
    await fs.writeFile(join(root, "ok"), "ok");
    observe(h => { if (stage === "stat") vi.spyOn(h, "stat").mockRejectedValue(new Error("stat-failure")); else vi.spyOn(h, "readFile").mockRejectedValue(new Error("read-failure")); });
    const result = await setup().invoke("ok"); expect(result.status).toBe("failed"); expect(result.error?.message).toContain(`${stage}-failure`);
    expect(handles[0]!.close).toHaveBeenCalledTimes(1); expect(handles[0]!.fd).toBe(-1); expect(fileLockEntryCount()).toBe(0);
  });
  it("reports a close failure and still releases coordination", async () => {
    await fs.writeFile(join(root, "ok"), "ok"); observe(h => { const close = h.close.bind(h); vi.spyOn(h, "close").mockImplementation(async () => { await close(); throw new Error("close-failure"); }); });
    const result = await setup().invoke("ok"); expect(result.status).toBe("failed"); expect(result.error?.message).toContain("close-failure"); expect(handles[0]!.fd).toBe(-1); expect(fileLockEntryCount()).toBe(0);
  });
  it("passes an effective timeout signal and cleans up after the race settles", async () => {
    await fs.writeFile(join(root, "ok"), "ok"); let received: AbortSignal | undefined;
    observe(h => { vi.spyOn(h, "readFile").mockImplementation(options => new Promise((_resolve, reject) => {
      received = typeof options === "object" ? options?.signal : undefined;
      received?.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })), { once: true });
    })); });
    const result = await setup(undefined, 25).invoke("ok"); expect(result.status).toBe("timeout"); expect(received?.aborted).toBe(true);
    await vi.waitFor(() => { expect(handles[0]!.fd).toBe(-1); expect(fileLockEntryCount()).toBe(0); }, { timeout: 250, interval: 5 });
  });
  it("cancels a queued reader without opening it", async () => {
    await fs.writeFile(join(root, "ok"), "ok"); const ac = new AbortController(); const opened = observe();
    let entered!: () => void, release!: () => void;
    const ready = new Promise<void>(r => { entered = r; }); const gate = new Promise<void>(r => { release = r; });
    const held = withFileLock(join(root, "ok"), undefined, async () => { entered(); await gate; }); await ready;
    const read = setup(ac.signal).invoke("ok"); ac.abort(); const result = await read; release(); await held;
    expect(result.status).toBe("cancelled"); expect(opened).not.toHaveBeenCalled(); expect(fileLockEntryCount()).toBe(0);
  });
  it.each(["deny", "pre-abort", "escape"])("does zero opens on %s", async kind => {
    await fs.writeFile(join(root, "ok"), "ok"); const ac = new AbortController(); if (kind === "pre-abort") ac.abort(); const opened = observe();
    const result = await setup(ac.signal, undefined, kind !== "deny").invoke(kind === "escape" ? "../escape" : "ok");
    expect(result.status).toBe(kind === "pre-abort" ? "cancelled" : "denied"); expect(opened).not.toHaveBeenCalled(); expect(fileLockEntryCount()).toBe(0);
  });
  it("preserves the native missing-file error without a descriptor leak", async () => {
    observe(); const result = await setup().invoke("missing"); expect(result.status).toBe("failed"); expect(result.error?.message).toMatch(/ENOENT/); expect(handles).toHaveLength(0); expect(fileLockEntryCount()).toBe(0);
  });
  it("rejects a directory before reading it", async () => {
    const opened = observe(h => { vi.spyOn(h, "readFile"); }); const result = await setup().invoke(".");
    expect(result.status).toBe("failed"); expect(result.error?.message).toMatch(/regular file/); expect(opened).toHaveBeenCalled(); expect(handles[0]!.readFile).not.toHaveBeenCalled(); expect(handles[0]!.fd).toBe(-1); expect(fileLockEntryCount()).toBe(0);
  });
  it.skipIf(process.platform === "win32").each(["fifo", "alias", "replacement"])("rejects native %s without waiting for a writer", async kind => {
    const pipe = join(root, "pipe"); execFileSync("mkfifo", [pipe]); let target = pipe;
    if (kind === "alias") { target = join(root, "alias"); await fs.symlink(pipe, target); }
    if (kind === "replacement") {
      target = join(root, "replaced"); await fs.writeFile(target, "old"); const open = fs.open.bind(fs);
      vi.spyOn(fs, "open").mockImplementation(async (path, flags, mode) => { await fs.unlink(target); await fs.rename(pipe, target); return open(path, flags, mode); });
    }
    let rescue: Promise<void> | undefined;
    const timer = setTimeout(() => { rescue = fs.writeFile(target, "rescue"); }, 180);
    const start = performance.now(); const result = await setup(undefined, 60).invoke(target); const elapsed = performance.now() - start; const live = fileLockEntryCount();
    if (live) { await new Promise(r => setTimeout(r, 200)); await rescue; } else clearTimeout(timer);
    expect(result.status).toBe("failed"); expect(result.error?.message).toMatch(/regular file/); expect(elapsed).toBeLessThan(250); expect(live).toBe(0); expect(fileLockEntryCount()).toBe(0);
  });
  it.each([Buffer.alloc(0), Buffer.from("\ufeff中文\r\nbody\n"), Buffer.from([0xff, 10, 65])])("preserves exact content and raw-byte version for %j", async bytes => {
    await fs.writeFile(join(root, "raw"), bytes); const result = await setup().invoke("raw", true);
    expect(result.output).toEqual({ path: join(root, "raw"), content: bytes.toString("utf8"), bytes: bytes.length, sha256: digest(bytes) }); expect(fileLockEntryCount()).toBe(0);
  });
  it.each(["hard", "symlink"])("reads an authorized %s alias", async kind => {
    await fs.writeFile(join(root, "raw"), "alias-content"); if (kind === "hard") await fs.link(join(root, "raw"), join(root, "alias")); else await fs.symlink(join(root, "raw"), join(root, "alias"));
    expect((await setup().invoke("alias")).output).toBe("alias-content"); expect(fileLockEntryCount()).toBe(0);
  });
});
