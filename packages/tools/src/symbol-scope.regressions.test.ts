import { promises as fs } from "node:fs";
import { readFile, readdir, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ToolExecutionContext } from "@ar/contracts";
import { newAgentId, newSessionId, newToolCallId, newTurnId } from "@ar/contracts";
import { ToolOrchestrator } from "./orchestrator.js";
import { ToolRegistry } from "./registry.js";
import { indexedSymbolSearch } from "./symbol-index.js";
import { symbolSearchTool } from "./tools/navigation-tools.js";

vi.mock("node:fs/promises", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:fs/promises")>();
  return { ...original, readFile: vi.fn(original.readFile), readdir: vi.fn(original.readdir), stat: vi.fn(original.stat) };
});
const actualFs = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
let root: string;
let fallbackRead: ReturnType<typeof vi.spyOn>;
let fallbackList: ReturnType<typeof vi.spyOn>;
let fallbackStat: ReturnType<typeof vi.spyOn>;

beforeEach(async () => {
  root = await fs.mkdtemp(join(tmpdir(), "ar-symbol-scope-"));
  vi.mocked(readFile).mockReset().mockImplementation(actualFs.readFile);
  vi.mocked(readdir).mockReset().mockImplementation(actualFs.readdir);
  vi.mocked(stat).mockReset().mockImplementation(actualFs.stat);
  fallbackRead = vi.spyOn(fs, "readFile");
  fallbackList = vi.spyOn(fs, "readdir");
  fallbackStat = vi.spyOn(fs, "stat");
});
afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(root, { recursive: true, force: true });
});

async function write(path: string, body: string): Promise<void> {
  await fs.mkdir(dirname(join(root, path)), { recursive: true });
  await fs.writeFile(join(root, path), body);
}
async function fixture(): Promise<void> {
  await write("ts/a.ts", "export function TsOnly() {}\nexport const SharedSymbol = 1;\n");
  await write("ts/b.ts", "export const SiblingOnly = 1;\n");
  await write("tsx/a.ts", "export const PrefixOnly = 1;\n");
  await write("py/logic.py", "def PyOnly():\n    return 1\n\ndef SharedSymbol():\n    return 2\n");
  await write("private/secret.ts", "export const OffScope = 1;\n");
}
function context(): ToolExecutionContext {
  return { cwd: root, sessionId: newSessionId(), agentId: newAgentId(), turnId: newTurnId(), signal: new AbortController().signal,
    permissions: { rules: [], defaultEffect: "allow" },
    sandboxPolicy: { filesystem: { mode: "workspace-write" }, network: { mode: "deny" }, process: { timeoutMs: 5000, maxOutputBytes: 65536 } } };
}
function orchestrator() {
  const registry = new ToolRegistry(); registry.register(symbolSearchTool);
  return new ToolOrchestrator({ registry, workspaceRoot: root });
}
async function run(args: Record<string, unknown>, ctx = context(), orch = orchestrator()) {
  return orch.execute({ id: newToolCallId(), sessionId: ctx.sessionId, agentId: ctx.agentId, turnId: ctx.turnId,
    call: { id: newToolCallId(), name: "symbol_search", args } }, ctx);
}
function paths(): string[] {
  return [...vi.mocked(readFile).mock.calls, ...vi.mocked(readdir).mock.calls, ...vi.mocked(stat).mock.calls,
    ...fallbackRead.mock.calls, ...fallbackList.mock.calls, ...fallbackStat.mock.calls].map(([path]) => resolve(String(path)));
}
function expectScope(scope: string): void {
  const selected = join(root, scope);
  expect(paths().every((path) => path === selected || path.startsWith(`${selected}/`) || path.startsWith(`${selected}\\`)), paths().join("\n")).toBe(true);
}
function clearIO(): void {
  vi.mocked(readFile).mockClear(); vi.mocked(readdir).mockClear(); vi.mocked(stat).mockClear();
  fallbackRead.mockClear(); fallbackList.mockClear(); fallbackStat.mockClear();
}
function output(result: Awaited<ReturnType<typeof run>>) {
  expect(result.status, JSON.stringify(result.error)).toBe("success");
  return result.output as { fallback: boolean; hits: Array<{ file: string; name: string; kind: string; text: string }> };
}

