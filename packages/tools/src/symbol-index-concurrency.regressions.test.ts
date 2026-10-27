import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { indexedSymbolSearch } from "./symbol-index.js";
import { readIndexedSource } from "./indexed-source-reader.js";

vi.mock("./indexed-source-reader.js", async importOriginal => {
  const actual = await importOriginal<typeof import("./indexed-source-reader.js")>();
  return { ...actual, readIndexedSource: vi.fn(actual.readIndexedSource) };
});
const actual = await vi.importActual<typeof import("./indexed-source-reader.js")>("./indexed-source-reader.js");
let root: string;
beforeEach(async () => {
  root = await fs.mkdtemp(join(tmpdir(), "symbol-read-slots-"));
  vi.mocked(readIndexedSource).mockReset().mockImplementation(actual.readIndexedSource);
});
afterEach(async () => { vi.restoreAllMocks(); await fs.rm(root, { recursive: true, force: true }); });
function deferred() {
  let release!: () => void;
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
}
async function fixture(size = 8 * 1024 * 1024 + 1) {
  for (let i = 0; i < 5; i++) {
    const file = await fs.open(join(root, `source-${i}.ts`), "w");
    await file.truncate(size); await file.close();
  }
}
function start(gates: ReturnType<typeof deferred>[], started: number[]) {
  vi.mocked(readIndexedSource).mockImplementation(async (path, options) => {
    const index = Number(basename(path).match(/source-(\d+)\.ts/)![1]);
    started.push(index); await gates[index]!.promise; options.signal.throwIfAborted();
    return `export const SharedNeedle = ${index};\n`;
  });
  const controllers = Array.from({ length: 5 }, () => new AbortController());
  const listeners = controllers.map(controller => vi.spyOn(controller.signal, "addEventListener"));
  const results = controllers.map((controller, index) => indexedSymbolSearch({ root, relPath: `source-${index}.ts`,
    symbol: "SharedNeedle", signal: controller.signal }).catch(error => error));
  return { controllers, listeners, results };
}

