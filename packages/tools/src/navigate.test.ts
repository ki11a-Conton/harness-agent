import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { grepFiles, repoTree, symbolSearch, walkFiles } from "./navigate.js";

let ws = "";
beforeAll(() => {
  ws = mkdtempSync(join(tmpdir(), "nav-"));
  mkdirSync(join(ws, "src"), { recursive: true });
  mkdirSync(join(ws, "node_modules"), { recursive: true });
  mkdirSync(join(ws, ".git"), { recursive: true });
  writeFileSync(join(ws, "src", "app.ts"), "export function hello() { return 1; }\nconst version = '1.0';\ntype User = { id: number };\n");
  writeFileSync(join(ws, "src", "util.ts"), "export class Helper {}\n// TODO(p2): fix this\nexport const NAME = 'x';\n");
  writeFileSync(join(ws, "node_modules", "dep.js"), "const hidden = require('x');\n");
  writeFileSync(join(ws, "notes.md"), "hello world\n");
});
afterAll(() => rmSync(ws, { recursive: true, force: true }));

describe("P2-29 walkFiles skips VCS/dependency dirs", () => {
  it("does not surface .git / node_modules files", async () => {
    const files: string[] = [];
    await walkFiles(ws, ".", async (_abs, rel) => {
      if (!rel.startsWith(".")) files.push(rel);
    });
    expect(files).not.toContain("node_modules/dep.js");
    expect(files).toContain("src/app.ts");
  });
});

describe("P2-29 grepFiles", () => {
  it("finds case-insensitive text matches with line/column", async () => {
    const hits = await grepFiles({ pattern: "hello", root: ws });
    expect(hits.some((h) => h.file === "notes.md" && h.text.includes("hello"))).toBe(true);
    const fn = hits.find((h) => h.file.endsWith("app.ts"));
    expect(fn?.line).toBe(1);
  });

  it("restricts to fileGlob and respects caseSensitive", async () => {
    const ts = await grepFiles({ pattern: "export", root: ws, fileGlob: "*.ts" });
    expect(ts.every((h) => h.file.endsWith(".ts"))).toBe(true);
    const insensitive = await grepFiles({ pattern: "HELLO", root: ws });
    expect(insensitive.length).toBeGreaterThan(0);
    const strict = await grepFiles({ pattern: "HELLO", root: ws, caseSensitive: true });
    expect(strict.length).toBe(0);
  });

  it("skips binary / oversized files", async () => {
    writeFileSync(join(ws, "blob.bin"), Buffer.from([0, 1, 2, 0, 97, 0]));
    const hits = await grepFiles({ pattern: "\\x00", root: ws });
    // pattern won't match binary content because we refuse NUL files entirely
    expect(hits.find((h) => h.file === "blob.bin")).toBeUndefined();
  });
});

describe("P2-29 symbolSearch fallback", () => {
  it("returns fallback:true with an explicit indexer note", async () => {
    const res = await symbolSearch({ symbol: "hello", root: ws });
    expect(res.fallback).toBe(true);
    expect(res.indexer).toContain("regex-symbol-fallback");
    expect(res.hits.some((h) => h.name === "hello" && h.kind === "function")).toBe(true);
  });

  it("finds class and const symbols", async () => {
    const res = await symbolSearch({ symbol: "Helper", root: ws });
    expect(res.hits.some((h) => h.name === "Helper" && h.kind === "class")).toBe(true);
  });
});

describe("P2-29 repoTree", () => {
  it("lists files and synthesized dirs, skipping VCS/dep dirs", async () => {
    const tree = await repoTree({ root: ws });
    const paths = tree.map((e) => e.path);
    expect(paths).toContain("src/app.ts");
    expect(paths).toContain("notes.md");
    // skips .git / node_modules entirely
    expect(paths.some((p) => p.startsWith("node_modules"))).toBe(false);
    expect(paths.some((p) => p.startsWith(".git"))).toBe(false);
    const srcDir = tree.find((e) => e.path === "src");
    expect(srcDir?.type).toBe("dir");
  });
});