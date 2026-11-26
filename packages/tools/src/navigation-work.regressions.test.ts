import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ToolExecutionContext } from "@ar/contracts";
import { newAgentId, newSessionId, newToolCallId, newTurnId } from "@ar/contracts";
import { grepFiles, repoTree, symbolSearch, walkFiles } from "./navigate.js";
import { readFileTool } from "./tools/read-file.js";
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
async function run(name: "grep_search" | "repo_tree" | "read_file", args: Record<string, unknown>, ctx = context()) {
  const registry = new ToolRegistry(); registry.register(grepSearchTool); registry.register(repoTreeTool); registry.register(readFileTool);
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

describe("grep_search with neighboring source lines", () => {
  it.each([true, false])("merges overlapping windows from one file read, literal=%s", async literal => {
    await write("src/settings.txt", "first\nneedle one\nshared\nneedle two\nlast\n");
    await write("elsewhere.txt", "needle outside the scope\n");
    const files = vi.spyOn(fs, "readFile");
    const result = await run("grep_search", { pattern: "needle", path: "src/settings.txt", contextLines: 1, literal });
    expect(result.status).toBe("success");
    expect(result.output).toMatchObject({
      summary: { complete: true },
      hits: [{ file: "src/settings.txt", line: 2, column: 1 }, { file: "src/settings.txt", line: 4, column: 1 }],
      context: [
        { file: "src/settings.txt", line: 1, text: "first" },
        { file: "src/settings.txt", line: 3, text: "shared" },
        { file: "src/settings.txt", line: 5, text: "last" },
      ],
    });
    expect(files).toHaveBeenCalledTimes(1);
  });

  it("retains the legacy array and summary shapes when the option is absent", async () => {
    await write("settings.txt", "start\nneedle\nend\n");
    const args = { pattern: "needle", literal: true, path: "settings.txt" };
    const hit = { file: "settings.txt", line: 2, column: 1, text: "needle" };
    expect((await run("grep_search", args)).output).toEqual([hit]);
    const detailed = await run("grep_search", { ...args, includeSummary: true });
    expect(detailed.output).toMatchObject({ summary: { complete: true }, hits: [hit] });
    expect(detailed.output).not.toHaveProperty("context");
  });

  it("reports output limits and keeps complete JSON rows for large windows", async () => {
    await write("many.txt", `needle ${"\t".repeat(1700)}\n${"\t".repeat(900)}\n`.repeat(100));
    const result = await run("grep_search", { pattern: "needle", literal: true, path: "many.txt", maxResults: 1000, contextLines: 2 });
    expect(result.status).toBe("success");
    expect(result.metadata).toMatchObject({ complete: false, limitReached: true, outputLimitReached: true, contextTruncated: true });
    const output = result.output as { context: { truncated?: true }[] };
    expect(output.context.some(row => row.truncated)).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(result.output), "utf8")).toBeLessThanOrEqual(32 * 1024);
  });

  it("marks a clipped UTF-8 context line without turning it into a missing search result", async () => {
    await write("settings.txt", `needle\n${"😃".repeat(500)}\n`);
    const result = await run("grep_search", { pattern: "needle", literal: true, path: "settings.txt", contextLines: 2 });
    const output = result.output as { summary: Record<string, unknown>; context: { line: number; text: string; truncated?: true }[] };
    expect(output.summary).toMatchObject({ complete: true, contextTruncated: true });
    expect(output.context).toHaveLength(1);
    expect(output.context[0]).toMatchObject({ line: 2, truncated: true });
    expect(output.context[0]!.text).toMatch(/^😃+$/u);
    expect(output.context[0]!.text.length).toBeLessThan(1000);
  });

  it("does not open a file when permission, sandbox, or cancellation prevents context search", async () => {
    await write("settings.txt");
    await fs.writeFile(join(outside, "settings.txt"), "needle outside workspace");
    const args = { pattern: "needle", contextLines: 2, path: "settings.txt" };
    const files = vi.spyOn(fs, "readFile");
    const denied = await run("grep_search", args, { ...context(), permissions: { rules: [], defaultEffect: "deny" } });
    const blocked = await run("grep_search", { ...args, path: join(outside, "settings.txt") });
    const control = new AbortController(); control.abort();
    const cancelled = await run("grep_search", args, { ...context(), signal: control.signal });
    expect([denied.status, blocked.status, cancelled.status]).toEqual(["denied", "denied", "cancelled"]);
    expect(files).not.toHaveBeenCalled();
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

describe("grep source line boundaries", () => {
  it.each([
    { text: "", blankLines: [] },
    { text: "value\n", blankLines: [] },
    { text: "value", blankLines: [] },
    { text: "\n", blankLines: [1] },
    { text: "value\n\n", blankLines: [2] },
    { text: "\r\n\r\nend", blankLines: [1, 2] },
    { text: "value\r\n\r\n", blankLines: [2] },
  ])("returns only blank lines that read_file can address in $text", async ({ text, blankLines }) => {
    const path = "sample.txt";
    await write(path, text);
    const result = await run("grep_search", { path, pattern: "^$", maxResults: blankLines.length + 1, includeSummary: true });
    expect(result.status).toBe("success");
    const output = result.output as { hits: { line: number; text: string }[]; summary: { complete: boolean; limitReached: boolean } };
    expect(output.hits.map(hit => hit.line)).toEqual(blankLines);
    expect(output.summary).toMatchObject({ complete: true, limitReached: false });
    for (const hit of output.hits) {
      const page = await run("read_file", { path, offset: hit.line, limit: 1 });
      expect(page.output).toMatchObject({ startLine: hit.line, endLine: hit.line, content: hit.text });
    }
  });

  it.each([false, true])("matches literal CR inside lines and returns readable context, literal=%s", async literal => {
    const path = "mixed.txt";
    await write(path, "first\r\nkeep\r\r\nlast\nend\r");
    const result = await run("grep_search", { path, pattern: "\r", literal, contextLines: 1 });
    expect(result.status).toBe("success");
    expect(result.output).toMatchObject({
      hits: [{ line: 2, column: 5, text: "keep\r" }, { line: 4, column: 4, text: "end\r" }],
      context: [{ line: 1, text: "first" }, { line: 3, text: "last" }],
    });
  });

  it.each([false, true])("keeps a final real blank line as match context, literal=%s", async literal => {
    const path = "context.txt";
    await write(path, "needle\n\n");
    const result = await run("grep_search", { path, pattern: "needle", literal, contextLines: 2 });
    expect(result.output).toMatchObject({ hits: [{ line: 1 }], context: [{ line: 2, text: "" }] });
  });
});
