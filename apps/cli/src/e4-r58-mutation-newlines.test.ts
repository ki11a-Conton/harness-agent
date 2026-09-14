/**
 * E4-R58 (G58) — the order mutation must work on LF *and* CRLF sources.
 *
 * `mutateChainOrdering` located its markers with `\n<marker>\n`. On a Windows
 * checkout (git `core.autocrlf`) the module on disk is CRLF, so between the
 * marker and the next line there is `\r\n` — the needle never matched and the
 * mutation threw `START marker is not a standalone line`. That is exactly the
 * failure the Windows CI gate reported for `e4-r55-failure-wiring.test.ts`.
 *
 * The line-anchored requirement must SURVIVE the fix: this module's own string
 * constants contain the same marker text, so a bare `indexOf` would splice the
 * block into a literal (that bug was already hit once during R55 development).
 *
 * The pure-function cases below run on BOTH newline conventions built from the
 * real module, so the regression is covered on any checkout.
 */
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import {
  MUTATION_ASSERT,
  MUTATION_END,
  MUTATION_START,
  mutateChainOrdering,
} from "./e4-09-real-chain.js";

const CHAIN_PATH = resolve(fileURLToPath(new URL("./e4-09-real-chain.ts", import.meta.url)));

let LF = "";
let CRLF = "";

beforeAll(async () => {
  const onDisk = await readFile(CHAIN_PATH, "utf8");
  // Build both conventions from the REAL module so the regression is covered
  // regardless of how this working copy happens to be checked out.
  LF = onDisk.replace(/\r\n/g, "\n");
  CRLF = LF.replace(/\n/g, "\r\n");
});

/**
 * The helpers below are newline-agnostic on purpose: the declared contract is
 * that the generated copy is canonical LF, so an invariant like "the marker
 * constants are unchanged" must be stated modulo the declared EOL normalisation
 * (otherwise a CRLF input line would compare unequal purely because of its `\r`).
 */
const toLines = (text: string): string[] => text.replace(/\r\n/g, "\n").split("\n");

/** Line index of a standalone `line`, or -1. */
const lineIndex = (text: string, line: string): number => toLines(text).indexOf(line);

/** The `export const MUTATION_*` declaration lines, verbatim (quote-agnostic). */
const constLinesOf = (text: string): string[] =>
  toLines(text).filter((l) => l.startsWith("export const MUTATION_"));

/** Build a synthetic module containing the three markers (plus the hazards). */
function synthetic(opts: { start?: number; end?: number; assert?: number; block?: boolean }): string {
  const constLines = [
    `export const MUTATION_START = ${JSON.stringify(MUTATION_START)};`,
    `export const MUTATION_END = ${JSON.stringify(MUTATION_END)};`,
    `export const MUTATION_ASSERT = ${JSON.stringify(MUTATION_ASSERT)};`,
  ];
  const body: string[] = [];
  const push = (n: number, line: string): void => {
    for (let i = 0; i < n; i += 1) body.push(line);
  };
  const startN = opts.start ?? 1;
  const endN = opts.end ?? 1;
  const assertN = opts.assert ?? 1;
  // Default order: START, END, assert (the real module's order).
  push(startN, MUTATION_START);
  if (opts.block !== false) body.push("  await writeFile(decisionArtifactPath, body, \"utf8\");");
  push(endN, MUTATION_END);
  push(assertN, MUTATION_ASSERT);
  return [...constLines, "", "export function demo(): void {", ...body, "}"].join("\n") + "\n";
}

