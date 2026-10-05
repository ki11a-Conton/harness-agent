import fs from "node:fs/promises";
import { constants } from "node:fs";
import { execFileSync } from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PathScopedInstructionDiscovery } from "./path-scoped-discovery.js";
import { HierarchicalInstructionDiscovery } from "./discovery.js";

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks(); syncBuiltinESMExports();
  await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true })));
});
async function fixture(body: string | Buffer = "root regular control"): Promise<string> {
  const root = await fs.mkdtemp(join(tmpdir(), "ar-scoped-read-boundary-")); roots.push(root);
  await fs.writeFile(join(root, "AGENTS.md"), body);
  await fs.mkdir(join(root, "nested"));
  await fs.writeFile(join(root, "nested/AGENTS.md"), "nested regular control");
  await fs.writeFile(join(root, "nested/file.ts"), "target");
  return root;
}
function scoped(root: string) {
  return new PathScopedInstructionDiscovery({ workspaceRoot: root, targets: () => ["nested/file.ts"] });
}
function decorate(root: string, update: (handle: Awaited<ReturnType<typeof fs.open>>) => void, target = "AGENTS.md") {
  const original = fs.open;
  vi.spyOn(fs, "open").mockImplementation((async (path: Parameters<typeof fs.open>[0], ...args: unknown[]) => {
    const handle = await (original as (...args: unknown[]) => ReturnType<typeof fs.open>)(path, ...args);
    if (String(path) === join(root, target)) update(handle);
    return handle;
  }) as typeof fs.open); syncBuiltinESMExports();
}

