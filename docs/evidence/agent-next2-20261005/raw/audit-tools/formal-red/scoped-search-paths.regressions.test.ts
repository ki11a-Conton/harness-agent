import fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { newAgentId, newSessionId, newToolCallId, newTurnId } from "@ar/contracts";
import type { PermissionPolicy, ToolExecutionContext } from "@ar/contracts";
import { ToolOrchestrator } from "./orchestrator.js";
import { createProductionTools } from "./production-tools.js";
import { ToolRegistry } from "./registry.js";

let root: string;
let outside: string;
let orchestrator: ToolOrchestrator;
const sessionId = newSessionId(), agentId = newAgentId(), turnId = newTurnId();

function context(cwd = root, permissions: PermissionPolicy = {
  rules: [{ action: "read", resource: "file", pattern: "**/*", effect: "allow" }], defaultEffect: "deny",
}): ToolExecutionContext {
  return { sessionId, agentId, turnId, cwd, signal: new AbortController().signal, permissions,
    sandboxPolicy: { filesystem: { mode: "workspace-write" }, network: { mode: "deny" },
      process: { timeoutMs: 2000, maxOutputBytes: 65536 } } };
}

async function invoke(name: string, args: Record<string, unknown>, ctx = context()) {
  return orchestrator.execute({ id: newToolCallId(), sessionId, agentId, turnId,
    call: { id: newToolCallId(), name, args } }, ctx);
}

async function write(path: string, body: string) {
  await fs.mkdir(dirname(join(root, path)), { recursive: true });
  await fs.writeFile(join(root, path), body);
}

beforeEach(async () => {
  root = await fs.mkdtemp(join(tmpdir(), "ar-scoped-search-regression-"));
  outside = await fs.mkdtemp(join(tmpdir(), "ar-scoped-search-outside-"));
  await write("src/deep/target.ts", "SCOPED_DEEP_SENTINEL");
  await write("src/root.ts", "SCOPED_TOPLEVEL_SENTINEL");
  await write("root.ts", "WRONG_ROOT_SENTINEL");
  await write("代码/深层/目标.ts", "UNICODE_SCOPED_SENTINEL");
  const registry = new ToolRegistry();
  for (const tool of createProductionTools({ networkMode: "deny", availableTools: () => registry.names() })) registry.register(tool);
  orchestrator = new ToolOrchestrator({ registry, workspaceRoot: root });
});

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all([fs.rm(root, { recursive: true, force: true }), fs.rm(outside, { recursive: true, force: true })]);
});

describe("search_files returned paths work in the session cwd", () => {
  it.each(["relative", "normalized", "absolute"])("reads the selected deep file from a %s scope result", async alias => {
    const path = alias === "absolute" ? join(root, "src") : alias === "normalized" ? "./src/deep/.." : "src";
    const found = await invoke("search_files", { pattern: "deep/*.ts", path });
    expect(found.status).toBe("success");
    expect(found.output).toEqual(["src/deep/target.ts"]);
    const read = await invoke("read_file", { path: (found.output as string[])[0] });
    expect(read.status).toBe("success");
    expect(read.output).toBe("SCOPED_DEEP_SENTINEL");
  });

  it("does not read a root distractor after a basename search in src", async () => {
    const found = await invoke("search_files", { pattern: "root.ts", path: "src" });
    expect(found.status).toBe("success");
    const read = await invoke("read_file", { path: (found.output as string[])[0] });
    expect(read.output).toBe("SCOPED_TOPLEVEL_SENTINEL");
    expect(found.output).toEqual(["src/root.ts"]);
  });

  it("returns a directly usable path when the session cwd is nested", async () => {
    const ctx = context(join(root, "src"));
    const found = await invoke("search_files", { pattern: "**/*.ts", path: "deep" }, ctx);
    expect(found.output).toEqual(["deep/target.ts"]);
    const read = await invoke("read_file", { path: (found.output as string[])[0] }, ctx);
    expect(read.output).toBe("SCOPED_DEEP_SENTINEL");
  });

  it("preserves Unicode scope and file names in the search -> read loop", async () => {
    const found = await invoke("search_files", { pattern: "**/*.ts", path: "代码" });
    expect(found.output).toEqual(["代码/深层/目标.ts"]);
    const read = await invoke("read_file", { path: (found.output as string[])[0] });
    expect(read.output).toBe("UNICODE_SCOPED_SENTINEL");
  });

  it("retains the default root's existing workspace-relative output", async () => {
    const found = await invoke("search_files", { pattern: "**/*.ts" });
    expect(found.status).toBe("success");
    expect((found.output as string[]).sort()).toEqual(["root.ts", "src/deep/target.ts", "src/root.ts", "代码/深层/目标.ts"].sort());
  });

  it("retains matching relative to the selected scope rather than output prefix", async () => {
    const found = await invoke("search_files", { pattern: "src/deep/*.ts", path: "src" });
    expect(found.status).toBe("success");
    expect(found.output).toEqual([]);
  });

  it("retains basename matching below the selected directory", async () => {
    const found = await invoke("search_files", { pattern: "target.ts", path: "src" });
    expect(found.output).toEqual(["src/deep/target.ts"]);
  });

  it("preserves POSIX separators for nested returned paths", async () => {
    const found = await invoke("search_files", { pattern: "**/*.ts", path: join(root, "src") });
    expect((found.output as string[]).every(path => !path.includes("\\"))).toBe(true);
    expect(found.output).toContain("src/deep/target.ts");
  });
});

