#!/usr/bin/env node
/**
 * E4-R101-A (T6) — the 9-row acceptance matrix, asserted from STRUCTURED results.
 *
 * WHY THIS FILE EXISTS (plan §T6 怎么做 5, 怎么验收 1)
 * -------------------------------------------------
 *   "使用结构化测试结果/稳定断言验证关键场景执行。现有 verbose grep 可以保留为辅助；
 *    不要继续为终端符号、相对路径和阈值写大量修补逻辑."
 *
 * The previous gate read `--reporter=verbose` text and grepped for a `✓` next to a
 * test NAME. That is fragile in exactly the ways the plan names: it depends on the
 * reporter's terminal symbols (`✓` / `↓` / `×`), on a name string being
 * byte-identical, and on the test's own line surviving wrapping. MEASURED: it
 * already failed once on a GREEN suite, because a few-millisecond test never got
 * its own line under the default reporter.
 *
 * This script instead consumes vitest's JSON report, where each test carries a
 * stable `fullName` and a machine-readable `status`. A row is satisfied only when
 * EVERY test it names is present AND `status === "passed"` — so a `skipped` test
 * fails the row rather than passing it silently, which is the property plan §T6
 * 怎么验收 1 requires ("关键场景没有 skip").
 *
 * WHAT IT DOES NOT DO
 * -------------------
 * It does not run the tests. It reads a report produced by the job that did, so
 * the gate and the run cannot disagree about what executed.
 *
 * USAGE
 * -----
 *   node scripts/e4/r97-acceptance-matrix.mjs --report .ci/r97-r98.json
 *   node scripts/e4/r97-acceptance-matrix.mjs --report <p> --out .ci/r97-r98/matrix.json
 *
 * Exit codes: 0 = every row satisfied · 1 = a row unsatisfied · 2 = usage error.
 */

import { readFile, writeFile } from "node:fs/promises";
import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";

export const MATRIX_VERSION = "e4-r101-acceptance-matrix-v1";

export const EXIT_OK = 0;
export const EXIT_FAILED = 1;
export const EXIT_CONFIG = 2;

/**
 * REGRESSION PINS — names that must be present AND passing, independently of which
 * matrix row they belong to.
 *
 * These were `grep … ✓` assertions in the previous workflow, kept so that a RENAME
 * cannot silently drop the pin for a measured defect. Plan §T6 怎么做 5 permits the
 * verbose grep to remain as AUXILIARY but forbids building the gate on terminal
 * symbols — and a `shell: bash` step would also reintroduce the platform dependency
 * this job exists to remove. Reading the same pins out of the JSON report keeps
 * their strength while dropping both weaknesses: a pin that is ABSENT or `skipped`
 * fails here, and nothing depends on a checkmark being printed.
 *
 * Each entry is a SUBSTRING of the vitest `fullName`, because the describe chain in
 * front of a test title is an implementation detail of how the file is organised.
 */
export const PINNED_REGRESSIONS = [
  // N1/N2 — the dispatch argv must carry --plan-digest, or no case can ever run.
  "passes --plan-digest to the dispatch",
  // N5 — the verdict must come from the REAL report, not a fixed placeholder.
  "executes the case and records a verdict that can ONLY come from the real report",
  // N5 — two cases must not share one placeholder request.
  "TWO DIFFERENT CASES each enter their OWN context",
  // G5/F4 — the budget's cross-process claim is only proven by spawning children.
  // The words live in a DESCRIBE, not in a test title, which is why a pin is
  // matched against the whole `fullName` rather than against a title alone.
  "G5: the budget holds ACROSS PROCESSES",
];

/**
 * The nine rows of plan §T6's acceptance matrix, each bound to the tests that
 * actually measure it.
 *
 * The `id` is the row's own wording from the plan, kept verbatim so a reader can
 * check the mapping rather than trust it. Each `tests` entry is a vitest
 * `fullName` — the `<describe...> <name>` string the JSON reporter emits, which is
 * stable across reporter formats because it is data rather than presentation.
 *
 * A row with an EMPTY `tests` array is not allowed: that would be a row nobody
 * measures, dressed as a satisfied row. `planExpectation` records the plan's own
 * requirement so the script fails loudly instead.
 */
