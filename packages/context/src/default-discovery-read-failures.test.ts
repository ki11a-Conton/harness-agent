import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HierarchicalInstructionDiscovery } from "./discovery.js";

const roots: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); syncBuiltinESMExports(); await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true }))); });
async function fixture(): Promise<string> {
  const root = await fs.mkdtemp(join(tmpdir(), "ar-default-doc-read-failure-")); roots.push(root);
  await fs.writeFile(join(root, "AGENTS.md"), "root regular instructions ".repeat(100));
  await fs.mkdir(join(root, "nested")); await fs.writeFile(join(root, "nested/AGENTS.md"), "nested control");
  return root;
}
function decorate(root: string, update: (handle: Awaited<ReturnType<typeof fs.open>>) => void): void {
  const original = fs.open;
  vi.spyOn(fs, "open").mockImplementation((async (path: Parameters<typeof fs.open>[0], ...args: unknown[]) => {
    const handle = await (original as (...args: unknown[]) => ReturnType<typeof fs.open>)(path, ...args);
    if (String(path) === join(root, "AGENTS.md")) update(handle);
    return handle;
  }) as typeof fs.open); syncBuiltinESMExports();
}

describe("default AGENTS bounded read/cleanup failures", () => {
  it("continues discovery after a real descriptor closes then reports a cleanup error", async () => {
    const root = await fixture(); let closes = 0;
    decorate(root, handle => {
      const close = handle.close.bind(handle);
      handle.close = async () => { await close(); closes++; throw Object.assign(new Error("cleanup failed"), { code: "EIO" }); };
    });
    const docs = await new HierarchicalInstructionDiscovery().discover(root);
    expect(closes).toBe(1); expect(docs.some(doc => doc.content === "nested control")).toBe(true);
  });
  it("accumulates actual short reads while keeping capture/allocation within cap+4", async () => {
    const root = await fixture(); const observed: { requested: number; returned: number; allocation: number }[] = [];
    decorate(root, handle => {
      const read = handle.read.bind(handle) as (buffer: Buffer, offset: number, length: number, position: number) => Promise<{ bytesRead: number; buffer: Buffer }>;
      handle.read = (async (buffer: Buffer, offset: number, length: number, position: number) => {
        const reduced = Math.max(1, Math.floor(length / 2));
        const result = await read(buffer, offset, reduced, position);
        observed.push({ requested: length, returned: result.bytesRead, allocation: buffer.byteLength }); return result;
      }) as typeof handle.read;
    });
    const docs = await new HierarchicalInstructionDiscovery().discover(root, { maxBytesPerFile: 100 });
    expect(observed.length).toBeGreaterThan(1);
    expect(observed.reduce((sum, read) => sum + read.returned, 0)).toBe(104);
    expect(observed.reduce((sum, read) => sum + read.requested, 0)).toBeGreaterThan(104);
    expect(observed.every(read => read.allocation <= 104)).toBe(true);
    expect(docs[0]!.truncated).toBe(true); expect(Buffer.byteLength(docs[0]!.content)).toBeLessThanOrEqual(100);
  });
  it("omits an incomplete zero-byte capture instead of describing it as the source document", async () => {
    const root = await fixture(); let reads = 0;
    decorate(root, handle => {
      handle.read = (async (buffer: Buffer) => { reads++; return { bytesRead: 0, buffer }; }) as typeof handle.read;
    });
    const docs = await new HierarchicalInstructionDiscovery().discover(root, { maxBytesPerFile: 100 });
    expect(reads).toBe(1); expect(docs.map(doc => doc.content)).toEqual(["nested control"]);
  });
});
