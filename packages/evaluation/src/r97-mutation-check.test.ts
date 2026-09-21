/**
 * E4-R101-A (T6) — the ANTI-CHEAT mutation gate must itself be verifiable.
 *
 * WHY THIS FILE EXISTS (plan §T6 怎么做 7)
 * ---------------------------------------
 *   "mutation/反例直接改变行为：让两臂都用一个构建、跳过 verifier、固定 request=r97、
 *    绕过预算、resume 丢历史失败，对应测试必须失败."
 *
 * `r97-mutation-check.mjs` applies each of those five mutations to the real
 * production source, runs the test that exists to catch it, and requires that test
 * to FAIL. A mutation gate is only worth its runtime if its mutations really LAND:
 * a `find` string that no longer matches the file makes the "mutation" a no-op, the
 * test passes, and the gate would report... nothing, because a no-op mutation is
 * indistinguishable from a caught one unless the anchor is checked.
 *
 * So the properties pinned here are the ones that decide whether the gate can
 * report a false result:
 *
 *   - every anchor is present EXACTLY ONCE in its target file. Zero means the
 *     mutation silently does nothing; two or more means the mutation is wider than
 *     it looks, and the `replace` may land somewhere unintended;
 *   - every named test filter matches a test the named suite really declares, so
 *     the run cannot pass because it selected no tests at all;
 *   - the five mutations are the plan's five, by wording;
 *   - the mutation actually CHANGES the text.
 *
 * This is deliberately not part of the ordinary suite: the script mutates files on
 * disk, so it is invoked explicitly. What is safe to run always is the VALIDATION
 * below, which reads the anchors without writing anything.
 */

import { describe, expect, it } from "vitest";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const REPO = process.cwd();
const SCRIPT = pathToFileURL(join(REPO, "scripts", "e4", "r97-mutation-check.mjs")).href;

const mod = (await import(SCRIPT)) as {
  MUTATION_VERSION: string;
  EXIT_OK: number;
  EXIT_FAILED: number;
  EXIT_CONFIG: number;
  MUTATIONS: Array<{
    id: string;
    planWording: string;
    file: string;
    find: string;
    replace: string;
    suite: string;
    test: string;
    catchExpectation: string;
  }>;
  parseArgs: (argv: string[]) => { only?: string; out?: string };
  main: (argv: string[]) => Promise<number>;
};

describe("E4-R101-A (T6) X1: the mutation gate covers the plan's five mutations", () => {
  it("carries a version so a report can be tied to the gate that produced it", () => {
    expect(mod.MUTATION_VERSION).toMatch(/^e4-r101-mutation-check-v\d+$/);
  });

  it("declares exactly the five mutations plan 怎么做 7 names", () => {
    expect(mod.MUTATIONS).toHaveLength(5);
    const wording = mod.MUTATIONS.map((m) => m.planWording).join("\n");
    // The plan's own list, verbatim. A gate that quietly dropped one of these would
    // still report "all mutations caught".
    expect(wording).toContain("让两臂都用一个构建");
    expect(wording).toContain("跳过 verifier");
    expect(wording).toContain("固定 request=r97");
    expect(wording).toContain("绕过预算");
    expect(wording).toContain("resume 丢历史失败");
  });

  it("gives every mutation a unique id and a stated expectation", () => {
    expect(new Set(mod.MUTATIONS.map((m) => m.id)).size).toBe(mod.MUTATIONS.length);
    for (const m of mod.MUTATIONS) {
      expect(m.catchExpectation.length, `${m.id} states no expectation`).toBeGreaterThan(0);
    }
  });
});

describe("E4-R101-A (T6) X2: every mutation really LANDS on its target", () => {
  it("changes the text — a find identical to its replace is a no-op", () => {
    for (const m of mod.MUTATIONS) {
      expect(m.find, `${m.id}: find and replace are identical`).not.toBe(m.replace);
    }
  });

  it("names a production file that exists", () => {
    for (const m of mod.MUTATIONS) {
      expect(existsSync(join(REPO, m.file)), `${m.id}: ${m.file} does not exist`).toBe(true);
    }
  });

  it("matches its anchor EXACTLY ONCE — zero is a silent no-op, two is ambiguous", async () => {
    // THE LOAD-BEARING CHECK. Without it, a rename upstream turns the mutation into
    // a no-op, the test passes, and the gate reports a MISS that reads like a
    // defect in the test rather than in the anchor.
    for (const m of mod.MUTATIONS) {
      const src = await readFile(join(REPO, m.file), "utf8");
      const occurrences = src.split(m.find).length - 1;
      expect(occurrences, `${m.id}: the anchor appears ${occurrences} time(s) in ${m.file}, expected 1`).toBe(1);
    }
  });

  it("does NOT mutate a test file — a mutation must change PRODUCTION behaviour", async () => {
    for (const m of mod.MUTATIONS) {
      expect(m.file, `${m.id} mutates a test file, which proves nothing about production`).not.toMatch(
        /\.test\.ts$/,
      );
    }
  });
});

describe("E4-R101-A (T6) X3: each mutation names a test that can actually catch it", () => {
  it("names a suite that exists and declares the filtered test", async () => {
    // A `-t` filter that matches NOTHING makes vitest report success with no tests
    // run, which would look exactly like "the test did not catch the mutation" —
    // or, worse, like a pass if the assertion were inverted. So the filter is
    // checked against the suite's own declared titles.
    for (const m of mod.MUTATIONS) {
      const path = join(REPO, m.suite);
      expect(existsSync(path), `${m.id}: ${m.suite} does not exist`).toBe(true);
      const src = await readFile(path, "utf8");
      const titles = [...src.matchAll(/\bit\(\s*"((?:[^"\\]|\\.)*)"/g)].map((x) =>
        (x[1] ?? "").replace(/\\(.)/g, "$1"),
      );
      expect(titles.length, `${m.id}: ${m.suite} declares no tests`).toBeGreaterThan(0);
      expect(
        titles.some((t) => t.includes(m.test)),
        `${m.id}: no test in ${m.suite} contains "${m.test}" — the filter would select nothing`,
      ).toBe(true);
    }
  });

  it("binds each mutation to a DIFFERENT test, so one break cannot cover five", () => {
    const keys = mod.MUTATIONS.map((m) => `${m.suite}::${m.test}`);
    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe("E4-R101-A (T6) X4: the gate refuses to run on a bad request", () => {
  it("refuses `--only` with an id that matches no mutation", async () => {
    // Silently running zero mutations and exiting 0 is the failure mode that would
    // make this gate decorative.
    await expect(mod.main(["--only", "definitely-not-a-mutation"])).resolves.toBe(mod.EXIT_CONFIG);
  });

  it("refuses a flag with no value", () => {
    // Whichever flag the parser reaches first is the one it names; the CONTRACT is
    // that a value-less flag is refused rather than read as the next flag.
    expect(() => mod.parseArgs(["--out", "--only"])).toThrow(/requires a value/);
    expect(() => mod.parseArgs(["--only"])).toThrow(/--only requires a value/);
  });

  it("selects the whole set when no --only is given", () => {
    expect(mod.parseArgs([]).only).toBeUndefined();
  });
});
