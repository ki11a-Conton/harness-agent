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

  for (const file of FILES) {
    it(`${file.slice(ROOT.length + 1)} guards every Windows-only spawn fixture`, () => {
      const offenders = unguardedWindowsSpawns(readFileSync(file, "utf8"));
      expect(
        offenders,
        `these tests spawn a Windows script fixture without a platform guard:\n${offenders.join("\n")}`,
      ).toEqual([]);
    });
  }
});
