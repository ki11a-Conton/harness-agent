/**
 * P14-1 — canonicalizePath unit tests.
 *
 * Directly verifies the I/O layer contract that both SandboxManager and the
 * capability guard share:
 *   - existing path → realpath (symlink/junction resolved)
 *   - non-existent path → realpath(deepest existing ancestor) + lexically
 *     resolved tail (a not-yet-existing write target can never escape via `..`)
 */
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { canonicalizePath } from "./canonical-path.js";

let base: string;
let ws: string;
let outside: string;
const cwd = process.cwd();

beforeAll(() => {
  base = mkdtempSync(join(tmpdir(), "ar-canon-"));
  ws = join(base, "ws");
  outside = join(base, "outside");
  mkdirSync(join(ws, "sub"), { recursive: true });
  mkdirSync(outside, { recursive: true });
  writeFileSync(join(ws, "sub", "file.txt"), "hello");
  writeFileSync(join(outside, "secret.txt"), "top secret");
});

afterAll(() => {
  rmSync(base, { recursive: true, force: true });
});

describe("canonicalizePath — existing paths", () => {
  it("returns the realpath of an existing file (symlink-free)", () => {
    const p = canonicalizePath(join(ws, "sub", "file.txt"), { cwd });
    expect(p.endsWith("sub/file.txt")).toBe(true);
    expect(p.startsWith(ws.replace(/\\/g, "/"))).toBe(true);
  });

  it("resolves a symlink to its real target (no textual illusion)", () => {
    const link = join(ws, "secret-link");
    try {
      symlinkSync(join(outside, "secret.txt"), link);
    } catch {
      return; // symlink unsupported
    }
    const p = canonicalizePath(link, { cwd });
    expect(p.endsWith("outside/secret.txt")).toBe(true);
    expect(p.startsWith(outside.replace(/\\/g, "/"))).toBe(true);
  });
});

describe("canonicalizePath — non-existent paths (write scenario)", () => {
  it("resolves the deepest existing ancestor and keeps the tail", () => {
    const p = canonicalizePath(join(ws, "newdir", "deep", "file.txt"), { cwd });
    expect(p.endsWith("ws/newdir/deep/file.txt")).toBe(true);
    expect(p.startsWith(ws.replace(/\\/g, "/"))).toBe(true);
  });

  it("a .. in the tail cannot climb above the deepest existing ancestor", () => {
    // base/ws/newdir/../../outside/secret.txt → the tail `newdir/../../outside`
    // climbs out of ws → resolves to base/outside/secret.txt (outside ws).
    const baseSlash = base.replace(/\\/g, "/");
    const outsideSlash = outside.replace(/\\/g, "/");
    const p = canonicalizePath(`${baseSlash}/ws/newdir/../../outside/secret.txt`, { cwd });
    expect(p.startsWith(outsideSlash)).toBe(true);
  });

  it("a . in the tail is a no-op", () => {
    const p = canonicalizePath(`${ws.replace(/\\/g, "/")}/./newdir/./file.txt`, { cwd });
    expect(p.endsWith("ws/newdir/file.txt")).toBe(true);
  });

  it("trailing separators are stripped", () => {
    const p = canonicalizePath(`${ws.replace(/\\/g, "/")}/newdir/`, { cwd });
    expect(p.endsWith("ws/newdir")).toBe(true);
  });
});

describe("canonicalizePath — invalid inputs", () => {
  it("throws on empty input", () => {
    expect(() => canonicalizePath("", { cwd })).toThrow();
  });

  it("throws on control characters", () => {
    expect(() => canonicalizePath("ok\u0000name", { cwd })).toThrow();
    expect(() => canonicalizePath("\npath", { cwd })).toThrow();
  });
});

describe("canonicalizePath — traversal cannot escape", () => {
  it("/work/../etc style input resolves to a path NOT inside /work", () => {
    // Real filesystem: /work doesn't exist; deepest existing ancestor is the
    // filesystem root; tail `work/../etc` lexically resolves to /etc — which
    // is NOT inside /work. isPathWithin(/etc, /work) === false.
    const p = canonicalizePath("/work/../etc/passwd", { cwd });
    expect(p.endsWith("/etc/passwd") || p.endsWith("etc/passwd")).toBe(true);
    expect(p.startsWith("/work") || p.startsWith("C:/work")).toBe(false);
  });

  it("/work/a/../../etc also resolves outside /work", () => {
    const p = canonicalizePath("/work/a/../../etc", { cwd });
    expect(p.endsWith("/etc") || p.endsWith("etc")).toBe(true);
  });
});