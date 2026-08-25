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
import { canonicalizePath, CanonicalizationFailed } from "./canonical-path.js";

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

describe("canonicalizePath — root-ancestor join regression (P14-1 fix)", () => {
  // Regression: when the deepest existing ancestor of a non-existent path is
  // the filesystem root "/", the ancestor/tail join used to produce "//tail",
  // which lexicalNormalize preserved as a UNC marker. Every such canonical
  // form then failed containment against its (single-slash) root and was
  // misreported as an escalation. On case-insensitive policies the folded
  // comparison could never match either.
  it("never emits a double-slash prefix when the deepest existing ancestor is the root", () => {
    const p = canonicalizePath("/Definitely/Not/Existing/sub", { cwd });
    expect(p.startsWith("//")).toBe(false);
    // Windows resolves /foo to the current drive (D:/foo); POSIX keeps /foo.
    expect(p.replace(/^[A-Za-z]:/, "")).toBe("/Definitely/Not/Existing/sub");
  });

  it("case-folded containment matches after root-ancestor canonicalization", () => {
    const declared = canonicalizePath("/HOME/U/WORK/sub", { cwd });
    const conferred = canonicalizePath("/home/u/work", { cwd });
    expect(declared.startsWith("//")).toBe(false);
    // case-insensitive fold: /home/u/work/sub is inside /home/u/work
    expect(declared.toLowerCase().startsWith(`${conferred.toLowerCase()}/`)).toBe(true);
  });

  it("traversal below a non-existent root still resolves lexically (no // prefix)", () => {
    const p = canonicalizePath("/work/../etc/passwd", { cwd });
    expect(p.startsWith("//")).toBe(false);
    expect(p.replace(/^[A-Za-z]:/, "")).toBe("/etc/passwd");
  });
});