describe("symbol search: actual approved scope, mixed languages and isolated caches", () => {
  it("only lists, stats and reads the selected TS directory on a cold query", async () => {
    await fixture();
    expect(output(await run({ symbol: "TsOnly", path: "ts" })).hits.map((h) => h.file)).toEqual(["ts/a.ts"]);
    expectScope("ts");
  });
  it("only stats and reads the selected TS file rather than its siblings", async () => {
    await fixture();
    expect(output(await run({ symbol: "TsOnly", path: "ts/a.ts" })).hits.map((h) => h.file)).toEqual(["ts/a.ts"]);
    expectScope("ts/a.ts");
  });
  it("uses the existing fallback for a Python-only directory in a mixed repository", async () => {
    await fixture();
    expect(output(await run({ symbol: "PyOnly", path: "py" }))).toMatchObject({ fallback: true, hits: [{ file: "py/logic.py", name: "PyOnly", kind: "def" }] });
    expectScope("py");
  });
  it("uses the existing fallback for a selected Python file", async () => {
    await fixture();
    expect(output(await run({ symbol: "PyOnly", path: "py/logic.py" }))).toMatchObject({ fallback: true, hits: [{ file: "py/logic.py", name: "PyOnly", kind: "def" }] });
    expectScope("py/logic.py");
  });
  it("recovers Python when the root's TS/JS index has no query hit", async () => {
    await fixture();
    expect(output(await run({ symbol: "PyOnly" }))).toMatchObject({ fallback: true, hits: [{ file: "py/logic.py", name: "PyOnly", kind: "def" }] });
  });
  it("retains indexed hits as the priority without merging Python definitions", async () => {
    await fixture();
    expect(output(await run({ symbol: "SharedSymbol" }))).toMatchObject({ fallback: false, hits: [{ file: "ts/a.ts", name: "SharedSymbol", kind: "const" }] });
  });
  it.each(["ts", "ts/a.ts"])("gives identical root-relative hits for absolute and relative TS scope %s", async (scope) => {
    await fixture();
    const relative = output(await run({ symbol: "TsOnly", path: scope }));
    clearIO();
    expect(output(await run({ symbol: "TsOnly", path: join(root, scope) })).hits).toEqual(relative.hits);
    expectScope(scope);
  });
  it.each(["py", "py/logic.py"])("gives identical root-relative hits for absolute and relative Python scope %s", async (scope) => {
    await fixture();
    const relative = output(await run({ symbol: "PyOnly", path: scope }));
    expect(relative.hits).not.toHaveLength(0);
    clearIO();
    expect(output(await run({ symbol: "PyOnly", path: join(root, scope) })).hits).toEqual(relative.hits);
    expectScope(scope);
  });
  it("normalizes aliases and retains directory boundaries", async () => {
    await fixture();
    expect(output(await run({ symbol: "TsOnly", path: "./ts/../ts/" })).hits).toHaveLength(1);
    expectScope("ts");
    clearIO();
    expect(output(await run({ symbol: "PrefixOnly", path: "ts" })).hits).toEqual([]);
    expectScope("ts");
  });
  it("reuses unchanged scoped contents on warm validation without accessing other scopes", async () => {
    await fixture();
    await run({ symbol: "TsOnly", path: "ts" });
    clearIO();
    expect(output(await run({ symbol: "TsOnly", path: "ts" })).hits).toHaveLength(1);
    expect(readFile).not.toHaveBeenCalled(); expect(fallbackRead).not.toHaveBeenCalled();
    expectScope("ts");
  });
  it("keeps root and selected-scope caches isolated across root -> file -> directory queries", async () => {
    await fixture();
    await run({ symbol: "TsOnly" });
    clearIO();
    expect(output(await run({ symbol: "TsOnly", path: "ts/a.ts" })).hits).toHaveLength(1);
    expectScope("ts/a.ts");
    clearIO();
    expect(output(await run({ symbol: "TsOnly", path: "ts" })).hits).toHaveLength(1);
    expectScope("ts");
  });
  it("coalesces concurrent queries of the same normalized scope", async () => {
    await fixture();
    const results = await Promise.all(Array.from({ length: 16 }, (_, i) => run({ symbol: "TsOnly", path: i % 2 ? join(root, "ts") : "./ts/" })));
    expect(results.every((r) => output(r).hits.length === 1)).toBe(true);
    expect(readFile).toHaveBeenCalledTimes(2);
    expectScope("ts");
  });
  it("does not share a flight or cached file set between concurrent different scopes", async () => {
    await fixture();
    const [a, b] = await Promise.all([run({ symbol: "TsOnly", path: "ts" }), run({ symbol: "PrefixOnly", path: "tsx" })]);
    expect(output(a).hits.map((h) => h.file)).toEqual(["ts/a.ts"]);
    expect(output(b).hits.map((h) => h.file)).toEqual(["tsx/a.ts"]);
    expect(paths().every((p) => p === join(root, "ts") || p.startsWith(`${join(root, "ts")}/`) || p === join(root, "tsx") || p.startsWith(`${join(root, "tsx")}/`))).toBe(true);
    expect(readFile).toHaveBeenCalledTimes(3);
  });
  it("updates scoped edits, additions and removals before the next query", async () => {
    await fixture();
    await run({ symbol: "TsOnly", path: "ts" });
    await write("ts/a.ts", "export const ChangedOnly = 111;\n");
    await write("ts/new.ts", "export const AddedOnly = 1;\n");
    await fs.rm(join(root, "ts/b.ts"));
    clearIO();
    expect(output(await run({ symbol: "ChangedOnly", path: "ts" })).hits).toHaveLength(1);
    expect(output(await run({ symbol: "AddedOnly", path: "ts" })).hits).toHaveLength(1);
    expect(output(await run({ symbol: "TsOnly", path: "ts" })).hits).toEqual([]);
    expect(output(await run({ symbol: "SiblingOnly", path: "ts" })).hits).toEqual([]);
    expectScope("ts");
  });
  it("preserves maxResults for indexed and fallback queries", async () => {
    await fixture(); await write("py/other.py", "def PyOnly():\n    return 1\n");
    expect(output(await run({ symbol: "PyOnly", path: "py", maxResults: 1 })).hits).toHaveLength(1);
    expect(output(await run({ symbol: "export", path: "ts", maxResults: 1 })).hits).toHaveLength(1);
  });
  it("skips discovered symlinks and VCS/dependency/generated paths", async () => {
    await fixture();
    for (const skipped of [".git", "node_modules", "dist", "build", "coverage"]) await write(`${skipped}/hidden.ts`, "export const HiddenOnly = 1;\n");
    await fs.symlink(join(root, "private"), join(root, "ts", "link"), process.platform === "win32" ? "junction" : "dir");
    expect(output(await run({ symbol: "HiddenOnly" })).hits).toEqual([]);
    clearIO(); expect(output(await run({ symbol: "OffScope", path: "ts" })).hits).toEqual([]); expectScope("ts");
  });
  it("retains a trusted root alias while refusing selected directory symlinks", async () => {
    await fixture();
    const alias = `${root}-alias`;
    await fs.symlink(root, alias, process.platform === "win32" ? "junction" : "dir");
    try {
      expect((await indexedSymbolSearch({ root: alias, symbol: "TsOnly", relPath: "ts" })).hits.map((h) => h.file)).toEqual(["ts/a.ts"]);
      await fs.symlink(join(root, "private"), join(root, "selected-link"), process.platform === "win32" ? "junction" : "dir");
      clearIO();
      expect(output(await run({ symbol: "OffScope", path: "selected-link" })).hits).toEqual([]);
      expect(paths()).toEqual([]);
    } finally { await fs.rm(alias, { force: true }); }
  });
  it("refuses a selected file reached through a directory symlink", async () => {
    await fixture();
    await fs.symlink(join(root, "private"), join(root, "selected-link"), process.platform === "win32" ? "junction" : "dir");
    expect(output(await run({ symbol: "OffScope", path: "selected-link/secret.ts" })).hits).toEqual([]);
    expect(paths()).toEqual([]);
  });
  it("never reads other paths when permission only allows the requested directory", async () => {
    await fixture();
    const ctx = context(); ctx.permissions = { rules: [{ action: "read", resource: "file", pattern: "ts", effect: "allow" }], defaultEffect: "deny" };
    expect(output(await run({ symbol: "TsOnly", path: "ts" }, ctx)).hits).toHaveLength(1);
    expectScope("ts");
  });
  it("keeps permission denial and outside-sandbox rejection before all source IO", async () => {
    await fixture();
    const ctx = context(); ctx.permissions = { rules: [], defaultEffect: "deny" };
    expect((await run({ symbol: "TsOnly", path: "ts" }, ctx)).status).toBe("denied");
    expect((await run({ symbol: "TsOnly", path: "../outside" })).status).toBe("denied");
    expect(paths()).toEqual([]);
  });
  it("returns no stale scoped contents after the selected file vanishes", async () => {
    await fixture(); await run({ symbol: "TsOnly", path: "ts/a.ts" });
    await fs.rm(join(root, "ts/a.ts")); clearIO();
    expect(output(await run({ symbol: "TsOnly", path: "ts/a.ts" })).hits).toEqual([]);
    expect(paths()).toEqual([]);
  });
});
