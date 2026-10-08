import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { newAgentId, newSessionId, newToolCallId, newTurnId, type ToolExecutionContext } from "@ar/contracts";
import { createHash } from "node:crypto";
import { ToolRegistry } from "./registry.js";
import { ToolOrchestrator } from "./orchestrator.js";
import { createProductionTools } from "./production-tools.js";
import { readWindow } from "./read-window.js";
import { MAX_FULL_READ_BYTES } from "./tools/read-file.js";
import { indexedSymbolSearch } from "./symbol-index.js";

let root: string;
let orch: ToolOrchestrator;
beforeEach(async () => {
  root = await fs.mkdtemp(join(tmpdir(), "ar-gen1-text-"));
  const registry = new ToolRegistry();
  for (const t of createProductionTools({ networkMode: "deny", availableTools: () => registry.names() })) registry.register(t);
  orch = new ToolOrchestrator({ registry, workspaceRoot: root });
});
afterEach(async () => { vi.restoreAllMocks(); syncBuiltinESMExports(); await fs.rm(root, { recursive: true, force: true }); });
async function invoke(name: string, args: Record<string, unknown>, signal = new AbortController().signal, deny = false) {
  syncBuiltinESMExports();
  const id = newToolCallId();
  const ctx: ToolExecutionContext = {
    cwd: root, sessionId: newSessionId(), turnId: newTurnId(), agentId: newAgentId(), signal,
    permissions: { rules: [{ action: "read", resource: "file", effect: deny ? "deny" : "allow" }] },
    sandboxPolicy: { filesystem: { mode: "workspace-write" }, network: { mode: "deny" }, process: { maxOutputBytes: 65536 } },
  };
  return orch.execute({ id, sessionId: ctx.sessionId, turnId: ctx.turnId, agentId: ctx.agentId, call: { id, name, args } }, ctx);
}

