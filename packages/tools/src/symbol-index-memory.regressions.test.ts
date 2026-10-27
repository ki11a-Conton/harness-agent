import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getSymbolIndex, indexedSymbolSearch } from "./symbol-index.js";
import { readIndexedSource } from "./indexed-source-reader.js";

vi.mock("./indexed-source-reader.js", async importOriginal => {
  const actual = await importOriginal<typeof import("./indexed-source-reader.js")>();
  return { ...actual, readIndexedSource: vi.fn(actual.readIndexedSource) };
});
const actual = await vi.importActual<typeof import("./indexed-source-reader.js")>("./indexed-source-reader.js");
let root: string;
beforeEach(async () => {
  root = await fs.mkdtemp(join(tmpdir(), "symbol-cache-budget-"));
  vi.mocked(readIndexedSource).mockReset().mockImplementation(actual.readIndexedSource);
});
afterEach(async () => { vi.restoreAllMocks(); await fs.rm(root, { recursive: true, force: true }); });
function deferred() {
  let release!: () => void;
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
}

describe("bounded lexical index caching", () => {
  it("evicts old scopes by content weight before the 64-entry count limit", async () => {
    const content = "x".repeat(1500 * 1024);
    for (let i = 0; i < 12; i++) {
      const scope = `scope-${String(i).padStart(2, "0")}`;
      await fs.mkdir(join(root, scope));
      await fs.writeFile(join(root, scope, "source.ts"), content);
      await getSymbolIndex(root, scope);
    }
    expect(readIndexedSource).toHaveBeenCalledTimes(12);
    await getSymbolIndex(root, "scope-11");
    expect(readIndexedSource).toHaveBeenCalledTimes(12);
    await getSymbolIndex(root, "scope-00");
    expect(readIndexedSource).toHaveBeenCalledTimes(13);
  });

  it("reads uncached files on demand and preserves all hits and freshness", async () => {
    const content = "// filler line\n".repeat(220000) + "export const CacheNeedle = 1;\n";
    for (let i = 0; i < 3; i++) await fs.writeFile(join(root, `source-${i}.ts`), content);
    const index = await getSymbolIndex(root);
    expect([...index.files.values()].filter(file => file.content !== undefined)).toHaveLength(2);
    const lazy = [...index.files.values()].find(file => file.content === undefined)!;
    expect(lazy).toBeDefined();
    expect(readIndexedSource).toHaveBeenCalledTimes(2);
    const result = await indexedSymbolSearch({ root, symbol: "CacheNeedle" });
    expect(result.hits).toHaveLength(3);
    expect(result.complete).toBe(true);
    expect(result.lexicalSummary.scannedFiles).toBe(3);
    expect(readIndexedSource).toHaveBeenCalledTimes(3);
    await fs.writeFile(join(root, lazy.relPath), "export const UpdatedNeedle = 2;\n");
    const updated = await indexedSymbolSearch({ root, symbol: "UpdatedNeedle" });
    expect(updated.hits.map(hit => hit.file)).toEqual([lazy.relPath]);
    expect(updated.complete).toBe(true);
  });

  it("does not retain content that outgrew the cache budget after the outer stat", async () => {
    await fs.writeFile(join(root, "growing.ts"), "x");
    vi.mocked(readIndexedSource).mockResolvedValueOnce("x".repeat(8 * 1024 * 1024 + 1));
    const index = await getSymbolIndex(root);
    expect(index.files.get("growing.ts")?.content).toBeUndefined();
    expect(index.lexicalSummary.complete).toBe(true);
  });

  it("shares an on-demand large-file read without letting one cancelled caller stop its sibling", async () => {
    const body = "// filler\n".repeat(950000) + "export const SharedNeedle = 1;\n";
    await fs.writeFile(join(root, "large.ts"), body);
    expect((await getSymbolIndex(root)).files.get("large.ts")?.content).toBeUndefined();
    const started = deferred(), finish = deferred();
    vi.mocked(readIndexedSource).mockImplementationOnce(async (...args) => {
      const contents = await actual.readIndexedSource(...args); started.release(); await finish.promise; return contents;
    });
    const a = new AbortController(), b = new AbortController();
    const first = indexedSymbolSearch({ root, symbol: "SharedNeedle", signal: a.signal }).catch(error => error);
    await started.promise;
    const add = vi.spyOn(b.signal, "addEventListener");
    const second = indexedSymbolSearch({ root, symbol: "SharedNeedle", signal: b.signal });
    try {
      await vi.waitFor(() => expect(add.mock.calls.filter(([type]) => type === "abort")).toHaveLength(2), { timeout: 5000 });
      expect(readIndexedSource).toHaveBeenCalledTimes(1);
      const readerSignal = vi.mocked(readIndexedSource).mock.calls[0]![1].signal;
      a.abort(); expect(await first).toBe(a.signal.reason); expect(readerSignal.aborted).toBe(false);
      finish.release();
      expect((await second).hits.map(hit => hit.file)).toEqual(["large.ts"]);
    } finally { finish.release(); }
  });

  it("aborts the shared large-file read only after its last subscriber leaves", async () => {
    const body = "// filler\n".repeat(950000) + "export const SharedNeedle = 1;\n";
    await fs.writeFile(join(root, "large.ts"), body); await getSymbolIndex(root);
    const started = deferred(), finish = deferred();
    vi.mocked(readIndexedSource).mockImplementationOnce(async (...args) => {
      const contents = await actual.readIndexedSource(...args); started.release(); await finish.promise; return contents;
    });
    const a = new AbortController(), b = new AbortController();
    const first = indexedSymbolSearch({ root, symbol: "SharedNeedle", signal: a.signal }).catch(error => error);
    await started.promise;
    const add = vi.spyOn(b.signal, "addEventListener");
    const second = indexedSymbolSearch({ root, symbol: "SharedNeedle", signal: b.signal }).catch(error => error);
    try {
      await vi.waitFor(() => expect(add.mock.calls.filter(([type]) => type === "abort")).toHaveLength(2), { timeout: 5000 });
      const readerSignal = vi.mocked(readIndexedSource).mock.calls[0]![1].signal;
      a.abort(); expect(await first).toBe(a.signal.reason); expect(readerSignal.aborted).toBe(false);
      b.abort(); expect(await second).toBe(b.signal.reason); expect(readerSignal.aborted).toBe(true);
    } finally { finish.release(); }
    expect((await indexedSymbolSearch({ root, symbol: "SharedNeedle" })).hits.map(hit => hit.file)).toEqual(["large.ts"]);
    expect(readIndexedSource).toHaveBeenCalledTimes(2);
  });

  it("does not share an older large-file read after the source changes", async () => {
    const prefix = "// filler\n".repeat(950000);
    await fs.writeFile(join(root, "large.ts"), `${prefix}export const OldNeedle = 1;\n`);
    await getSymbolIndex(root);
    const started = deferred(), finish = deferred();
    vi.mocked(readIndexedSource).mockImplementationOnce(async (...args) => {
      const contents = await actual.readIndexedSource(...args); started.release(); await finish.promise; return contents;
    });
    const first = indexedSymbolSearch({ root, symbol: "OldNeedle" });
    await started.promise;
    try {
      await fs.writeFile(join(root, "large.ts"), `${prefix}export const NewLongerNeedle = 2;\n`);
      const second = await indexedSymbolSearch({ root, symbol: "NewLongerNeedle" });
      expect(second.hits.map(hit => hit.file)).toEqual(["large.ts"]);
      expect(readIndexedSource).toHaveBeenCalledTimes(2);
      finish.release(); expect((await first).hits.map(hit => hit.file)).toEqual(["large.ts"]);
    } finally { finish.release(); }
  });
});
