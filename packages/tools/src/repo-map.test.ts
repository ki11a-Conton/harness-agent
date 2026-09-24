import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  RepositoryMapCache,
  repoFingerprint,
  scanRepoStats,
} from "./repo-map.js";

let ws = "";

function write(file: string, content: string): void {
  const abs = join(ws, file);
  mkdirSync(abs.slice(0, abs.lastIndexOf("/")) || ws, { recursive: true });
  writeFileSync(abs, content, "utf8");
}

beforeAll(() => {
  ws = mkdtempSync(join(tmpdir(), "ar-repomap-"));
  write("package.json", JSON.stringify({ name: "root", version: "1.0.0", scripts: { test: "vitest run" }, dependencies: { zod: "^3.0.0" } }));
  write("src/index.ts", "export const hi = 1;\n");
  write("src/util.ts", "export function f() { return 2; }\n");
  write("packages/app/package.json", JSON.stringify({ name: "app", main: "lib/index.js", scripts: { build: "tsc" } }));
  write("packages/app/lib/index.js", "module.exports = 1;\n");
  write("packages/app/lib/index.js.map", "{}");
  write("Cargo.toml", "[package]\nname = \"core\"\n");
  write("src/main.rs", "fn main() {}\n");
  write("node_modules/dep/index.js", "x");
  write(".git/config", "x");
  write("dist/bundle.js", "x");
});

afterAll(() => {
  rmSync(ws, { recursive: true, force: true });
});

describe("P2-30 repoFingerprint stability", () => {
  it("ignores order and is deterministic", () => {
    const a = repoFingerprint([{ path: "b", size: 1, mtimeMs: 10 }, { path: "a", size: 2, mtimeMs: 9 }]);
    const b = repoFingerprint([{ path: "a", size: 2, mtimeMs: 9 }, { path: "b", size: 1, mtimeMs: 10 }]);
    expect(a).toBe(b);
  });
  it("changes when a file size or mtime changes", () => {
    const base = repoFingerprint([{ path: "a", size: 2, mtimeMs: 9 }]);
    expect(repoFingerprint([{ path: "a", size: 3, mtimeMs: 9 }])).not.toBe(base);
    expect(repoFingerprint([{ path: "a", size: 2, mtimeMs: 99 }])).not.toBe(base);
  });
});

describe("P2-30 scanRepoStats skips VCS/dependency dirs", () => {
  it("does not surface node_modules / .git / dist", async () => {
    const entries = await scanRepoStats(ws);
    const paths = entries.map((e) => e.path);
    expect(paths).toContain("src/index.ts");
    expect(paths.some((p) => p.startsWith("node_modules"))).toBe(false);
    expect(paths.some((p) => p.startsWith(".git"))).toBe(false);
    expect(paths.some((p) => p.startsWith("dist"))).toBe(false);
  });
});

