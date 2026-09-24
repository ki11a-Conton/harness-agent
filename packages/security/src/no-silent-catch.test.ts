// P14-6 — static scan: no silent security/recovery catches.
//
// This lint test scans the production source tree (packages/**/src,
// apps/**/src) and FAILS on any pattern that silently swallows an error:
//
//   1. `.catch(() => {})`            — fire-and-forget with zero observability
//   2. `.catch(() => undefined)`     — same, returning undefined
//   3. `catch { /* comments only */ }` — an empty catch block (no fallback
//      logic, no typed report, no fail-closed return)
//
// Best-effort / cleanup / telemetry failures must go through a typed channel
// (NonFatalErrorSink / runtime.degraded / a `[degraded]` stderr report) or be
// explicit fail-closed logic. A comment next to a catch does NOT satisfy this:
// comments are not observable.
//
// Excluded: test files (*.test.ts), dist/, node_modules/, .git/, coverage/.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = process.cwd();
const IGNORED_DIRS = new Set(["node_modules", "dist", ".git", "coverage"]);

/** Strip // and /* *\/ comments so a comment mentioning a forbidden pattern
 *  does not trip the scan. Strings that literally contain the pattern are
 *  intentionally NOT stripped (a source file shipping the pattern in a string
 *  is still a smell worth a human review). */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .map((line) => line.replace(/\/\/.*$/, ""))
    .join("\n");
}

/** Collect non-test .ts sources under a directory (recursive). */
function collectSources(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!IGNORED_DIRS.has(entry.name)) collectSources(join(dir, entry.name), out);
    } else if (entry.isFile() && entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) {
      out.push(join(dir, entry.name));
    }
  }
  return out;
}

interface Match {
  file: string;
  line: number;
  snippet: string;
}

/** Find every match of `pattern` in the stripped source with 1-based lines. */
function findMatches(src: string, pattern: RegExp, file: string): Match[] {
  const matches: Match[] = [];
  for (const match of src.matchAll(pattern)) {
    const index = match.index ?? 0;
    const line = src.slice(0, index).split("\n").length;
    const snippet = match[0].length > 80 ? `${match[0].slice(0, 77)}...` : match[0];
    matches.push({ file: relative(ROOT, file), line, snippet: snippet.replace(/\n/g, "\\n") });
  }
  return matches;
}

// Patterns are built by concatenation so THIS file never contains the literal
// forbidden sequence (defense-in-depth for the very scan it performs).
const DOT = ".";
const OPEN = "(";
const CLOSE = ")";
const EMPTY_CALLBACK_CATCH = new RegExp(
  `${DOT}catch\\s*\\(\\s*(?:async\\s*)?\\(\\s*\\)\\s*=>\\s*\\{\\s*\\}\\)`,
  "g",
);
const UNDEFINED_CALLBACK_CATCH = new RegExp(
  `${DOT}catch\\s*\\(\\s*\\(\\s*\\)\\s*=>\\s*undefined\\s*\\)`,
  "g",
);
const EMPTY_CATCH_BLOCK = new RegExp(
  `catch\\s*\\{\\s*(?:(?:\\/\\*[\\s\\S]*?\\*\\/)|(?:\\/\\/[^\\n]*\\n)|[\\s])*?\\}`,
  "g",
);

describe("P14-6: no silent security/recovery catches (static scan)", () => {
  const sources = collectSources(join(ROOT, "packages"))
    .concat(collectSources(join(ROOT, "apps")))
    .sort();

  it("scans a non-empty production tree", () => {
    expect(sources.length).toBeGreaterThan(100);
  });

  it("forbids `.catch(() => {})` fire-and-forget swallows", () => {
    const hits: Match[] = [];
    for (const file of sources) {
      const stripped = stripComments(readFileSync(file, "utf8"));
      hits.push(...findMatches(stripped, EMPTY_CALLBACK_CATCH, file));
    }
    expect(hits, JSON.stringify(hits, null, 2)).toEqual([]);
  });

  it("forbids `.catch(() => undefined)` swallows", () => {
    const hits: Match[] = [];
    for (const file of sources) {
      const stripped = stripComments(readFileSync(file, "utf8"));
      hits.push(...findMatches(stripped, UNDEFINED_CALLBACK_CATCH, file));
    }
    expect(hits, JSON.stringify(hits, null, 2)).toEqual([]);
  });

  it("forbids empty catch blocks (comments are not observability)", () => {
    const hits: Match[] = [];
    for (const file of sources) {
      const stripped = stripComments(readFileSync(file, "utf8"));
      hits.push(...findMatches(stripped, EMPTY_CATCH_BLOCK, file));
    }
    expect(hits, JSON.stringify(hits, null, 2)).toEqual([]);
  });
});
