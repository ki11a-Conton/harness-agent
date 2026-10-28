import { promises as fs } from "node:fs";
import { open } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { buildSyntaxIndex, syntaxSymbolSearch } from "./syntax-index.js";

vi.mock("node:fs/promises", async importOriginal => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, open: vi.fn(actual.open) };
});
const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
let root: string;
let handles: Awaited<ReturnType<typeof actual.open>>[];
beforeEach(async () => {
  root = await fs.mkdtemp(join(tmpdir(), "syntax-short-read-")); handles = [];
  vi.mocked(open).mockReset().mockImplementation(actual.open);
});
afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 50 });
});

/** Every read still uses the actual FileHandle and OS; only its requested
 * length is limited to exercise Node's legal short-read contract. */
function shortReads(afterRead?: (path: string, bytes: number) => Promise<void> | void): void {
  vi.mocked(open).mockImplementation(async (...args) => {
    const handle = await actual.open(...args); handles.push(handle);
    handle.read = new Proxy(handle.read, { apply(target, _thisArg, readArgs) {
      readArgs[2] = Math.min(Number(readArgs[2]), 3);
      return (Reflect.apply(target, handle, readArgs) as Promise<{ bytesRead: number }>).then(async result => {
        await afterRead?.(String(args[0]), result.bytesRead); return result;
      });
    } });
    return handle;
  });
}

it("indexes the tail of a short-read UTF-8 source and hashes the entire raw file", async () => {
  const content = '// 中文😀\r\nexport function shortReadTail() { return 1; }\r\n';
  await fs.writeFile(join(root, "source.ts"), content); shortReads();
  const result = await syntaxSymbolSearch({ root, symbol: "shortReadTail" });
  expect(result.complete).toBe(true);
  expect(result.hits).toContainEqual(expect.objectContaining({ file: "source.ts", role: "definition", line: 2,
    sha256: createHash("sha256").update(content).digest("hex") }));
  expect(handles.length).toBeGreaterThan(0); expect(handles.every(handle => handle.fd === -1)).toBe(true);
});

it("applies .gitignore rules after the first short read instead of indexing ignored source", async () => {
  await fs.writeFile(join(root, ".gitignore"), "# comment before the rule\nsecret.ts\n");
  await fs.writeFile(join(root, "secret.ts"), "export function privateTail() {}\n");
  await fs.writeFile(join(root, "public.ts"), "export function publicTail() {}\n"); shortReads();
  const index = await buildSyntaxIndex(root);
  expect(index.complete).toBe(true); expect(index.files.map(file => file.file)).toEqual(["public.ts"]);
  expect(handles.every(handle => handle.fd === -1)).toBe(true);
});

it.each(["source.ts", ".gitignore"])("honors cancellation during a real short read of %s and closes the handle", async target => {
  await fs.writeFile(join(root, ".gitignore"), "# comment before the rule\nsecret.ts\n");
  await fs.writeFile(join(root, "source.ts"), "export function cancellationTail() {}\n");
  const controller = new AbortController(); let readsAfterAbort = 0;
  shortReads((path, bytes) => {
    if (controller.signal.aborted) readsAfterAbort++;
    if (basename(path) === target && bytes > 0) controller.abort(new Error("cancelled during native read"));
  });
  const failure = await buildSyntaxIndex(root, ".", controller.signal).then(() => undefined, error => error);
  expect(failure).toBe(controller.signal.reason);
  expect(controller.signal.aborted).toBe(true); expect(readsAfterAbort).toBe(0);
  expect(handles.every(handle => handle.fd === -1)).toBe(true);
});

it("does not publish an oversized growing source as a complete prefix", async () => {
  const path = join(root, "growing.ts"); await fs.writeFile(path, "// seed\n");
  let grew = false; let readBytes = 0;
  vi.mocked(open).mockImplementation(async (...args) => {
    const handle = await actual.open(...args); handles.push(handle);
    handle.read = new Proxy(handle.read, { apply(target, _thisArg, readArgs) {
      return (Reflect.apply(target, handle, readArgs) as Promise<{ bytesRead: number }>).then(async result => {
        readBytes += result.bytesRead;
        if (!grew && result.bytesRead) { grew = true; await fs.appendFile(path, "x".repeat(600 * 1024)); }
        return result;
      });
    } });
    return handle;
  });
  const index = await buildSyntaxIndex(root);
  expect(grew).toBe(true); expect(index.complete).toBe(false); expect(index.files).toEqual([]);
  expect(index.skippedFiles).toBe(1); expect(readBytes).toBeLessThanOrEqual(512 * 1024 + 1);
  expect(handles.every(handle => handle.fd === -1)).toBe(true);
});