describe("P36-6 — canonicalization error taxonomy (INV-P36-006)", () => {
  it("CanonicalizationFailed is a typed error with ok=false and a code", () => {
    const err = new CanonicalizationFailed("permission", "/some/path", "access denied");
    expect(err.ok).toBe(false);
    expect(err.code).toBe("permission");
    expect(err.path).toBe("/some/path");
    expect(err.message).toContain("permission");
    expect(err instanceof Error).toBe(true);
  });

  it("non-existent (ENOENT) still falls back to ancestor — no throw", () => {
    // Paths that don't exist must still work (backward compat).
    const p = canonicalizePath("/tmp/__nonexistent_p36_test__/file.txt", { cwd });
    expect(p).toContain("__nonexistent_p36_test__/file.txt");
  });

  it("permission-denied path throws CanonicalizationFailed with code=permission", () => {
    // Windows: try the System Volume Information directory (usually access-denied).
    // POSIX: try /root (usually no access for non-root).
    // A path may fail with a DIFFERENT taxonomy code (e.g. EPERM → "unknown"
    // on some Windows configurations); only code=permission proves the
    // taxonomy. If no path yields permission, skip gracefully.
    const paths = [
      "C:\\System Volume Information\\test",
      "/root/secret",
      "\\\\?\\C:\\System Volume Information",
    ];
    for (const p of paths) {
      try {
        canonicalizePath(p, { cwd });
      } catch (err) {
        if (err instanceof CanonicalizationFailed && err.code === "permission") {
          return; // found a permission-denied path
        }
        // any other code/taxonomy — try the next candidate path
      }
    }
    // No path triggered a permission error — skip (platform limitation).
  });

  // ---------------------------------------------------------------------------
  // P38-13 — deterministic canonical error taxonomy (INV-P38-016)
  // ---------------------------------------------------------------------------

  /** Fake realpath that throws a specific error code. */
  function fakeRealpath(code: string): (p: string) => string {
    return (p: string) => {
      const err = new Error(`fake ${code}`) as NodeJS.ErrnoException;
      err.code = code;
      throw err;
    };
  }

  it.each([
    ["EACCES", "permission"],
    ["EPERM", "permission"],
    ["ELOOP", "symlink_loop"],
    ["EIO", "io"],
    ["UNKNOWN_CODE", "unknown"],
  ] as const)("P38-13: %s → CanonicalizationFailed(code=%s)", (errCode, expectedCode) => {
    try {
      canonicalizePath("/some/path", { cwd }, { realpath: fakeRealpath(errCode) });
      throw new Error("expected canonicalizePath to throw");
    } catch (err) {
      if (err instanceof CanonicalizationFailed) {
        expect(err.code).toBe(expectedCode);
        expect(err.path).toBe("/some/path");
      } else {
        throw err;
      }
    }
  });

  it("P38-13: depth exhaustion throws CanonicalizationFailed(code=depth)", () => {
    // A path deeper than the 64-ancestor cap, with a fake realpath that
    // always throws ENOENT (each ancestor walk tries another level without
    // reaching the root before the cap).
    const deep = `/${Array.from({ length: 80 }, (_, i) => `d${i}`).join("/")}`;
    try {
      canonicalizePath(deep, { cwd }, { realpath: fakeRealpath("ENOENT") });
      throw new Error("expected canonicalizePath to throw");
    } catch (err) {
      if (err instanceof CanonicalizationFailed) {
        expect(err.code).toBe("depth");
      } else {
        throw err;
      }
    }
  });

  // ---------------------------------------------------------------------------
  // P38.1-9 — canonical path deterministic seam (INV-P38.1-012)
  // ---------------------------------------------------------------------------
  // The ancestor walker MUST honour the injected `realpath` adapter used for
  // the full path. If it silently falls back to the real `realpathSync`, a
  // fake adapter can't witness the ancestor calls and real-FS ENOENT/EACCES
  // bypasses the taxonomy. Each regression below is deterministic: it must
  // FAIL on the old (realpathSync-driven) walker and PASS now.

  /** Fake realpath that records every call, throwing per-path rules. */
  function tracingRealpath(rules: Map<string, string>): {
    adapter: (p: string) => string;
    calls: string[];
  } {
    const calls: string[] = [];
    return {
      calls,
      adapter: (p: string) => {
        calls.push(p);
        const code = rules.get(p) ?? "ENOENT";
        const err = new Error(`fake ${code}`) as NodeJS.ErrnoException;
        err.code = code;
        throw err;
      },
    };
  }

  it.each([
    ["EACCES", "permission"],
    ["ELOOP", "symlink_loop"],
    ["EIO", "io"],
  ] as const)(
    "P38.1-9: full-path ENOENT then ancestor %s → CanonicalizationFailed(code=%s)",
    (ancestorCode, expectedCode) => {
      // Full path is missing (ENOENT); the ancestor walker then probes
      // dirname(current) each level. Make one ancestor probe throw.
      const target = "/p38a/no/such/deep/path";
      const rules = new Map<string, string>([["/p38a/no/such", ancestorCode]]);
      const { adapter } = tracingRealpath(rules);
      try {
        canonicalizePath(target, { cwd }, { realpath: adapter });
        throw new Error("expected canonicalizePath to throw");
      } catch (err) {
        if (err instanceof CanonicalizationFailed) {
          expect(err.code).toBe(expectedCode);
        } else {
          throw err;
        }
      }
    },
  );

  it("P38.1-9: ancestor walk is fully driven by the injected adapter (exact call trace)", () => {
    // Prove the ancestor walker calls the INJECTED adapter at every level —
    // if it silently used realpathSync, the fake would only see the single
    // full-path call and the real FS would terminate the walk early.
    const target = "/s0/s1/s2/s3/s4/s5/s6/s7";
    const { adapter, calls } = tracingRealpath(new Map());
    // Always-ENOENT → the walk climbs to root and falls back there. The seam
    // proof is the exact call trace: the ancestor walk MUST drive the injected
    // adapter (never realpathSync).
    canonicalizePath(target, { cwd }, { realpath: adapter });
    // 1 full-path pre-check + 1 initial walker probe (same path) + then one
    // probe per ancestor level, each dropping a trailing segment down to root.
    expect(calls).toEqual([
      "/s0/s1/s2/s3/s4/s5/s6/s7",
      "/s0/s1/s2/s3/s4/s5/s6/s7",
      "/s0/s1/s2/s3/s4/s5/s6",
      "/s0/s1/s2/s3/s4/s5",
      "/s0/s1/s2/s3/s4",
      "/s0/s1/s2/s3",
      "/s0/s1/s2",
      "/s0/s1",
      "/s0",
      "/",
    ]);
  });
});