describe("scoped output correction preserves traversal and fail-closed gates", () => {
  it.each([1, 2])("retains maxResults=%s", async maxResults => {
    const found = await invoke("search_files", { pattern: "**/*.ts", path: "src", maxResults });
    expect(found.status).toBe("success");
    expect(found.output).toHaveLength(maxResults);
  });

  it("skips existing VCS, dependency and DS_Store entries", async () => {
    await write("src/.git/hidden.ts", "GIT");
    await write("src/node_modules/hidden.ts", "DEPENDENCY");
    await write("src/.DS_Store", "MAC");
    const found = await invoke("search_files", { pattern: "**/*", path: "src" });
    expect(found.status).toBe("success");
    expect((found.output as string[]).sort()).toEqual(["src/deep/target.ts", "src/root.ts"]);
  });

  it("does not traverse existing descendant directory symlinks", async () => {
    await fs.writeFile(join(outside, "outside.ts"), "OUTSIDE");
    await fs.symlink(outside, join(root, "src", "linked-directory"), process.platform === "win32" ? "junction" : "dir");
    const list = vi.spyOn(fs, "readdir");
    const found = await invoke("search_files", { pattern: "**/*", path: "src" });
    expect(found.status).toBe("success");
    expect(found.output).toContain("src/linked-directory");
    expect((found.output as string[]).some(path => path.endsWith("outside.ts"))).toBe(false);
    expect(list.mock.calls.some(([path]) => String(path).includes("linked-directory"))).toBe(false);
  });

  it("enumerates only the explicitly allowed selected scope", async () => {
    const list = vi.spyOn(fs, "readdir");
    const ctx = context(root, { rules: [{ action: "read", resource: "file", pattern: "src", effect: "allow" }], defaultEffect: "deny" });
    const found = await invoke("search_files", { pattern: "**/*.ts", path: "src" }, ctx);
    expect(found.status).toBe("success");
    expect(list.mock.calls.map(([path]) => String(path)).sort()).toEqual([join(root, "src"), join(root, "src", "deep")].sort());
  });

  it("rejects permission denial before any directory enumeration", async () => {
    const list = vi.spyOn(fs, "readdir");
    const found = await invoke("search_files", { pattern: "**/*", path: "src" }, context(root, { rules: [], defaultEffect: "deny" }));
    expect(found.status).toBe("denied");
    expect(found.error?.code).toBe("PERMISSION_DENIED");
    expect(list).not.toHaveBeenCalled();
  });

  it("rejects an outside scope before any directory enumeration", async () => {
    const list = vi.spyOn(fs, "readdir");
    const found = await invoke("search_files", { pattern: "**/*", path: outside });
    expect(found.status).toBe("denied");
    expect(found.error?.code).toBe("SANDBOX_FILESYSTEM_DENIED");
    expect(list).not.toHaveBeenCalled();
  });

  it.each(["missing", "root.ts"])("preserves failure for an unavailable directory: %s", async path => {
    const found = await invoke("search_files", { pattern: "**/*", path });
    expect(found.status).toBe("failed");
    expect(found.error?.code).toBe("PROCESS_ERROR");
    expect(found.evidence).toBeUndefined();
  });

  it("does not turn an unreadable descendant into partial success", async () => {
    const actual = fs.readdir.bind(fs);
    vi.spyOn(fs, "readdir").mockImplementation((async (...args: Parameters<typeof fs.readdir>) => {
      if (String(args[0]) === join(root, "src", "deep")) throw Object.assign(new Error("selected descendant unreadable"), { code: "EACCES" });
      return actual(...args);
    }) as typeof fs.readdir);
    const found = await invoke("search_files", { pattern: "**/*", path: "src" });
    expect(found.status).toBe("failed");
    expect(found.error?.message).toContain("selected descendant unreadable");
    expect(found.evidence).toBeUndefined();
  });

  it.each([0, 10_001])("rejects invalid maxResults=%s before enumeration", async maxResults => {
    const list = vi.spyOn(fs, "readdir");
    const found = await invoke("search_files", { pattern: "**/*", path: "src", maxResults });
    expect(found.status).toBe("failed");
    expect(found.error?.code).toBe("TOOL_SCHEMA_ERROR");
    expect(list).not.toHaveBeenCalled();
  });

  it("retains cancellation before dispatch with no enumeration", async () => {
    const list = vi.spyOn(fs, "readdir");
    const controller = new AbortController(); controller.abort();
    const found = await invoke("search_files", { pattern: "**/*", path: "src" }, { ...context(), signal: controller.signal });
    expect(found.status).toBe("cancelled");
    expect(list).not.toHaveBeenCalled();
  });

  it("retains cancellation during actual selected directory enumeration", async () => {
    const controller = new AbortController();
    const actual = fs.readdir.bind(fs);
    vi.spyOn(fs, "readdir").mockImplementation((async (...args: Parameters<typeof fs.readdir>) => {
      const entries = await actual(...args); controller.abort(); return entries;
    }) as typeof fs.readdir);
    const found = await invoke("search_files", { pattern: "**/*", path: "src" }, { ...context(), signal: controller.signal });
    expect(found.status).toBe("cancelled");
    expect(found.evidence).toBeUndefined();
  });
});
