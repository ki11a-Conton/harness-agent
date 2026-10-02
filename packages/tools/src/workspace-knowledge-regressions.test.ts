import { promises as fs } from "node:fs";
import { readFile, readdir, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ToolExecutionContext } from "@ar/contracts";
import { newAgentId, newSessionId, newToolCallId, newTurnId } from "@ar/contracts";
import { RepositoryMapCache, scanRepoStats } from "./repo-map.js";
import { getSymbolIndex, indexedSymbolSearch } from "./symbol-index.js";
import { createRepoMapTool, makeRepoMapResolver } from "./tools/repo-map-tool.js";
import { symbolSearchTool } from "./tools/navigation-tools.js";
import { ToolRegistry } from "./registry.js";
import { ToolOrchestrator } from "./orchestrator.js";

vi.mock("node:fs/promises", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:fs/promises")>();
  return { ...original, readFile: vi.fn(original.readFile), readdir: vi.fn(original.readdir), stat: vi.fn(original.stat) };
});
const actualFs = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
let root: string;

beforeEach(async () => {
  root = await fs.mkdtemp(join(tmpdir(), "ar-workspace-knowledge-"));
  vi.mocked(readFile).mockReset().mockImplementation(actualFs.readFile);
  vi.mocked(readdir).mockReset().mockImplementation(actualFs.readdir);
  vi.mocked(stat).mockReset().mockImplementation(actualFs.stat);
});
afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(root, { recursive: true, force: true });
});

async function write(path: string, contents: string): Promise<void> {
  const target = join(root, path);
  await fs.mkdir(dirname(target), { recursive: true });
  await fs.writeFile(target, contents);
}
async function repoFixture(): Promise<void> {
  await write("package.json", JSON.stringify({ name: "old-package" }));
  await write("src/main.ts", "export const KnownSymbol = 1;\n");
  await write("src/other.ts", "export const OtherSymbol = 2;\n");
}
function deferred() {
  let release!: () => void;
  const promise = new Promise<void>((done) => { release = done; });
  return { promise, release };
}
function context(cwd = root): ToolExecutionContext {
  return {
    cwd, sessionId: newSessionId(), turnId: newTurnId(), agentId: newAgentId(),
    signal: new AbortController().signal,
    permissions: { rules: [], defaultEffect: "allow" },
    sandboxPolicy: { filesystem: { mode: "workspace-write" }, network: { mode: "deny" }, process: { timeoutMs: 10_000 } },
  };
}
async function runTool(orch: ToolOrchestrator, name: string, args: Record<string, unknown>, ctx: ToolExecutionContext) {
  return orch.execute({ id: newToolCallId(), sessionId: ctx.sessionId, turnId: ctx.turnId, agentId: ctx.agentId, call: { id: newToolCallId(), name, args } }, ctx);
}

