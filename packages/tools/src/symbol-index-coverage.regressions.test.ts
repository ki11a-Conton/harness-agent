import { promises as fs } from "node:fs";
import { opendir, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { newAgentId, newSessionId, newToolCallId, newTurnId, type ToolExecutionContext } from "@ar/contracts";
import { ToolOrchestrator } from "./orchestrator.js";
import { ToolRegistry } from "./registry.js";
import { symbolSearchTool } from "./tools/navigation-tools.js";
import { MAX_INDEXED_SOURCE_BYTES, readIndexedSource } from "./indexed-source-reader.js";

vi.mock("node:fs/promises", async importOriginal => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, opendir: vi.fn(actual.opendir), stat: vi.fn(actual.stat) };
});
vi.mock("./indexed-source-reader.js", async importOriginal => {
  const actual = await importOriginal<typeof import("./indexed-source-reader.js")>();
  return { ...actual, readIndexedSource: vi.fn(actual.readIndexedSource) };
});
const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
const actualReader = await vi.importActual<typeof import("./indexed-source-reader.js")>("./indexed-source-reader.js");
let root: string;
beforeEach(async () => {
  root = await fs.mkdtemp(join(tmpdir(), "symbol-coverage-"));
  vi.mocked(opendir).mockReset().mockImplementation(actual.opendir);
  vi.mocked(stat).mockReset().mockImplementation(actual.stat);
  vi.mocked(readIndexedSource).mockReset().mockImplementation(actualReader.readIndexedSource);
});
afterEach(async () => { vi.restoreAllMocks(); await fs.rm(root, { recursive: true, force: true }); });

async function run(args: Record<string, unknown>) {
  const context: ToolExecutionContext = { cwd: root, sessionId: newSessionId(), agentId: newAgentId(), turnId: newTurnId(),
    signal: new AbortController().signal, permissions: { rules: [], defaultEffect: "allow" },
    sandboxPolicy: { filesystem: { mode: "workspace-write" }, network: { mode: "deny" }, process: { timeoutMs: 10000 } } };
  const registry = new ToolRegistry(); registry.register(symbolSearchTool);
  const orch = new ToolOrchestrator({ registry, workspaceRoot: root });
  const result = await orch.execute({ id: newToolCallId(), sessionId: context.sessionId, agentId: context.agentId,
    turnId: context.turnId, call: { id: newToolCallId(), name: "symbol_search", args } }, context);
  expect(result.status, JSON.stringify(result.error)).toBe("success");
  return result.output as { complete?: boolean; hits: Array<{ file: string }>; lexicalSummary?: { unreadableDirectories?: number; unavailableScope?: boolean } };
}