describe("opt-in scoped instruction hard read boundaries", () => {
  for (const bytes of [Buffer.from([0xff]), Buffer.from([0xe2, 0x28, 0xa1]), Buffer.from([0xe2, 0x82]), Buffer.from([0xed, 0xa0, 0x80])]) {
    for (const cap of [1, 3, 100]) it(`omits malformed UTF-8 ${bytes.toString("hex")} at cap ${cap}, retaining a regular control`, async () => {
      const root = await fixture(bytes);
      const docs = await scoped(root).discover(root, { maxBytesPerFile: cap });
      expect(docs.map(doc => doc.path)).toEqual([join(root, "nested/AGENTS.md")]);
      expect(docs.every(doc => Buffer.byteLength(doc.content) <= cap && !doc.content.includes("\uFFFD"))).toBe(true);
      const control = await new HierarchicalInstructionDiscovery().discover(root, { maxBytesPerFile: cap });
      expect(control.map(doc => doc.path)).toEqual(docs.map(doc => doc.path));
    });
  }
  it("omits a malformed truncated prefix rather than expanding replacement bytes", async () => {
    const root = await fixture(Buffer.alloc(100, 0xff));
    const docs = await scoped(root).discover(root, { maxBytesPerFile: 1 });
    expect(docs.map(doc => doc.path)).toEqual([join(root, "nested/AGENTS.md")]);
    expect(docs.every(doc => Buffer.byteLength(doc.content) <= 1)).toBe(true);
  });
  for (const cap of [0, 1, 2, 3, 4, 8, 17, 24, 64]) it(`preserves valid UTF-8 truncation and its existing marker within cap ${cap}`, async () => {
    const root = await fixture("中文😀é\n".repeat(100));
    const docs = await scoped(root).discover(root, { maxBytesPerFile: cap });
    const doc = docs.find(doc => doc.path === join(root, "AGENTS.md"))!;
    expect(doc).toBeDefined(); expect(doc.truncated).toBe(true);
    expect(Buffer.byteLength(doc.content)).toBeLessThanOrEqual(cap);
    expect(doc.content).not.toContain("\uFFFD");
    if (cap >= Buffer.byteLength("\n# [truncated]")) expect(doc.content).toContain("\n# [truncated]");
  });
  it.each([100, 18])("preserves the literal BOM in valid capture with cap %i", async cap => {
    const body = "\uFEFFfirst line\nnext line with more text";
    const root = await fixture(body);
    const doc = (await scoped(root).discover(root, { maxBytesPerFile: cap }))[0]!;
    expect(doc.content.startsWith("\uFEFF")).toBe(true);
    expect(Buffer.byteLength(doc.content)).toBeLessThanOrEqual(cap);
    if (cap === 100) expect(doc.content).toBe(body);
  });
  it("accepts a genuinely empty regular file", async () => {
    const root = await fixture("");
    const doc = (await scoped(root).discover(root))[0]!;
    expect(doc.path).toBe(join(root, "AGENTS.md")); expect(doc.content).toBe(""); expect(doc.sizeBytes).toBe(0);
  });
  it("accumulates short reads with allocation and actual capture bounded by cap plus four", async () => {
    const root = await fixture("valid regular lines\n".repeat(100));
    const captures: { allocation: number; actual: number }[] = [];
    decorate(root, handle => {
      const read = handle.read.bind(handle) as (buffer: Buffer, offset: number, length: number, position: number) => Promise<{ bytesRead: number; buffer: Buffer }>;
      handle.read = (async (buffer: Buffer, offset: number, length: number, position: number) => {
        const result = await read(buffer, offset, Math.max(1, Math.floor(length / 2)), position);
        captures.push({ allocation: buffer.byteLength, actual: result.bytesRead }); return result;
      }) as typeof handle.read;
    });
    const doc = (await scoped(root).discover(root, { maxBytesPerFile: 100 }))[0]!;
    expect(captures.length).toBeGreaterThan(1);
    expect(captures.reduce((sum, item) => sum + item.actual, 0)).toBe(104);
    expect(captures.every(item => item.allocation <= 104)).toBe(true);
    expect(doc.truncated).toBe(true); expect(Buffer.byteLength(doc.content)).toBeLessThanOrEqual(100);
  });
  it.each(["zero", "partial"])("omits a %s premature EOF capture and does not cache it", async mode => {
    const root = await fixture(); const adapter = scoped(root); let calls = 0;
    decorate(root, handle => {
      const read = handle.read.bind(handle) as (buffer: Buffer, offset: number, length: number, position: number) => Promise<{ bytesRead: number; buffer: Buffer }>;
      handle.read = (async (buffer: Buffer, offset: number, length: number, position: number) => {
        calls++;
        if (mode === "partial" && position === 0) return read(buffer, offset, 3, position);
        return { bytesRead: 0, buffer };
      }) as typeof handle.read;
    });
    expect((await adapter.discover(root)).map(doc => doc.path)).toEqual([join(root, "nested/AGENTS.md")]);
    const firstCalls = calls;
    expect((await adapter.discover(root)).map(doc => doc.path)).toEqual([join(root, "nested/AGENTS.md")]);
    expect(calls).toBeGreaterThan(firstCalls);
    vi.restoreAllMocks(); syncBuiltinESMExports();
    expect((await adapter.discover(root))[0]!.content).toBe("root regular control");
  });
  it("continues to other documents after an actual descriptor closes and reports EIO", async () => {
    const root = await fixture(); let closes = 0;
    decorate(root, handle => { const close = handle.close.bind(handle); handle.close = async () => { await close(); closes++; throw Object.assign(new Error("cleanup EIO"), { code: "EIO" }); }; });
    const docs = await scoped(root).discover(root);
    expect(closes).toBe(1);
    expect(docs.map(doc => doc.content)).toEqual(["root regular control", "nested regular control"]);
  });
  it("isolates read failure and retries a failed capture instead of caching it", async () => {
    const root = await fixture(); const adapter = scoped(root);
    decorate(root, handle => { handle.read = async () => { throw Object.assign(new Error("read EIO"), { code: "EIO" }); }; });
    expect((await adapter.discover(root)).map(doc => doc.content)).toEqual(["nested regular control"]);
    vi.restoreAllMocks(); syncBuiltinESMExports();
    expect((await adapter.discover(root)).map(doc => doc.content)).toEqual(["root regular control", "nested regular control"]);
  });
  it("rejects a nonregular opened descriptor even when its numeric revision matches", async () => {
    const root = await fixture(); let reads = 0;
    decorate(root, handle => {
      const stat = handle.stat.bind(handle);
      handle.stat = (async () => { const value = await stat(); value.isFile = () => false; return value; }) as typeof handle.stat;
      const read = handle.read.bind(handle); handle.read = (async (...args: unknown[]) => { reads++; return (read as (...args: unknown[]) => ReturnType<typeof handle.read>)(...args); }) as typeof handle.read;
    });
    expect((await scoped(root).discover(root)).map(doc => doc.content)).toEqual(["nested regular control"]);
    expect(reads).toBe(0);
  });
  it("rejects a pathname revision changed after open but before capture", async () => {
    const root = await fixture(); const original = fs.lstat; let checked = 0;
    vi.spyOn(fs, "lstat").mockImplementation((async (path: Parameters<typeof fs.lstat>[0], ...args: unknown[]) => {
      const value = await (original as (...args: unknown[]) => ReturnType<typeof fs.lstat>)(path, ...args);
      if (String(path) === join(root, "AGENTS.md") && ++checked >= 2) value.mtimeMs += 1;
      return value;
    }) as typeof fs.lstat); syncBuiltinESMExports();
    expect((await scoped(root).discover(root)).map(doc => doc.content)).toEqual(["nested regular control"]);
  });
  it("rejects a real parent-directory replacement after reading despite an unchanged descriptor revision", async () => {
    const root = await fixture(); let replaced = false;
    decorate(root, handle => {
      const read = handle.read.bind(handle);
      handle.read = (async (...args: unknown[]) => {
        const result = await (read as (...args: unknown[]) => ReturnType<typeof handle.read>)(...args);
        if (!replaced) {
          replaced = true; await fs.rename(join(root, "nested"), join(root, "old-nested"));
          await fs.mkdir(join(root, "nested")); await fs.writeFile(join(root, "nested/AGENTS.md"), "replacement regular document");
          await fs.writeFile(join(root, "nested/file.ts"), "replacement target");
        }
        return result;
      }) as typeof handle.read;
    }, "nested/AGENTS.md");
    const adapter = scoped(root);
    expect((await adapter.discover(root)).map(doc => doc.content)).toEqual(["root regular control"]);
    expect(replaced).toBe(true);
    vi.restoreAllMocks(); syncBuiltinESMExports();
    expect((await adapter.discover(root)).map(doc => doc.content)).toEqual(["root regular control", "replacement regular document"]);
  });
  it("handles a real regular-to-FIFO race with a guarded nonblocking native open", async () => {
    const root = await fixture(); const original = fs.open; let guarded = false; let nonregular = false;
    vi.spyOn(fs, "open").mockImplementation((async (path: Parameters<typeof fs.open>[0], ...args: unknown[]) => {
      if (String(path) !== join(root, "AGENTS.md")) return (original as (...args: unknown[]) => ReturnType<typeof fs.open>)(path, ...args);
      const flags = args[0] as number;
      if (process.platform !== "win32" && (flags & (constants.O_NONBLOCK ?? 0)) === 0) { guarded = true; throw new Error("audit prevented blocking FIFO open"); }
      if (process.platform !== "win32") {
        await fs.rm(path); execFileSync("mkfifo", [String(path)]);
        const handle = await (original as (...args: unknown[]) => ReturnType<typeof fs.open>)(path, ...args);
        nonregular = !(await handle.stat()).isFile(); return handle;
      }
      // Windows has no POSIX FIFO here; only verify the type-boundary hook.
      console.info("POSIX FIFO native race NOT_RUN on Windows; descriptor type hook exercised");
      const handle = await (original as (...args: unknown[]) => ReturnType<typeof fs.open>)(path, ...args);
      const stat = handle.stat.bind(handle); handle.stat = (async () => { const value = await stat(); value.isFile = () => false; nonregular = true; return value; }) as typeof handle.stat;
      return handle;
    }) as typeof fs.open); syncBuiltinESMExports();
    expect((await scoped(root).discover(root)).map(doc => doc.content)).toEqual(["nested regular control"]);
    expect(guarded).toBe(false); expect(nonregular).toBe(true);
  });
});
