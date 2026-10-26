import { promises as fs } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { newAgentId, newSessionId, newToolCallId, newTurnId, type ToolExecutionContext } from "@ar/contracts";
import { ToolRegistry } from "./registry.js";
import { ToolOrchestrator } from "./orchestrator.js";
import { repoTree } from "./navigate.js";
import { repoTreeTool } from "./tools/navigation-tools.js";
import { searchFilesTool } from "./tools/search-files.js";

let root: string;
beforeEach(async () => { root = await fs.mkdtemp(join(tmpdir(), "ar-search-completeness-")); });
afterEach(async () => { vi.restoreAllMocks(); syncBuiltinESMExports(); await fs.rm(root, { recursive: true, force: true }); });
function setup(signal = new AbortController().signal, allow = true) {
  const registry = new ToolRegistry(); registry.register(repoTreeTool); registry.register(searchFilesTool);
  const orch = new ToolOrchestrator({ registry, workspaceRoot: root });
  const context: ToolExecutionContext = {
    cwd: root, sessionId: newSessionId(), turnId: newTurnId(), agentId: newAgentId(), signal,
    permissions: { rules: [{ action: "read", resource: "file", effect: allow ? "allow" : "deny" }] },
    sandboxPolicy: { filesystem: { mode: "workspace-write" }, network: { mode: "deny" }, process: { timeoutMs: 2000, maxOutputBytes: 100000 } },
  };
  return async (name: string, args: Record<string, unknown>) => {
    syncBuiltinESMExports(); const id = newToolCallId();
    return orch.execute({ id, sessionId: context.sessionId, turnId: context.turnId, agentId: context.agentId, call: { id, name, args } }, context);
  };
}

describe("repo_tree reports unavailable and incomplete scopes", () => {
  it.each(["missing", "file.txt"])("does not call %s an empty directory", async path => {
    await fs.writeFile(join(root, "file.txt"), "actual file");
    const result = await setup()("repo_tree", { path });
    expect(result.status).toBe("failed"); expect(result.error?.message).toContain("SCAN_INCOMPLETE");
    expect(result.metadata).toMatchObject({ complete: false, unavailableScope: true });
    expect(result.evidence).toBeUndefined();
    // The standalone navigation utility retains its old array contract.
    expect(await repoTree({ root, relPath: path })).toEqual([]);
  });
  it.each([false, true])("reports an unreadable subtree, includeSummary=%s", async includeSummary => {
    await fs.mkdir(join(root, "blocked")); await fs.writeFile(join(root, "visible.txt"), "visible");
    const actual = fs.readdir.bind(fs);
    vi.spyOn(fs, "readdir").mockImplementation((async (...args: Parameters<typeof fs.readdir>) => {
      if (String(args[0]) === join(root, "blocked")) throw Object.assign(new Error("permission denied"), { code: "EACCES" });
      return actual(...args);
    }) as typeof fs.readdir);
    const result = await setup()("repo_tree", { includeSummary });
    if (includeSummary) {
      expect(result.status).toBe("success");
      expect(result.output).toMatchObject({ summary: { complete: false, unreadableDirectories: 1 }, entries: expect.arrayContaining([{ path: "visible.txt", type: "file", depth: 1 }]) });
    } else {
      expect(result.status).toBe("failed"); expect(result.error?.message).toContain("SCAN_INCOMPLETE");
      expect(result.output).toContainEqual({ path: "visible.txt", type: "file", depth: 1 });
    }
  });
  it("distinguishes a verified empty directory from a missing one", async () => {
    await fs.mkdir(join(root, "empty"));
    const result = await setup()("repo_tree", { path: "empty", includeSummary: true });
    expect(result.status).toBe("success");
    expect(result.output).toMatchObject({ summary: { complete: true, unavailableScope: false, unreadableDirectories: 0 }, entries: [] });
  });
  it("exposes bounded entry and depth traversal without changing legacy arrays", async () => {
    await fs.mkdir(join(root, "a")); await fs.writeFile(join(root, "a", "nested.txt"), "nested"); await fs.writeFile(join(root, "z.txt"), "tail");
    const invoke = setup();
    const capped = await invoke("repo_tree", { maxEntries: 1, includeSummary: true });
    expect(capped.status).toBe("success"); expect(capped.output).toMatchObject({ summary: { complete: false, limitReached: true }, entries: [{ path: "a", type: "dir", depth: 1 }] });
    const depth = await invoke("repo_tree", { depth: 1, includeSummary: true });
    expect(depth.output).toMatchObject({ summary: { complete: false, depthLimitReached: true } });
    const legacy = await invoke("repo_tree", { maxEntries: 1 });
    expect(legacy.status).toBe("success"); expect(legacy.output).toEqual([{ path: "a", type: "dir", depth: 1 }]);
  });
});

describe("search_files model-visible completeness", () => {
  it("exposes a capped scan and preserves its directly usable paths", async () => {
    await fs.mkdir(join(root, "src"));
    await fs.writeFile(join(root, "src", "a.ts"), "a"); await fs.writeFile(join(root, "src", "b.ts"), "b");
    const invoke = setup();
    const result = await invoke("search_files", { pattern: "*.ts", path: "src", maxResults: 1, includeSummary: true });
    expect(result.status).toBe("success");
    expect(result.output).toEqual({ summary: { complete: false, limitReached: true }, hits: ["src/a.ts"] });
    const legacy = await invoke("search_files", { pattern: "*.ts", path: "src", maxResults: 1 });
    expect(legacy.status).toBe("success"); expect(legacy.output).toEqual(["src/a.ts"]);
  });
  it("can prove a completed empty scan", async () => {
    await fs.writeFile(join(root, "a.ts"), "a");
    const result = await setup()("search_files", { pattern: "*.py", includeSummary: true });
    expect(result.output).toEqual({ summary: { complete: true, limitReached: false }, hits: [] });
  });
  it.each(["search_files", "repo_tree"])("retains denial and pre-abort before %s enumeration", async name => {
    const reads = vi.spyOn(fs, "readdir");
    const args = { pattern: "*", includeSummary: true };
    expect((await setup(undefined, false)(name, args)).status).toBe("denied");
    const ac = new AbortController(); ac.abort();
    expect((await setup(ac.signal)(name, args)).status).toBe("cancelled");
    expect(reads).not.toHaveBeenCalled();
  });
});