export const ACCEPTANCE_MATRIX = [
  {
    id: "两个不同 arm + 两种不同 request",
    planExpectation: "每臂模块/build identity、捕获输入、真实工具事件",
    tests: [
      "R100 I3: the build identity is a BYTE hash over the modules that actually execute the executed-bytes manifest covers the provider and runtime trees, not only the CLI",
      "R99 W8: THE REAL EXECUTION — the arm's own build actually runs the case TWO DIFFERENT CASES each enter their OWN context — no single placeholder request",
      "E4-R101-A (T6) C1: the seam reads the case's OWN contract recovers the literal from a case whose command verifier embeds it",
    ],
  },
  {
    id: "写文件成功 / 只说完成但未写文件",
    planExpectation: "TaskVerifier 的正反结果和持久报告",
    tests: [
      "E4-R101-A (T6) C3: an artifact-only case gets a REAL non-null write puts the write FIRST, so the tool call really happens",
      "E4-R101-A (T6) C2: scripting NEVER throws a case into infrastructure scripts a command-only case as the claim-only negative control",
      "R99 W5: report classification is three-way and never invents a pass a case that RAN and failed its task is a VALID negative (`case_failed`), not an infrastructure error",
      "R99 W10: the worker's report SURVIVES it, linked and hashed leaves a real evidence file on disk after the worker returns",
    ],
  },
  {
    id: "多轮与子代理共享预算 3 次",
    planExpectation: "第四次未进入 provider；实际计数与 ledger 一致",
    tests: [
      "R98-A C1: every logical generate() reserves BEFORE the call leaves a grant of 3 admits exactly three calls across the SAME channel",
      "R98-A C1: every logical generate() reserves BEFORE the call leaves with a grant of 1, a second generate() is refused BEFORE the provider is entered",
      "R98-A C1: every logical generate() reserves BEFORE the call leaves the budget is shared with a SECOND channel on the same ledger (the two-arm case)",
      "R98-A C3: a PRE-TAKEN reservation is adopted, not double-charged spends the caller's reservation on the first call and reserves fresh afterwards",
    ],
  },
  {
    id: "成功、有效负例、provider 失败后的恢复",
    planExpectation: "新调用 0；累计结果和失败不消失",
    tests: [
      "E4-R99-A D8: a resume aggregates the FULL history, not just this run a resumed run does NOT report COMPLETE when history holds failures",
      "E4-R99-A D8: a resume aggregates the FULL history, not just this run the pass aggregate is a UNION over units, never a SUM over lists counts a unit present in BOTH history and this run exactly once",
      "E4-R99-A D8: a resume aggregates the FULL history, not just this run the pass aggregate is a UNION over units, never a SUM over lists a resume reports the SAME numerator as the run it resumed",
    ],
  },
  {
    id: "缺 state/ledger、换目录、hash 改动",
    planExpectation: "命名拒绝；0 新调用",
    tests: [
      "R98-B S1: an ESTABLISHED campaign's missing state is a LOSS, not a blank slate REFUSES to treat a deleted state file as 'nothing has run'",
      "R98-B S1: an ESTABLISHED campaign's missing state is a LOSS, not a blank slate still CREATES state on a genuine first run (no ledger yet)",
      "E4-R98 S2: the execution state fails closed on identity drift refuses a store bound to a different plan digest",
      "E4-R98 S2: the execution state fails closed on identity drift refuses a corrupted store rather than treating it as empty",
    ],
  },
  {
    id: "同单位竞争、活 owner、死 owner、reconcile retry",
    planExpectation: "所有权和预算证据，未重复执行",
    tests: [
      "R98-B S2: one unit has exactly ONE owner at a time REFUSES a second begin while the unit is running",
      "R98-B S2: one unit has exactly ONE owner at a time records owner evidence (pid + host) on the attempt",
      "R98-B S3: recovery respects a LIVE owner does NOT reclassify a running unit whose owner is alive",
      "R98-B S3: recovery respects a LIVE owner quarantines a running unit whose owner is provably DEAD, keeping its allowance",
      "R98-B S3: recovery respects a LIVE owner conservatively does NOT touch a running unit owned by ANOTHER HOST",
      "R98-B S4: reconciliation actually re-opens the unit isDone is FALSE after a retry reconciliation, so the dispatcher re-runs it",
      "R98-B S4: reconciliation actually re-opens the unit preserves the OLD attempt's audit trail rather than overwriting it",
    ],
  },
  {
    id: "输入/构建/model/endpoint 漂移",
    planExpectation: "实际执行边界拒绝，不仅纯函数比较",
    tests: [
      "R100 I2: the request the arm ACTUALLY made carries the approved identity runs under the APPROVED model and endpoint, not the default pair",
      "R100 I2: the request the arm ACTUALLY made carries the approved identity REFUSES to dispatch at all when the identity is incomplete",
      "R100 I1: the approved identity is REQUIRED, never defaulted REFUSES a missing or empty modelId rather than falling back to gpt-4o-mini",
      "R99 W8: THE REAL EXECUTION — the arm's own build actually runs the case REFUSES a unit whose checkout is not the approved build, and dispatches NOTHING",
      "R100 I3: the build identity is a BYTE hash over the modules that actually execute is null when a covered module is missing, so an unestablished build never passes",
    ],
  },
  {
    id: "超时/取消/输出过量",
    planExpectation: "有界返回，无遗留进程，状态正确",
    tests: [
      "R99-B S1: a child that IGNORES SIGTERM is still stopped, within deadline + grace returns a NAMED timeout result, and the child is really gone",
      "R99-B S2: the output cap is BYTES, not a count of chunks one HUGE chunk and many SMALL chunks are bounded identically",
      "R99-B S2: the output cap is BYTES, not a count of chunks the module's own default cap is a real byte limit, not a chunk count",
      "R99-B S3: cancellation and spawn failure are distinct, named outcomes an AbortSignal cancels a running child and is reported as `cancelled`",
      "R99-B S6: the deadline reaches the REAL execution path a unit whose deadline is ALREADY spent never dispatches, and reports timeout",
      "R99-B S7: an interrupted unit settles its budget and its state honestly a unit stopped by the deadline is TERMINAL, so a resume skips it rather than re-sending",
    ],
  },
  {
    id: "外部 provider 未获授权",
    planExpectation: "真实 gate 拒绝、provider 未构造、外部请求 0",
    tests: [
      "E4-R97 D4: the CLI entry refuses to build a real provider by default without --fake-provider the driver only prints a plan and makes no provider",
      "E4-R97 D9: the finalized plan is executable WITHOUT modification an unauthorized run of the same unmodified artifact is NOT_RUN with 0 requests",
      // The row's third leg must be about the GATE, not about pass labelling. The
      // previous entry (`… labels a banner-derived pass as weak`) was a labelling
      // test that had nothing to do with authorization — a matrix row that is
      // satisfied by an unrelated test is a row that can go green while the
      // scenario it names is broken.
      "E4-R97 D1: every refusal path makes ZERO provider requests UNAUTHORIZED: no auth env -> refused, 0 requests, provider never constructed",
    ],
  },
];

