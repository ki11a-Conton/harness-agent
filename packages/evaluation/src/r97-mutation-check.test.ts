/**
 * E4-R101-A (T6) — the ANTI-CHEAT mutation gate must itself be verifiable.
 *
 * WHY THIS FILE EXISTS (plan §T6 怎么做 7)
 * ---------------------------------------
 *   "mutation/反例直接改变行为：让两臂都用一个构建、跳过 verifier、固定 request=r97、
 *    绕过预算、resume 丢历史失败，对应测试必须失败."
 *
 * `r97-mutation-check.mjs` applies each of those five mutations (plus A7's and A8's
 * counterexample mutations) to the real production source, runs the test that exists
 * to catch it, and requires that test to FAIL. A mutation gate is only worth its
 * runtime if its mutations really LAND:
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
    /** Which round's defect list this mutation came from: T6's five, or A7's five. */
    round: "T6" | "A7";
    file: string;
    find: string;
    replace: string;
    suite: string;
    test: string;
    catchExpectation: string;
  }>;
  parseArgs: (argv: string[]) => { only?: string; out?: string };
  main: (argv: string[]) => Promise<number>;
  anchorOccurrences: (source: string, find: string) => number;
  classifyCatch: (opts: { exitCode: number; output: string; testFilter: string }) => {
    caught: boolean;
    failedTestNamed: boolean;
    reason: string | null;
  };
  /**
   * E4-R101-A (A8): the pre-existing-mutation guard. Exported as a pure function so
   * BOTH directions — it fires on a mutated target, and it does NOT fire on a healthy
   * one — can be pinned here rather than only observed when a mutation misfires.
   */
  isPreexistingMutation: (opts: { findCount: number; replaceCount: number }) => boolean;
  preexistingMutationReason: (mutation: { file: string }, replaceCount: number) => string;
  /**
   * E4-R101-A (A8): the ANSI stripper. CI run 35972462139 reported 0/12 caught on both
   * platforms because vitest colors its reporter on a runner and the line-anchored
   * FAILED marker stopped matching. Exported so the colored case is pinned by a test.
   */
  stripAnsi: (text: string) => string;
};
describe("E4-R101-A (T6) X1: the mutation gate covers the plan's five mutations", () => {
  it("carries a version so a report can be tied to the gate that produced it", () => {
    expect(mod.MUTATION_VERSION).toMatch(/^e4-r101-mutation-check-v\d+$/);
  });

  it("declares exactly the five T6 mutations plan 怎么做 7 names, alongside A7's five", () => {
    // A7 ADDED five mutations (plan §A7 怎么做 3) to the SAME list, because the
    // restoration discipline must have one home. The T6 five are still pinned as an
    // exact SET rather than as "at least five": a gate that quietly dropped one of
    // the plan's original five would otherwise still report "all mutations caught",
    // which is the failure this assertion exists to prevent.
    const t6 = mod.MUTATIONS.filter((m) => m.round === "T6");
    expect(t6, "the T6 mutation set must be exactly the plan's five").toHaveLength(5);
    const wording = t6.map((m) => m.planWording).join("\n");
    // The plan's own list, verbatim.
    expect(wording).toContain("让两臂都用一个构建");
    expect(wording).toContain("跳过 verifier");
    expect(wording).toContain("固定 request=r97");
    expect(wording).toContain("绕过预算");
    expect(wording).toContain("resume 丢历史失败");
  });

  it("declares one A7 counterexample mutation per closed counterexample, plus A4's formal path", () => {
    // The A7 set was FIVE while A4's formal-path binding was still PARTIAL: the
    // counterexamples A1, A2, A3, A5 and A6 each got one mutation, and A4 could not
    // have one because the defect it names was not fixed on the formal path yet.
    // A4's formal path is now closed (§9.8b), so its mutation joins this set and the
    // count became SIX. A8 added the WORKER-LEVEL half of A1/F1 — the residual gap
    // `docs/E4-R99-R101-report.md:2370` names — bringing it to SEVEN: the existing
    // `a1-skip-generator-finally-settlement` covers the CHANNEL's settlement, and
    // `a1-worker-settlement-failure-refunded` covers the WORKER's handling of it.
    // Pinned as an exact SET rather than "at least": a gate that quietly dropped one
    // would otherwise still report "all mutations caught".
    const a7 = mod.MUTATIONS.filter((m) => m.round === "A7");
    expect(a7, "A7 must add one mutation per counterexample it closed").toHaveLength(7);
    const wording = a7.map((m) => m.planWording).join("\n");
    expect(wording).toContain("跳过 generator finally 结算");
    expect(wording).toContain("允许丢失根目录重新领取");
    expect(wording).toContain("把正式时钟改回快照");
    expect(wording).toContain("恢复 verdict 覆盖");
    expect(wording).toContain("断开当前 unit 的取消");
    // A4/F4's formal-path half: removing the driver's `approvedBuildDigest`
    // forwarding restores the pre-fix behaviour, where a rebuilt `dist/` could run
    // under an old approval because nothing bound the executed bytes.
    expect(wording).toContain("移除正式路径的构建身份绑定");
    // The worker-level half of A1/F1: routing an ENTERED-but-unsettled dispatch to
    // the refund path restores the pre-A1 behaviour the report's :2370 gap is about.
    expect(wording).toContain("已进入但未结算的调用被退款");
  });

  it("tags every mutation with the round whose defect list it came from", () => {
    // The tag is what lets the two sets above be asserted as exact sets. An
    // untagged entry would be invisible to BOTH, so it is a failure rather than a
    // silently-ignored extra.
    for (const m of mod.MUTATIONS) {
      expect(["T6", "A7"], `${m.id} has no round tag`).toContain(m.round);
    }
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
    //
    // It counts through the gate's OWN matcher rather than a raw `split`, because
    // the gate normalizes line endings (X5): a raw split would fail on a CRLF
    // checkout for a reason that has nothing to do with the anchor, which is
    // exactly what happened in CI run 35560959837.
    for (const m of mod.MUTATIONS) {
      const src = await readFile(join(REPO, m.file), "utf8");
      const occurrences = mod.anchorOccurrences(src, m.find);
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

describe("E4-R101-A (T6) X5: an anchor is matched independently of the checkout's EOL policy", () => {
  /**
   * MEASURED (CI run 35560959837): `r97-r98 closed loop (windows-latest)` failed
   * with
   *
   *   skip-verifier: the anchor appears 0 time(s) in scripts/e4/r97-arm-worker.mjs,
   *   expected 1
   *
   * and the Windows `Unit and integration tests` job failed the same assertion.
   * Ubuntu passed, and `pnpm test:coverage` (which includes this file) passed too,
   * which is what pinned the cause to the checkout rather than to the anchor.
   *
   * The cause is EOL rewriting, not a stale anchor: `git ls-files --eol` reports
   * `i/lf` for all five target files, while `core.autocrlf=true` (true in the repo
   * and in a fresh clone) rewrites a Windows checkout to CRLF. The two anchors that
   * span more than one line — `skip-verifier` and `resume-loses-history` — are the
   * only ones affected, because only they contain an interior newline. Measured
   * directly: rewriting the real file to CRLF makes exactly those two anchors
   * match 0 times.
   *
   * An anchor is a SOURCE-level construct. The line ending a particular checkout
   * happens to use is not part of the program, so the matcher must not treat it as
   * significant — otherwise this gate silently degrades to "0 occurrences" on one
   * of the two platforms T6 requires.
   */
  it("still finds its anchor when the checkout rewrote the file to CRLF", async () => {
    expect(typeof mod.anchorOccurrences, "the gate exposes no EOL-insensitive anchor matcher").toBe("function");
    for (const m of mod.MUTATIONS) {
      const src = await readFile(join(REPO, m.file), "utf8");
      const crlf = src.replace(/\r\n/g, "\n").replace(/\n/g, "\r\n");
      expect(
        mod.anchorOccurrences(crlf, m.find),
        `${m.id}: the anchor is invisible in ${m.file} on a CRLF checkout`,
      ).toBe(1);
    }
  });

  it("finds an anchor that itself arrived with CRLF line endings", async () => {
    expect(typeof mod.anchorOccurrences, "the gate exposes no EOL-insensitive anchor matcher").toBe("function");
    for (const m of mod.MUTATIONS) {
      const src = await readFile(join(REPO, m.file), "utf8");
      const crlfFind = m.find.replace(/\r\n/g, "\n").replace(/\n/g, "\r\n");
      expect(
        mod.anchorOccurrences(src, crlfFind),
        `${m.id}: an anchor written with CRLF is invisible in ${m.file}`,
      ).toBe(1);
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

/**
 * E4-R101-A (A7) X6 — a CAUGHT mutation means the SELECTED TEST went red, not merely
 * that something exited non-zero.
 *
 * Plan §A7 怎么做 4: "断言对应测试真正 RED，不接受语法错误、构建失败或 unrelated timeout
 * 冒充捕获了缺陷." This is the decision at the centre of the whole gate: if a build
 * failure or a timeout counted as "caught", every mutation would appear caught and
 * the gate would certify a suite that detects nothing.
 *
 * The cases below are the exact shapes those false positives take in vitest's output.
 */
describe("E4-R101-A (A7) X6: only a real FAILED TEST counts as catching the mutation", () => {
  const FILTER = "grant=1, the consumer breaks mid-stream and the CLI throws";
  /** The verbose reporter's own failing-test line for the selected test. */
  const REAL_RED = [
    " FAIL  packages/evaluation/src/r97-arm-worker-contract.test.ts > R99 W11 (A1/F1): a DISPATCHED call is never refunded when the arm CLI dies afterwards > " +
      FILTER,
    "AssertionError: an ENTERED call is never refunded as abandoned: expected 'reserved' to be 'unknown'",
    " Test Files  1 failed (1)",
    "      Tests  1 failed (1)",
  ].join("\n");

  it("counts a genuine failing assertion as CAUGHT", () => {
    const v = mod.classifyCatch({ exitCode: 1, output: REAL_RED, testFilter: FILTER });
    expect(v.caught).toBe(true);
    expect(v.failedTestNamed).toBe(true);
    expect(v.reason).toBeNull();
  });

  it("REFUSES a passing run, even though the gate would like it to be red", () => {
    const v = mod.classifyCatch({
      exitCode: 0,
      output: ` ✓ packages/evaluation/src/r97-arm-worker-contract.test.ts (56 tests)\n  ${FILTER}`,
      testFilter: FILTER,
    });
    expect(v.caught).toBe(false);
    expect(v.reason).toMatch(/PASSED with the mutation applied/);
  });

  it("REFUSES a BUILD failure — it tests the compiler, not the behaviour", () => {
    // The build is checked separately before this point, but a `tsc` error surfacing
    // through the test child looks exactly like this.
    const v = mod.classifyCatch({
      exitCode: 1,
      output: `Error: Transform failed with 1 error:\nsrc/x.ts:1:1: ERROR: Expected ";" but found "}"`,
      testFilter: FILTER,
    });
    expect(v.caught).toBe(false);
    expect(v.reason).toMatch(/infrastructure abort or a timeout/);
  });

  it("REFUSES a COLLECTION error — a suite that never loaded proved nothing", () => {
    const v = mod.classifyCatch({
      exitCode: 1,
      output: `Failed to load url ./missing.ts\nNo test files found, exiting with code 1\n${FILTER}`,
      testFilter: FILTER,
    });
    expect(v.caught).toBe(false);
    expect(v.reason).toMatch(/did not COLLECT/);
  });

  it("REFUSES a failure of a DIFFERENT test, which the filter happened to also select", () => {
    // The filter text must appear, or the red test is not the one bound to the
    // mutation — a mutation caught by an unrelated test proves nothing about the
    // invariant it was written to break.
    const v = mod.classifyCatch({
      exitCode: 1,
      output: [
        " FAIL  packages/evaluation/src/r97-arm-worker-contract.test.ts > some OTHER test entirely",
        "AssertionError: something unrelated",
      ].join("\n"),
      testFilter: FILTER,
    });
    expect(v.caught).toBe(false);
    expect(v.reason).toMatch(/failed a DIFFERENT test/);
  });

  it("REFUSES a timeout with no per-test marker", () => {
    const v = mod.classifyCatch({
      exitCode: 1,
      output: `Error: timed out after 900000ms\n${FILTER}`,
      testFilter: FILTER,
    });
    expect(v.caught).toBe(false);
    expect(v.reason).toMatch(/no per-test FAILED marker/);
  });

  it("counts a genuine RED when the reporter COLORED its output (CI run 35972462139)", () => {
    // MEASURED REGRESSION, both platforms, 0/12 "caught". On a GitHub runner vitest
    // colors the reporter, so the failing-test line arrives as
    //
    //   "\u001b[41m\u001b[1m FAIL \u001b[22m\u001b[49m packages/… > … > <name>"
    //
    // and the line-anchored `/^\s*FAIL\s+\S/m` stopped matching. Every mutation was
    // then rejected as "exited 1 with no per-test FAILED marker … an infrastructure
    // abort or a timeout" even though the mutated test was failing correctly. Locally
    // stdout is not a TTY, vitest emits no color, and the gate passed — which is why
    // the push was needed to see it.
    //
    // This is the EXACT byte sequence the CI artifact's mutation-report.json stored
    // for `same-build-for-both-arms` (ESC[41m ESC[1m " FAIL " ESC[22m ESC[49m).
    const COLORED = [
      "\u001b[41m\u001b[1m FAIL \u001b[22m\u001b[49m packages/evaluation/src/r97-plan.test.ts > E4-R97 P3: readiness refuses a plan that is not executable as written > " +
        FILTER,
      "\u001b[31mAssertionError\u001b[39m: expected 1 to be 2 // Object.is equality",
      "\u001b[2m Test Files \u001b[22m \u001b[1m\u001b[31m1 failed\u001b[39m\u001b[22m\u001b[90m (1)\u001b[39m",
    ].join("\n");
    const v = mod.classifyCatch({ exitCode: 1, output: COLORED, testFilter: FILTER });
    expect(v.caught, "a colored per-test FAILED marker must still count as caught").toBe(true);
    expect(v.failedTestNamed).toBe(true);
    expect(v.reason).toBeNull();
  });

  it("strips ANSI escapes without touching the surrounding text", () => {
    expect(typeof mod.stripAnsi, "the gate exposes no ANSI stripper").toBe("function");
    expect(mod.stripAnsi("\u001b[41m\u001b[1m FAIL \u001b[22m\u001b[49m x")).toBe(" FAIL  x");
    // A string with no escapes is returned unchanged.
    expect(mod.stripAnsi("plain text")).toBe("plain text");
    // Stripping is what makes a colored and an uncolored run agree.
    const colored = "\u001b[1m FAIL \u001b[22m file > name";
    expect(/^\s*FAIL\s+\S/m.test(mod.stripAnsi(colored))).toBe(true);
    expect(/^\s*FAIL\s+\S/m.test(colored)).toBe(false);
  });

  it("still REFUSES an infrastructure abort even when the output is colored", () => {
    // The stripper must not weaken the rule it exists to preserve: a colored abort
    // with no per-test marker is still not a catch.
    const v = mod.classifyCatch({
      exitCode: 1,
      output: "\u001b[31mError\u001b[39m: timed out after 900000ms\n" + FILTER,
      testFilter: FILTER,
    });
    expect(v.caught).toBe(false);
    expect(v.reason).toMatch(/no per-test FAILED marker/);
  });
});

/**
 * E4-R101-A (A8) X7 — a target ALREADY in its mutated state is a refusal, not a catch.
 *
 * MEASURED DEFECT (this round). The gate's restoration proof is SELF-REFERENTIAL: it
 * reads the file when it starts and compares the file against that same text after
 * writing it back. A target that was ALREADY mutated when the gate started therefore
 * has `original` == the MUTATED text, the restore "succeeds", the hashes agree, and
 * the mutation is reported `restored: true` — while the defect it models stays LIVE
 * and the fix this campaign closed stays reverted.
 *
 * That is not hypothetical. Three targets were found in exactly this state while
 * closing the A1 worker-level settlement gap:
 *
 *   a2-deleted-root-can-be-reclaimed        (r97-budget-ledger.ts)   F2 reverted
 *   a3-formal-clock-reverts-to-plan-snapshot (r97-campaign-driver.mjs) F3 reverted
 *   a5-verdict-overwrite-restored            (r97-arm-worker.mjs)     F5 reverted
 *
 * and they were invisible to BOTH existing guards: the per-file hash compares the
 * tree against itself, and `treeRestored` compares `git status --porcelain`, which
 * carries only path+status — so a content change inside a file ALREADY listed as ` M`
 * yields a byte-identical porcelain line. The consequence was measurable, not
 * cosmetic: with the a2 leftover in place, the A2 regression failed with
 * `expected null not to be null` — deleting a spent root re-granted the approval.
 */
describe("E4-R101-A (A8) X7: a target left in its mutated state is refused, not silently 'restored'", () => {
  it("detects the mutated state: the fixed text is ABSENT and the mutated text is PRESENT", () => {
    expect(typeof mod.isPreexistingMutation, "the gate exposes no pre-existing-mutation check").toBe("function");
    expect(mod.isPreexistingMutation({ findCount: 0, replaceCount: 1 })).toBe(true);
    expect(mod.isPreexistingMutation({ findCount: 0, replaceCount: 2 })).toBe(true);
  });

  it("does NOT fire on a healthy tree, where the fixed text is present", () => {
    expect(mod.isPreexistingMutation({ findCount: 1, replaceCount: 0 })).toBe(false);
    // BOTH HALVES ARE REQUIRED, and the reason is MEASURED, not assumed.
    // `a2-deleted-root-can-be-reclaimed` drops the second line of a two-line anchor,
    // so its `replace` is a strict SUBSTRING of its `find` — on a HEALTHY tree that
    // anchor counts `find=1, replace=1`. A `replace`-only check would report a false
    // positive here and wedge the gate on a perfectly healthy checkout.
    expect(mod.isPreexistingMutation({ findCount: 1, replaceCount: 1 })).toBe(false);
    // The genuinely ambiguous case (anchor renamed upstream, mutated text also
    // absent) is NOT this defect and keeps its own separate refusal.
    expect(mod.isPreexistingMutation({ findCount: 0, replaceCount: 0 })).toBe(false);
  });

  it("is REQUIRED for real: a2's replace text really is a substring of its find", async () => {
    // The measured fact the two-half condition exists for. Asserted against the real
    // list rather than asserted in prose: if `a2`'s anchor is ever rewritten so the
    // two texts stop overlapping, this test says so and the justification is revisited
    // instead of silently becoming folklore.
    const a2 = mod.MUTATIONS.find((m) => m.id === "a2-deleted-root-can-be-reclaimed");
    expect(a2, "the a2 mutation is gone from the gate").toBeDefined();
    expect(a2!.find.includes(a2!.replace), "a2's replace is no longer a substring of its find").toBe(true);
    // And on the healthy tree the check must not fire for ANY mutation.
    for (const m of mod.MUTATIONS) {
      const src = await readFile(join(REPO, m.file), "utf8");
      const findCount = mod.anchorOccurrences(src, m.find);
      const replaceCount = mod.anchorOccurrences(src, m.replace);
      expect(findCount, `${m.id}: the fixed anchor must be present on a healthy tree`).toBe(1);
      expect(
        mod.isPreexistingMutation({ findCount, replaceCount }),
        `${m.id}: the pre-existing check fired on a HEALTHY tree`,
      ).toBe(false);
    }
  });

  it("names the live defect in its refusal, so an operator knows the tree is not trustworthy", () => {
    const m = { file: "packages/evaluation/src/r97-budget-ledger.ts" };
    const reason = mod.preexistingMutationReason(m, 1);
    expect(reason).toMatch(/ALREADY in its mutated state/);
    expect(reason).toMatch(/is LIVE in the tree right now/);
    expect(reason).toContain(m.file);
  });
});
