import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { removeFixtureAsync } from "./n2-forward-fixture.js";
it("awaits fixture deletion while preserving a referenced dependency tree through a junction/symlink", async () => {
  const root = mkdtempSync(join(tmpdir(), "n2-cleanup-")), target = join(root, "dependency"), fixture = join(root, "fixture");
  try {
    mkdirSync(target); mkdirSync(fixture); writeFileSync(join(target, "keep"), "original");
    symlinkSync(target, join(fixture, "dependency-link"), process.platform === "win32" ? "junction" : "dir");
    for (let i = 0; i < 300; i++) writeFileSync(join(fixture, `build-${i}.js`), "export {};\n");
    await removeFixtureAsync(fixture);
    expect(existsSync(fixture)).toBe(false); expect(readFileSync(join(target, "keep"), "utf8")).toBe("original");
  } finally { rmSync(root, { recursive: true, force: true }); }
});