describe("Gen1 text tools correctness", () => {
  it("searches a selected Unicode filename instead of silently listing it as a directory", async () => {
    await fs.writeFile(join(root, "代码.ts"), "needle\r\nother\r\n");
    const r = await invoke("grep_search", { path: "代码.ts", pattern: "needle" });
    expect(r.status).toBe("success");
    expect(r.output).toEqual([{ file: "代码.ts", line: 1, column: 1, text: "needle\r" }]);
  });
  it("finds a real match beyond the previous 2000 character line boundary", async () => {
    await fs.writeFile(join(root, "wide.txt"), "x".repeat(2100) + "needle\n");
    const r = await invoke("grep_search", { pattern: "needle" });
    expect(r.output).toEqual([expect.objectContaining({ file: "wide.txt", line: 1, column: 2101 })]);
    expect(r.metadata).toMatchObject({ truncatedLines: 1 });
  });
  it("reports oversized skipped files rather than claiming a complete zero-match scan", async () => {
    await fs.writeFile(join(root, "large.txt"), "x".repeat(512 * 1024 + 1) + "needle");
    const r = await invoke("grep_search", { pattern: "needle" });
    expect(r.status).toBe("failed");
    expect(r.error?.message).toContain("SCAN_INCOMPLETE");
    expect(r.metadata).toMatchObject({ complete: false, skippedOversizedFiles: 1 });
  });
  it("reads the requested page and hashes the complete original CRLF/Unicode bytes", async () => {
    const bytes = Buffer.from("\ufeff中文\r\nsecond\r\n第三行\n");
    await fs.writeFile(join(root, "page.txt"), bytes);
    const r = await invoke("read_file", { path: "page.txt", offset: 2, limit: 1, versioned: true });
    expect(r.status).toBe("success");
    expect(r.output).toMatchObject({ content: "second\r", startLine: 2, endLine: 2, totalLines: 3, nextOffset: 3, truncated: true, bytes: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex") });
  });
  it("rejects invalid pagination rather than silently ignoring unknown arguments", async () => {
    await fs.writeFile(join(root, "page.txt"), "ok");
    const r = await invoke("read_file", { path: "page.txt", offset: 0 });
    expect(r.status).toBe("failed");
    expect(r.error?.code).toBe("TOOL_SCHEMA_ERROR");
  });
  it("does not keep traversing sibling files after a grep cancellation", async () => {
    await fs.mkdir(join(root, "a")); await fs.mkdir(join(root, "b"));
    await fs.writeFile(join(root, "a", "one.txt"), "needle");
    await fs.writeFile(join(root, "b", "two.txt"), "needle");
    const ac = new AbortController(); const actual = fs.readFile.bind(fs);
    const reads = vi.spyOn(fs, "readFile").mockImplementation((async (...args: Parameters<typeof fs.readFile>) => {
      const out = await actual(...args); ac.abort(); return out;
    }) as typeof fs.readFile);
    const r = await invoke("grep_search", { pattern: "needle" }, ac.signal);
    expect(r.status).toBe("cancelled"); expect(r.evidence).toBeUndefined();
    expect(reads).toHaveBeenCalledTimes(1);
  });
  it("exposes incomplete scans in a JSON-serializable opt-in envelope", async () => {
    await fs.writeFile(join(root, "large.txt"), "x".repeat(512 * 1024 + 1));
    const r = await invoke("grep_search", { pattern: "needle", includeSummary: true });
    expect(r.status).toBe("success");
    expect(JSON.parse(JSON.stringify(r.output))).toMatchObject({ summary: { complete: false, skippedOversizedFiles: 1 }, hits: [] });
    expect(Object.keys(r.output as object)[0]).toBe("summary");
  });
  it("keeps a complete zero-match scan separate from a capped positive scan", async () => {
    await fs.writeFile(join(root, "ok.txt"), "needle\nneedle\n");
    const zero = await invoke("grep_search", { pattern: "absent", includeSummary: true });
    expect(zero.output).toMatchObject({ summary: { complete: true, limitReached: false }, hits: [] });
    const capped = await invoke("grep_search", { pattern: "needle", maxResults: 1, includeSummary: true });
    expect(capped.output).toMatchObject({ summary: { complete: false, limitReached: true }, hits: [expect.objectContaining({ line: 1 })] });
  });
  it("searches exact source strings containing invalid regex syntax", async () => {
    await fs.writeFile(join(root, "literal.ts"), "array[0] = ([value]);\n");
    const r = await invoke("grep_search", { pattern: "([value]", literal: true });
    expect(r.status).toBe("success");
    expect(r.output).toEqual([expect.objectContaining({ column: 12, text: "array[0] = ([value]);" })]);
  });
  it.each([{ name: "empty", content: "" }, { name: "empty line", content: "\n" }, { name: "terminal LF", content: "a\n" },
    { name: "Unicode CRLF", content: "中文\r\nb\r\n" }, { name: "split UTF8/CRLF chunk", content: "x".repeat(65535) + "中\r\nsecond\n" }]) (
    "matches a whole-snapshot reference: $name", async ({ content }) => {
      await fs.writeFile(join(root, "chunks.txt"), content);
      const r = await invoke("read_file", { path: "chunks.txt", offset: 1, limit: 2, maxBytes: 1048576, versioned: true });
      expect(r.status).toBe("success");
      expect(r.output).toMatchObject(readWindow(content, 1, 2, 1048576));
      expect(r.output).toMatchObject({ bytes: Buffer.byteLength(content), sha256: createHash("sha256").update(content).digest("hex") });
    });
  it("bounds a giant newline-free page without buffering it or looping the same offset", async () => {
    await fs.writeFile(join(root, "giant.txt"), Buffer.alloc(2 * 1024 * 1024, 97));
    const actual = fs.open.bind(fs);
    let wholeRead: ReturnType<typeof vi.spyOn> | undefined;
    let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
    vi.spyOn(fs, "open").mockImplementation(async (...args) => {
      handle = await actual(...args); wholeRead = vi.spyOn(handle, "readFile"); return handle;
    });
    const r = await invoke("read_file", { path: "giant.txt", limit: 1, maxBytes: 1000, versioned: true });
    expect(r.status).toBe("success");
    expect(r.output).toMatchObject({ content: "", totalLines: 1, firstLineExceedsLimit: true, truncated: true, bytes: 2 * 1024 * 1024 });
    expect(r.output).not.toHaveProperty("nextOffset");
    expect(wholeRead).not.toHaveBeenCalled(); expect(handle?.fd).toBe(-1);
  });
  it("rejects an oversized sparse full read before allocating the file", async () => {
    const sparse = await fs.open(join(root, "sparse.txt"), "w");
    await sparse.truncate(MAX_FULL_READ_BYTES + 1); await sparse.close();
    const actual = fs.open.bind(fs); let full: ReturnType<typeof vi.spyOn> | undefined;
    let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
    vi.spyOn(fs, "open").mockImplementation(async (...args) => {
      handle = await actual(...args); full = vi.spyOn(handle, "readFile"); return handle;
    });
    const r = await invoke("read_file", { path: "sparse.txt", versioned: true });
    expect(r.status).toBe("failed"); expect(r.error?.message).toContain("READ_FILE_TOO_LARGE");
    expect(r.error?.message).toContain("offset/limit"); expect(full).not.toHaveBeenCalled(); expect(handle?.fd).toBe(-1);
  });
  it("actually cancels malicious grep regex through the orchestrator without freezing timers", async () => {
    await fs.writeFile(join(root, "regex.txt"), "a".repeat(60) + "!");
    const ac = new AbortController(); let timerFired = false;
    const timer = setTimeout(() => { timerFired = true; ac.abort(); }, 150);
    try {
      const r = await invoke("grep_search", { pattern: "(a+)+$", includeSummary: true }, ac.signal);
      expect(r.status).toBe("cancelled"); expect(r.output).toBeUndefined(); expect(timerFired).toBe(true);
    } finally { clearTimeout(timer); }
  });
  it("cancels expensive heuristic method scanning without freezing the main event loop", async () => {
    await fs.writeFile(join(root, "methods.py"), "a(".repeat(200000));
    const ac = new AbortController(); let timerFired = false;
    const timer = setTimeout(() => { timerFired = true; ac.abort(); }, 150);
    try {
      const r = await invoke("symbol_search", { symbol: "a" }, ac.signal);
      expect(r.status).toBe("cancelled"); expect(r.output).toBeUndefined(); expect(timerFired).toBe(true);
    } finally { clearTimeout(timer); }
  });
  it.each([{ kind: "import", text: "import " + "a ".repeat(100000) }, { kind: "export", text: "export {a ".repeat(40000) }]) (
    "handles the actual malformed $kind ReDoS fixture with a linear classifier", async ({ text }) => {
    await fs.writeFile(join(root, "imports.ts"), text);
    const start = performance.now();
    const r = await indexedSymbolSearch({ root, symbol: "a" });
    expect(performance.now() - start).toBeLessThan(1500);
    expect(r.hits).toHaveLength(1); expect(r.hits[0]?.role).toBe("reference");
  });
  it("retains the existing real named-export role", async () => {
    await fs.writeFile(join(root, "exports.ts"), "export { NAME };\n");
    const r = await indexedSymbolSearch({ root, symbol: "NAME" });
    expect(r.hits[0]).toMatchObject({ role: "export", kind: "export", name: "NAME" });
  });
  it.each([
    { line: "import NAME from './a';", symbol: "NAME" },
    { line: "import type NAME from './a';", symbol: "NAME" },
    { line: "import { NAME } from './a';", symbol: "NAME" },
    { line: "import { VALUE as NAME } from './a';", symbol: "NAME" },
    { line: "import * as NAME from './a';", symbol: "NAME" },
  ])("classifies a real import without backtracking: $line", async ({ line, symbol }) => {
    await fs.writeFile(join(root, "imports.ts"), line);
    const r = await indexedSymbolSearch({ root, symbol });
    expect(r.hits[0]).toMatchObject({ role: "import", kind: "import", name: symbol });
  });
  it("retains full legacy outputs when pagination is omitted", async () => {
    const text = "\ufeff中文\r\nbody\n";
    await fs.writeFile(join(root, "old.txt"), text);
    expect((await invoke("read_file", { path: "old.txt" })).output).toBe(text);
    expect((await invoke("read_file", { path: "old.txt", versioned: true })).output).toEqual({
      path: join(root, "old.txt"), content: text, sha256: createHash("sha256").update(text).digest("hex"), bytes: Buffer.byteLength(text),
    });
  });
  it("keeps raw whole-file SHA and page continuation before page content", async () => {
    await fs.writeFile(join(root, "order.txt"), "one\ntwo\nthree\n");
    const r = await invoke("read_file", { path: "order.txt", limit: 1, versioned: true });
    const keys = Object.keys(r.output as object);
    expect(keys.indexOf("sha256")).toBeLessThan(keys.indexOf("content"));
    expect(keys.indexOf("nextOffset")).toBeLessThan(keys.indexOf("content"));
  });
  it.each([{ offset: 0 }, { offset: -1 }, { offset: 1.5 }, { limit: 0 }, { limit: 2001 }, { maxBytes: 0 }, { maxBytes: 1048577 }]) (
    "rejects invalid pagination before opening a descriptor: %j", async args => {
      const open = vi.spyOn(fs, "open");
      const r = await invoke("read_file", { path: "anything", ...args });
      expect(r.status).toBe("failed"); expect(r.error?.code).toBe("TOOL_SCHEMA_ERROR"); expect(open).not.toHaveBeenCalled();
    });
  it.each(["read_file", "grep_search"]) (
    "enforces permission before %s I/O with new arguments", async name => {
      const open = vi.spyOn(fs, "open"), read = vi.spyOn(fs, "readFile"), stat = vi.spyOn(fs, "lstat");
      const r = await invoke(name, name === "read_file" ? { path: "blocked", offset: 1 } : { path: "blocked", pattern: "x", includeSummary: true }, undefined, true);
      expect(r.status).toBe("denied"); expect(open).not.toHaveBeenCalled(); expect(read).not.toHaveBeenCalled(); expect(stat).not.toHaveBeenCalled();
    });
  it("reports cancellation during a paged descriptor read and closes it", async () => {
    await fs.writeFile(join(root, "cancel.txt"), "one\ntwo\n");
    const ac = new AbortController(), actual = fs.open.bind(fs);
    let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
    vi.spyOn(fs, "open").mockImplementation(async (...args) => {
      const owned = await actual(...args); handle = owned; const read = owned.read.bind(owned);
      vi.spyOn(owned, "read").mockImplementation(async (...args: Parameters<typeof owned.read>) => { const r = await read(...args); ac.abort(); return r; });
      return owned;
    });
    const r = await invoke("read_file", { path: "cancel.txt", offset: 1 }, ac.signal);
    expect(r.status).toBe("cancelled"); expect(r.output).toBeUndefined(); expect(handle?.fd).toBe(-1);
  });
  it("stops repo_tree enumeration after cancellation", async () => {
    await fs.mkdir(join(root, "a")); await fs.mkdir(join(root, "b"));
    const ac = new AbortController(), actual = fs.readdir.bind(fs);
    const lists = vi.spyOn(fs, "readdir").mockImplementation((async (...args: Parameters<typeof fs.readdir>) => {
      const r = await actual(...args); ac.abort(); return r;
    }) as typeof fs.readdir);
    const r = await invoke("repo_tree", {}, ac.signal);
    expect(r.status).toBe("cancelled"); expect(lists).toHaveBeenCalledTimes(1);
  });
});