describe("symbol index scan coverage is visible to the caller", () => {
  it("reports an unreadable indexed directory even when another TS file has a hit", async () => {
    await fs.writeFile(join(root, "visible.ts"), "export const SharedSymbol = 1;\n");
    await fs.mkdir(join(root, "blocked"));
    await fs.writeFile(join(root, "blocked", "private.ts"), "export const SharedSymbol = 2;\n");
    vi.mocked(opendir).mockImplementation((async (...args: Parameters<typeof actual.opendir>) => {
      if (String(args[0]) === join(root, "blocked")) throw Object.assign(new Error("access denied"), { code: "EACCES" });
      return actual.opendir(...args);
    }) as typeof actual.opendir);
    const result = await run({ symbol: "SharedSymbol" });
    expect(result.hits.map(hit => hit.file)).toContain("visible.ts");
    expect(result).toMatchObject({ complete: false, lexicalSummary: { unreadableDirectories: 1 } });
  });

  it("reports an unavailable selected scope as incomplete", async () => {
    const result = await run({ symbol: "SharedSymbol", path: "missing" });
    expect(result.hits).toEqual([]);
    expect(result).toMatchObject({ complete: false, lexicalSummary: { unavailableScope: true } });
  });

  it("retains the lexical warning when another language's fallback finds a hit", async () => {
    await fs.writeFile(join(root, "visible.ts"), "export const OtherSymbol = 1;\n");
    await fs.writeFile(join(root, "worker.py"), "def SharedSymbol():\n    return 1\n");
    await fs.mkdir(join(root, "blocked"));
    vi.mocked(opendir).mockImplementation((async (...args: Parameters<typeof actual.opendir>) => {
      if (String(args[0]) === join(root, "blocked")) throw Object.assign(new Error("access denied"), { code: "EACCES" });
      return actual.opendir(...args);
    }) as typeof actual.opendir);
    const result = await run({ symbol: "SharedSymbol" });
    expect(result.hits.map(hit => hit.file)).toContain("worker.py");
    expect(result).toMatchObject({ complete: false, lexicalSummary: { unreadableDirectories: 1 } });
  });

  it("reports a skipped oversized source even when a different file matched", async () => {
    await fs.writeFile(join(root, "visible.ts"), "export const SharedSymbol = 1;\n");
    const file = await fs.open(join(root, "large.ts"), "w");
    await file.truncate(MAX_INDEXED_SOURCE_BYTES + 1); await file.close();
    const result = await run({ symbol: "SharedSymbol" });
    expect(result.hits.map(hit => hit.file)).toContain("visible.ts");
    expect(result).toMatchObject({ complete: false, lexicalSummary: { skippedOversizedFiles: 1, maxFileBytes: MAX_INDEXED_SOURCE_BYTES } });
  });

  it("finds a huge-line hit while reporting that its analysis is incomplete", async () => {
    await fs.writeFile(join(root, "visible.ts"), "export const SharedSymbol = 1;\n");
    await fs.writeFile(join(root, "minified.ts"), `${"x".repeat(1024 * 1024 + 1)} SharedSymbol\n`);
    const result = await run({ symbol: "SharedSymbol" });
    expect(result.hits.map(hit => hit.file)).toContain("visible.ts");
    expect(result.hits.map(hit => hit.file)).toContain("minified.ts");
    expect(result).toMatchObject({ complete: false, lexicalSummary: { limitedLongLines: 1, maxLineChars: 1024 * 1024 } });
  });

  it("finds a huge-line match across a chunk boundary after expanding Unicode characters", async () => {
    await fs.writeFile(join(root, "minified.ts"), `${"İ".repeat(65530)}😀SharedSymbol${"x".repeat(1024 * 1024)}\n`);
    const result = await run({ symbol: "SharedSymbol" });
    expect(result).toMatchObject({ complete: false, lexicalSummary: { limitedLongLines: 1 },
      hits: [{ file: "minified.ts", line: 1, text: expect.stringContaining("SharedSymbol"), truncated: true }] });
  });

  it("stops a huge directory at the entry budget, closes it, and avoids an unbounded fallback", async () => {
    let visited = 0;
    const directory = {
      read: vi.fn(async () => ++visited <= 60_000 ? { name: `file-${visited}.txt`, isDirectory: () => false, isFile: () => true } : null),
      close: vi.fn(async () => {}),
    };
    vi.mocked(opendir).mockResolvedValue(directory as unknown as Awaited<ReturnType<typeof opendir>>);
    const fallbackWalk = vi.spyOn(fs, "readdir");
    const result = await run({ symbol: "MissingSymbol" });
    expect(result.hits).toEqual([]);
    expect(result).toMatchObject({ complete: false, supplementalSearch: "skipped_limit",
      lexicalSummary: { entryLimitReached: true, visitedEntries: 50_000, maxEntries: 50_000 } });
    expect(directory.read).toHaveBeenCalledTimes(50_001);
    expect(directory.close).toHaveBeenCalledOnce();
    expect(fallbackWalk).not.toHaveBeenCalled();
  });

  it("stops at the source-file budget without walking later entries", async () => {
    let visited = 0;
    const directory = {
      read: vi.fn(async () => ++visited <= 25_000 ? { name: `file-${visited}.ts`, isDirectory: () => false, isFile: () => true } : null),
      close: vi.fn(async () => {}),
    };
    vi.mocked(opendir).mockResolvedValue(directory as unknown as Awaited<ReturnType<typeof opendir>>);
    vi.mocked(stat).mockImplementation((async () => ({ isFile: () => true, size: 3, mtimeMs: 0 })) as unknown as typeof actual.stat);
    vi.mocked(readIndexedSource).mockResolvedValue("//\n");
    const fallbackWalk = vi.spyOn(fs, "readdir");
    const result = await run({ symbol: "MissingSymbol" });
    expect(result.hits).toEqual([]);
    expect(result).toMatchObject({ complete: false, supplementalSearch: "skipped_limit",
      lexicalSummary: { fileLimitReached: true, maxFiles: 20_000, scannedFiles: 20_000 } });
    expect(directory.read).toHaveBeenCalledTimes(20_000);
    expect(directory.close).toHaveBeenCalledOnce(); expect(fallbackWalk).not.toHaveBeenCalled();
  });

  it("bounds directory depth and closes every opened directory", async () => {
    let opened = 0, closed = 0;
    vi.mocked(opendir).mockImplementation(async () => {
      opened++;
      let read = false;
      return {
        async read() {
          if (read) return null;
          read = true; return { name: "d", isDirectory: () => true, isFile: () => false };
        },
        async close() { closed++; },
      } as unknown as Awaited<ReturnType<typeof opendir>>;
    });
    const result = await run({ symbol: "MissingSymbol" });
    expect(result).toMatchObject({ complete: false, supplementalSearch: "skipped_limit",
      lexicalSummary: { depthLimitReached: true, maxDepth: 128 } });
    expect(opened).toBe(129); expect(closed).toBe(opened);
  });
});
