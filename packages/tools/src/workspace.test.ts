import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  matchGlobDirs,
  loadWorkspacePatterns,
  listDirs,
  resolveWorkspace,
} from "./workspace.js";

describe("P2-30+ matchGlobDirs glob matching", () => {
  const dirs = ["packages/app", "packages/util", "apps/web", "libs/core", "tools/cli", "scripts"];

  it("matches `packages/*` for a single segment", () => {
    expect(matchGlobDirs(["packages/*"], dirs).sort()).toEqual(["packages/app", "packages/util"]);
  });

  it("matches `**` across segments", () => {
    expect(matchGlobDirs(["packages/**"], dirs).sort()).toEqual(["packages/app", "packages/util"]);
  });

  it("matches nested `apps/**` and `**/core`", () => {
    expect(matchGlobDirs(["apps/**"], dirs)).toEqual(["apps/web"]);
    expect(matchGlobDirs(["**/core"], dirs)).toEqual(["libs/core"]);
  });

  it("applies `!` negation after a positive pattern", () => {
    const got = matchGlobDirs(["packages/*", "!packages/util"], dirs);
    expect(got).toEqual(["packages/app"]);
  });

  it("matches `?` for a single char in a segment", () => {
    expect(matchGlobDirs(["li[bs]/core"], dirs)).toEqual([]); // char class is literal, no match
    expect(matchGlobDirs(["tools/?li"], dirs)).toEqual(["tools/cli"]);
    expect(matchGlobDirs(["??/core"], dirs)).toEqual([]); // TWO chars ≠ "libs" (four chars)
  });
});

let ws = "";

function write(file: string, content: string): void {
  const abs = join(ws, file);
  mkdirSync(abs.slice(0, abs.lastIndexOf("/")) || ws, { recursive: true });
  writeFileSync(abs, content, "utf8");
}

beforeAll(() => {
  ws = mkdtempSync(join(tmpdir(), "ar-ws-glob-"));
  write("pnpm-workspace.yaml", "packages:\n  - 'packages/*'\n  - '!packages/skip'\n");
  write("package.json", JSON.stringify({ name: "root", workspaces: ["packages/*"], scripts: { test: "npm test" } }));
  write("packages/a/package.json", JSON.stringify({ name: "a" }));
  write("packages/b/package.json", JSON.stringify({ name: "b" }));
  write("packages/skip/package.json", JSON.stringify({ name: "skip" }));
  write("other/package.json", JSON.stringify({ name: "other" }));
});

afterAll(() => {
  rmSync(ws, { recursive: true, force: true });
});

describe("P2-30+ workspace loading & resolution", () => {
  it("loads patterns from pnpm-workspace.yaml + package.json#workspaces", async () => {
    const pats = await loadWorkspacePatterns(ws);
    expect(pats).toContain("packages/*");
    expect(pats).toContain("!packages/skip");
  });

  it("resolveWorkspace marks explicit that a negated member is excluded", async () => {
    const res = await resolveWorkspace(ws);
    expect(res.explicit).toBe(true);
    expect(res.members).toContain("packages/a");
    expect(res.members).toContain("packages/b");
    // `!packages/skip` excludes it; `other` is outside any positive pattern
    expect(res.members).not.toContain("packages/skip");
    expect(res.members).not.toContain("other");
  });

  it("listDirs skips VCS/dependency dirs and yields repo-relative dirs", async () => {
    // a fresh dir with node_modules should be skipped
    const clean = mkdtempSync(join(tmpdir(), "ar-ws-ls-"));
    try {
      mkdirSync(join(clean, "node_modules/pkg"), { recursive: true });
      mkdirSync(join(clean, ".git") , { recursive: true });
      mkdirSync(join(clean, "src/x"), { recursive: true });
      const dirs = await listDirs(clean);
      expect(dirs).toContain("src");
      expect(dirs).toContain("src/x");
      expect(dirs.some((d) => d.includes("node_modules"))).toBe(false);
      expect(dirs.some((d) => d.includes(".git"))).toBe(false);
    } finally {
      rmSync(clean, { recursive: true, force: true });
    }
  });
});