/** Read `--flag value` pairs, refusing a flag with no value. */
export function parseArgs(argv) {
  const value = (name) => {
    const i = argv.indexOf(name);
    if (i < 0) return undefined;
    const v = argv[i + 1];
    if (v === undefined || v.startsWith("--")) throw new Error(`${name} requires a value`);
    return v;
  };
  return { report: value("--report"), out: value("--out") };
}

/**
 * Index a vitest JSON report by `fullName`.
 *
 * A name that appears more than once is recorded as ambiguous rather than being
 * silently overwritten: two tests sharing a name would make a row's evidence
 * unattributable, which is worth failing on.
 */
export function indexReport(report) {
  const byName = new Map();
  const duplicates = [];
  for (const file of report?.testResults ?? []) {
    for (const a of file?.assertionResults ?? []) {
      const name = String(a?.fullName ?? "");
      if (name === "") continue;
      if (byName.has(name)) {
        duplicates.push(name);
        continue;
      }
      byName.set(name, { status: String(a?.status ?? "unknown"), file: String(file?.name ?? "") });
    }
  }
  return { byName, duplicates };
}

/**
 * Evaluate every row against the indexed report.
 *
 * `status === "passed"` is the ONLY satisfying status. vitest reports a skipped
 * test as `skipped` and a `todo` as `todo`, so both fail the row — which is what
 * "关键场景没有 skip" means mechanically rather than by inspection.
 *
 * The regression PINS are then checked the same way and independently of the rows:
 * a pin is matched as a substring of the `fullName`, so a pin whose test was
 * renamed away is reported as MISSING rather than silently satisfied by a shorter
 * run.
 */
