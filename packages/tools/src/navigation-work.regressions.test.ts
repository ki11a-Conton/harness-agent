import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ToolExecutionContext } from "@ar/contracts";
import { newAgentId, newSessionId, newToolCallId, newTurnId } from "@ar/contracts";
import { grepFiles, repoTree, symbolSearch, walkFiles } from "./navigate.js";
import { grepSearchTool, repoTreeTool } from "./tools/navigation-tools.js";
import { ToolRegistry } from "./registry.js";
import { ToolOrchestrator } from "./orchestrator.js";

// R3: verify actual traversal work and output through the unchanged production
// permission/sandbox pipeline. These are permanent RED/GREEN regressions.
let root: string;
let outside: string;
beforeEach(async () => {
  root = await fs.mkdtemp(join(tmpdir(), "ar-navigation-work-"));
  outside = await fs.mkdtemp(join(tmpdir(), "ar-navigation-outside-"));
});
afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(root, { recursive: true, force: true });
  await fs.rm(outside, { recursive: true, force: true });
});
async function write(path: string, contents = "needle\n"): Promise<void> {
  const target = join(root, path);
  await fs.mkdir(dirname(target), { recursive: true });
  await fs.writeFile(target, contents);
}
async function siblings(count = 12, deep = false): Promise<void> {
  for (let i = 0; i < count; i += 1) {
    await write(`group-${String(i).padStart(2, "0")}/${deep ? "nested/" : ""}one.txt`);
  }
}
function context(): ToolExecutionContext {
  return {
    cwd: root, sessionId: newSessionId(), turnId: newTurnId(), agentId: newAgentId(),
    signal: new AbortController().signal,
    permissions: { rules: [{ action: "read", resource: "file", pattern: "**/*", effect: "allow" }] },
    sandboxPolicy: {
      filesystem: { mode: "workspace-write", allowedPaths: [root] },
      network: { mode: "deny" }, process: { timeoutMs: 10_000, maxOutputBytes: 4096 },
    },
  };
}
async function run(name: "grep_search" | "repo_tree", args: Record<string, unknown>, ctx = context()) {
  const registry = new ToolRegistry(); registry.register(grepSearchTool); registry.register(repoTreeTool);
  const orch = new ToolOrchestrator({ registry, workspaceRoot: root });
  return orch.execute({
    id: newToolCallId(), sessionId: ctx.sessionId, turnId: ctx.turnId, agentId: ctx.agentId,
    call: { id: newToolCallId(), name, args },
  }, ctx);
}

describe("R3 navigation: global traversal stop", () => {
  it("propagates a nested callback stop across all ancestor/sibling directories", async () => {
    await siblings(12, true);
    const reads = vi.spyOn(fs, "readdir");
    const visited: string[] = [];
    const result: void = await walkFiles(root, ".", async (_abs, rel) => { visited.push(rel); return false; });
    expect(result).toBeUndefined(); // public Promise<void> remains unchanged
    expect(visited).toHaveLength(1);
    expect(reads).toHaveBeenCalledTimes(3); // root, first group, first nested
  });

  it("keeps directory callbacks and their entry-name contract while stopping", async () => {
    await siblings(3);
    const seen: Array<{ rel: string; names: string[] }> = [];
    await walkFiles(root, ".", async () => false, (names, _abs, rel) => { seen.push({ rel, names }); });
    expect(seen).toHaveLength(2);
    expect(seen[0]?.rel).toBe(".");
    expect(seen[0]?.names.sort()).toEqual(["group-00", "group-01", "group-02"]);
    expect(seen[1]?.names).toEqual(["one.txt"]);
  });

  it("stops grep immediately when the first file fills the hit cap", async () => {
    await siblings();
    const reads = vi.spyOn(fs, "readdir");
    const files = vi.spyOn(fs, "readFile");
    const hits = await grepFiles({ root, pattern: "needle", maxHits: 1 });
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ line: 1, column: 1, text: "needle" });
    expect(reads).toHaveBeenCalledTimes(2);
    expect(files).toHaveBeenCalledTimes(1);
  });

  it("stops at a cap inside a multi-line file without entering later siblings", async () => {
    for (let i = 0; i < 8; i += 1) await write(`group-${i}/one.txt`, "needle\nneedle\nneedle\n");
    const reads = vi.spyOn(fs, "readdir");
    const files = vi.spyOn(fs, "readFile");
    const result = await run("grep_search", { pattern: "needle", maxResults: 2 });
    expect(result.status).toBe("success");
    expect(result.output).toMatchObject([{ line: 1 }, { line: 2 }]);
    expect(reads).toHaveBeenCalledTimes(2);
    expect(files).toHaveBeenCalledTimes(1);
  });

  it("also stops the unchanged regex symbol fallback globally", async () => {
    for (let i = 0; i < 10; i += 1) await write(`group-${i}/source.txt`, "export function KnownSymbol() {}\n");
    const reads = vi.spyOn(fs, "readdir");
    const files = vi.spyOn(fs, "readFile");
    const result = await symbolSearch({ root, symbol: "KnownSymbol", maxHits: 1 });
    expect(result).toMatchObject({ fallback: true, hits: [{ name: "KnownSymbol", kind: "function" }] });
    expect(reads).toHaveBeenCalledTimes(2);
    expect(files).toHaveBeenCalledTimes(1);
  });
});

