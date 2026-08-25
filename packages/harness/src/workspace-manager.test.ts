// P3-4/P3-5: child workspace isolation — readonly children share the parent
// root; writable children get an isolated copy whose diff is a structured
// patch that applies under conflict detection.

import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { newSessionId } from "@ar/contracts";
import { safeJoin } from "./workspace-manager.js";
import { DefaultChildWorkspaceManager } from "./workspace-manager.js";
import { resolve, sep } from "node:path";

let tempDirs: string[] = [];
async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "ar-wsi-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.map((d) => rm(d, { recursive: true, force: true })));
  tempDirs = [];
});

describe("P3-4: child workspace creation", () => {
  it("shares the parent root for read-only children (no copy)", async () => {
    const parentRoot = await tempDir();
    const manager = new DefaultChildWorkspaceManager();
    const handle = await manager.create({
      parentRoot,
      childSessionId: newSessionId(),
      writable: false,
    });
    expect(handle.mode).toBe("shared-readonly");
    expect(handle.root).toBe(parentRoot);
    expect((await handle.diff()).entries).toEqual([]);
    await handle.dispose();
  });

  it("copies the parent tree into an isolated root, skipping ignored directories", async () => {
    const parentRoot = await tempDir();
    await writeFile(join(parentRoot, "a.ts"), "export const a = 1;\n");
    await mkdir(join(parentRoot, "node_modules"), { recursive: true });
    await writeFile(join(parentRoot, "node_modules", "pkg.js"), "BIG");
    await mkdir(join(parentRoot, ".git"), { recursive: true });
    await writeFile(join(parentRoot, ".git", "config"), "GIT");
    await writeFile(join(parentRoot, "big.log"), "x".repeat(1000));

    const manager = new DefaultChildWorkspaceManager();
    const handle = await manager.create({
      parentRoot,
      childSessionId: newSessionId(),
      writable: true,
    });
    try {
      expect(handle.mode).toBe("isolated-copy");
      expect(handle.root).not.toBe(parentRoot);
      expect(await readFile(join(handle.root, "a.ts"), "utf8")).toBe("export const a = 1;\n");
      // node_modules / .git are never copied.
      await expect(readFile(join(handle.root, "node_modules", "pkg.js"), "utf8")).rejects.toThrow();
      await expect(readFile(join(handle.root, ".git", "config"), "utf8")).rejects.toThrow();
      // The unmodified file produces no diff entry.
      expect((await handle.diff()).entries).toEqual([]);
    } finally {
      await handle.dispose();
      await expect(readFile(join(handle.root, "a.ts"), "utf8")).rejects.toThrow();
    }
  });
});

describe("P3-5: diff + physical apply", () => {
  it("produces added/modified/deleted patch entries with parent baseline hashes", async () => {
    const parentRoot = await tempDir();
    await writeFile(join(parentRoot, "keep.ts"), "keep\n");
    await writeFile(join(parentRoot, "change.ts"), "old\n");

    const manager = new DefaultChildWorkspaceManager();
    const handle = await manager.create({
      parentRoot,
      childSessionId: newSessionId(),
      writable: true,
    });
    try {
      // Child edits a file, adds one, deletes another.
      await writeFile(join(handle.root, "change.ts"), "new content\n");
      await writeFile(join(handle.root, "added.ts"), "brand new\n");
      await rm(join(handle.root, "keep.ts"));

      const patch = await handle.diff();
      const byPath = new Map(patch.entries.map((e) => [e.path, e]));
      expect(byPath.get("change.ts")).toMatchObject({ kind: "modified", content: "new content\n" });
      expect(byPath.get("change.ts")!.parentBaselineHash).toBeDefined();
      expect(byPath.get("added.ts")).toMatchObject({ kind: "added", content: "brand new\n" });
      expect(byPath.get("keep.ts")).toMatchObject({ kind: "deleted" });
    } finally {
      await handle.dispose();
    }
  });

  it("applies the patch to the parent workspace", async () => {
    const parentRoot = await tempDir();
    await writeFile(join(parentRoot, "change.ts"), "old\n");

    const manager = new DefaultChildWorkspaceManager();
    const handle = await manager.create({ parentRoot, childSessionId: newSessionId(), writable: true });
    let patch;
    try {
      await writeFile(join(handle.root, "change.ts"), "new content\n");
      await writeFile(join(handle.root, "added.ts"), "brand new\n");
      patch = await handle.diff();
    } finally {
      await handle.dispose();
    }

    const result = await manager.apply(parentRoot, patch!);
    expect(result.applied.sort()).toEqual(["added.ts", "change.ts"]);
    expect(result.conflicts).toEqual([]);
    expect(await readFile(join(parentRoot, "change.ts"), "utf8")).toBe("new content\n");
    expect(await readFile(join(parentRoot, "added.ts"), "utf8")).toBe("brand new\n");
  });

  it("refuses to overwrite a path the parent changed while the child ran (conflict)", async () => {
    const parentRoot = await tempDir();
    await writeFile(join(parentRoot, "change.ts"), "old\n");

    const manager = new DefaultChildWorkspaceManager();
    const handle = await manager.create({ parentRoot, childSessionId: newSessionId(), writable: true });
    let patch;
    try {
      await writeFile(join(handle.root, "change.ts"), "child version\n");
      patch = await handle.diff();
    } finally {
      await handle.dispose();
    }

    // Parent changes the same path AFTER the child was created.
    await writeFile(join(parentRoot, "change.ts"), "parent version\n");
    const result = await manager.apply(parentRoot, patch!);
    expect(result.conflicts.map((c) => c.path)).toEqual(["change.ts"]);
    expect(result.applied).toEqual([]);
    // Parent's version survives.
    expect(await readFile(join(parentRoot, "change.ts"), "utf8")).toBe("parent version\n");
  });
});

describe("P3-4: path safety", () => {
  it("rejects traversal and absolute paths", () => {
    // Use a real, accessible absolute root (tmpdir). `/root` on Linux CI is
    // a real directory the runner cannot read (EACCES) — canonicalization
    // fails closed with CanonicalizationFailed, which breaks the positive
    // assertion below. tmpdir is readable on every platform.
    const root = join(tmpdir(), `ws-root-${process.pid}`);
    expect(safeJoin(root, "../escape")).toBeUndefined();
    expect(safeJoin(root, "a/../../escape")).toBeUndefined();
    expect(safeJoin(root, "/absolute")).toBeUndefined();
    expect(safeJoin(root, "C:\\win")).toBeUndefined();
    expect(safeJoin(root, "sub/file.ts")).toBe(resolve(root, "sub/file.ts"));
  });
});
