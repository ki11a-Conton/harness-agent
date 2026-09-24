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
 * The behavior matrix of the CLOSING plan (§A7 必须覆盖的行为矩阵, M1–M9).
 *
 * WHY THIS EXISTS (plan §A7 怎么做 2)
 * ----------------------------------
 *   "acceptance matrix 建立下面的行为映射。用具体测试名/证据关联各行，不允许一个无关
 *    测试让多行自动通过."
 *
 * The nine acceptance rows below carry the SCENARIO wording the T6 matrix was built
 * on, because the shipped gate and its own test file (`r97-acceptance-matrix.test.ts`)
 * pin those ids, and re-keying them would mean editing assertions to fit a
 * production change. What A7 adds instead is this explicit, machine-checked
 * mapping: each acceptance row DECLARES which of the closing plan's M1–M9 rows it
 * evidences (`planRows`), and `evaluateMatrix` fails if any M row is left with no
 * row behind it. So the plan's table is enforced rather than described, and the
 * round's counterexamples are bound to the M row they were written for.
 *
 * `id` is the T6 row's own wording, kept verbatim. `planRows` names the closing
 * plan's rows this acceptance row evidences — the plan's own wording is carried in
 * `requirement` so a reader can check the mapping instead of trusting it.
 */
export const PLAN_BEHAVIOR_MATRIX = [
  {
    id: "M1",
    requirement: "流提前 break/return 后 CLI 异常",
    minimumEvidence: "innerCalls=1；预算不退；第二次 reserve 拒绝",
  },
  {
    id: "M2",
    requirement: "已消费 campaign 整目录删除后重新打开",
    minimumEvidence: "同批准拒绝；没有新调用",
  },
  {
    id: "M3",
    requirement: "旧 observation.now + 当前时间已过期",
    minimumEvidence: "真实 main/gate 拒绝；没有进入 worker",
  },
  {
    id: "M4",
    requirement: "计划后修改实际 case/staged 字节",
    minimumEvidence: "首次/恢复均拒绝，调用 0",
  },
  {
    id: "M5",
    requirement: "只改被导入 dist 子模块",
    minimumEvidence: "实际批准 digest 不匹配，调用前拒绝",
  },
  {
    id: "M6",
    requirement: "身份漂移 + 成功报告",
    minimumEvidence: "非 PASS；落盘与汇总一致",
  },
  {
    id: "M7",
    requirement: "当前 unit 中取消/总 deadline/output_limit",
    minimumEvidence: "当前执行及进程树停止；原因准确；预算保守结算",
  },
  {
    id: "M8",
    requirement: "正常双 arm 工具/verifier 路径",
    minimumEvidence: "正常通过与真实负例仍成立；不是协议 fixture 伪造通过",
  },
  {
    id: "M9",
    requirement: "正常/失败/unknown 的 resume",
    minimumEvidence: "新增调用与累计结果符合合同；损坏证据先拒绝",
  },
];

/**
 * The nine acceptance rows, each bound to the tests that actually measure it.
 *
 * The `id` is the row's own wording, kept verbatim so a reader can check the
 * mapping rather than trust it. Each `tests` entry is a vitest `fullName` — the
 * `<describe...> <name>` string the JSON reporter emits, which is stable across
 * reporter formats because it is data rather than presentation.
 *
 * A row with an EMPTY `tests` array is not allowed: that would be a row nobody
 * measures, dressed as a satisfied row. `planExpectation` records the plan's own
 * requirement so the script fails loudly instead.
 *
 * THE ROUND COUNTEREXAMPLES (A1–A6) ARE BOUND IN, one per M row:
 *   A1/F1 -> the budget row (M1); A2/F2 -> the lost-state row (M2);
 *   A3/F3 -> the expired-clock row (M3) and the staged-bytes leg of the lost-state
 *   row (M4); A4/F4 -> the drift row (M5); A5/F5 -> the drift row (M6);
 *   A6/F6 -> the stop row (M7). The resume evidence ordering (M9) is the A3 resume
 *   counterexample. Every name below was measured present and `passed` in a real
 *   vitest JSON report before being written here.
 */
