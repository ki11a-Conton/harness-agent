import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HierarchicalInstructionDiscovery } from "./discovery.js";

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  syncBuiltinESMExports();
  await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true })));
});
async function fixture(files: Record<string, string | Buffer>): Promise<string> {
  const root = await fs.mkdtemp(join(tmpdir(), "ar-default-doc-budget-")); roots.push(root);
  for (const [path, content] of Object.entries(files)) {
    await fs.mkdir(dirname(join(root, path)), { recursive: true }); await fs.writeFile(join(root, path), content);
  }
  return root;
}
const discovery = new HierarchicalInstructionDiscovery();

describe("default AGENTS discovery hard byte budget", () => {
  for (const [name, unit] of [["ASCII", "abcdefg"], ["Chinese and emoji", "中文😀é"]] as const) {
    for (const cap of [0, 1, 4, 12, 13, 14, 24, 30, 99, 100, 50_000]) {
      it(`bounds a single ${name} line including marker to ${cap} bytes`, async () => {
        const content = unit.repeat(Math.ceil(60_000 / Buffer.byteLength(unit)));
        const root = await fixture({ "AGENTS.md": content });
        const docs = await discovery.discover(root, { maxBytesPerFile: cap });
        expect(docs).toHaveLength(1);
        const doc = docs[0]!;
        expect(doc.sizeBytes).toBe(Buffer.byteLength(content)); expect(doc.truncated).toBe(true);
        expect(Buffer.byteLength(doc.content)).toBeLessThanOrEqual(cap);
        expect(doc.content).not.toContain("\ufffd");
        // A valid UTF-8 prefix plus the optional ASCII marker must round-trip.
        expect(Buffer.from(doc.content).toString("utf8")).toBe(doc.content);
      });
    }
  }
  it("reserves marker space while preserving complete lines when possible", async () => {
    const content = "first-complete-line\nsecond-complete-line\n".repeat(20);
    const root = await fixture({ "AGENTS.md": content });
    const [doc] = await discovery.discover(root, { maxBytesPerFile: 70 });
    expect(doc!.content).toContain("# [truncated");
    const prefix = doc!.content.slice(0, doc!.content.indexOf("\n# [truncated"));
    expect(content.startsWith(prefix + "\n")).toBe(true);
    expect(Buffer.byteLength(doc!.content)).toBeLessThanOrEqual(70);
  });
  for (const content of ["", "a", "abc中文😀", "first\nsecond\n"]) {
    it(`preserves an exact-budget document of ${Buffer.byteLength(content)} bytes`, async () => {
      const root = await fixture({ "AGENTS.md": content });
      expect((await discovery.discover(root, { maxBytesPerFile: Buffer.byteLength(content) }))[0]).toMatchObject({ content, sizeBytes: Buffer.byteLength(content), truncated: false });
    });
  }
  for (const field of ["maxBytesPerFile", "maxDocuments"] as const) {
    for (const value of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, -1]) {
      it(`rejects invalid ${field}=${String(value)} explicitly`, async () => {
        const root = await fixture({ "AGENTS.md": "safe" });
        await expect(discovery.discover(root, { [field]: value })).rejects.toThrow(/finite|non-negative|budget/i);
      });
    }
  }
  it("floors fractional byte/document budgets and keeps zero document budget empty", async () => {
    const root = await fixture({ "AGENTS.md": "safe root", "nested/AGENTS.md": "safe nested" });
    const docs = await discovery.discover(root, { maxBytesPerFile: 4.9, maxDocuments: 1.9 });
    expect(docs).toHaveLength(1); expect(Buffer.byteLength(docs[0]!.content)).toBeLessThanOrEqual(4);
    expect(await discovery.discover(root, { maxDocuments: 0 })).toEqual([]);
  });
  for (const pattern of ["x", "line line line\n"]) {
    it(`captures only cap+4 bytes from an actual 16 MiB ${pattern === "x" ? "single-line" : "multi-line"} document`, async () => {
      const size = 16 * 1024 * 1024;
      const bytes = Buffer.alloc(size); bytes.fill(pattern);
      const root = await fixture({ "AGENTS.md": bytes });
      const handle = await fs.open(join(root, "AGENTS.md"), "r");
      const proto = Object.getPrototypeOf(handle) as { readFile: (...args: unknown[]) => unknown; read: (...args: unknown[]) => unknown };
      const handleReadFile = vi.spyOn(proto, "readFile"); const readFile = vi.spyOn(fs, "readFile");
      const read = vi.spyOn(proto, "read"); await handle.close(); syncBuiltinESMExports();
      const docs = await discovery.discover(root, { maxBytesPerFile: 50_000 });
      expect(handleReadFile).not.toHaveBeenCalled(); expect(readFile).not.toHaveBeenCalled(); expect(read).toHaveBeenCalled();
      expect(read.mock.calls.reduce((sum, args) => sum + Number(args[2]), 0)).toBeLessThanOrEqual(50_004);
      for (const args of read.mock.calls) expect((args[0] as Buffer).byteLength).toBeLessThanOrEqual(50_004);
      expect(docs[0]!.sizeBytes).toBe(size); expect(Buffer.byteLength(docs[0]!.content)).toBeLessThanOrEqual(50_000);
    });
  }
  for (const bytes of [Buffer.from([0xff, 0xfe, 0xfd]), Buffer.from([0xc0, 0xaf]), Buffer.from([0x61, 0xe4, 0xb8]), Buffer.from([0xed, 0xa0, 0x80])]) {
    it(`omits malformed UTF-8 ${bytes.toString("hex")} without injecting replacement characters`, async () => {
      const root = await fixture({ "AGENTS.md": bytes, "nested/AGENTS.md": "valid control" });
      const docs = await discovery.discover(root, { maxBytesPerFile: 4 });
      expect(docs.some(doc => doc.path === join(root, "AGENTS.md"))).toBe(false);
      expect(docs.map(doc => doc.path)).toEqual([join(root, "nested/AGENTS.md")]);
    });
  }
  it("preserves default root/nested/cwd ordering, scope, dedup and maxDocuments", async () => {
    const root = await fixture({ "AGENTS.md": "root", "sub/AGENTS.md": "cwd", "sub/z/AGENTS.md": "z", "sub/a/AGENTS.md": "a", "sub/a/deep/AGENTS.md": "deep" });
    const docs = await discovery.discover(join(root, "sub"), { maxDocuments: 20 });
    expect(docs.map(doc => [doc.content, doc.scope])).toEqual([["root", "root"], ["a", "nested"], ["z", "nested"], ["deep", "nested"], ["cwd", "cwd"]]);
    expect((await discovery.discover(join(root, "sub"), { maxDocuments: 2 })).map(doc => doc.content)).toEqual(["root", "a"]);
  });
});

