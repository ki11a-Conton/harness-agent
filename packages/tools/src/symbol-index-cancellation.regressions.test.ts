import { promises as fs } from "node:fs";
import { opendir, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate as yieldToEventLoop } from "node:timers/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ToolExecutionContext } from "@ar/contracts";
import { newAgentId, newSessionId, newToolCallId, newTurnId } from "@ar/contracts";
import { getSymbolIndex, indexedSymbolSearch } from "./symbol-index.js";
import { symbolSearchTool } from "./tools/navigation-tools.js";
import { ToolRegistry } from "./registry.js";
import { ToolOrchestrator } from "./orchestrator.js";
import { readIndexedSource as readFile } from "./indexed-source-reader.js";

vi.mock("node:fs/promises", async importOriginal => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, opendir: vi.fn(actual.opendir), stat: vi.fn(actual.stat) };
});
vi.mock("./indexed-source-reader.js", async importOriginal => {
  const actual = await importOriginal<typeof import("./indexed-source-reader.js")>();
  return { ...actual, readIndexedSource: vi.fn(actual.readIndexedSource) };
});
const actualFs = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
const actualReader = await vi.importActual<typeof import("./indexed-source-reader.js")>("./indexed-source-reader.js");
let root: string;
beforeEach(async () => {
  root = await fs.mkdtemp(join(tmpdir(), "ar-symbol-cancel-"));
  vi.mocked(readFile).mockReset().mockImplementation(actualReader.readIndexedSource);
  vi.mocked(opendir).mockReset().mockImplementation(actualFs.opendir);
  vi.mocked(stat).mockReset().mockImplementation(actualFs.stat);
});
afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(root, { recursive: true, force: true });
});
function deferred() {
  let release!: () => void;
  const promise = new Promise<void>(done => { release = done; });
  return { promise, release };
}
async function fixture(count = 12) {
  for (let i = 0; i < count; i++) await fs.writeFile(join(root, `source-${String(i).padStart(2, "0")}.ts`), `export const SharedSymbol = ${i};\n`);
}
function invoke(signal: AbortSignal) {
  const registry = new ToolRegistry(); registry.register(symbolSearchTool);
  const orch = new ToolOrchestrator({ registry, workspaceRoot: root });
  const ctx: ToolExecutionContext = {
    cwd: root, signal, sessionId: newSessionId(), turnId: newTurnId(), agentId: newAgentId(),
    permissions: { rules: [{ action: "read", resource: "file", pattern: "**/*", effect: "allow" }] },
    sandboxPolicy: { filesystem: { mode: "workspace-write", allowedPaths: [root] }, network: { mode: "deny" }, process: { timeoutMs: 10000 } },
  };
  return orch.execute({ id: newToolCallId(), sessionId: ctx.sessionId, turnId: ctx.turnId, agentId: ctx.agentId,
    call: { id: newToolCallId(), name: "symbol_search", args: { symbol: "SharedSymbol" } } }, ctx);
}