describe("R3 navigation: real directory entries and work bounds", () => {
  it("returns all 66 immediate directories including empty ones with one read", async () => {
    await fs.mkdir(join(root, "a-hit"));
    await fs.mkdir(join(root, "empty"));
    for (let i = 0; i < 64; i += 1) await write(`z${String(i).padStart(2, "0")}/sub/tail.txt`);
    const reads = vi.spyOn(fs, "readdir");
    const result = await run("repo_tree", { depth: 1, maxEntries: 1000 });
    expect(result.status).toBe("success");
    expect(result.output).toHaveLength(66);
    expect(result.output).toContainEqual({ path: "empty", type: "dir", depth: 1 });
    expect(reads).toHaveBeenCalledTimes(1);
  });

  it("performs no listing at absolute depth zero", async () => {
    await siblings(12, true);
    const reads = vi.spyOn(fs, "readdir");
    expect(await repoTree({ root, depth: 0 })).toEqual([]);
    expect(reads).not.toHaveBeenCalled();
  });

  it("counts real directories toward the entry cap and stops before descent", async () => {
    await siblings(12, true);
    const reads = vi.spyOn(fs, "readdir");
    const result = await run("repo_tree", { depth: 6, maxEntries: 1 });
    expect(result.status).toBe("success");
    expect(result.output).toHaveLength(1);
    expect(result.output).toMatchObject([{ type: "dir", depth: 1 }]);
    expect(reads).toHaveBeenCalledTimes(1);
  });

  it("shares one cap for mixed files and directories and preserves path sort", async () => {
    await write("top.txt"); await write("full/child.txt"); await fs.mkdir(join(root, "empty"));
    const result = await repoTree({ root, maxEntries: 10 });
    expect(result).toEqual([
      { path: "empty", type: "dir", depth: 1 },
      { path: "full", type: "dir", depth: 1 },
      { path: "full/child.txt", type: "file", depth: 2 },
      { path: "top.txt", type: "file", depth: 1 },
    ]);
    const capped = await repoTree({ root, maxEntries: 2 });
    expect(capped).toHaveLength(2);
    expect(capped.every((entry) => entry.depth <= 2)).toBe(true);
  });

  it("prunes recursion exactly at the root-relative depth boundary", async () => {
    await write("a/b/c/leaf.txt");
    const reads = vi.spyOn(fs, "readdir");
    expect(await repoTree({ root, depth: 2 })).toEqual([
      { path: "a", type: "dir", depth: 1 }, { path: "a/b", type: "dir", depth: 2 },
    ]);
    expect(reads).toHaveBeenCalledTimes(2); // root and a; never a/b
  });

  it("keeps verified ancestors for a nonempty subpath and root-relative depth", async () => {
    await write("a/b/leaf.txt");
    expect(await repoTree({ root, relPath: "a/b" })).toEqual([
      { path: "a", type: "dir", depth: 1 },
      { path: "a/b", type: "dir", depth: 2 },
      { path: "a/b/leaf.txt", type: "file", depth: 3 },
    ]);
    const reads = vi.spyOn(fs, "readdir");
    expect(await repoTree({ root, relPath: "a/b", depth: 2 })).toEqual([]);
    expect(reads).not.toHaveBeenCalled();
  });

  it("counts subpath ancestors toward the same cap", async () => {
    await write("a/b/leaf.txt");
    expect(await repoTree({ root, relPath: "a/b", maxEntries: 1 })).toEqual([
      { path: "a", type: "dir", depth: 1 },
    ]);
    expect(await repoTree({ root, relPath: "a/b", maxEntries: 2 })).toEqual([
      { path: "a", type: "dir", depth: 1 }, { path: "a/b", type: "dir", depth: 2 },
    ]);
  });

  it("keeps missing and empty directories as empty output", async () => {
    expect(await repoTree({ root })).toEqual([]);
    expect(await repoTree({ root, relPath: "missing" })).toEqual([]);
    await fs.mkdir(join(root, "empty"));
    expect(await repoTree({ root, relPath: "empty" })).toEqual([]);
  });

  it("does not invent ancestor directories for a file path", async () => {
    await write("a/leaf.txt");
    expect(await repoTree({ root, relPath: "a/leaf.txt" })).toEqual([]);
  });

  it("treats an unreadable directory as empty rather than fabricating entries", async () => {
    const reads = vi.spyOn(fs, "readdir").mockRejectedValueOnce(Object.assign(new Error("permission denied"), { code: "EACCES" }));
    expect(await repoTree({ root })).toEqual([]);
    expect(reads).toHaveBeenCalledTimes(1);
  });
});