describe("default AGENTS no-follow and isolated read failures", () => {
  for (const scope of ["cwd", "ancestor", "nested"] as const) {
    it(`omits a ${scope} AGENTS file symlink while keeping regular controls`, async () => {
      const root = await fixture({ "outside.md": "outside linked instructions", "sub/control/AGENTS.md": "control" });
      const path = scope === "cwd" ? join(root, "sub/AGENTS.md") : scope === "ancestor" ? join(root, "AGENTS.md") : join(root, "sub/linked/AGENTS.md");
      await fs.mkdir(dirname(path), { recursive: true });
      if (scope === "ancestor") await fs.writeFile(join(root, "sub/AGENTS.md"), "cwd control");
      try { await fs.symlink(join(root, "outside.md"), path); }
      catch (err) {
        if (process.platform !== "win32" || (err as NodeJS.ErrnoException).code !== "EPERM") throw err;
        // Windows without CreateSymbolicLinkPrivilege: inject only the filesystem
        // lstat boundary, rather than skip this behavioral safety regression.
        await fs.writeFile(path, "outside linked instructions"); const original = fs.lstat;
        vi.spyOn(fs, "lstat").mockImplementation((async (target: Parameters<typeof fs.lstat>[0], ...args: unknown[]) => {
          const stat = await (original as (...args: unknown[]) => Promise<Awaited<ReturnType<typeof fs.lstat>>>)(target, ...args);
          if (String(target) === path) return Object.assign(stat, { isSymbolicLink: () => true });
          return stat;
        }) as typeof fs.lstat); syncBuiltinESMExports();
        console.info("AGENTS symlink regression: Windows lstat boundary used after EPERM");
      }
      const docs = await discovery.discover(join(root, "sub"));
      expect(docs.some(doc => doc.path === path || doc.content.includes("outside linked"))).toBe(false);
      expect(docs.some(doc => doc.content === "control")).toBe(true);
    });
  }
  it("omits a nonregular AGENTS directory and keeps a readable nested document", async () => {
    const root = await fixture({ "nested/AGENTS.md": "nested control" }); await fs.mkdir(join(root, "AGENTS.md"));
    expect((await discovery.discover(root)).map(doc => doc.content)).toEqual(["nested control"]);
  });
  it("isolates an unreadable AGENTS file from the rest of discovery", async () => {
    const root = await fixture({ "AGENTS.md": "root denied", "nested/AGENTS.md": "nested control" });
    const denied = join(root, "AGENTS.md");
    for (const name of ["open", "readFile"] as const) {
      const original = fs[name];
      vi.spyOn(fs, name).mockImplementation(((path: unknown, ...args: unknown[]) => String(path) === denied
        ? Promise.reject(Object.assign(new Error("denied"), { code: "EACCES" }))
        : (original as (...args: unknown[]) => Promise<unknown>)(path, ...args)) as typeof fs[typeof name]);
    }
    syncBuiltinESMExports();
    expect((await discovery.discover(root)).map(doc => doc.content)).toEqual(["nested control"]);
  });
  it("omits a document changed after its bounded capture", async () => {
    const root = await fixture({ "AGENTS.md": "unchanged-at-open", "nested/AGENTS.md": "nested control" });
    const probe = await fs.open(join(root, "AGENTS.md"), "r");
    const proto = Object.getPrototypeOf(probe) as { read: (...args: unknown[]) => Promise<{ bytesRead: number }> };
    const original = proto.read; let changed = false;
    vi.spyOn(proto, "read").mockImplementation(async function (this: unknown, ...args: unknown[]) {
      const result = await original.apply(this, args);
      if (!changed) { changed = true; await fs.writeFile(join(root, "AGENTS.md"), "changed-after-capture-with-new-size"); }
      return result;
    }); await probe.close();
    expect((await discovery.discover(root)).map(doc => doc.content)).toEqual(["nested control"]);
  });
});
