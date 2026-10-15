import { mkdtemp, mkdir, readFile, rm, stat, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import { buildSyntaxIndex, syntaxSymbolSearch } from "./syntax-index.js";
import { buildRelevantCodeMap } from "./relevant-code-map.js";

interface Gold { id: string; query: string; symbol: string; goldFile: string; goldLine: number; callerFile: string; files: Record<string, string> }
const gold = JSON.parse(await readFile(new URL("../test-fixtures/coding-retrieval-gold.json", import.meta.url), "utf8")) as { cases: Gold[] };
let root: string;
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "coding-syntax-"));
  for (const task of gold.cases) for (const [path, content] of Object.entries(task.files)) {
    await mkdir(dirname(join(root, path)), { recursive: true }); await writeFile(join(root, path), content);
  }
});
afterAll(async () => { await rm(root, { recursive: true, force: true }); });

it.each(gold.cases)("C5 AST locates real definition and candidate caller: $id", async task => {
  const result = await syntaxSymbolSearch({ root, symbol: task.symbol });
  expect(result.indexer).toBe("tree-sitter-wasm-v1"); expect(result.semantic).toBe(false);
  expect(result.hits).toContainEqual(expect.objectContaining({ file: task.goldFile, line: task.goldLine, role: "definition" }));
  expect(result.hits.some(hit => hit.file === task.callerFile)).toBe(true);
  for (const hit of result.hits) {
    const lines = (await readFile(join(root, hit.file), "utf8")).split("\n");
    expect(lines[hit.line - 1]).toContain(task.symbol); expect(hit.sha256).toMatch(/^[a-f0-9]{64}$/);
  }
});

it("C5 frozen 30-query retrieval set meets recall@5 and bounded graph budget", async () => {
  let recalled = 0;
  for (const task of gold.cases) {
    const map = await buildRelevantCodeMap({ root, query: task.query, maxTokens: 1600 });
    if (map.files.slice(0, 5).some(file => file.path === task.goldFile)) recalled++;
    expect(Buffer.byteLength(JSON.stringify(map))).toBeLessThanOrEqual(6400);
    expect(map.files.some(file => file.path === task.callerFile)).toBe(true);
  }
  expect(recalled / gold.cases.length).toBeGreaterThanOrEqual(.8);
});

it("C5 ignores comments/strings and notices edits even with unchanged size and mtime", async () => {
  const path = join(root, "fresh.ts");
  await writeFile(path, 'export function oldName() {}\n// phantomName\nconst value = "phantomName";\n');
  const before = await stat(path);
  expect((await syntaxSymbolSearch({ root, path: "fresh.ts", symbol: "phantomName" })).hits).toHaveLength(0);
  const old = await syntaxSymbolSearch({ root, path: "fresh.ts", symbol: "oldName" });
  await writeFile(path, (await readFile(path, "utf8")).replace("oldName", "newName")); await utimes(path, before.atime, before.mtime);
  const current = await syntaxSymbolSearch({ root, path: "fresh.ts", symbol: "newName" });
  expect(current.hits.some(hit => hit.role === "definition")).toBe(true); expect(current.fingerprint).not.toBe(old.fingerprint);
  expect((await syntaxSymbolSearch({ root, path: "fresh.ts", symbol: "oldName" })).hits).toHaveLength(0);
});

it("C5 honors nested ignore, negation, scope, symlinks and cancellation", async () => {
  await mkdir(join(root, "ignored"), { recursive: true }); await writeFile(join(root, "ignored/secret.ts"), "function foreignSecret() {}\n");
  await writeFile(join(root, ".gitignore"), "ignored/\n*.generated.ts\n!keep.generated.ts\n");
  await writeFile(join(root, "skip.generated.ts"), "function excludedGenerated() {}\n");
  await writeFile(join(root, "keep.generated.ts"), "function allowedGenerated() {}\n");
  const foreign = await mkdtemp(join(tmpdir(), "syntax-foreign-"));
  try {
    await writeFile(join(foreign, "outside.ts"), "function outsideSymbol() {}\n");
    await symlink(foreign, join(root, "linked"), process.platform === "win32" ? "junction" : "dir");
    const index = await buildSyntaxIndex(root);
    expect(index.files.some(file => /ignored|linked|skip.generated/.test(file.file))).toBe(false);
    expect(index.files.some(file => file.file === "keep.generated.ts")).toBe(true);
    expect((await buildSyntaxIndex(root, "typescript")).files.every(file => file.file.startsWith("typescript/"))).toBe(true);
    expect((await buildSyntaxIndex(root, "../")).files).toHaveLength(0);
    const controller = new AbortController(); controller.abort();
    await expect(buildSyntaxIndex(root, ".", controller.signal)).rejects.toThrow();
    const limited = await buildSyntaxIndex(root, ".", undefined, 2); expect(limited.files.length).toBeLessThanOrEqual(2); expect(limited.complete).toBe(false);
  } finally { await rm(foreign, { recursive: true, force: true }); }
});

it("C5 small budgets remain bounded with long non-ASCII queries", async () => {
  const map = await buildRelevantCodeMap({ root, query: "查找相关的函数和调用方".repeat(40), maxTokens: 128 });
  expect(Buffer.byteLength(JSON.stringify(map))).toBeLessThanOrEqual(512); expect(map.truncated).toBe(true);
});