describe("R3 navigation: production security controls", () => {
  it("accepts a trusted root directory alias while keeping repository-relative output", async () => {
    await write("visible/leaf.txt");
    const alias = join(outside, "root-alias");
    await fs.symlink(root, alias, process.platform === "win32" ? "junction" : "dir");
    expect(await repoTree({ root: alias })).toEqual([
      { path: "visible", type: "dir", depth: 1 }, { path: "visible/leaf.txt", type: "file", depth: 2 },
    ]);
  });

  it("skips generated, VCS, dependency and directory symlink entries before descent", async () => {
    for (const path of [".git", "node_modules", "dist", "build", "coverage"]) await write(`${path}/secret.txt`);
    await fs.writeFile(join(outside, "secret.txt"), "needle outside\n");
    await fs.symlink(outside, join(root, "external-link"), process.platform === "win32" ? "junction" : "dir");
    await write("visible/leaf.txt");
    const reads = vi.spyOn(fs, "readdir");
    expect(await repoTree({ root })).toEqual([
      { path: "visible", type: "dir", depth: 1 }, { path: "visible/leaf.txt", type: "file", depth: 2 },
    ]);
    expect(reads.mock.calls.map(([path]) => relative(root, String(path)) || ".")).toEqual([".", "visible"]);
  });

  it("does not follow a directory symlink supplied as the subtree", async () => {
    await fs.writeFile(join(outside, "secret.txt"), "needle outside\n");
    await fs.symlink(outside, join(root, "external-link"), process.platform === "win32" ? "junction" : "dir");
    const reads = vi.spyOn(fs, "readdir");
    expect(await repoTree({ root, relPath: "external-link" })).toEqual([]);
    expect(reads).not.toHaveBeenCalled();
  });

  it("does not follow a symlink ancestor of the selected subtree", async () => {
    await fs.mkdir(join(outside, "nested"));
    await fs.writeFile(join(outside, "nested", "secret.txt"), "needle outside\n");
    await fs.symlink(outside, join(root, "external-link"), process.platform === "win32" ? "junction" : "dir");
    const reads = vi.spyOn(fs, "readdir");
    expect(await repoTree({ root, relPath: "external-link/nested" })).toEqual([]);
    expect(reads).not.toHaveBeenCalled();
  });

  it("rejects a denied permission before any directory read", async () => {
    await siblings();
    const reads = vi.spyOn(fs, "readdir");
    const ctx = context(); ctx.permissions = { rules: [], defaultEffect: "deny" };
    const result = await run("repo_tree", {}, ctx);
    expect(result.status).toBe("denied");
    expect(reads).not.toHaveBeenCalled();
  });

  it("rejects an outside path through the real sandbox before any directory read", async () => {
    await fs.writeFile(join(outside, "outside.txt"), "secret\n");
    const reads = vi.spyOn(fs, "readdir");
    const result = await run("repo_tree", { path: outside });
    expect(result.status).toBe("denied");
    expect(reads).not.toHaveBeenCalled();
  });
});