export function evaluateMatrix(report) {
  const { byName, duplicates } = indexReport(report);
  const rows = ACCEPTANCE_MATRIX.map((row) => {
    const results = row.tests.map((name) => {
      const found = byName.get(name);
      return {
        name,
        present: found !== undefined,
        status: found?.status ?? "missing",
        ok: found?.status === "passed",
      };
    });
    const missing = results.filter((r) => !r.present).map((r) => r.name);
    const notPassed = results.filter((r) => r.present && !r.ok).map((r) => `${r.name} [${r.status}]`);
    return {
      id: row.id,
      planExpectation: row.planExpectation,
      tests: results,
      ok: results.length > 0 && results.every((r) => r.ok),
      missing,
      notPassed,
    };
  });

  // The pins, matched by substring because the describe chain in front of a title
  // is an implementation detail of the file's organisation.
  const all = [...byName.entries()];
  const missingPinned = [];
  const notPassedPinned = [];
  for (const pin of PINNED_REGRESSIONS) {
    const matches = all.filter(([name]) => name.includes(pin));
    if (matches.length === 0) {
      missingPinned.push(pin);
      continue;
    }
    // A pin satisfied by a SKIPPED match is not satisfied: the pin exists to prove
    // a measured defect stays fixed, and a test that did not run proves nothing.
    if (!matches.some(([, v]) => v.status === "passed")) {
      notPassedPinned.push(`${pin} [${matches.map(([, v]) => v.status).join(",")}]`);
    }
  }

  return {
    matrixVersion: MATRIX_VERSION,
    totalTests: Number(report?.numTotalTests ?? 0),
    passedTests: Number(report?.numPassedTests ?? 0),
    suiteSuccess: report?.success === true,
    duplicateNames: duplicates,
    pinnedRegressions: [...PINNED_REGRESSIONS],
    missingPinned,
    notPassedPinned,
    rows,
    ok:
      rows.every((r) => r.ok) &&
      duplicates.length === 0 &&
      missingPinned.length === 0 &&
      notPassedPinned.length === 0,
  };
}

export async function main(argv) {
  let parsed;
  try {
    parsed = parseArgs(argv);
  } catch (err) {
    process.stderr.write(`r101-matrix: ${err instanceof Error ? err.message : String(err)}\n`);
    return EXIT_CONFIG;
  }
  if (parsed.report === undefined) {
    process.stderr.write("r101-matrix: --report <vitest-json> is required\n");
    return EXIT_CONFIG;
  }

  let report;
  try {
    report = JSON.parse(await readFile(resolve(parsed.report), "utf8"));
  } catch (err) {
    process.stderr.write(`r101-matrix: could not read the report at ${parsed.report} — ${err instanceof Error ? err.message : String(err)}\n`);
    return EXIT_CONFIG;
  }

  const result = evaluateMatrix(report);
  if (parsed.out !== undefined) {
    const out = resolve(parsed.out);
    await mkdir(dirname(out), { recursive: true });
    await writeFile(out, `${JSON.stringify(result, null, 2)}\n`, "utf8");
  }

  for (const row of result.rows) {
    process.stdout.write(`[${row.ok ? "PASS" : "FAIL"}] ${row.id}\n`);
    if (!row.ok) {
      for (const name of row.missing) process.stdout.write(`       MISSING TEST: ${name}\n`);
      for (const name of row.notPassed) process.stdout.write(`       NOT PASSED:   ${name}\n`);
    }
  }
  for (const name of result.duplicateNames) {
    process.stdout.write(`[FAIL] duplicate test name makes evidence unattributable: ${name}\n`);
  }
  for (const name of result.missingPinned) {
    process.stdout.write(`[FAIL] pinned regression test is MISSING from the report: ${name}\n`);
  }
  for (const name of result.notPassedPinned) {
    process.stdout.write(`[FAIL] pinned regression test did not pass: ${name}\n`);
  }
  process.stdout.write(
    `\nr101-matrix: ${result.rows.filter((r) => r.ok).length}/${result.rows.length} row(s) satisfied, ` +
      `${result.pinnedRegressions.length - result.missingPinned.length - result.notPassedPinned.length}/` +
      `${result.pinnedRegressions.length} pinned regression(s) intact ` +
      `over ${result.passedTests}/${result.totalTests} passing test(s)\n`,
  );
  return result.ok ? EXIT_OK : EXIT_FAILED;
}

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === (await import("node:url")).pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  process.exitCode = await main(process.argv.slice(2));
}