describe("large source read concurrency", () => {
  it("queues large sources by reserved bytes even when count slots are available", async () => {
    await fixture(21 * 1024 * 1024);
    const gates = Array.from({ length: 5 }, deferred), started: number[] = [];
    const { listeners, results } = start(gates, started);
    try {
      await vi.waitFor(() => expect(listeners.every(spy => spy.mock.calls.filter(([type]) => type === "abort").length >= 2)).toBe(true), { timeout: 5000 });
      expect(started).toHaveLength(1);
      gates[started[0]!]!.release();
      await vi.waitFor(() => expect(started).toHaveLength(2), { timeout: 5000 });
      for (const gate of gates) gate.release();
      expect((await Promise.all(results)).every(result => result.hits.length === 1)).toBe(true);
    } finally { for (const gate of gates) gate.release(); await Promise.allSettled(results); }
  });

  it("unblocks a smaller FIFO waiter when the larger head is cancelled", async () => {
    await fixture();
    await fs.truncate(join(root, "source-0.ts"), 24 * 1024 * 1024);
    await fs.truncate(join(root, "source-1.ts"), 17 * 1024 * 1024);
    const gates = Array.from({ length: 3 }, deferred), started: number[] = [];
    vi.mocked(readIndexedSource).mockImplementation(async (path, options) => {
      const index = Number(basename(path).match(/source-(\d+)\.ts/)![1]);
      started.push(index); await gates[index]!.promise; options.signal.throwIfAborted();
      return "export const SharedNeedle = 1;\n";
    });
    const results: Promise<unknown>[] = [];
    const begin = (index: number, controller = new AbortController()) => {
      const promise = indexedSymbolSearch({ root, relPath: `source-${index}.ts`, symbol: "SharedNeedle", signal: controller.signal }).catch(error => error);
      results.push(promise); return promise;
    };
    try {
      begin(0); await vi.waitFor(() => expect(started).toEqual([0]), { timeout: 5000 });
      const head = new AbortController(), tail = new AbortController();
      const headListener = vi.spyOn(head.signal, "addEventListener");
      const headResult = begin(1, head);
      await vi.waitFor(() => expect(headListener.mock.calls.filter(([type]) => type === "abort")).toHaveLength(2), { timeout: 5000 });
      const tailListener = vi.spyOn(tail.signal, "addEventListener");
      begin(2, tail);
      await vi.waitFor(() => expect(tailListener.mock.calls.filter(([type]) => type === "abort")).toHaveLength(2), { timeout: 5000 });
      expect(started).toEqual([0]);
      head.abort(); expect(await headResult).toBe(head.signal.reason);
      await vi.waitFor(() => expect(started).toEqual([0, 2]), { timeout: 5000 });
      for (const gate of gates) gate.release();
      const output = await Promise.all(results);
      expect(output[0]).toHaveProperty("hits.length", 1); expect(output[2]).toHaveProperty("hits.length", 1);
      expect((await begin(1)).hits).toHaveLength(1);
    } finally { for (const gate of gates) gate.release(); await Promise.allSettled(results); }
  });

  it("rejects a queued source that grows beyond its byte reservation and allows a fresh retry", async () => {
    await fixture(21 * 1024 * 1024);
    const started = deferred(), finish = deferred();
    vi.mocked(readIndexedSource).mockImplementation(async (path, options) => {
      if (basename(path) === "source-0.ts") {
        started.release(); await finish.promise; options.signal.throwIfAborted();
        return "export const SharedNeedle = 1;\n";
      }
      return actual.readIndexedSource(path, options);
    });
    const first = indexedSymbolSearch({ root, relPath: "source-0.ts", symbol: "SharedNeedle" });
    await started.promise;
    const controller = new AbortController(), listener = vi.spyOn(controller.signal, "addEventListener");
    const second = indexedSymbolSearch({ root, relPath: "source-1.ts", symbol: "SharedNeedle", signal: controller.signal });
    try {
      await vi.waitFor(() => expect(listener.mock.calls.filter(([type]) => type === "abort")).toHaveLength(2), { timeout: 5000 });
      expect(readIndexedSource).toHaveBeenCalledTimes(1);
      await fs.truncate(join(root, "source-1.ts"), 22 * 1024 * 1024);
      finish.release(); expect((await first).hits).toHaveLength(1);
      expect(await second).toMatchObject({ complete: false, lexicalSummary: { changedFiles: 1, skippedOversizedFiles: 0 } });
      await fs.writeFile(join(root, "source-1.ts"), "export const FreshNeedle = 1;\n");
      expect((await indexedSymbolSearch({ root, relPath: "source-1.ts", symbol: "FreshNeedle" })).hits).toHaveLength(1);
    } finally { finish.release(); await Promise.allSettled([first, second]); }
  });

  it("limits simultaneous distinct large reads and starts the next when a scan finishes", async () => {
    await fixture(); const gates = Array.from({ length: 5 }, deferred), started: number[] = [];
    const { listeners, results } = start(gates, started);
    try {
      await vi.waitFor(() => expect(listeners.every(spy => spy.mock.calls.filter(([type]) => type === "abort").length >= 2)).toBe(true), { timeout: 5000 });
      expect(started).toHaveLength(4);
      gates[started[0]!]!.release();
      await vi.waitFor(() => expect(started).toHaveLength(5), { timeout: 5000 });
      for (const gate of gates) gate.release();
      const output = await Promise.all(results);
      expect(output.every(result => Array.isArray(result.hits) && result.hits.length === 1)).toBe(true);
    } finally { for (const gate of gates) gate.release(); await Promise.allSettled(results); }
  });

  it("removes a cancelled queued read without interrupting the active reads", async () => {
    await fixture(); const gates = Array.from({ length: 5 }, deferred), started: number[] = [];
    const { controllers, listeners, results } = start(gates, started);
    try {
      await vi.waitFor(() => expect(listeners.every(spy => spy.mock.calls.filter(([type]) => type === "abort").length >= 2)).toBe(true), { timeout: 5000 });
      expect(started).toHaveLength(4);
      const queued = [0, 1, 2, 3, 4].find(index => !started.includes(index))!;
      controllers[queued]!.abort(); expect(await results[queued]).toBe(controllers[queued]!.signal.reason);
      for (const gate of gates) gate.release();
      const output = await Promise.all(results);
      expect(started).toHaveLength(4);
      expect(output.filter((_, index) => index !== queued).every(result => result.hits.length === 1)).toBe(true);
      const resumed = await indexedSymbolSearch({ root, relPath: `source-${queued}.ts`, symbol: "SharedNeedle" });
      expect(resumed.hits).toHaveLength(1); expect(started).toHaveLength(5);
    } finally { for (const gate of gates) gate.release(); await Promise.allSettled(results); }
  });

  it("releases slots after failed reads so later searches can proceed", async () => {
    await fixture();
    vi.mocked(readIndexedSource).mockImplementation(async path => {
      if (!String(path).endsWith("source-4.ts")) throw Object.assign(new Error("unreadable"), { code: "EACCES" });
      return "export const SharedNeedle = 1;\n";
    });
    for (let i = 0; i < 4; i++) {
      const failed = await indexedSymbolSearch({ root, relPath: `source-${i}.ts`, symbol: "SharedNeedle" });
      expect(failed).toMatchObject({ complete: false, lexicalSummary: { unreadableFiles: 1 } });
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const result = await Promise.race([
        indexedSymbolSearch({ root, relPath: "source-4.ts", symbol: "SharedNeedle" }),
        new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("read slots were not released")), 10000); }),
      ]);
      expect(result.hits).toHaveLength(1);
    } finally { if (timer) clearTimeout(timer); }
  });
});
