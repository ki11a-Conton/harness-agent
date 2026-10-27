import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { newAgentId, newSessionId, newToolCallId, newTurnId, type ToolExecutionContext } from "@ar/contracts";
import { ToolOrchestrator } from "./orchestrator.js";
import { ToolRegistry } from "./registry.js";
import { symbolSearchTool } from "./tools/navigation-tools.js";

let root: string;
beforeEach(async () => { root = await fs.mkdtemp(join(tmpdir(), "symbol-mixed-budget-")); });
afterEach(async () => { vi.restoreAllMocks(); await fs.rm(root, { recursive: true, force: true }); });

async function run(args: Record<string, unknown>) {
  const context: ToolExecutionContext = {
    cwd: root, sessionId: newSessionId(), agentId: newAgentId(), turnId: newTurnId(),
    signal: new AbortController().signal,
    permissions: { rules: [], defaultEffect: "allow" },
    sandboxPolicy: { filesystem: { mode: "workspace-write" }, network: { mode: "deny" }, process: { timeoutMs: 10000, maxOutputBytes: 65536 } },
  };
  const registry = new ToolRegistry(); registry.register(symbolSearchTool);
  const orchestrator = new ToolOrchestrator({ registry, workspaceRoot: root });
  const result = await orchestrator.execute({ id: newToolCallId(), sessionId: context.sessionId, agentId: context.agentId,
    turnId: context.turnId, call: { id: newToolCallId(), name: "symbol_search", args } }, context);
  expect(result.status, JSON.stringify(result.error)).toBe("success");
  return result.output as { hits: Array<{ file: string; line: number; name: string; text: string; truncated?: boolean }>;
    limitReached?: boolean; complete?: boolean; supplementalSearch?: string; supplementalSummary?: { skippedOversizedFiles: number; complete: boolean } };
}

