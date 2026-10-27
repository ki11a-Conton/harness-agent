import { promises as fs } from "node:fs";
import { open } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IndexedSourceError, readIndexedSource } from "./indexed-source-reader.js";

vi.mock("node:fs/promises", async importOriginal => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, open: vi.fn(actual.open) };
});
const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
let root: string;
let realRoot: string;
beforeEach(async () => {
  root = await fs.mkdtemp(join(tmpdir(), "indexed-reader-"));
  realRoot = await fs.realpath(root);
  vi.mocked(open).mockReset().mockImplementation(actual.open);
});
afterEach(async () => { vi.restoreAllMocks(); await fs.rm(root, { recursive: true, force: true }); });
const options = (maxBytes: number, signal = new AbortController().signal) => ({ encoding: "utf8" as const, signal, root, realRoot, maxBytes });

describe("bounded indexed source reads", () => {
  it("preserves UTF-8, CRLF, and exact-limit reads across real short reads", async () => {
    const path = join(root, "source.ts"), body = "中文😀\r\nsecond\r\n";
    await fs.writeFile(path, body);
    let handle: Awaited<ReturnType<typeof actual.open>> | undefined;
    vi.mocked(open).mockImplementation(async (...args) => {
      handle = await actual.open(...args);
      const own = handle;
      handle.read = new Proxy(handle.read, { apply(target, _thisArg, readArgs) {
        readArgs[2] = Math.min(Number(readArgs[2]), 3);
        return Reflect.apply(target, own, readArgs);
      } });
      return handle;
    });
    expect(await readIndexedSource(path, options(Buffer.byteLength(body)))).toBe(body);
    expect(handle?.fd).toBe(-1);
  });

  it("bounds bytes actually read when a file grows after opening and closes the handle", async () => {
    const path = join(root, "growing.ts"); await fs.writeFile(path, "seed");
    let handle: Awaited<ReturnType<typeof actual.open>> | undefined, bytesRead = 0, grew = false;
    vi.mocked(open).mockImplementation(async (...args) => {
      handle = await actual.open(...args);
      const own = handle;
      handle.read = new Proxy(handle.read, { apply(target, _thisArg, readArgs) {
        return (Reflect.apply(target, own, readArgs) as Promise<{ bytesRead: number }>).then(async result => {
          bytesRead += result.bytesRead;
          if (!grew && result.bytesRead > 0) { grew = true; await fs.appendFile(path, "x".repeat(2048)); }
          return result;
        });
      } });
      return handle;
    });
    await expect(readIndexedSource(path, options(1024))).rejects.toMatchObject({ code: "SOURCE_TOO_LARGE" });
    expect(grew).toBe(true); expect(bytesRead).toBeLessThanOrEqual(1025); expect(handle?.fd).toBe(-1);
  });

  it("reports an in-limit mutation instead of caching a mixed snapshot", async () => {
    const path = join(root, "changed.ts"); await fs.writeFile(path, "seed");
    let handle: Awaited<ReturnType<typeof actual.open>> | undefined, changed = false;
    vi.mocked(open).mockImplementation(async (...args) => {
      handle = await actual.open(...args);
      const own = handle;
      handle.read = new Proxy(handle.read, { apply(target, _thisArg, readArgs) {
        return (Reflect.apply(target, own, readArgs) as Promise<{ bytesRead: number }>).then(async result => {
          if (!changed && result.bytesRead > 0) { changed = true; await fs.appendFile(path, "x"); }
          return result;
        });
      } });
      return handle;
    });
    await expect(readIndexedSource(path, options(1024))).rejects.toMatchObject({ code: "SOURCE_CHANGED" });
    expect(handle?.fd).toBe(-1);
  });

  it("honours cancellation and closes the real handle", async () => {
    const path = join(root, "cancel.ts"); await fs.writeFile(path, "a".repeat(128 * 1024));
    const controller = new AbortController();
    let handle: Awaited<ReturnType<typeof actual.open>> | undefined;
    vi.mocked(open).mockImplementation(async (...args) => {
      handle = await actual.open(...args);
      const own = handle;
      handle.read = new Proxy(handle.read, { apply(target, _thisArg, readArgs) {
        return (Reflect.apply(target, own, readArgs) as Promise<{ bytesRead: number }>).then(result => {
          if (result.bytesRead > 0) controller.abort();
          return result;
        });
      } });
      return handle;
    });
    const failure = await readIndexedSource(path, options(256 * 1024, controller.signal)).catch(error => error);
    expect(failure).toBe(controller.signal.reason);
    expect(controller.signal.aborted).toBe(true);
    expect(handle?.fd).toBe(-1);
  });

  it("rejects an external path and a directory symlink before opening either file", async () => {
    const outside = await fs.mkdtemp(join(tmpdir(), "indexed-reader-outside-"));
    try {
      await fs.writeFile(join(outside, "secret.ts"), "secret");
      await fs.symlink(outside, join(root, "link"), process.platform === "win32" ? "junction" : "dir");
      await expect(readIndexedSource(join(outside, "secret.ts"), options(1024))).rejects.toBeInstanceOf(IndexedSourceError);
      await expect(readIndexedSource(join(root, "link", "secret.ts"), options(1024))).rejects.toMatchObject({ code: "SOURCE_CHANGED" });
      expect(open).not.toHaveBeenCalled();
    } finally { await fs.rm(outside, { recursive: true, force: true }); }
  });

  it("does not return outside content when a parent directory is swapped before open", async () => {
    const outside = await fs.mkdtemp(join(tmpdir(), "indexed-reader-swap-"));
    try {
      await fs.mkdir(join(root, "sub"));
      await fs.writeFile(join(root, "sub", "source.ts"), "inside");
      await fs.writeFile(join(outside, "source.ts"), "outside-secret");
      let swapped = false;
      vi.mocked(open).mockImplementation(async (...args) => {
        if (!swapped) {
          swapped = true;
          await fs.rename(join(root, "sub"), join(root, "old-sub"));
          await fs.symlink(outside, join(root, "sub"), process.platform === "win32" ? "junction" : "dir");
        }
        return actual.open(...args);
      });
      await expect(readIndexedSource(join(root, "sub", "source.ts"), options(1024))).rejects.toMatchObject({ code: "SOURCE_CHANGED" });
      expect(swapped).toBe(true);
    } finally { await fs.rm(outside, { recursive: true, force: true }); }
  });

  it("allows an empty file at limit zero and rejects a nonempty file", async () => {
    const path = join(root, "empty.ts"); await fs.writeFile(path, "");
    expect(await readIndexedSource(path, options(0))).toBe("");
    await fs.writeFile(path, "a");
    await expect(readIndexedSource(path, options(0))).rejects.toMatchObject({ code: "SOURCE_TOO_LARGE" });
  });
});
