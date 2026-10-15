import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";

const race = vi.hoisted(() => ({ path: "", outside: "", deniedIgnore: "", armed: false }));
vi.mock("node:fs/promises", async original => {
  const fs = await original<typeof import("node:fs/promises")>();
  return { ...fs, lstat: async (...args: Parameters<typeof fs.lstat>) => {
    if (String(args[0]) === race.deniedIgnore) throw Object.assign(new Error("ignore read denied"), { code: "EACCES" });
    const observed = await fs.lstat(...args);
    if (race.armed && String(args[0]) === race.path) {
      race.armed = false; await fs.rename(race.path, race.path + "-saved");
      await fs.symlink(race.outside, race.path, process.platform === "win32" ? "junction" : "dir");
    }
    return observed;
  } };
});
import { buildSyntaxIndex } from "./syntax-index.js";
afterEach(() => { race.armed = false; race.path = ""; race.deniedIgnore = ""; });

it("C5 rejects a directory swapped for an external symlink after its initial stat", async () => {
  const root = await mkdtemp(join(tmpdir(), "syntax-race-")), outside = await mkdtemp(join(tmpdir(), "syntax-outside-"));
  try {
    await mkdir(join(root, "safe")); await writeFile(join(root, "safe/good.ts"), "function localOnly() {}\n");
    await writeFile(join(outside, "private.ts"), "function externalPrivateSymbol() {}\n");
    race.path = join(root, "safe"); race.outside = outside; race.armed = true;
    const result = await buildSyntaxIndex(root);
    expect(result.complete).toBe(false);
    expect(JSON.stringify(result)).not.toContain("externalPrivateSymbol");
    expect(result.files.some(file => file.file.endsWith("private.ts"))).toBe(false);
  } finally { await rm(root, { recursive: true, force: true }); await rm(outside, { recursive: true, force: true }); }
});
it("C5 an unreadable ignore file cannot silently broaden the index", async () => {
  const root = await mkdtemp(join(tmpdir(), "syntax-ignore-denied-"));
  try {
    await writeFile(join(root, "hidden.ts"), "function shouldNotBeScanned() {}\n");
    race.deniedIgnore = join(root, ".gitignore");
    const result = await buildSyntaxIndex(root); expect(result.files).toEqual([]); expect(result.complete).toBe(false);
  } finally { await rm(root, { recursive: true, force: true }); }
});
