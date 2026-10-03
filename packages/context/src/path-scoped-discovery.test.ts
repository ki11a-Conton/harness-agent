import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { InstructionDiscovery } from "@ar/contracts";
import * as context from "./index.js";

const roots: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); syncBuiltinESMExports(); await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true }))); });
async function fixture(files: Record<string, string>): Promise<string> {
  const root = await fs.mkdtemp(join(tmpdir(), "ar-path-scope-")); roots.push(root);
  for (const [path, value] of Object.entries(files)) { await fs.mkdir(join(root, path, ".."), { recursive: true }); await fs.writeFile(join(root, path), value); }
  return root;
}
function discovery(root: string, targets: () => readonly string[] = () => [], options: { maxDocuments?: number; maxBytesPerFile?: number } = {}): InstructionDiscovery & { metrics?: { reads: number; cacheHits: number; probes: number } } {
  // The baseline executes its real discovery, so RED is a behavior difference,
  // never a missing-export / module-collection failure.
  const Constructor = (context as unknown as { PathScopedInstructionDiscovery?: new (opts: unknown) => InstructionDiscovery }).PathScopedInstructionDiscovery;
  return Constructor === undefined ? new context.HierarchicalInstructionDiscovery() : new Constructor({ workspaceRoot: root, targets, ...options });
}
const MONOREPO = { "AGENTS.md": "ROOT rules\n", "a/AGENTS.md": "A package rules\n", "a/src/file.ts": "a", "b/AGENTS.md": "B package rules\n", "b/src/file.ts": "b", "c/AGENTS.md": "C package rules\n", "c/src/file.ts": "c" };

