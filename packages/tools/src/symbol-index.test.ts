import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { indexedSymbolSearch } from "./symbol-index.js";

let tempDir: string | undefined;
afterEach(async () => {
  if (tempDir !== undefined) {
    await rm(tempDir, { recursive: true, force: true });
    tempDir = undefined;
  }
});

async function freshRoot(): Promise<string> {
  tempDir = await mkdtemp(join(tmpdir(), "sym-index-"));
  return tempDir;
}

describe("P7-4: light TS/JS symbol index (EXPERIMENT)", () => {
  it("finds function/class/interface definitions with roles and positions", async () => {
    const root = await freshRoot();
    await mkdir(join(root, "src"), { recursive: true });
    await writeFile(
      join(root, "src", "parser.ts"),
      [
        "export function parse(input: string): number {",
        "  return input.length;",
        "}",
        "",
        "export class Parser {",
        "  run() { return parse('x'); }",
        "}",
        "",
        "export interface ParserOptions {",
        "  strict: boolean;",
        "}",
      ].join("\n"),
    );
    const result = await indexedSymbolSearch({ symbol: "parse", root });
    expect(result.fallback).toBe(false);
    expect(result.indexer).toBe("ts-regex-index");
    expect(result.filesIndexed).toBe(1);
    const definition = result.hits.find((h) => h.role === "definition");
    expect(definition).toBeDefined();
    expect(definition!.kind).toBe("function");
    expect(definition!.file).toBe("src/parser.ts");
    expect(definition!.line).toBe(1);

    const parser = await indexedSymbolSearch({ symbol: "Parser", root });
    const parserDef = parser.hits.find((h) => h.role === "definition");
    expect(parserDef!.kind).toBe("class");
  });

  it("classifies imports and references", async () => {
    const root = await freshRoot();
    await mkdir(join(root, "src"), { recursive: true });
    await writeFile(join(root, "src", "a.ts"), "export const VALUE = 42;\n");
    await writeFile(join(root, "src", "b.ts"), "import { VALUE } from './a';\nconsole.log(VALUE);\n");
    const result = await indexedSymbolSearch({ symbol: "VALUE", root });
    const roles = new Set(result.hits.map((h) => h.role));
    expect(roles.has("definition")).toBe(true);
    expect(roles.has("import")).toBe(true);
    expect(roles.has("reference")).toBe(true);
  });

  it("skips node_modules and honours maxHits", async () => {
    const root = await freshRoot();
    await mkdir(join(root, "node_modules", "dep"), { recursive: true });
    await mkdir(join(root, "src"), { recursive: true });
    await writeFile(join(root, "node_modules", "dep", "index.ts"), "export function helper() {}\n");
    await writeFile(join(root, "src", "main.ts"), "export function helper() {}\n");
    const result = await indexedSymbolSearch({ symbol: "helper", root, maxHits: 10 });
    // node_modules is skipped — only src/main.ts contributes.
    expect(result.hits.every((h) => !h.file.startsWith("node_modules"))).toBe(true);
    expect(result.filesIndexed).toBe(1);
  });

  it("caches the index per root (second search does not re-scan)", async () => {
    const root = await freshRoot();
    await writeFile(join(root, "main.ts"), "export function cached() {}\n");
    const first = await indexedSymbolSearch({ symbol: "cached", root });
    const second = await indexedSymbolSearch({ symbol: "cached", root });
    expect(first.filesIndexed).toBe(1);
    expect(second.filesIndexed).toBe(1);
    expect(second.hits).toHaveLength(first.hits.length);
  });
});

describe("P15-5: cross-repo cache isolation + freshness", () => {
  it("two repos never share index state through the module cache", async () => {
    const rootA = await freshRoot();
    await mkdir(join(rootA, "src"), { recursive: true });
    await writeFile(join(rootA, "src", "a.ts"), "export function alpha() {}\n", "utf8");
    const rootB = await freshRoot();
    await mkdir(join(rootB, "src"), { recursive: true });
    await writeFile(join(rootB, "src", "b.ts"), "export function beta() {}\n", "utf8");

    const a = await indexedSymbolSearch({ symbol: "alpha", root: rootA });
    expect(a.hits.length).toBeGreaterThan(0);
    // the same symbol in repo B must NOT resolve from A's index
    const aInB = await indexedSymbolSearch({ symbol: "alpha", root: rootB });
    expect(aInB.hits.length).toBe(0);
    const bInB = await indexedSymbolSearch({ symbol: "beta", root: rootB });
    expect(bInB.hits.length).toBeGreaterThan(0);
  });

  it("a root whose directory fingerprint changed rebuilds the index (no stale state)", async () => {
    const root = await freshRoot();
    await mkdir(join(root, "src"), { recursive: true });
    await writeFile(join(root, "src", "one.ts"), "export function first() {}\n", "utf8");
    const first = await indexedSymbolSearch({ symbol: "first", root });
    expect(first.hits.length).toBeGreaterThan(0);

    // Change the ROOT directory itself (new subdirectory) so the fingerprint
    // (mtime/size of root) changes; the cache must rebuild, not serve stale.
    await new Promise((r) => setTimeout(r, 5));
    await mkdir(join(root, "newpkg"), { recursive: true });
    await writeFile(join(root, "newpkg", "two.ts"), "export function second() {}\n", "utf8");

    const second = await indexedSymbolSearch({ symbol: "second", root });
    expect(second.hits.length).toBeGreaterThan(0);
    // the old symbol is still found (rebuilt index covers the whole tree)
    const firstAgain = await indexedSymbolSearch({ symbol: "first", root });
    expect(firstAgain.hits.length).toBeGreaterThan(0);
  });
});
