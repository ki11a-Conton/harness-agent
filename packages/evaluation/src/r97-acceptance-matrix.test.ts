/**
 * E4-R101-A (T6) — the acceptance matrix gate must be a GATE, not a formality.
 *
 * WHY THIS FILE EXISTS (plan §T6 怎么做 5, 怎么验收 1)
 * -------------------------------------------------
 *   "使用结构化测试结果/稳定断言验证关键场景执行。现有 verbose grep 可以保留为辅助；
 *    不要继续为终端符号、相对路径和阈值写大量修补逻辑."
 *   "两平台专用 job 全通过，关键场景没有 skip."
 *
 * `r97-acceptance-matrix.mjs` maps the plan's nine-row matrix onto the tests that
 * actually measure each row, and reads vitest's JSON report rather than scraping
 * `✓` out of verbose text. The properties that make it a GATE are pinned here:
 *
 *   - a row whose test is `skipped` FAILS. That is the whole point of "关键场景没有
 *     skip": a skipped test is not evidence, and the old text-scraping gate could
 *     not tell the difference between `✓` and `↓` if the name matched.
 *   - a row whose test is ABSENT fails, naming the missing test.
 *   - a duplicate test name is a failure, because it makes a row's evidence
 *     unattributable.
 *   - no row may be vacuous: a row with no tests would be satisfied by nothing.
 *
 * The names are also checked against the REAL suite sources, so a rename that the
 * matrix was not updated for is caught here rather than at the point where CI
 * reports a row as unsatisfied with no clue why.
 */

import { describe, expect, it } from "vitest";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const REPO = process.cwd();
const MATRIX = pathToFileURL(join(REPO, "scripts", "e4", "r97-acceptance-matrix.mjs")).href;

interface RowResult {
  id: string;
  planExpectation: string;
  ok: boolean;
  missing: string[];
  notPassed: string[];
  tests: Array<{ name: string; present: boolean; status: string; ok: boolean }>;
}

interface MatrixResult {
  matrixVersion: string;
  totalTests: number;
  passedTests: number;
  duplicateNames: string[];
  rows: RowResult[];
  missingPinned: string[];
  notPassedPinned: string[];
  ok: boolean;
}

const mod = (await import(MATRIX)) as {
  ACCEPTANCE_MATRIX: Array<{ id: string; planExpectation: string; tests: string[] }>;
  MATRIX_VERSION: string;
  PINNED_REGRESSIONS: string[];
  evaluateMatrix: (report: unknown) => MatrixResult;
  indexReport: (report: unknown) => { byName: Map<string, { status: string }>; duplicates: string[] };
};

/** A vitest JSON report holding exactly the given `(fullName, status)` pairs. */
function reportOf(entries: Array<[string, string]>, over: Record<string, unknown> = {}) {
  return {
    numTotalTests: entries.length,
    numPassedTests: entries.filter(([, s]) => s === "passed").length,
    success: entries.every(([, s]) => s === "passed"),
    testResults: [
      {
        name: join(REPO, "packages", "evaluation", "src", "synthetic.test.ts"),
        status: "passed",
        assertionResults: entries.map(([fullName, status]) => ({ fullName, status, title: fullName })),
      },
    ],
    ...over,
  };
}

/** Every name the matrix requires, flattened. */
const ALL_NAMES = mod.ACCEPTANCE_MATRIX.flatMap((r) => r.tests);

/**
 * A `fullName` that satisfies each pinned regression.
 *
 * The pins are matched as SUBSTRINGS of a `fullName`, so a synthetic entry just has
 * to contain the pin text. One pin names a DESCRIBE rather than a test title, which
 * is exactly why the match is a substring and not an equality.
 */
const PIN_NAMES = mod.PINNED_REGRESSIONS.map((p) => `${p} — synthetic pinned test`);

/** Every name a fully-satisfying report must contain: the rows' tests AND the pins. */
const EVERY_NAME = [...ALL_NAMES, ...PIN_NAMES];

describe("E4-R101-A (T6) M1: the matrix is well-formed and covers the plan's nine rows", () => {
  it("declares the nine rows of plan §T6's acceptance matrix", () => {
    // The plan's table has exactly nine rows. A matrix that silently lost one
    // would still report "all rows satisfied".
    expect(mod.ACCEPTANCE_MATRIX).toHaveLength(9);
  });

  it("has NO vacuous row — a row with no test would be satisfied by nothing", () => {
    for (const row of mod.ACCEPTANCE_MATRIX) {
      expect(row.tests.length, `row "${row.id}" names no test`).toBeGreaterThan(0);
      expect(row.planExpectation.length, `row "${row.id}" states no expectation`).toBeGreaterThan(0);
    }
  });

  it("names each test at most once across the whole matrix", () => {
    expect(new Set(ALL_NAMES).size).toBe(ALL_NAMES.length);
  });

  it("carries a version, so a report can be tied to the matrix that judged it", () => {
    expect(mod.MATRIX_VERSION).toMatch(/^e4-r101-acceptance-matrix-v\d+$/);
  });
});