describe("symbol_search across languages and context budgets", () => {
  it("returns the Python definition as well as a same-name TypeScript hit", async () => {
    await fs.writeFile(join(root, "frontend.ts"), "export const SharedSymbol = 1;\n");
    await fs.writeFile(join(root, "worker.py"), "def SharedSymbol():\n    return 2\n");
    const result = await run({ symbol: "SharedSymbol" });
    expect(result.hits.map(hit => hit.file).sort()).toEqual(["frontend.ts", "worker.py"]);
  });

  it("finds Go and Rust definitions with return types in a mixed repository", async () => {
    await fs.writeFile(join(root, "frontend.ts"), "export const SharedSymbol = 1;\n");
    await fs.writeFile(join(root, "worker.go"), "func SharedSymbol() int { return 2 }\n");
    await fs.writeFile(join(root, "worker.rs"), "pub fn SharedSymbol() -> usize { 3 }\n");
    const result = await run({ symbol: "SharedSymbol" });
    expect(result.hits.map(hit => hit.file).sort()).toEqual(["frontend.ts", "worker.go", "worker.rs"]);
  });

  it("does not duplicate a Go or Rust declaration matched by multiple fallback patterns", async () => {
    await fs.writeFile(join(root, "worker.go"), "func SharedSymbol() {}\n");
    await fs.writeFile(join(root, "worker.rs"), "pub fn SharedSymbol() {}\n");
    const result = await run({ symbol: "SharedSymbol" });
    expect(result.hits.map(hit => hit.file).sort()).toEqual(["worker.go", "worker.rs"]);
  });

  it("does not reread indexed files when searching the supplementary languages", async () => {
    await fs.writeFile(join(root, "frontend.ts"), "export const SharedSymbol = 1;\n");
    await fs.writeFile(join(root, "worker.py"), "def SharedSymbol():\n    return 2\n");
    const reads = vi.spyOn(fs, "readFile");
    const result = await run({ symbol: "SharedSymbol" });
    expect(result.supplementalSearch).toBe("regex-symbol-fallback");
    expect(reads.mock.calls.some(([path]) => String(path) === join(root, "worker.py"))).toBe(true);
    expect(reads.mock.calls.some(([path]) => String(path) === join(root, "frontend.ts"))).toBe(false);
  });

  it("preserves the selected file boundary and does not read its sibling", async () => {
    await fs.writeFile(join(root, "frontend.ts"), "export const SharedSymbol = 1;\n");
    await fs.writeFile(join(root, "worker.py"), "def SharedSymbol():\n    return 2\n");
    const result = await run({ symbol: "SharedSymbol", path: "frontend.ts" });
    expect(result.hits.map(hit => hit.file)).toEqual(["frontend.ts"]);
    expect(result.supplementalSearch).toBeUndefined();
  });

  it("discovers a newly added non-indexed file on a warm index", async () => {
    await fs.writeFile(join(root, "frontend.ts"), "export const SharedSymbol = 1;\n");
    expect((await run({ symbol: "SharedSymbol" })).hits).toHaveLength(1);
    await fs.writeFile(join(root, "worker.py"), "def SharedSymbol():\n    return 2\n");
    expect((await run({ symbol: "SharedSymbol" })).hits.map(hit => hit.file).sort()).toEqual(["frontend.ts", "worker.py"]);
  });

  it("reports when the result cap prevents the supplementary scan", async () => {
    await fs.writeFile(join(root, "frontend.ts"), "export const SharedSymbol = 1;\n");
    await fs.writeFile(join(root, "worker.py"), "def SharedSymbol():\n    return 2\n");
    const result = await run({ symbol: "SharedSymbol", maxResults: 1 });
    expect(result.hits.map(hit => hit.file)).toEqual(["frontend.ts"]);
    expect(result).toMatchObject({ limitReached: true, supplementalSearch: "skipped_limit" });
  });

  it("reports an oversized supplementary file instead of implying a complete search", async () => {
    await fs.writeFile(join(root, "frontend.ts"), "export const SharedSymbol = 1;\n");
    await fs.writeFile(join(root, "worker.py"), `def SharedSymbol():\n${" ".repeat(512 * 1024)}`);
    const result = await run({ symbol: "SharedSymbol" });
    expect(result.hits.map(hit => hit.file)).toEqual(["frontend.ts"]);
    expect(result).toMatchObject({ supplementalSearch: "incomplete", supplementalSummary: { complete: false, skippedOversizedFiles: 1 } });
  });

  it("keeps indexed hits but reports an unreadable supplementary directory", async () => {
    await fs.writeFile(join(root, "frontend.ts"), "export const SharedSymbol = 1;\n");
    await fs.writeFile(join(root, "worker.py"), "def SharedSymbol():\n    return 2\n");
    vi.spyOn(fs, "readdir").mockRejectedValueOnce(Object.assign(new Error("access denied"), { code: "EACCES" }));
    const result = await run({ symbol: "SharedSymbol" });
    expect(result.hits.map(hit => hit.file)).toEqual(["frontend.ts"]);
    expect(result).toMatchObject({ supplementalSearch: "incomplete", supplementalSummary: { complete: false, unreadableDirectories: 1 } });
  });

  it("keeps a tail match visible in a bounded, explicitly truncated long line", async () => {
    await fs.writeFile(join(root, "generated.ts"), `${"x".repeat(12000)}😀 ImportantSymbol ${"y".repeat(3000)}\n`);
    const result = await run({ symbol: "ImportantSymbol" });
    expect(result.hits).toHaveLength(1);
    expect(result.hits[0]).toMatchObject({ file: "generated.ts", line: 1, truncated: true });
    expect(result.hits[0]!.text).toContain("ImportantSymbol");
    expect(result.hits[0]!.text.length).toBeLessThanOrEqual(2000);
    expect(result.hits[0]!.text).not.toMatch(/^[\uDC00-\uDFFF]|[\uD800-\uDBFF]$/u);
  });

  it("bounds the serialized result and marks omitted hits instead of filling the model context", async () => {
    await fs.writeFile(join(root, "large.ts"), Array.from({ length: 100 }, (_, i) => `const SharedSymbol${i} = '${"a".repeat(1800)}';`).join("\n"));
    const result = await run({ symbol: "SharedSymbol", maxResults: 5000 });
    expect(result.hits.length).toBeGreaterThan(0);
    expect(result.hits.length).toBeLessThan(100);
    expect(result.limitReached).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(result), "utf8")).toBeLessThanOrEqual(65536);
  });

  it("preserves ordinary source lines without a truncation marker", async () => {
    await fs.writeFile(join(root, "small.ts"), "  export const SharedSymbol = 1;  \n");
    const result = await run({ symbol: "SharedSymbol" });
    expect(result.hits[0]).toMatchObject({ line: 1, text: "export const SharedSymbol = 1;" });
    expect(result.hits[0]).not.toHaveProperty("truncated");
    expect(result.limitReached).toBeUndefined();
  });

  it("marks the syntax result incomplete when its byte budget omits hits", async () => {
    await fs.writeFile(join(root, "many.ts"), Array.from({ length: 500 }, () => `const SharedSymbol = '${"a".repeat(300)}';`).join("\n"));
    const result = await run({ symbol: "SharedSymbol", mode: "syntax", maxResults: 5000 });
    expect(result.hits.length).toBeGreaterThan(0);
    expect(result.hits.length).toBeLessThan(500);
    expect(result).toMatchObject({ complete: false, limitReached: true });
    expect(Buffer.byteLength(JSON.stringify(result), "utf8")).toBeLessThanOrEqual(65536);
  });
});