describe("P2-30 RepositoryMapCache", () => {
  it("builds a map with files, packages, languages, entrypoints, test commands", async () => {
    const cache = new RepositoryMapCache({ root: ws });
    const map = await cache.get();
    expect(map.root).toBe(ws);
    expect(map.files.some((f) => f.path === "src/index.ts")).toBe(true);
    expect(map.files.some((f) => f.path === "node_modules/dep/index.js")).toBe(false);
    expect(map.complete).toBe(true);

    const names = map.packages.map((p) => p.name);
    expect(names).toContain("root");
    expect(names).toContain("app");
    expect(names).toContain("core"); // Cargo.toml
    const app = map.packages.find((p) => p.name === "app");
    expect(app?.entrypoints).toContain("lib/index.js");
    expect(app?.hasLockfile).toBe(false);
    const root = map.packages.find((p) => p.name === "root");
    expect(root?.prodDeps).toContain("zod");
    expect(root?.testCommands.some((c) => c.startsWith("test:"))).toBe(true);

    // language detection by extension
    const langs = map.languages.map((l) => l.lang);
    expect(langs).toContain("typescript");
    expect(langs).toContain("rust");
  });

  it("returns a fresh cached hit when nothing changed (no rebuild)", async () => {
    const cache = new RepositoryMapCache({ root: ws });
    await cache.get();
    expect(cache.stats.builds).toBe(1);
    const again = await cache.get();
    expect(cache.stats.builds).toBe(1); // no second build
    expect(cache.stats.hits).toBe(1);
    expect(again.fingerprint).toBe(cache.peek()?.fingerprint);
    expect(cache.isFresh()).toBe(true);
  });

  it("rebuilds after a real repo change", async () => {
    const cache = new RepositoryMapCache({ root: ws });
    const before = await cache.get();
    expect(before.files.some((f) => f.path === "src/extra.ts")).toBe(false);
    write("src/extra.ts", "export const y = 1;\n");
    const after = await cache.get();
    expect(after.files.some((f) => f.path === "src/extra.ts")).toBe(true);
    expect(cache.stats.builds).toBe(2);
  });

  it("noteChange forces a rebuild even when size+mtime fingerprint is unchanged", async () => {
    const cache = new RepositoryMapCache({ root: ws });
    await cache.get();
    cache.noteChange("package.json");
    await cache.get();
    expect(cache.stats.builds).toBe(2);
    expect(cache.stats.hits).toBe(0);
  });

  it("invalidate drops the cache; next get builds again", async () => {
    const cache = new RepositoryMapCache({ root: ws });
    await cache.get();
    cache.invalidate();
    expect(cache.isFresh()).toBe(false);
    await cache.get();
    expect(cache.stats.builds).toBe(2);
  });

  it("concurrent get() coalesces onto a single build", async () => {
    const cache = new RepositoryMapCache({ root: ws });
    const [a, b] = await Promise.all([cache.get(), cache.get()]);
    expect(a.fingerprint).toBe(b.fingerprint);
    expect(cache.stats.builds).toBe(1);
  });

  it("caps the file tree and flags complete:false", async () => {
    const cache = new RepositoryMapCache({ root: ws, maxFiles: 2 });
    const map = await cache.get();
    expect(map.files.length).toBeLessThanOrEqual(2);
    expect(map.complete).toBe(false);
  });
});

describe("P2-30+ monorepo glob awareness + dependency graph", () => {
  let mono = "";
  beforeAll(() => {
    mono = mkdtempSync(join(tmpdir(), "ar-repomap-mono-"));
    const w = (file: string, content: string): void => writeAt(mono, file, content);
    w("pnpm-workspace.yaml", "packages:\n  - 'packages/*'\n  - '!packages/skip'\n");
    w("package.json", JSON.stringify({
      name: "root",
      scripts: { test: "pnpm -r test" },
      dependencies: { a: "workspace:*" },
    }));
    w("packages/a/package.json", JSON.stringify({ name: "a", dependencies: { b: "workspace:*" } }));
    w("packages/a/index.ts", "export {};\n");
    w("packages/b/package.json", JSON.stringify({ name: "b", scripts: { test: "vitest run" } }));
    w("packages/b/index.ts", "export {};\n");
    w("packages/skip/package.json", JSON.stringify({ name: "skip", scripts: { test: "echo skipped" } }));
    w("packages/skip/index.ts", "export const s = 1;\n");
    w("other/package.json", JSON.stringify({ name: "other" }));
    w("other/index.ts", "export const o = 1;\n");
  });
  afterAll(() => rg(mono));

  function writeAt(root: string, file: string, content: string): void {
    const abs = join(root, file);
    mkdirSync(abs.slice(0, abs.lastIndexOf("/")) || root, { recursive: true });
    writeFileSync(abs, content, "utf8");
  }
  function rg(root: string): void {
    rmSync(root, { recursive: true, force: true });
  }

  it("restricts package boundaries to workspace member dirs (glob 精细化)", async () => {
    const cache = new RepositoryMapCache({ root: mono });
    const map = await cache.get();
    const names = map.packages.map((p) => p.name);
    // member dirs packages/a + packages/b, plus the root manifest
    expect(map.workspaces?.members.sort()).toEqual(["packages/a", "packages/b"]);
    expect(names).toContain("root");
    expect(names).toContain("a");
    expect(names).toContain("b");
    // `packages/skip` (negated) and `other` (outside the positive glob) are NOT boundaries
    expect(names).not.toContain("skip");
    expect(names).not.toContain("other");
  });

  it("links the intra-repo dependency graph via workspace: protocol", async () => {
    const cache = new RepositoryMapCache({ root: mono });
    const map = await cache.get();
    const graph = new Map(map.dependencyGraph.map((d) => [d.name, d.internalDeps]));
    // root depends on a, a depends on b
    expect(map.packages.find((p) => p.name === "a")?.workspaceDeps).toEqual(["b"]);
    expect(graph.get("root")).toEqual(["a"]);
    expect(graph.get("a")).toEqual(["b"]);
    expect(graph.get("b")).toEqual([]);
  });
});