describe("E4-R101-A (T6) M2: a SKIPPED test fails its row — the '没有 skip' property", () => {
  it("refuses a row whose test was skipped, even though it was PRESENT", () => {
    // The measured weakness of the old gate: it grepped for `✓` beside a name, so
    // a test that never ran could pass the gate if its name line happened to
    // match. Here `skipped` is a distinct status and it is NOT satisfying.
    const entries = ALL_NAMES.map((n): [string, string] => [n, "passed"]);
    // Skip exactly one test from the first row.
    const victim = mod.ACCEPTANCE_MATRIX[0]!.tests[0]!;
    const report = reportOf(entries.map(([n, s]) => [n, n === victim ? "skipped" : s]));

    const result = mod.evaluateMatrix(report);
    expect(result.ok, "a skipped test must fail the matrix").toBe(false);
    const row = result.rows.find((r) => r.id === mod.ACCEPTANCE_MATRIX[0]!.id)!;
    expect(row.ok).toBe(false);
    expect(row.missing, "the test WAS present — it just did not run").toEqual([]);
    expect(row.notPassed.join(" ")).toContain(victim);
    expect(row.notPassed.join(" ")).toContain("skipped");
  });

  it("refuses a `todo` test the same way", () => {
    const victim = mod.ACCEPTANCE_MATRIX[1]!.tests[0]!;
    const report = reportOf(ALL_NAMES.map((n): [string, string] => [n, n === victim ? "todo" : "passed"]));
    const result = mod.evaluateMatrix(report);
    expect(result.ok).toBe(false);
    expect(result.rows.find((r) => r.id === mod.ACCEPTANCE_MATRIX[1]!.id)!.notPassed.join(" ")).toContain("todo");
  });
});

describe("E4-R101-A (T6) M3: a MISSING test fails its row, and is named", () => {
  it("reports the absent test by name rather than only a count", () => {
    const victim = mod.ACCEPTANCE_MATRIX[5]!.tests[0]!;
    const report = reportOf(ALL_NAMES.filter((n) => n !== victim).map((n): [string, string] => [n, "passed"]));
    const result = mod.evaluateMatrix(report);
    expect(result.ok).toBe(false);
    const row = result.rows.find((r) => r.id === mod.ACCEPTANCE_MATRIX[5]!.id)!;
    expect(row.missing).toEqual([victim]);
    expect(row.notPassed, "an absent test is not also a not-passed one").toEqual([]);
  });

  it("fails EVERY row when the report holds nothing at all", () => {
    const result = mod.evaluateMatrix(reportOf([]));
    expect(result.ok).toBe(false);
    expect(result.rows.every((r) => !r.ok)).toBe(true);
  });

  it("is not satisfied by a passing SUITE whose individual tests are absent", () => {
    // `success: true` with no assertion results is what a reporter misconfiguration
    // looks like. The gate must read the TESTS, not the summary flag.
    const result = mod.evaluateMatrix({ success: true, numTotalTests: 0, numPassedTests: 0, testResults: [] });
    expect(result.ok).toBe(false);
  });
});

describe("E4-R101-A (T6) M4: a duplicate test name is refused as unattributable", () => {
  it("records the duplicate and fails the whole matrix", () => {
    const name = mod.ACCEPTANCE_MATRIX[0]!.tests[0]!;
    const report = {
      numTotalTests: ALL_NAMES.length + 1,
      numPassedTests: ALL_NAMES.length + 1,
      success: true,
      testResults: [
        {
          name: "a.test.ts",
          status: "passed",
          assertionResults: ALL_NAMES.map((n) => ({ fullName: n, status: "passed" })),
        },
        {
          // A SECOND file declaring the same full name: two tests now stand behind
          // one row entry, so "the test passed" no longer identifies which one.
          name: "b.test.ts",
          status: "passed",
          assertionResults: [{ fullName: name, status: "passed" }],
        },
      ],
    };
    const result = mod.evaluateMatrix(report);
    expect(result.duplicateNames).toEqual([name]);
    expect(result.ok).toBe(false);
    // The rows themselves are all satisfied — the failure is the ambiguity, and it
    // must not be swallowed by the row loop.
    expect(result.rows.every((r) => r.ok)).toBe(true);
  });
});