describe("workspace knowledge: bounded, shared repository scans", () => {
  it("shares a warm validation scan across 16 callers", async () => {
    await repoFixture();
    const cache = new RepositoryMapCache({ root });
    const initial = await cache.get();
    const calls = vi.spyOn(fs, "stat");
    const maps = await Promise.all(Array.from({ length: 16 }, () => cache.get()));
    expect(maps.every((map) => map === initial)).toBe(true);
    expect(calls).toHaveBeenCalledTimes(3);
    expect(cache.stats.builds).toBe(1);
  });

  it("reuses the changed validation scan to build the map", async () => {
    await repoFixture();
    const cache = new RepositoryMapCache({ root });
    await cache.get();
    await write("package.json", JSON.stringify({ name: "changed-package-longer" }));
    const calls = vi.spyOn(fs, "stat");
    const updated = await cache.get();
    expect(updated.packages[0]?.name).toBe("changed-package-longer");
    expect(calls).toHaveBeenCalledTimes(3);
  });

  it("stops traversal across sibling directories at the scan limit", async () => {
    for (let dir = 0; dir < 12; dir++) await write(`group-${String(dir).padStart(2, "0")}/one.ts`, "export {};\n");
    const calls = vi.spyOn(fs, "readdir");
    expect(await scanRepoStats(root, 1)).toHaveLength(1);
    expect(calls).toHaveBeenCalledTimes(2); // root + the one visited group
  });

  it("marks an exact cap complete and detects a new file beyond the cap", async () => {
    await write("a.ts", "export {};\n");
    await write("b.ts", "export {};\n");
    const cache = new RepositoryMapCache({ root, maxFiles: 2 });
    const exact = await cache.get();
    expect(exact.complete).toBe(true);
    await write("z.ts", "export {};\n");
    const truncated = await cache.get();
    expect(truncated.complete).toBe(false);
    expect(truncated.fileCount).toBe(2);
    expect(truncated.fingerprint).toBe(exact.fingerprint);
  });

  it("reports dirty freshness immediately", async () => {
    await repoFixture();
    const cache = new RepositoryMapCache({ root });
    await cache.get();
    cache.noteChange("package.json");
    expect(cache.isFresh()).toBe(false);
    await cache.get();
    expect(cache.isFresh()).toBe(true);
  });

  it.each(["noteChange", "invalidate"] as const)("preserves %s while a warm scan is pending", async (invalidate) => {
    await repoFixture();
    const cache = new RepositoryMapCache({ root });
    await cache.get();
    const original = fs.stat.bind(fs);
    const captured = deferred();
    const resume = deferred();
    let held = false;
    vi.spyOn(fs, "stat").mockImplementation((async (...args: Parameters<typeof fs.stat>) => {
      const result = await original(...args);
      if (!held && String(args[0]) === join(root, "package.json")) {
        held = true;
        captured.release();
        await resume.promise;
      }
      return result;
    }) as typeof fs.stat);
    const pending = cache.get();
    await captured.promise;
    try {
      // Same-length rewrite after the pending scan captured its old stat.
      await write("package.json", JSON.stringify({ name: "new-package" }));
      cache[invalidate]("package.json");
    } finally { resume.release(); }
    expect((await pending).packages[0]?.name).toBe("new-package");
    expect(cache.peek()?.packages[0]?.name).toBe("new-package");
  });

  it.each(["noteChange", "invalidate"] as const)("does not publish an old build after %s", async (invalidate) => {
    await repoFixture();
    const cache = new RepositoryMapCache({ root });
    const original = fs.readFile.bind(fs);
    const captured = deferred();
    const resume = deferred();
    let manifestReads = 0;
    vi.spyOn(fs, "readFile").mockImplementation((async (...args: Parameters<typeof fs.readFile>) => {
      const content = await original(...args);
      // resolveWorkspace reads the manifest first; hold the package parse read.
      if (String(args[0]) === join(root, "package.json") && ++manifestReads === 2) {
        captured.release();
        await resume.promise;
      }
      return content;
    }) as typeof fs.readFile);
    const pending = cache.get();
    await captured.promise;
    try {
      await write("package.json", JSON.stringify({ name: "new-package" }));
      cache[invalidate]("package.json");
    } finally { resume.release(); }
    const maps = await Promise.all([pending, cache.get()]);
    expect(maps.every((map) => map.packages[0]?.name === "new-package")).toBe(true);
    expect(cache.peek()).toBe(maps[1]);
    expect(cache.stats.builds).toBe(2);
  });
});

describe("workspace knowledge: repository resolver isolation", () => {
  it("uses separate workspace caches and reuses A after A → B → A", async () => {
    await write("a/one.ts", "export {};\n");
    await write("b/two.ts", "export {};\n");
    const resolver = makeRepoMapResolver();
    const a = await resolver.resolve({}, join(root, "a"));
    const b = await resolver.resolve({}, join(root, "b"));
    expect(b.root).toBe(join(root, "b"));
    expect(b.files.map((file) => file.path)).toEqual(["two.ts"]);
    expect(await resolver.resolve({}, join(root, "a"))).toBe(a);
  });

  it("honors maxFiles for each call without replacing a different budget", async () => {
    await repoFixture();
    const resolver = makeRepoMapResolver();
    const full = await resolver.resolve({}, root);
    const limited = await resolver.resolve({ maxFiles: 1 }, root);
    expect(limited.fileCount).toBe(1);
    expect(limited.complete).toBe(false);
    expect(await resolver.resolve({ maxFiles: 50_000 }, root)).toBe(full);
  });

  it("normalizes cwd aliases and limits refresh to that workspace", async () => {
    await write("a/one.ts", "export {};\n");
    await write("b/two.ts", "export {};\n");
    const resolver = makeRepoMapResolver();
    const a = await resolver.resolve({}, join(root, "a"));
    const b = await resolver.resolve({}, join(root, "b"));
    await resolver.resolve({ refresh: true }, join(root, "a", "."));
    expect(await resolver.resolve({}, join(root, "b"))).toBe(b);
    const alias = await resolver.resolve({}, `${join(root, "a")}/../a`);
    expect(alias.root).toBe(a.root);
    expect(resolver.cache?.stats.builds).toBe(2);
  });

  it("retains recently used entries while evicting the oldest of eight", async () => {
    const resolver = makeRepoMapResolver();
    const maps = [];
    for (let index = 0; index < 8; index++) {
      await write(`repo-${index}/one.ts`, "export {};\n");
      maps.push(await resolver.resolve({}, join(root, `repo-${index}`)));
    }
    expect(await resolver.resolve({}, join(root, "repo-0"))).toBe(maps[0]);
    await write("repo-8/one.ts", "export {};\n");
    await resolver.resolve({}, join(root, "repo-8"));
    expect(await resolver.resolve({}, join(root, "repo-0"))).toBe(maps[0]);
    expect(await resolver.resolve({}, join(root, "repo-1"))).not.toBe(maps[1]);
  });

  it("serves the correct root through two orchestrators sharing one tool", async () => {
    await write("a/one.ts", "export {};\n");
    await write("b/two.ts", "export {};\n");
    const registry = new ToolRegistry();
    registry.register(createRepoMapTool(makeRepoMapResolver()));
    for (const name of ["a", "b"]) {
      const cwd = join(root, name);
      const orch = new ToolOrchestrator({ registry, workspaceRoot: cwd });
      const result = await runTool(orch, "repo_map", {}, context(cwd));
      expect(result.status, JSON.stringify(result.error)).toBe("success");
      expect(result.output).toMatchObject({ root: cwd });
    }
  });
});