describe("Codex comparison: cancellable shared symbol indexing", () => {
  it("does zero indexing I/O for a pre-cancelled direct or orchestrated call", async () => {
    await fixture();
    const ac = new AbortController(), reason = new Error("user stopped"); ac.abort(reason);
    await expect(getSymbolIndex(root, ".", ac.signal)).rejects.toBe(reason);
    await expect(indexedSymbolSearch({ root, symbol: "SharedSymbol", signal: ac.signal })).rejects.toBe(reason);
    expect((await invoke(ac.signal)).status).toBe("cancelled");
    expect(readFile).not.toHaveBeenCalled(); expect(opendir).not.toHaveBeenCalled(); expect(stat).not.toHaveBeenCalled();
  });

  it("closes directory enumeration before reading sources when cancelled during opendir", async () => {
    await fixture();
    const ac = new AbortController(), reason = new Error("stop during enumeration");
    let close: ReturnType<typeof vi.spyOn> | undefined;
    vi.mocked(opendir).mockImplementationOnce(async (...args) => {
      const directory = await actualFs.opendir(...args); close = vi.spyOn(directory, "close"); ac.abort(reason); return directory;
    });
    await expect(getSymbolIndex(root, ".", ac.signal)).rejects.toBe(reason);
    await yieldToEventLoop();
    expect(readFile).not.toHaveBeenCalled(); expect(stat).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledOnce();
  });

  it("does not read a file after cancellation arrives during its stat", async () => {
    await fixture();
    const ac = new AbortController(), reason = new Error("stop during stat");
    vi.mocked(stat).mockImplementationOnce(async (...args) => {
      const result = await actualFs.stat(...args); ac.abort(reason); return result;
    });
    await expect(getSymbolIndex(root, ".", ac.signal)).rejects.toBe(reason);
    await yieldToEventLoop();
    expect(stat).toHaveBeenCalledTimes(1); expect(readFile).not.toHaveBeenCalled();
  });

  it("stops after one actual source read through the original permission/sandbox pipeline", async () => {
    await fixture();
    const ac = new AbortController();
    vi.mocked(readFile).mockImplementationOnce(async (...args) => {
      const contents = await actualReader.readIndexedSource(...args); ac.abort(); return contents;
    });
    expect((await invoke(ac.signal)).status).toBe("cancelled");
    await yieldToEventLoop();
    expect(readFile).toHaveBeenCalledTimes(1);
    const options = vi.mocked(readFile).mock.calls[0]?.[1] as { signal: AbortSignal };
    expect(options.signal.aborted).toBe(true);
    expect(options.signal).not.toBe(ac.signal); // the shared scan owns its own lifetime
  });

  it("does not cache the partial first file from a cancelled build", async () => {
    await fixture();
    const ac = new AbortController(), reason = new Error("stop after first source");
    vi.mocked(readFile).mockImplementationOnce(async (...args) => {
      const contents = await actualReader.readIndexedSource(...args); ac.abort(reason); return contents;
    });
    await expect(getSymbolIndex(root, ".", ac.signal)).rejects.toBe(reason);
    await yieldToEventLoop(); vi.mocked(readFile).mockClear();
    const result = await indexedSymbolSearch({ root, symbol: "SharedSymbol" });
    expect(result.hits).toHaveLength(12); expect(readFile).toHaveBeenCalledTimes(12);
  });

  it.each([true, false])("keeps a shared scan alive for a sibling with its own signal=%s", async siblingHasSignal => {
    await fixture();
    const started = deferred(), finish = deferred();
    vi.mocked(readFile).mockImplementationOnce(async (...args) => {
      const contents = await actualReader.readIndexedSource(...args); started.release(); await finish.promise; return contents;
    });
    const a = new AbortController(), b = new AbortController();
    const first = getSymbolIndex(root, ".", a.signal).catch(error => error);
    await started.promise;
    const add = vi.spyOn(b.signal, "addEventListener");
    const second = getSymbolIndex(root, ".", siblingHasSignal ? b.signal : undefined);
    if (siblingHasSignal) await vi.waitFor(() => expect(add).toHaveBeenCalledWith("abort", expect.any(Function), { once: true }));
    else await yieldToEventLoop();
    try {
      a.abort();
      expect(await first).toBe(a.signal.reason);
      const options = vi.mocked(readFile).mock.calls[0]?.[1] as { signal: AbortSignal };
      expect(options.signal.aborted).toBe(false);
      finish.release();
      expect((await second).filesIndexed).toBe(12);
      expect(readFile).toHaveBeenCalledTimes(12);
    } finally { finish.release(); }
  });

  it("cancels the underlying read only when both subscribed callers leave", async () => {
    await fixture();
    const started = deferred(), finish = deferred();
    vi.mocked(readFile).mockImplementationOnce(async (...args) => {
      const contents = await actualReader.readIndexedSource(...args); started.release(); await finish.promise; return contents;
    });
    const a = new AbortController(), b = new AbortController();
    const first = getSymbolIndex(root, ".", a.signal).catch(error => error);
    await started.promise;
    const add = vi.spyOn(b.signal, "addEventListener");
    const second = getSymbolIndex(root, ".", b.signal).catch(error => error);
    await vi.waitFor(() => expect(add).toHaveBeenCalled());
    try {
      a.abort(); expect(await first).toBe(a.signal.reason);
      const options = vi.mocked(readFile).mock.calls[0]?.[1] as { signal: AbortSignal };
      expect(options.signal.aborted).toBe(false);
      b.abort(); expect(await second).toBe(b.signal.reason); expect(options.signal.aborted).toBe(true);
    } finally { finish.release(); }
    await yieldToEventLoop(); expect(readFile).toHaveBeenCalledTimes(1);
  });

  it("lets a replacement flight survive an aborted old flight's finalizer", async () => {
    await fixture();
    const oldStarted = deferred(), oldFinish = deferred(), newStarted = deferred(), newFinish = deferred();
    vi.mocked(readFile).mockImplementationOnce(async (...args) => {
      const contents = await actualReader.readIndexedSource(...args); oldStarted.release(); await oldFinish.promise; return contents;
    }).mockImplementationOnce(async (...args) => {
      const contents = await actualReader.readIndexedSource(...args); newStarted.release(); await newFinish.promise; return contents;
    });
    const ac = new AbortController();
    const old = getSymbolIndex(root, ".", ac.signal).catch(error => error);
    await oldStarted.promise; ac.abort(); expect(await old).toBe(ac.signal.reason);
    const next = getSymbolIndex(root);
    try {
      await newStarted.promise;
      oldFinish.release(); await yieldToEventLoop();
      const sibling = getSymbolIndex(root); await yieldToEventLoop();
      expect(readFile).toHaveBeenCalledTimes(2); // replacement is still shared
      newFinish.release();
      const [a, b] = await Promise.all([next, sibling]);
      expect(a.files).toBe(b.files); expect(a.filesIndexed).toBe(12);
      expect(readFile).toHaveBeenCalledTimes(13);
    } finally { oldFinish.release(); newFinish.release(); }
  });

  it("preserves a complete warm cache when validation is cancelled", async () => {
    await fixture();
    const before = await getSymbolIndex(root); vi.mocked(readFile).mockClear();
    const ac = new AbortController(), reason = new Error("stop validating warm index");
    vi.mocked(stat).mockImplementationOnce(async (...args) => {
      const result = await actualFs.stat(...args); ac.abort(reason); return result;
    });
    await expect(getSymbolIndex(root, ".", ac.signal)).rejects.toBe(reason);
    await yieldToEventLoop();
    const after = await getSymbolIndex(root);
    expect(after.files.get("source-00.ts")).toBe(before.files.get("source-00.ts"));
    expect(after.filesIndexed).toBe(12); expect(readFile).not.toHaveBeenCalled();
  });

  it("yields during hot-index matching so a real timer can stop a long query", async () => {
    await fs.writeFile(join(root, "long.ts"), "// actual source line\n".repeat(199999) + "// actual source line");
    const index = await getSymbolIndex(root);
    expect(index.files.get("long.ts")?.content).toBeDefined();
    const ac = new AbortController(); let timer: ReturnType<typeof setTimeout> | undefined;
    vi.mocked(stat).mockImplementationOnce(async (...args) => {
      const result = await actualFs.stat(...args);
      timer = setTimeout(() => ac.abort(), 0);
      return result;
    });
    try {
      await expect(indexedSymbolSearch({ root, symbol: "not_present", signal: ac.signal })).rejects.toBeInstanceOf(DOMException);
      expect(ac.signal.aborted).toBe(true);
    } finally { if (timer) clearTimeout(timer); }
  });

  it("yields while scanning a giant single line so a real timer can stop the query", async () => {
    await fs.writeFile(join(root, "minified.ts"), "A".repeat(4 * 1024 * 1024));
    await getSymbolIndex(root);
    const ac = new AbortController(); let timer: ReturnType<typeof setTimeout> | undefined;
    vi.mocked(stat).mockImplementationOnce(async (...args) => {
      const result = await actualFs.stat(...args); timer = setTimeout(() => ac.abort(), 0); return result;
    });
    try {
      await expect(indexedSymbolSearch({ root, symbol: "not_present", signal: ac.signal })).rejects.toBeInstanceOf(DOMException);
      expect(ac.signal.aborted).toBe(true);
    } finally { if (timer) clearTimeout(timer); }
  });

  it("removes the subscriber abort listener after a successful shared scan", async () => {
    await fixture();
    const ac = new AbortController(), add = vi.spyOn(ac.signal, "addEventListener"), remove = vi.spyOn(ac.signal, "removeEventListener");
    const result = await indexedSymbolSearch({ root, symbol: "SharedSymbol", signal: ac.signal });
    expect(result.hits).toHaveLength(12);
    expect(add).toHaveBeenCalledTimes(1); expect(remove).toHaveBeenCalledWith("abort", add.mock.calls[0]![1]);
    ac.abort(); expect(result.hits).toHaveLength(12);
  });
});
