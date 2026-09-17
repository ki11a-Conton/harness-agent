// E4-R92 regression — a test that SPAWNS a Windows-only fixture must be
// platform-guarded, or it fails on the Linux CI job that runs it.
//
// Why this exists: E4-R91 added `it("runs a real .cmd shim resolved by BARE NAME
// through runArgv end-to-end")` to an UNGUARDED describe block. It creates a
// `.cmd` shim and spawns it by bare name. That is correct on Windows
// (planArgvLaunch routes it through cmd.exe) and impossible on POSIX, which has
// no PATHEXT: a file that exists only as `tool.cmd` is not found, so the test
// failed with `spawn r91endtoend ENOENT` on the `offline cold-start (ubuntu)`
// job. The author's machine is Windows, so every local gate was green.
//
// This is a STATIC scan, deliberately: it must catch the shape without running
// the spawn. For each `it(...)` body it looks for a `.cmd`/`.bat`/`.ps1` fixture
// together with a spawn, then checks the test itself and every enclosing
// `describe` for a platform guard.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = process.cwd();

/** Test files that spawn Windows-only script fixtures. Each must guard them. */
const FILES = [join(ROOT, "packages", "tools", "src", "process", "executor.test.ts")];

/** A Windows-only script fixture, e.g. `join(dir, "tool.cmd")`. */
const WINDOWS_FIXTURE = /\.(?:cmd|bat|ps1)["'`]/;
/** Something that actually launches a process. */
const SPAWNS = /\b(?:exe\.)?runArgv\s*\(|\bspawn\s*\(|\bspawnSync\s*\(|\bexecFileSync\s*\(/;
/** A platform guard on a `describe`/`it` call. */
const GUARD = /\.(?:skipIf|runIf)\s*\(|if\s*\(\s*!?\s*isWindows\s*\)/;

/** Index of the `{` that opens `call`'s body, or -1.
 *
 *  The body brace is the first `{` reached while the call's argument list is
 *  still open (paren depth 1). That handles `it("x", async () => {` — where the
 *  arrow's own `()` balances back to 1 before the `{` — without being confused
 *  by the trailing `})` that closes the call after the body. */
function bodyStart(source: string, callIndex: number): number {
  const paren = source.indexOf("(", callIndex);
  if (paren < 0) return -1;
  let depth = 0;
  for (let i = paren; i < source.length; i++) {
    const ch = source[i];
    if (ch === "(") depth++;
    else if (ch === ")") depth--;
    else if (ch === "{" && depth === 1) return i;
  }
  return -1;
}

/** Index just past the `}` closing the block opened at `open`. */
function bodyEnd(source: string, open: number): number {
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    const ch = source[i];
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return i + 1;
    }
  }
  return source.length;
}

/**
 * Report each `it(...)` whose body creates a Windows script fixture and spawns
 * it, unless the test itself or an enclosing `describe` carries a platform guard.
 */
function unguardedWindowsSpawns(source: string): string[] {
  const offenders: string[] = [];
  const callRe = /\b(it|describe)\s*(?:\.\w+)?\s*\(/g;
  let m: RegExpExecArray | null;
  while ((m = callRe.exec(source)) !== null) {
    const open = bodyStart(source, m.index);
    if (open < 0) continue;
    const end = bodyEnd(source, open);
    const body = source.slice(open, end);
    const guardedHere = GUARD.test(source.slice(m.index, open));

    // Enclosing describes: any describe call whose body contains this `it`.
    let inheritedGuard = false;
    const dRe = /\bdescribe\s*(?:\.\w+)?\s*\(/g;
    let d: RegExpExecArray | null;
    while ((d = dRe.exec(source)) !== null) {
      if (d.index >= m.index) continue;
      const dOpen = bodyStart(source, d.index);
      if (dOpen < 0) continue;
      const dEnd = bodyEnd(source, dOpen);
      if (d.index < m.index && m.index < dEnd && GUARD.test(source.slice(d.index, dOpen))) inheritedGuard = true;
    }

    if (m[1] !== "it") continue;
    if (!WINDOWS_FIXTURE.test(body)) continue;
    if (!SPAWNS.test(body)) continue;
    if (guardedHere || inheritedGuard) continue;

    const line = source.slice(0, m.index).split("\n").length;
    offenders.push(`${line}: ${body.slice(0, 90).split("\n")[0]?.trim() ?? ""}`);
  }
  return offenders;
}

const hasUnguardedWindowsSpawn = (source: string): boolean => unguardedWindowsSpawns(source).length > 0;

/** A lowercase Windows-script fixture literal; group 1 is the stem. */
const LOWER_SCRIPT_LITERAL = /["'`]([A-Za-z0-9_.-]*?)\.(?:cmd|bat|ps1)["'`]/g;
/**
 * An uppercase (PATHEXT-spelled) fixture literal. The stem must be NON-EMPTY:
 * without that, a comment mentioning `` `.CMD` `` in prose would match and make
 * the scan believe an uppercase fixture already exists.
 */
const UPPER_SCRIPT_LITERAL = /["'`][A-Za-z0-9_-][A-Za-z0-9_.-]*\.(?:CMD|BAT|PS1)["'`]/;
/** The documented helper that writes a fixture under every probed casing. */
const BOTH_CASINGS_HELPER = /\bwriteShimBothCasings\s*\(/;

/**
 * Blank out `//` and block comments, preserving every other character AND the
 * total length, so indices and line numbers stay aligned with the original.
 *
 * This matters: E4-R91's own explanatory comment contains the text
 * ``PATHEXT spelling (`.CMD`)``. Scanning raw source lets that prose satisfy the
 * "an uppercase fixture is present" escape hatch, which silently made this scan
 * vacuous — it passed against the very file it was written to catch. String
 * literals are copied verbatim, because fixtures live inside them.
 */
function blankComments(source: string): string {
  const out = source.split("");
  let i = 0;
  const blankTo = (end: number) => {
    for (let j = i; j < end && j < out.length; j++) {
      if (out[j] !== "\n") out[j] = " ";
    }
  };
  while (i < source.length) {
    const ch = source[i];
    const next = source[i + 1];
    if (ch === "/" && next === "/") {
      let j = i;
      while (j < source.length && source[j] !== "\n") j++;
      blankTo(j);
      i = j;
      continue;
    }
    if (ch === "/" && next === "*") {
      let j = i + 2;
      while (j < source.length && !(source[j] === "*" && source[j + 1] === "/")) j++;
      blankTo(Math.min(j + 2, source.length));
      i = Math.min(j + 2, source.length);
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      const quote = ch;
      i++;
      while (i < source.length && source[i] !== quote) {
        if (source[i] === "\\") i++;
        i++;
      }
      i++;
      continue;
    }
    i++;
  }
  return out.join("");
}

/**
 * Report each unguarded `it(...)` that resolves a Windows script by BARE NAME
 * while only ever writing the LOWERCASE spelling of that fixture to disk.
 *
 * `resolveWindowsCommand` appends the PATHEXT spelling VERBATIM — uppercase
 * `.CMD` on a real Windows box — and then asks the filesystem whether that path
 * exists. Windows folds case, so a lowercase `toolname.cmd` on disk answers a
 * probe for `toolname.CMD`. ext4 does not, so the probe misses and the test fails
 * ONLY on the Linux CI job. That is exactly how E4-R91's
 * "win32 resolves a BARE name through PATH+PATHEXT" and
 * "resolves PATH case-insensitively, so an env SPREAD does not lose it" passed
 * on every Windows gate and reddened `Unit and integration tests`,
 * `coverage gate` and `offline cold-start` on ubuntu-latest.
 *
 * Only tests that call `resolveWindowsCommand` are at risk: it is the function
 * that appends the extension. A test that hands `planArgvLaunch` a FULL path
 * (e.g. the `.ps1` case) probes the exact spelling it wrote, so it is immune.
 */
function unguardedCaseFoldingReliance(rawSource: string): string[] {
  const source = blankComments(rawSource);
  const offenders: string[] = [];
  const callRe = /\b(it|describe)\s*(?:\.\w+)?\s*\(/g;
  let m: RegExpExecArray | null;
  while ((m = callRe.exec(source)) !== null) {
    if (m[1] !== "it") continue;
    const open = bodyStart(source, m.index);
    if (open < 0) continue;
    const body = source.slice(open, bodyEnd(source, open));
    // A guarded test never runs on POSIX, so it cannot red the Linux job.
    if (GUARD.test(source.slice(m.index, open))) continue;
    let inheritedGuard = false;
    const dRe = /\bdescribe\s*(?:\.\w+)?\s*\(/g;
    let d: RegExpExecArray | null;
    while ((d = dRe.exec(source)) !== null) {
      if (d.index >= m.index) continue;
      const dOpen = bodyStart(source, d.index);
      if (dOpen < 0) continue;
      if (m.index < bodyEnd(source, dOpen) && GUARD.test(source.slice(d.index, dOpen))) inheritedGuard = true;
    }
    if (inheritedGuard) continue;

    if (!/\bresolveWindowsCommand\s*\(/.test(body)) continue;
    // The documented fix: write the fixture under every probed casing.
    if (BOTH_CASINGS_HELPER.test(body)) continue;

    const stems: string[] = [];
    LOWER_SCRIPT_LITERAL.lastIndex = 0;
    let l: RegExpExecArray | null;
    while ((l = LOWER_SCRIPT_LITERAL.exec(body)) !== null) stems.push(l[1] ?? "");
    if (stems.length === 0) continue;
    // An explicit uppercase spelling in the same body is also sufficient.
    if (UPPER_SCRIPT_LITERAL.test(body)) continue;

    const line = rawSource.slice(0, m.index).split("\n").length;
    offenders.push(`${line}: writes ${stems.join(", ")} but probes the PATHEXT spelling`);
  }
  return offenders;
}

const hasCaseFoldingReliance = (source: string): boolean => unguardedCaseFoldingReliance(source).length > 0;

describe("E4-R92: Windows-only spawn fixtures are platform-guarded", () => {
  it("the scan is not vacuous: it detects an unguarded fixture", () => {
    const unguarded = [
      'describe("x", () => {',
      '  it("runs it", async () => {',
      '    const shim = join(dir, "tool.cmd");',
      "    await exe.runArgv({ file: shim });",
      "  });",
      "});",
    ].join("\n");
    expect(hasUnguardedWindowsSpawn(unguarded)).toBe(true);
  });

  it("the scan accepts a guarded test", () => {
    const guarded = [
      'describe("x", () => {',
      '  it.skipIf(!isWindows)("runs it", async () => {',
      '    const shim = join(dir, "tool.cmd");',
      "    await exe.runArgv({ file: shim });",
      "  });",
      "});",
    ].join("\n");
    expect(hasUnguardedWindowsSpawn(guarded)).toBe(false);
  });

  it("the scan accepts a test inside a guarded describe", () => {
    const guarded = [
      'describe.skipIf(!isWindows)("x", () => {',
      '  it("runs it", async () => {',
      '    const shim = join(dir, "tool.cmd");',
      "    await exe.runArgv({ file: shim });",
      "  });",
      "});",
    ].join("\n");
    expect(hasUnguardedWindowsSpawn(guarded)).toBe(false);
  });

  it("the case-folding scan is not vacuous: it detects a lowercase-only fixture", () => {
    // The exact E4-R91 shape: an UNGUARDED test writes `toolname.cmd` and probes
    // the bare name, so the resolver asks for `toolname.CMD` — a miss on ext4.
    const unguarded = [
      'describe("platform-parameterised", () => {',
      '  it("win32 resolves a BARE name through PATH+PATHEXT", () => {',
      '    const shim = join(dir, "toolname.cmd");',
      '    writeFileSync(shim, "@echo off\\r\\n", "utf8");',
      '    expect(resolveWindowsCommand("toolname", env)).not.toBeNull();',
      "  });",
      "});",
    ].join("\n");
    expect(hasCaseFoldingReliance(unguarded)).toBe(true);
  });

  it("the case-folding scan accepts the both-casings helper", () => {
    const fixed = [
      'describe("platform-parameterised", () => {',
      '  it("win32 resolves a BARE name through PATH+PATHEXT", () => {',
      '    const shim = writeShimBothCasings(dir, "toolname");',
      '    expect(resolveWindowsCommand("toolname", env)).not.toBeNull();',
      "  });",
      "});",
    ].join("\n");
    expect(hasCaseFoldingReliance(fixed)).toBe(false);
  });

  it("the case-folding scan accepts an explicit uppercase fixture", () => {
    const fixed = [
      'describe("platform-parameterised", () => {',
      '  it("win32 resolves a BARE name through PATH+PATHEXT", () => {',
      '    writeFileSync(join(dir, "toolname.CMD"), "@echo off", "utf8");',
      '    expect(resolveWindowsCommand("toolname", env)).not.toBeNull();',
      "  });",
      "});",
    ].join("\n");
    expect(hasCaseFoldingReliance(fixed)).toBe(false);
  });

  it("the case-folding scan ignores a test that passes a FULL path", () => {
    // `planArgvLaunch` with a full path probes the exact spelling it wrote, so a
    // lowercase fixture is correct there and must not be flagged.
    const immune = [
      'describe("platform-parameterised", () => {',
      '  it("win32 routes a .cmd shim through cmd.exe", () => {',
      '    const shim = join(dir, "tool.cmd");',
      '    writeFileSync(shim, "@echo off\\r\\n", "utf8");',
      '    expect(planArgvLaunch(shim, [], env, "win32").ok).toBe(true);',
      "  });",
      "});",
    ].join("\n");
    expect(hasCaseFoldingReliance(immune)).toBe(false);
  });

  for (const file of FILES) {
    it(`${file.slice(ROOT.length + 1)} guards every Windows-only spawn fixture`, () => {
      const offenders = unguardedWindowsSpawns(readFileSync(file, "utf8"));
      expect(
        offenders,
        `these tests spawn a Windows script fixture without a platform guard:\n${offenders.join("\n")}`,
      ).toEqual([]);
    });

    it(`${file.slice(ROOT.length + 1)} does not rely on the host folding case`, () => {
      const offenders = unguardedCaseFoldingReliance(readFileSync(file, "utf8"));
      expect(
        offenders,
        `these tests write a lowercase fixture but probe the PATHEXT spelling, which only a ` +
          `case-insensitive filesystem resolves — they pass on Windows and fail on Linux CI:\n` +
          offenders.join("\n"),
      ).toEqual([]);
    });
  }
});