describe("E4-R101-A (T6) M6: the PINNED regression names survive, read from the JSON report", () => {
  // These were name-based `grep … ✓` assertions in the previous workflow, kept so a
  // RENAME cannot silently drop a pin for a measured defect. Plan 怎么做 5 allows the
  // verbose grep to remain as AUXILIARY but forbids building the gate on terminal
  // symbols, and `shell: bash` would also reintroduce the platform dependency this
  // job exists to remove. So the same pins are read from the JSON report instead.
  it("exports a non-empty list of pinned regression names", () => {
    expect(mod.PINNED_REGRESSIONS.length).toBeGreaterThan(0);
    for (const name of mod.PINNED_REGRESSIONS) {
      expect(name.length, "a pinned name must not be empty").toBeGreaterThan(0);
    }
  });

  it("pins the four defects the previous gate asserted by symbol", () => {
    const joined = mod.PINNED_REGRESSIONS.join("\n");
    // N1/N2's dispatch regression, N5's real-report verdict, and the ledger's
    // cross-process claim — each is a P0/P1 finding from plan §0.2.
    expect(joined).toContain("passes --plan-digest to the dispatch");
    expect(joined).toContain("executes the case and records a verdict that can ONLY come from the real report");
    expect(joined).toContain("TWO DIFFERENT CASES each enter their OWN context");
    expect(joined).toContain("G5: the budget holds ACROSS PROCESSES");
  });

  it("FAILS the whole gate when a pinned name is absent from the report", () => {
    // The point of a pin: losing it is a failure, not a smaller run. The victim is
    // removed while EVERY matrix row stays satisfied, so only the pin check can
    // catch it.
    const victim = PIN_NAMES[0]!;
    const report = reportOf(
      [...ALL_NAMES, ...PIN_NAMES.filter((n) => n !== victim)].map((n): [string, string] => [n, "passed"]),
    );
    const result = mod.evaluateMatrix(report);
    expect(result.rows.every((r) => r.ok), "the rows are all satisfied — only the pin is lost").toBe(true);
    expect(result.ok).toBe(false);
    expect(result.missingPinned).toEqual([mod.PINNED_REGRESSIONS[0]!]);
  });

  it("FAILS when a pinned name is present but SKIPPED", () => {
    const victim = PIN_NAMES[0]!;
    const report = reportOf(EVERY_NAME.map((n): [string, string] => [n, n === victim ? "skipped" : "passed"]));
    const result = mod.evaluateMatrix(report);
    expect(result.ok).toBe(false);
    expect(result.notPassedPinned).toHaveLength(1);
    expect(result.notPassedPinned[0]).toContain(mod.PINNED_REGRESSIONS[0]!);
  });

  it("reports no pinned failure when every pin ran and passed", () => {
    const report = reportOf(EVERY_NAME.map((n): [string, string] => [n, "passed"]));
    const result = mod.evaluateMatrix(report);
    expect(result.missingPinned).toEqual([]);
    expect(result.notPassedPinned).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it("names only pins that some suite really declares", async () => {
    // A typo here would fail every run with no clue why, so the pins are checked
    // against the suite sources exactly as the matrix names are. A pin may live in
    // a DESCRIBE rather than in a test title — the G5 pin does — so the whole
    // source is searched, not just the `it("…")` titles.
    const srcDir = join(REPO, "packages", "evaluation", "src");
    const files = (await readdir(srcDir)).filter((f) => f.startsWith("r9") && f.endsWith(".test.ts"));
    const sources = await Promise.all(files.map(async (f) => await readFile(join(srcDir, f), "utf8")));
    const missing = mod.PINNED_REGRESSIONS.filter((p) => !sources.some((src) => src.includes(p)));
    expect(missing, "these pins match no text the suites declare").toEqual([]);
  });
});

describe("E4-R101-A (T6) M5: the matrix names tests that REALLY EXIST in the suites", () => {
  /**
   * The names are vitest `fullName`s, so each is a chain of describe titles
   * followed by the test's own title. Checking the FINAL title against the suite
   * sources catches a rename or a typo here — where the cause is obvious — instead
   * of leaving CI to report an unsatisfied row with no explanation.
   *
   * It cannot prove the describe chain is right; the real report does that, which
   * is why the matrix is evaluated against a report produced by the same job.
   */
  const SUITES = [
    "r97-budget-channel.test.ts",
    "r97-execution-state-ownership.test.ts",
    "r97-execution-identity.test.ts",
    "r97-bounded-stop.test.ts",
    "r97-arm-worker-contract.test.ts",
    "r97-offline-seam.test.ts",
    "r97-execution-state.test.ts",
    "r97-driver-closed-loop.test.ts",
  ];

  it("finds each named test's own title in one of the R97 suites", async () => {
    const sources = await Promise.all(
      SUITES.map(async (f) => await readFile(join(REPO, "packages", "evaluation", "src", f), "utf8")),
    );
    // Every `it("…")` title the suites declare. The matrix entry is
    // `<describe chain> <title>`, so a correct entry ENDS WITH one of these.
    const titles = new Set<string>();
    for (const src of sources) {
      for (const m of src.matchAll(/\bit\(\s*"((?:[^"\\]|\\.)*)"/g)) {
        if (m[1] !== undefined) titles.add(m[1].replace(/\\(.)/g, "$1"));
      }
    }
    expect(titles.size, "the suites must declare tests at all").toBeGreaterThan(100);
    const missing = ALL_NAMES.filter((name) => ![...titles].some((t) => name.endsWith(` ${t}`)));
    expect(missing, "these matrix entries name no test the suites declare").toEqual([]);
  });

  it("names a suite that is actually part of the CI closed-loop run", async () => {
    // A matrix entry could be perfectly correct and still be useless if its file is
    // not in the job that produces the report. The list now lives in the committed
    // cross-platform runner — which the workflow invokes — so the runner is the
    // authority, and the workflow is checked to really call it.
    const runner = await readFile(join(REPO, "scripts", "e4", "r97-closed-loop.mjs"), "utf8");
    const ci = await readFile(join(REPO, ".github", "workflows", "ci.yml"), "utf8");
    expect(ci, "the workflow must invoke the runner whose list this checks").toContain(
      "scripts/e4/r97-closed-loop.mjs",
    );
    for (const f of SUITES) {
      expect(runner, `${f} is not run by the closed-loop runner`).toContain(f);
    }
  });
});

describe("E4-R101-A (T6) M7: a row is satisfied only by tests about ITS OWN scenario", () => {
  /**
   * MEASURED DEFECT, found by reading the produced `acceptance-matrix.json` rather
   * than by a failing test. The row "外部 provider 未获授权" (an UNauthorized external
   * provider) listed as its third leg:
   *
   *   "… C5: a pass is labelled STRONG or WEAK, never just 'passed'
   *    labels a banner-derived pass as weak"
   *
   * That test is about pass LABELLING. It has nothing to do with authorization, and
   * it passes whether or not the authorization gate works. A row that can go green
   * on an unrelated test is worse than a row with no test: it reports coverage it
   * does not have, and it is exactly the "green while the scenario is broken"
   * failure this whole matrix exists to prevent.
   *
   * The check below is deliberately a KEYWORD check rather than a semantic one. It
   * cannot prove relevance; it CAN catch the specific defect of an entry that shares
   * no vocabulary at all with the scenario it is supposed to evidence, which is what
   * happened. Every row therefore declares the terms its tests must mention.
   */
  const REQUIRED_TERMS: Record<string, string[]> = {
    "两个不同 arm": ["arm", "request"],
    "写文件成功": ["write", "file"],
    "多轮与子代理共享预算": ["budget"],
    "成功、有效负例": ["resume"],
    "缺": ["ledger"],
    "同单位竞争": ["owner"],
    "输入": ["identity"],
    "超时": ["timeout"],
    "外部": ["UNAUTHORIZED"],
  };

  it("every row's tests share vocabulary with the scenario the row names", () => {
    for (const row of mod.ACCEPTANCE_MATRIX) {
      const key = Object.keys(REQUIRED_TERMS).find((k) => row.id.includes(k));
      expect(key, `row "${row.id}" has no declared vocabulary requirement`).toBeDefined();
      const terms = REQUIRED_TERMS[key!]!;
      const haystack = row.tests.join("\n");
      const missing = terms.filter((t) => !haystack.toLowerCase().includes(t.toLowerCase()));
      expect(
        missing,
        `row "${row.id}" is evidenced by tests mentioning none of ${JSON.stringify(terms)}: ` +
          `a row satisfied by an unrelated test reports coverage it does not have`,
      ).toEqual([]);
    }
  });

  it("the authorization row names a test that says the provider was never constructed", () => {
    // The strongest form of the row's own expectation ("provider 未构造"): the
    // refusal must happen BEFORE a provider exists, not after one was built.
    const row = mod.ACCEPTANCE_MATRIX.find((r) => r.id.includes("外部 provider"));
    expect(row).toBeDefined();
    expect(row!.tests.join("\n")).toContain("provider never constructed");
  });
});