describe("E4-R58 mutation works on LF and CRLF", () => {
  it("A: both conventions mutate successfully and produce the SAME bytes", () => {
    const fromLf = mutateChainOrdering(LF);
    const fromCrlf = mutateChainOrdering(CRLF);

    // Both inputs must be accepted (the CRLF case is the Windows regression).
    expect(fromLf).not.toBe(LF);
    expect(fromCrlf).not.toBe(CRLF);
    // Stronger than "identical after normalising": byte-identical.
    expect(fromCrlf).toBe(fromLf);
    // The generated copy is canonical LF — one declared output convention.
    expect(fromLf.includes("\r")).toBe(false);
  });

  it("B: the block really moves AFTER the assert, and the marker constants are not corrupted", () => {
    for (const [label, source] of [["LF", LF], ["CRLF", CRLF]] as const) {
      const out = mutateChainOrdering(source);
      const s = lineIndex(out, MUTATION_START);
      const e = lineIndex(out, MUTATION_END);
      const a = lineIndex(out, MUTATION_ASSERT);
      expect(s, `${label}: START marker must still be a standalone line`).toBeGreaterThan(-1);
      expect(e, `${label}: END marker must still be a standalone line`).toBeGreaterThan(-1);
      expect(a, `${label}: assert must still be a standalone line`).toBeGreaterThan(-1);
      // moved AFTER the assert
      expect(s, `${label}: block must follow the assert`).toBeGreaterThan(a);
      expect(e, `${label}: END must follow START`).toBeGreaterThan(s);
      // exactly one of each — no duplication from a bad splice
      const lines = out.split("\n");
      expect(lines.filter((l) => l === MUTATION_START)).toHaveLength(1);
      expect(lines.filter((l) => l === MUTATION_END)).toHaveLength(1);
      expect(lines.filter((l) => l === MUTATION_ASSERT)).toHaveLength(1);
      // the constants that CONTAIN the marker text are untouched
      expect(constLinesOf(out), `${label}: marker constants must be untouched`).toEqual(constLinesOf(source));
    }
  });

  it("C: marker text inside a string literal is never matched (line-anchored matching survives)", () => {
    const src = synthetic({});
    // the constants carry the same text as the markers
    expect(src).toContain(JSON.stringify(MUTATION_START));
    const out = mutateChainOrdering(src);
    // the literal declarations survive verbatim; only the real marker line moved
    expect(constLinesOf(out)).toEqual(constLinesOf(src));
    expect(out.split("\n").filter((l) => l === MUTATION_START)).toHaveLength(1);
  });

  it("D: missing / duplicated / mis-ordered markers and a missing assert all fail loudly", () => {
    expect(() => mutateChainOrdering(synthetic({ start: 0 }))).toThrow(/START/);
    expect(() => mutateChainOrdering(synthetic({ end: 0 }))).toThrow(/END/);
    expect(() => mutateChainOrdering(synthetic({ assert: 0 }))).toThrow(/ACCEPT assert/);
    expect(() => mutateChainOrdering(synthetic({ start: 2 }))).toThrow(/exactly ONE|START/);
    expect(() => mutateChainOrdering(synthetic({ end: 2 }))).toThrow(/exactly ONE|END/);
    expect(() => mutateChainOrdering(synthetic({ assert: 2 }))).toThrow(/exactly ONE|ACCEPT assert/);
    // END placed before START
    const misordered = [
      `export const MUTATION_START = ${JSON.stringify(MUTATION_START)};`,
      "",
      MUTATION_END,
      MUTATION_START,
      MUTATION_ASSERT,
      "",
    ].join("\n");
    expect(() => mutateChainOrdering(misordered)).toThrow(/order|before|after/i);
  });

  it("E: CRLF input with the markers present is not silently returned unmutated", () => {
    const out = mutateChainOrdering(CRLF);
    // The old implementation threw here; a silent no-op would be worse. Assert
    // the ordering really changed: block BEFORE the assert in, AFTER it out.
    expect(lineIndex(CRLF, MUTATION_START)).toBeLessThan(lineIndex(CRLF, MUTATION_ASSERT));
    expect(lineIndex(out, MUTATION_START)).toBeGreaterThan(lineIndex(out, MUTATION_ASSERT));
  });
});