export const ACCEPTANCE_MATRIX = [
  {
    id: "两个不同 arm + 两种不同 request",
    planExpectation: "每臂模块/build identity、捕获输入、真实工具事件",
    // M8 — "正常双 arm 工具/verifier 路径 … 不是协议 fixture 伪造通过". This row is
    // the normal two-arm path; the verdict test below is the one that can ONLY come
    // from the arm's real report, which is what distinguishes it from a fixture.
    planRows: ["M8"],
    tests: [
      "R100 I3: the build identity is a BYTE hash over the modules that actually execute the executed-bytes manifest covers the provider and runtime trees, not only the CLI",
      "R99 W8: THE REAL EXECUTION — the arm's own build actually runs the case TWO DIFFERENT CASES each enter their OWN context — no single placeholder request",
      "R99 W8: THE REAL EXECUTION — the arm's own build actually runs the case executes the case and records a verdict that can ONLY come from the real report",
      "E4-R101-A (T6) C1: the seam reads the case's OWN contract recovers the literal from a case whose command verifier embeds it",
    ],
  },
  {
    id: "写文件成功 / 只说完成但未写文件",
    planExpectation: "TaskVerifier 的正反结果和持久报告",
    // M8 — the verifier's positive AND negative result on the real path.
    planRows: ["M8"],
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
    // M1 — "流提前 break/return 后 CLI 异常 … innerCalls=1；预算不退；第二次 reserve 拒绝".
    // The A1/F1 counterexample is the worker-level form: a real dispatched call whose
    // stream is closed early must NOT be refunded, and the same approval cannot spend
    // again. The channel-level C4 test is the same fact one layer down.
    planRows: ["M1"],
    tests: [
      "R98-A C1: every logical generate() reserves BEFORE the call leaves a grant of 3 admits exactly three calls across the SAME channel",
      "R98-A C1: every logical generate() reserves BEFORE the call leaves with a grant of 1, a second generate() is refused BEFORE the provider is entered",
      "R98-A C1: every logical generate() reserves BEFORE the call leaves the budget is shared with a SECOND channel on the same ledger (the two-arm case)",
      "R98-A C3: a PRE-TAKEN reservation is adopted, not double-charged spends the caller's reservation on the first call and reserves fresh afterwards",
      // A1/F1 — the round's counterexample. A real dispatched call, a consumer that
      // BREAKS mid-stream, and the CLI throwing afterwards: the ledger entry is
      // `unknown`, remaining is 0, and a second reserve is refused.
      "R99 W11 (A1/F1): a DISPATCHED call is never refunded when the arm CLI dies afterwards grant=1, the consumer breaks mid-stream and the CLI throws: innerCalls=1, NOT abandoned, remaining=0, second reserve refused",
      "R98-A C4: an early close or an exception after dispatch still settles exactly once a consumer that BREAKS after a non-terminal event keeps the allowance (unknown) and never refunds it",
    ],
  },
  {
    id: "成功、有效负例、provider 失败后的恢复",
    planExpectation: "新调用 0；累计结果和失败不消失",
    // M9 — "正常/失败/unknown 的 resume … 损坏证据先拒绝". The A3 resume test is
    // the ordering leg: the OLD evidence is verified BEFORE any new budget is spent.
    planRows: ["M9"],
    tests: [
      "E4-R99-A D8: a resume aggregates the FULL history, not just this run a resumed run does NOT report COMPLETE when history holds failures",
      "E4-R99-A D8: a resume aggregates the FULL history, not just this run the pass aggregate is a UNION over units, never a SUM over lists counts a unit present in BOTH history and this run exactly once",
      "E4-R99-A D8: a resume aggregates the FULL history, not just this run the pass aggregate is a UNION over units, never a SUM over lists a resume reports the SAME numerator as the run it resumed",
      // A3 — the resume must not spend on the other units before it has verified the
      // old evidence. Dispatches are counted, so "0 new units" is a measured fact.
      "E4-R103 (A3): the formal CLI uses the execution clock and current inputs REAL GATE + FORMAL DRIVER: a resume verifies the OLD evidence before it spends any new budget",
    ],
  },
  {
    id: "缺 state/ledger、换目录、hash 改动",
    planExpectation: "命名拒绝；0 新调用",
    // M2 — "已消费 campaign 整目录删除后重新打开 … 同批准拒绝；没有新调用".
    // M4 — "计划后修改实际 case/staged 字节 … 首次/恢复均拒绝，调用 0".
    planRows: ["M2", "M4"],
    tests: [
      "R98-B S1: an ESTABLISHED campaign's missing state is a LOSS, not a blank slate REFUSES to treat a deleted state file as 'nothing has run'",
      "R98-B S1: an ESTABLISHED campaign's missing state is a LOSS, not a blank slate still CREATES state on a genuine first run (no ledger yet)",
      "E4-R98 S2: the execution state fails closed on identity drift refuses a store bound to a different plan digest",
      "E4-R98 S2: the execution state fails closed on identity drift refuses a corrupted store rather than treating it as empty",
      // A2/F2 — the round's counterexample: a root that SPENT its allowance is deleted
      // and the same approval is opened elsewhere. The claim anchor, not the directory,
      // decides, so the second open is a LOSS rather than a full new grant.
      "R98-A L3c: a SPENT authorization is not refreshed by deleting its root REFUSES a new root after the root that SPENT the authorization was deleted",
      "R98-A L3b: only a claim that never ESTABLISHED a budget is stale REFUSES a new root once the claiming directory is GONE — the claim is a LOSS, not garbage",
      // A2/F2 — the OTHER half: a leftover lock from a crashed process must not let
      // two real processes each mint a full budget for one approval.
      "R98-A L3f: two REAL processes racing one approval cannot both win a LEFTOVER claim lock from a crashed process cannot hand TWO roots the same approval",
      // A3/M4 — the staged bytes are compared with the APPROVED fingerprint, so
      // changing the real case content after approval is refused before a call.
      "E4-R103 (A3): the worker stages the bytes it was approved for REFUSES a unit dispatched with NO approved fingerprint, before the ledger exists",
      "E4-R103 (A3): the worker stages the bytes it was approved for REFUSES when the staged bytes do not match the approved fingerprint",
      "E4-R103 (A3): the worker stages the bytes it was approved for REFUSES when the SOURCE changes inside the copy window (probe → copy)",
      "E4-R103 (A3): the worker stages the bytes it was approved for ACCEPTS matching bytes and records the fingerprint it actually staged",
    ],
  },
  {
    id: "同单位竞争、活 owner、死 owner、reconcile retry",
    planExpectation: "所有权和预算证据，未重复执行",
    // NOT in the closing plan's M1–M9 table: this T6 row measures UNIT ownership and
    // owner liveness, which the A7 matrix does not re-open. Declared empty so the
    // omission is explicit rather than an accident of the mapping.
    planRows: [],
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
    // M5 — "只改被导入 dist 子模块 … 实际批准 digest 不匹配，调用前拒绝".
    // M6 — "身份漂移 + 成功报告 … 非 PASS；落盘与汇总一致".
    planRows: ["M5", "M6"],
    tests: [
      "R100 I2: the request the arm ACTUALLY made carries the approved identity runs under the APPROVED model and endpoint, not the default pair",
      "R100 I2: the request the arm ACTUALLY made carries the approved identity REFUSES to dispatch at all when the identity is incomplete",
      "R100 I1: the approved identity is REQUIRED, never defaulted REFUSES a missing or empty modelId rather than falling back to gpt-4o-mini",
      "R99 W8: THE REAL EXECUTION — the arm's own build actually runs the case REFUSES a unit whose checkout is not the approved build, and dispatches NOTHING",
      "R100 I3: the build identity is a BYTE hash over the modules that actually execute is null when a covered module is missing, so an unestablished build never passes",
      // A4/F4 — the round's counterexample: the identity is derived from the REAL
      // import graph, so a TRANSITIVELY imported module changes it at identical size
      // and mtime, an unresolvable dependency makes it NOT ESTABLISHED, and a unit
      // whose approved digest no longer matches is refused before the ledger opens.
      "E4-R104 (A4): the arm build identity is derived from the real import graph 1. CHANGES when a TRANSITIVELY imported module changes, at identical size and mtime",
      "E4-R104 (A4): the arm build identity is derived from the real import graph 2. is NOT ESTABLISHED (null) when an execution dependency cannot be resolved",
      "E4-R104 (A4): the arm build identity is derived from the real import graph 3. REFUSES a unit whose approved build digest no longer matches, before the ledger opens",
      // A4/F4 — the FORMAL-PATH half (plan §A4 做什么 3). The identity above is
      // derived correctly, but before this round the formal envelope had no slot
      // for it and the driver never forwarded it, so the refusal could only fire
      // where a caller opted in. These four measure the mandatory binding: the plan
      // refuses to finalize an unbound arm, the driver forwards the approved value
      // per arm, and the execution boundary refuses a moved build whose sha and
      // git-derived plan digest are both UNCHANGED (the rebuilt-`dist` case).
      "E4-R104 (A4): the formal plan binds the arm's EXECUTED bytes 1. REFUSES to finalize an arm that binds no EXECUTION build digest",
      "E4-R104 (A4): the formal plan binds the arm's EXECUTED bytes 3. REFUSES at execution time when the arm's BYTES moved, with sha and plan digest UNCHANGED",
      "E4-R104 (A4): the formal plan binds the arm's EXECUTED bytes 5. REFUSES an approval that binds NO build digest, naming regeneration",
      "E4-R104 (A4): the driver forwards the approved build identity A4: the driver forwards the APPROVED build digest to every unit, so a rebuilt arm is refused",
      // A5/F5 — the round's counterexample: the identity refusal OUTRANKS a report
      // that claims a PASS, and the approved-and-matching unit still PASSes, so the
      // priority is a total order rather than a blanket refusal.
      "R105 (A5/F5): an identity refusal outranks a report that claims a PASS PROTOCOL FIXTURE: the runtime's model ref disagrees with the approval, and the synthetic PASS report must not win",
      "R105 (A5/F5): an identity refusal outranks a report that claims a PASS PROTOCOL FIXTURE: a NULL runtime model ref is a refusal, never 'no drift'",
      "R105 (A5/F5): an identity refusal outranks a report that claims a PASS PROTOCOL FIXTURE: a FAILED dry run ends the unit BEFORE any dispatch",
      "R105 (A5/F5): an identity refusal outranks a report that claims a PASS PROTOCOL FIXTURE: a LEGITIMATE negative stays `case_failed`, not infrastructure",
      "R105 P: the verdict priority table is a real, ordered contract never lets a later assignment overwrite a more blocking fact, in EITHER order",
    ],
  },
  {
    id: "超时/取消/输出过量",
    planExpectation: "有界返回，无遗留进程，状态正确",
    // M7 — "当前 unit 中取消/总 deadline/output_limit … 当前执行及进程树停止；
    // 原因准确；预算保守结算". A6/F6 is the round's counterexample: a HANGING arm is
    // really terminated, and the driver FORWARDS the two values that end a unit.
    planRows: ["M7"],
    tests: [
      "R99-B S1: a child that IGNORES SIGTERM is still stopped, within deadline + grace returns a NAMED timeout result, and the child is really gone",
      "R99-B S2: the output cap is BYTES, not a count of chunks one HUGE chunk and many SMALL chunks are bounded identically",
      "R99-B S2: the output cap is BYTES, not a count of chunks the module's own default cap is a real byte limit, not a chunk count",
      "R99-B S3: cancellation and spawn failure are distinct, named outcomes an AbortSignal cancels a running child and is reported as `cancelled`",
      "R99-B S6: the deadline reaches the REAL execution path a unit whose deadline is ALREADY spent never dispatches, and reports timeout",
      "R99-B S7: an interrupted unit settles its budget and its state honestly a unit stopped by the deadline is TERMINAL, so a resume skips it rather than re-sending",
      // A6/F6 — a real hanging arm, stopped by the unit deadline / the cancellation,
      // with its process NOT outliving the unit and its admitted call NOT refunded.
      "E4-R106 (A6/F6): a HANGING arm is really TERMINATED, within the declared bound a dry run that never returns is stopped by the unit deadline, and its code does NOT outlive the unit",
      "E4-R106 (A6/F6): a HANGING arm is really TERMINATED, within the declared bound a DISPATCH that never returns is stopped too, and the admitted call is NOT refunded",
      "E4-R99-B (T5): the campaign's own stop, checked before every unit A6: the driver forwards the cancellation signal and the campaign's REMAINING time to every unit",
      "E4-R99-B (T5): the campaign's own stop, checked before every unit A6: an ALREADY-CANCELLED campaign never dispatches a unit at all",
    ],
  },
  {
    id: "外部 provider 未获授权",
    planExpectation: "真实 gate 拒绝、provider 未构造、外部请求 0",
    // M3 — "旧 observation.now + 当前时间已过期 … 真实 main/gate 拒绝；没有进入 worker".
    planRows: ["M3"],
    tests: [
      "E4-R97 D4: the CLI entry refuses to build a real provider by default without --fake-provider the driver only prints a plan and makes no provider",
      "E4-R97 D9: the finalized plan is executable WITHOUT modification an unauthorized run of the same unmodified artifact is NOT_RUN with 0 requests",
      // The row's third leg must be about the GATE, not about pass labelling. The
      // previous entry (`… labels a banner-derived pass as weak`) was a labelling
      // test that had nothing to do with authorization — a matrix row that is
      // satisfied by an unrelated test is a row that can go green while the
      // scenario it names is broken.
      "E4-R97 D1: every refusal path makes ZERO provider requests UNAUTHORIZED: no auth env -> refused, 0 requests, provider never constructed",
      // A3/F3 — the round's counterexample: the plan's own `observation.now` is
      // still inside the window, the EXECUTION clock is not, and the REAL gate
      // refuses with 0 calls, so the snapshot cannot stand in for the current time.
      "E4-R103 (A3): the formal CLI uses the execution clock and current inputs REAL GATE + DEV TOOL: an approval expired against the execution clock is REFUSED with 0 calls, even though plan.observation.now is still inside the window",
      "E4-R103 (A3): the formal CLI uses the execution clock and current inputs REAL GATE + FORMAL MAIN: the gate judges the CURRENT checkouts, not the plan's review snapshot",
      "E4-R103 (A3): the formal CLI uses the execution clock and current inputs REAL GATE + FORMAL MAIN: a checkout that has MOVED since approval is refused before any unit",
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
      planRows: [...(row.planRows ?? [])],
      tests: results,
      ok: results.length > 0 && results.every((r) => r.ok),
      missing,
      notPassed,
    };
  });

  // ---- THE CLOSING PLAN'S OWN M1–M9 TABLE (plan §A7 怎么做 2). -------------
  //
  // "acceptance matrix 建立下面的行为映射 … 不允许一个无关测试让多行自动通过." A
  // mapping that is only written in a comment cannot be checked. Each acceptance row
  // declares which M rows it evidences, and this computes the reverse index so an M
  // row with NO row behind it is a hard failure — the plan's table is then enforced
  // rather than described.
  //
  // It is deliberately computed from the MATRIX DEFINITION, not from the report: an
  // M row that no acceptance row claims is a gap in the mapping, and it is a gap
  // whether or not the run happened to be green.
  const declaredM = new Set(PLAN_BEHAVIOR_MATRIX.map((m) => m.id));
  const claimedM = new Set();
  for (const row of ACCEPTANCE_MATRIX) {
    for (const m of row.planRows ?? []) {
      if (!declaredM.has(m)) {
        throw new Error(`r101-matrix: acceptance row "${row.id}" claims unknown plan row ${m}`);
      }
      claimedM.add(m);
    }
  }
  const planRows = PLAN_BEHAVIOR_MATRIX.map((m) => {
    const coveredBy = rows.filter((r) => r.planRows.includes(m.id));
    return {
      id: m.id,
      requirement: m.requirement,
      minimumEvidence: m.minimumEvidence,
      coveredBy: coveredBy.map((r) => r.id),
      // An M row is satisfied only when EVERY acceptance row that claims it is
      // itself satisfied. A claim from a FAILING row is not coverage.
      ok: coveredBy.length > 0 && coveredBy.every((r) => r.ok),
    };
  });
  const uncoveredPlanRows = planRows.filter((p) => p.coveredBy.length === 0).map((p) => p.id);
  const unsatisfiedPlanRows = planRows.filter((p) => p.coveredBy.length > 0 && !p.ok).map((p) => p.id);

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
    // The closing plan's M1–M9 table, and the two ways it can be unsatisfied: an M
    // row nobody claims (a gap in the mapping) or one whose claiming rows did not
    // all pass (a scenario that is named but not measured).
    planRows,
    uncoveredPlanRows,
    unsatisfiedPlanRows,
    ok:
      rows.every((r) => r.ok) &&
      duplicates.length === 0 &&
      missingPinned.length === 0 &&
      notPassedPinned.length === 0 &&
      uncoveredPlanRows.length === 0 &&
      unsatisfiedPlanRows.length === 0,
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
  for (const row of result.planRows) {
    process.stdout.write(
      `[${row.ok ? "PASS" : "FAIL"}] ${row.id} ${row.requirement}` +
        `  <- ${row.coveredBy.length === 0 ? "(NO acceptance row claims this scenario)" : row.coveredBy.join("; ")}\n`,
    );
  }
  process.stdout.write(
    `\nr101-matrix: ${result.rows.filter((r) => r.ok).length}/${result.rows.length} row(s) satisfied, ` +
      `${result.planRows.filter((p) => p.ok).length}/${result.planRows.length} plan row(s) (M1–M9) covered and passing, ` +
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