describe("workspace knowledge: fresh and shared symbol indexes", () => {
  it.each([undefined, ".", "./", ""])("searches the root for scope %s", async (relPath) => {
    await repoFixture();
    const result = await indexedSymbolSearch({ root, symbol: "KnownSymbol", relPath });
    expect(result.hits.map((hit) => hit.file)).toEqual(["src/main.ts"]);
  });

  it("matches directory boundaries and exact file paths", async () => {
    await write("src/a/main.ts", "export const ScopedSymbol = 1;\n");
    await write("src/ab/main.ts", "export const ScopedSymbol = 2;\n");
    await write("src/a/main.tsx", "export const ScopedSymbol = 3;\n");
    const directory = await indexedSymbolSearch({ root, symbol: "ScopedSymbol", relPath: "./src/a/" });
    expect(directory.hits.map((hit) => hit.file).sort()).toEqual(["src/a/main.ts", "src/a/main.tsx"]);
    const exact = await indexedSymbolSearch({ root, symbol: "ScopedSymbol", relPath: "src/a/main.ts" });
    expect(exact.hits.map((hit) => hit.file)).toEqual(["src/a/main.ts"]);
    const simple = await indexedSymbolSearch({ root, symbol: "ScopedSymbol", relPath: "src/a" });
    expect(simple.hits).toHaveLength(2);
  });

  it("finds the default symbol through the permission and sandbox pipeline", async () => {
    await repoFixture();
    const registry = new ToolRegistry();
    registry.register(symbolSearchTool);
    const orch = new ToolOrchestrator({ registry, workspaceRoot: root });
    const result = await runTool(orch, "symbol_search", { symbol: "KnownSymbol" }, context());
    expect(result.status, JSON.stringify(result.error)).toBe("success");
    expect(result.output).toMatchObject({ hits: [{ file: "src/main.ts", line: 1, kind: "const" }] });
  });

  it("coalesces 16 cold queries and normalized root aliases", async () => {
    await repoFixture();
    const indexes = await Promise.all(Array.from({ length: 16 }, (_, index) => getSymbolIndex(index % 2 ? `${root}/../${root.split(/[\\/]/).pop()}` : root)));
    expect(indexes.every((index) => index.files === indexes[0]!.files)).toBe(true);
    expect(vi.mocked(readFile).mock.calls.filter(([path]) => String(path).endsWith(".ts"))).toHaveLength(2);
    expect(indexes[0]?.root).toBe(resolve(root));
  });

  it("does not index files when the orchestrator denies permissions", async () => {
    await repoFixture();
    const registry = new ToolRegistry();
    registry.register(symbolSearchTool);
    const orch = new ToolOrchestrator({ registry, workspaceRoot: root });
    const ctx = context();
    ctx.permissions = { rules: [], defaultEffect: "deny" };
    const result = await runTool(orch, "symbol_search", { symbol: "KnownSymbol" }, ctx);
    expect(result.status).toBe("denied");
    expect(readFile).not.toHaveBeenCalled();
  });

  it("rejects a path outside the workspace before indexing", async () => {
    await repoFixture();
    const registry = new ToolRegistry();
    registry.register(symbolSearchTool);
    const orch = new ToolOrchestrator({ registry, workspaceRoot: root });
    const result = await runTool(orch, "symbol_search", { symbol: "KnownSymbol", path: "../outside" }, context());
    expect(result.status).toBe("denied");
    expect(readFile).not.toHaveBeenCalled();
  });

  it("validates concurrent warm queries once without rereading contents", async () => {
    await repoFixture();
    const first = await getSymbolIndex(root);
    vi.mocked(readFile).mockClear();
    vi.mocked(stat).mockClear();
    const indexes = await Promise.all(Array.from({ length: 16 }, () => getSymbolIndex(root)));
    expect(indexes.every((index) => index.files.get("src/main.ts") === first.files.get("src/main.ts"))).toBe(true);
    expect(readFile).not.toHaveBeenCalled();
    expect(stat).toHaveBeenCalledTimes(2);
  });

  it("updates a nested edit immediately and reuses the unchanged file", async () => {
    await repoFixture();
    const before = await getSymbolIndex(root);
    await write("src/main.ts", "export const ChangedNestedSymbol = 100;\n");
    vi.mocked(readFile).mockClear();
    const after = await getSymbolIndex(root);
    expect(after.files.get("src/other.ts")).toBe(before.files.get("src/other.ts"));
    expect(after.files.get("src/main.ts")).not.toBe(before.files.get("src/main.ts"));
    expect(readFile).toHaveBeenCalledTimes(1);
    expect((await indexedSymbolSearch({ root, symbol: "ChangedNestedSymbol" })).hits).toHaveLength(1);
    expect((await indexedSymbolSearch({ root, symbol: "KnownSymbol" })).hits).toHaveLength(0);
  });

  it("detects same-size nested edits through the file mtime", async () => {
    await write("src/main.ts", "export const Before = 1;\n");
    await getSymbolIndex(root);
    const target = join(root, "src/main.ts");
    const original = await fs.stat(target);
    await write("src/main.ts", "export const After_ = 1;\n");
    await fs.utimes(target, original.atime, new Date(original.mtimeMs + 2_000));
    expect((await indexedSymbolSearch({ root, symbol: "After_" })).hits).toHaveLength(1);
  });

  it("detects nested additions and removals without a root-directory change", async () => {
    await repoFixture();
    await getSymbolIndex(root);
    await write("src/new.ts", "export const AddedSymbol = 1;\n");
    expect((await indexedSymbolSearch({ root, symbol: "AddedSymbol" })).hits).toHaveLength(1);
    await fs.rm(join(root, "src/main.ts"));
    expect((await indexedSymbolSearch({ root, symbol: "KnownSymbol" })).hits).toHaveLength(0);
    expect((await getSymbolIndex(root)).filesIndexed).toBe(2);
  });

  it("forces content rereads after the TTL even for matching file stats", async () => {
    await repoFixture();
    const timestamp = new Date("2026-01-01T00:00:00Z");
    await fs.utimes(join(root, "src/main.ts"), timestamp, timestamp);
    await getSymbolIndex(root);
    vi.mocked(readFile).mockClear();
    const now = Date.now();
    const clock = vi.spyOn(Date, "now").mockReturnValue(now + 30_000);
    await getSymbolIndex(root);
    expect(readFile).not.toHaveBeenCalled();
    // A warm validation must not postpone the full-refresh deadline.
    await write("src/main.ts", "export const NewerSymbol = 1;\n");
    await fs.utimes(join(root, "src/main.ts"), timestamp, timestamp);
    clock.mockReturnValue(now + 60_001);
    expect((await indexedSymbolSearch({ root, symbol: "NewerSymbol" })).hits).toHaveLength(1);
    expect(readFile).toHaveBeenCalledTimes(2);
  });

  it("keeps the 64 most recently used roots", async () => {
    const indexes = [];
    for (let index = 0; index < 64; index++) {
      await write(`repo-${index}/one.ts`, "export const CapacitySymbol = 1;\n");
      indexes.push(await getSymbolIndex(join(root, `repo-${index}`)));
    }
    const mostRecent = await getSymbolIndex(join(root, "repo-0"));
    expect(mostRecent.files.get("one.ts")).toBe(indexes[0]?.files.get("one.ts"));
    await write("repo-64/one.ts", "export const CapacitySymbol = 1;\n");
    await getSymbolIndex(join(root, "repo-64"));
    expect((await getSymbolIndex(join(root, "repo-0"))).files.get("one.ts")).toBe(indexes[0]?.files.get("one.ts"));
    expect((await getSymbolIndex(join(root, "repo-1"))).files.get("one.ts")).not.toBe(indexes[1]?.files.get("one.ts"));
  });
});