describe("S2 opt-in path scoped discovery", () => {
  it("loads only root and the explicit target package from three mutually exclusive packages", async () => {
    const root = await fixture(MONOREPO);
    const docs = await discovery(root, () => ["c/src/file.ts"]).discover(root);
    expect(docs.map(doc => doc.content)).toEqual(["ROOT rules\n", "C package rules\n"]);
    expect(docs.map(doc => doc.scope)).toEqual(["root", "nested"]);
  });
  it("keeps the production default discovery subtree contract", async () => {
    const root = await fixture(MONOREPO);
    const docs = await new context.HierarchicalInstructionDiscovery().discover(root);
    expect(docs.map(doc => doc.content)).toEqual(["ROOT rules\n", "A package rules\n", "B package rules\n", "C package rules\n"]);
    expect(docs[0]!.scope).toBe("cwd");
  });
  for (const cap of [1, 2, 4]) it(`preserves root → package → cwd order through an ancestor gap with document budget ${cap}`, async () => {
    const root = await fixture({ "AGENTS.md": "root", "a/AGENTS.md": "package", "a/gap/src/AGENTS.md": "cwd", "a/gap/src/file.ts": "target", "b/AGENTS.md": "sibling" });
    const docs = await discovery(root, () => [join(root, "a/gap/src/file.ts")]).discover(join(root, "a/gap/src"), { maxDocuments: cap });
    expect(docs.map(doc => doc.content)).toEqual(["root", "package", "cwd"].slice(0, cap));
    expect(docs.map(doc => doc.scope)).toEqual(["root", "nested", "cwd"].slice(0, cap));
  });
  it("unions multiple targets, deduplicates ancestors, and switches scope on a later discovery", async () => {
    const root = await fixture(MONOREPO); let targets = ["a/src/file.ts", "c/src/file.ts", "a/src/file.ts"];
    const adapter = discovery(root, () => targets);
    expect((await adapter.discover(root)).map(doc => doc.content)).toEqual(["ROOT rules\n", "A package rules\n", "C package rules\n"]);
    targets = ["b/src/file.ts"];
    expect((await adapter.discover(root)).map(doc => doc.content)).toEqual(["ROOT rules\n", "B package rules\n"]);
  });
  it("rejects traversal, sibling-prefix, outside paths and every symlink component", async () => {
    const root = await fixture(MONOREPO); const outside = await fixture({ "AGENTS.md": "OUTSIDE", "file.ts": "outside" });
    await fs.symlink(join(root, "c"), join(root, "linked"), process.platform === "win32" ? "junction" : "dir");
    await fs.symlink(join(outside, "AGENTS.md"), join(root, "a/src/AGENTS.md"));
    const docs = await discovery(root, () => ["../escape", "..\\escape", `${root}-sibling/file.ts`, join(outside, "file.ts"), "linked/src/file.ts", "C:\\outside\\file.ts", "\\\\server\\share\\file.ts"]).discover(root);
    expect(docs.map(doc => doc.content)).toEqual(["ROOT rules\n"]);
  });
  it("rejects a cwd outside its fixed workspace", async () => {
    const root = await fixture(MONOREPO); const outside = await fixture({ "AGENTS.md": "OUTSIDE" });
    await expect(discovery(root).discover(outside)).rejects.toThrow();
  });
  it("does not follow a symlinked instruction file for an otherwise valid target", async () => {
    const root = await fixture(MONOREPO); await fs.rm(join(root, "c/AGENTS.md")); await fs.symlink(join(root, "b/AGENTS.md"), join(root, "c/AGENTS.md"));
    expect((await discovery(root, () => ["c/src/file.ts"]).discover(root)).map(doc => doc.content)).toEqual(["ROOT rules\n"]);
  });
  for (const cap of [0, 1, 2, 3, 4, 8, 17, 24]) it(`caps the complete UTF-8 document including marker at ${cap} bytes`, async () => {
    const root = await fixture({ "AGENTS.md": "中文😀é\n".repeat(30) });
    const docs = await discovery(root).discover(root, { maxBytesPerFile: cap });
    expect(docs).toHaveLength(1); expect(docs[0]!.truncated).toBe(true);
    expect(Buffer.byteLength(docs[0]!.content)).toBeLessThanOrEqual(cap);
    expect(docs[0]!.content).not.toMatch(/\uFFFD|[\uD800-\uDBFF](?![\uDC00-\uDFFF])/u);
  });
  it("captures only a bounded prefix of a large sparse document and never calls readFile", async () => {
    const root = await fixture({ "AGENTS.md": "中文😀\n" });
    const handle = await fs.open(join(root, "AGENTS.md"), "r+"); await handle.truncate(64 * 1024 * 1024);
    const proto = Object.getPrototypeOf(handle) as { readFile: (...args: unknown[]) => unknown; read: (...args: unknown[]) => unknown };
    const readFile = vi.spyOn(proto, "readFile"); const fileRead = vi.spyOn(fs, "readFile");
    const read = vi.spyOn(proto, "read"); await handle.close();
    const docs = await discovery(root).discover(root, { maxBytesPerFile: 24 });
    expect(readFile).not.toHaveBeenCalled(); expect(fileRead).not.toHaveBeenCalled();
    for (const call of read.mock.calls) expect((call[0] as Buffer).byteLength).toBeLessThanOrEqual(28);
    expect(docs[0]!.sizeBytes).toBe(64 * 1024 * 1024); expect(Buffer.byteLength(docs[0]!.content)).toBeLessThanOrEqual(24);
  });
  it("reuses unchanged document captures but invalidates revision and cap changes", async () => {
    const root = await fixture(MONOREPO); const adapter = discovery(root, () => ["c/src/file.ts"]);
    expect((await adapter.discover(root)).map(doc => doc.content)).toEqual(["ROOT rules\n", "C package rules\n"]); const reads = adapter.metrics?.reads;
    await adapter.discover(root); expect(adapter.metrics?.reads).toBe(reads); expect(adapter.metrics?.cacheHits).toBeGreaterThanOrEqual(2);
    await fs.writeFile(join(root, "c/AGENTS.md"), "C revised rule\n");
    expect((await adapter.discover(root))[1]!.content).toBe("C revised rule\n");
    expect(adapter.metrics?.reads).toBe((reads ?? 0) + 1);
    expect(Buffer.byteLength((await adapter.discover(root, { maxBytesPerFile: 4 }))[1]!.content)).toBeLessThanOrEqual(4);
  });
  it("skips unreadable documents and continues to the next applicable ancestor", async () => {
    const root = await fixture(MONOREPO); const original = fs.open;
    vi.spyOn(fs, "open").mockImplementation(((path: unknown, ...args: unknown[]) => {
      if (path === join(root, "c/AGENTS.md")) return Promise.reject(Object.assign(new Error("denied"), { code: "EACCES" }));
      return (original as (...args: unknown[]) => Promise<unknown>)(path, ...args);
    }) as typeof fs.open);
    syncBuiltinESMExports();
    const docs = await discovery(root, () => ["c/src/file.ts"]).discover(root);
    expect(docs.map(doc => doc.content)).toEqual(["ROOT rules\n"]);
  });
});
