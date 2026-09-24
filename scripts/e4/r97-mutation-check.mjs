#!/usr/bin/env node
/**
 * E4-R101-A (T6) — the ANTI-CHEAT mutations (plan §T6 怎么做 7), extended by A7.
 *
 *   "mutation/反例直接改变行为：让两臂都用一个构建、跳过 verifier、固定 request=r97、
 *    绕过预算、resume 丢历史失败，对应测试必须失败."          (T6 怎么做 7)
 *
 *   "mutation gate 保留现有有效覆盖，并补能破坏本轮关键不变量的最小变异，例如跳过
 *    generator finally 结算、允许丢失根目录重新领取、把正式时钟改回快照、恢复
 *    verdict 覆盖、断开当前 unit 的取消."                     (A7 怎么做 3)
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * The plan's five mutations are the plan's own list of the ways this campaign could
 * be faked. A suite that passes while every one of them goes undetected proves
 * nothing about the suite — it proves only that the suite ran. So each mutation is
 * APPLIED to the real production source, the named test is run, and the test MUST
 * FAIL. The source is then restored, and the restoration is verified by hash.
 *
 * A7 added five more, one per counterexample A1–A6 closed, to the SAME list: the
 * restoration and RED-proof discipline is the part that must not be duplicated.
 * A8 adds a TWELFTH, the worker-level half of A1/F1 (`a1-worker-settlement-failure-refunded`),
 * for the gap `docs/E4-R99-R101-report.md:2370` records — the channel's own
 * settlement failure was covered, the WORKER's handling of it was not.
 *
 * This is deliberately not a test file. It mutates production code on disk, so it
 * must never run as part of an ordinary suite where a crash could leave the tree
 * modified. It is a separate, explicitly invoked gate, and it restores the file in
 * a `finally` block.
 *
 * HOW EACH MUTATION IS APPLIED
 * ---------------------------
 * A mutation is a literal `find`/`replace` on one production file. A literal swap is
 * used rather than a regex so the mutation is exactly as wide as it looks, and the
 * script REFUSES to proceed if the `find` text is not present exactly once — a
 * mutation that silently did nothing would report a false "the test caught it".
 *
 * HOW "CAUGHT" IS DEFINED, AND WHAT DOES NOT COUNT (plan §A7 怎么做 4)
 * -------------------------------------------------------------------
 *   "mutation 在隔离副本执行，结束校验工作树恢复；断言对应测试真正 RED，不接受语法
 *    错误、构建失败或 unrelated timeout 冒充捕获了缺陷."
 *
 * A mutation counts as CAUGHT only when the test PROCESS reports a FAILED TEST — a
 * non-zero exit alone is not enough, because a build failure, a syntax error or a
 * timeout also exits non-zero while proving nothing about the assertion. So the
 * script requires all three of:
 *
 *   1. the build of the mutated source SUCCEEDED (`tsc` exit 0) — a type error means
 *      the mutation tested the compiler;
 *   2. vitest exited non-zero AND its output names the FILTERED TEST as failed —
 *      `runVitest` selects one `-t` filter, so a failure with that filter present is
 *      a failure of the assertion under test;
 *   3. the tree is restored to its pre-mutation hash, and the whole WORKING TREE
 *      (not just the one file) is checked afterwards, so a mutation that leaked into
 *      another file is a CONFIG failure rather than a silent pass.
 *
 * USAGE
 * -----
 *   node scripts/e4/r97-mutation-check.mjs
 *   node scripts/e4/r97-mutation-check.mjs --only a3-formal-clock-reverts-to-plan-snapshot
 *   node scripts/e4/r97-mutation-check.mjs --out .ci/r97-r8/mutation-report.json
 *
 * Exit codes: 0 = every mutation was caught · 1 = a mutation was NOT caught (or a
 * mutation could not be applied) · 2 = usage error.
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(here, "..", "..");

export const MUTATION_VERSION = "e4-r101-mutation-check-v1";

export const EXIT_OK = 0;
export const EXIT_FAILED = 1;
export const EXIT_CONFIG = 2;

/**
 * The mutations, each bound to the test that must catch it.
 *
 * The first five are plan §T6 怎么做 7's list. The next SIX are the ROUND
 * COUNTEREXAMPLE mutations plan §A7 怎么做 3 names, one per closed defect:
 *
 *   "mutation gate 保留现有有效覆盖，并补能破坏本轮关键不变量的最小变异，例如跳过
 *    generator finally 结算、允许丢失根目录重新领取、把正式时钟改回快照、恢复
 *    verdict 覆盖、断开当前 unit 的取消."
 *
 * They are in the SAME list rather than a second gate because the contract is
 * identical: applied to real production source, the named test must go RED, and the
 * source must be restored and re-hashed. A second list would be a second place for
 * the restoration discipline to be forgotten.
 *
 * `find`/`replace` are literal strings. `test` is a `-t` filter for vitest, chosen
 * to be the test that exists to catch EXACTLY this mutation — not the whole file,
 * so a mutation that happens to break something unrelated is not mistaken for a
 * caught mutation.
 */
export const MUTATIONS = [
  {
    id: "same-build-for-both-arms",
    // 让两臂都用一个构建
    planWording: "让两臂都用一个构建",
    round: "T6",
    file: "packages/evaluation/src/r97-plan.ts",
    // `if (false)` would be a TYPE error (`baseline` is then possibly null), which
    // would make the mutation test the type system instead of the behaviour. This
    // variant keeps the narrowing and simply never fires — a same-build pair is
    // then accepted as two historical checkouts.
    find: `    if (baseline.sourceSha === candidate.sourceSha) {`,
    replace: `    if (baseline.sourceSha === candidate.sourceSha && baseline.arm === candidate.arm) {`,
    suite: "packages/evaluation/src/r97-plan.test.ts",
    test: "refuses two arms that observed the SAME build",
    catchExpectation: "ARMS_NOT_DISTINCT is no longer raised, so the readiness check reports none",
  },
  {
    id: "skip-verifier",
    // 跳过 verifier — a pass must be substantiated by the report's own verifier.
    planWording: "跳过 verifier",
    round: "T6",
    file: "scripts/e4/r97-arm-worker.mjs",
    find: `      category: "infrastructure",
      detail: \`E4-R98: case \${caseId} reports success=true but carries no verification evidence`,
    replace: `      category: null,
      detail: \`E4-R98: case \${caseId} reports success=true but carries no verification evidence`,
    suite: "packages/evaluation/src/r97-arm-worker-contract.test.ts",
    test: "success=true WITHOUT the report's own verification evidence",
    catchExpectation: "an unsubstantiated success is classified as a PASS instead of infrastructure",
  },
  {
    id: "fixed-request-placeholder",
    // 固定 request=r97 — every case would send the SAME request.
    planWording: "固定 request=r97",
    round: "T6",
    file: "scripts/e4/r97-arm-exec.mjs",
    find: `    prefix = [["text", \`done: \${caseDef.caseId}\`]];`,
    replace: `    prefix = [["text", "r97"]];`,
    suite: "packages/evaluation/src/r97-offline-seam.test.ts",
    test: "gives DIFFERENT cases DIFFERENT claim text",
    catchExpectation: "the request text is the same fixed placeholder for every case",
  },
  {
    id: "bypass-budget",
    // 绕过预算
    planWording: "绕过预算",
    round: "T6",
    file: "packages/evaluation/src/r97-budget-ledger.ts",
    find: `              reason: \`\${R97_BUDGET_EXHAUSTED}: \${count} logical call(s) requested but only \${currentView.remaining} of \${currentView.granted} remain`,
    replace: `              reason: \`\${count} logical call(s) requested but only \${currentView.remaining} of \${currentView.granted} remain`,
    suite: "packages/evaluation/src/r97-budget-ledger.test.ts",
    // The fixture test is the one that asserts the refusal NAMES the cause
    // (`expect(c.reason).toContain("BUDGET_EXHAUSTED")`), so dropping the name from
    // the reason is what it must catch.
    test: "the §R97 acceptance fixture: grant 3, arm A uses 2, arm B gets at most 1",
    catchExpectation: "an exhausted budget no longer names BUDGET_EXHAUSTED as the cause",
  },
  {
    id: "resume-loses-history",
    // resume 丢历史失败
    planWording: "resume 丢历史失败",
    round: "T6",
    file: "scripts/e4/r97-campaign-driver.mjs",
    find: `  const historicalFailures = settled
    .filter((r) => r.status === "failed")`,
    replace: `  const historicalFailures = settled
    .filter(() => false)`,
    suite: "packages/evaluation/src/r97-driver-closed-loop.test.ts",
    test: "a resumed run does NOT report COMPLETE when history holds failures",
    catchExpectation: "a resume forgets the failures its own history recorded",
  },
  // =========================================================================
  // THE ROUND COUNTEREXAMPLE MUTATIONS (plan §A7 怎么做 3) — A1, A2, A3, A5, A6,
  // plus A4's formal path, plus the WORKER-LEVEL half of A1/F1 (A8).
  //
  // Each one undoes the FIX for the counterexample the round added, so the test
  // that was written for that counterexample must go RED. Binding a mutation to
  // the counterexample's own test is what makes the pair a check on the FIX
  // rather than on the file it happens to live in.
  // =========================================================================
  {
    id: "a1-skip-generator-finally-settlement",
    // 跳过 generator finally 结算
    planWording: "跳过 generator finally 结算",
    round: "A7",
    file: "packages/evaluation/src/r97-budget-channel.ts",
    // MEASURED DEFECT F1: settlement used to live AFTER the `for await` loop, so a
    // consumer `break` (or an iterator return, or a throw) ended the generator
    // through a completion that skipped it — the reservation stayed `reserved` and
    // the worker refunded a call that had really entered the provider. The fix
    // moved settlement into the `finally`; this mutation skips that call, which is
    // exactly the pre-fix behaviour.
    //
    // `void settle;` rather than deleting the line: the reference keeps the
    // function "used", so the mutation changes the BEHAVIOUR under test instead of
    // tripping an unused-local rule (a mutation that fails to compile tests the
    // type system, not the defect — and the gate reports that as a broken mutation).
    find: `              await settle();`,
    replace: `              void settle; // A7 mutation: the finally settlement is skipped (pre-A1 behaviour)`,
    suite: "packages/evaluation/src/r97-arm-worker-contract.test.ts",
    test: "grant=1, the consumer breaks mid-stream and the CLI throws",
    catchExpectation:
      "an entered call whose stream was closed early is left `reserved` instead of settled `unknown`, so its spend is refundable again",
  },
  {
    id: "a2-deleted-root-can-be-reclaimed",
    // 允许丢失根目录重新领取
    planWording: "允许丢失根目录重新领取",
    round: "A7",
    file: "packages/evaluation/src/r97-budget-ledger.ts",
    // MEASURED DEFECT F2: the claim anchor distinguishes a directory that only
    // PROBED (recorded, no budget ever created) from one that ESTABLISHED a budget.
    // Only the second is authoritative when its directory disappears. This
    // mutation stops recording the establishment, so the anchor can no longer tell
    // "spent here and the root was deleted" from "never started" — and one
    // `rm -rf` re-grants the whole approval.
    find: `    const establishedDirs = [...previous.establishedDirs];
    if (!establishedDirs.includes(dir)) establishedDirs.push(dir);`,
    replace: `    const establishedDirs = [...previous.establishedDirs];`,
    suite: "packages/evaluation/src/r97-campaign-lifecycle.test.ts",
    test: "REFUSES a new root after the root that SPENT the authorization was deleted",
    catchExpectation: "a deleted, already-spent root is re-claimed as a first run with a FULL second budget",
  },
  {
    id: "a3-formal-clock-reverts-to-plan-snapshot",
    // 把正式时钟改回快照
    planWording: "把正式时钟改回快照",
    round: "A7",
    file: "scripts/e4/r97-campaign-driver.mjs",
    // MEASURED DEFECT F3: the formal entry fed `{ ...plan.observation, now:
    // observation.now ?? now }` into the real gate, so the instant the approval was
    // judged against was the instant the approval itself recorded. A plan whose
    // window had already closed was still authorized, because the comparison was
    // self-referential. This mutation restores the snapshot's `now` as the clock.
    find: `  const executionNow = testClock ?? new Date().toISOString();`,
    replace: `  const executionNow = testClock ?? plan.observation?.now ?? new Date().toISOString();`,
    suite: "packages/evaluation/src/r97-driver-closed-loop.test.ts",
    test: "an approval expired against the execution clock is REFUSED with 0 calls",
    catchExpectation: "an expired approval is authorized again, because the gate judged the plan's own stale snapshot instead of the current clock",
  },
  {
    id: "a5-verdict-overwrite-restored",
    // 恢复 verdict 覆盖
    planWording: "恢复 verdict 覆盖",
    round: "A7",
    file: "scripts/e4/r97-arm-worker.mjs",
    // MEASURED DEFECT F5: the identity-drift branch set a `harness` verdict and an
    // INDEPENDENT `if/else` below it then assigned the report's classification
    // unconditionally, so a report claiming `verification_passed=true` turned a
    // refused unit into a completed PASS. The fix FOLDS the report fact through the
    // verdict priority table; this mutation restores the unconditional assignment.
    find: `          verdict = foldR97Verdict(verdict, { category: classified.category, detail: classified.detail });`,
    replace: `          verdict = { category: classified.category, detail: classified.detail };`,
    suite: "packages/evaluation/src/r97-arm-worker-contract.test.ts",
    test: "the runtime's model ref disagrees with the approval, and the synthetic PASS report must not win",
    catchExpectation: "a report that claims a PASS overwrites the identity refusal, so a drifted unit reports a completed pass",
  },
  {
    id: "a6-running-unit-cancellation-disconnected",
    // 断开当前 unit 的取消
    planWording: "断开当前 unit 的取消",
    round: "A7",
    file: "scripts/e4/r97-campaign-driver.mjs",
    // MEASURED DEFECT F6: the driver forwarded `timeoutMs` and nothing else, so a
    // unit already in flight could not be cancelled — the campaign's stop was only
    // consulted BEFORE the next unit. The fix forwards the caller's own signal (and
    // the campaign's remaining time) to every unit; this mutation drops the signal,
    // so the unit's terminable boundary never sees the cancellation.
    find: `            ...(opts.signal === undefined || opts.signal === null ? {} : { signal: opts.signal }),`,
    replace: `            ...(opts.signal === undefined || opts.signal === null ? {} : {}),`,
    suite: "packages/evaluation/src/r97-driver-closed-loop.test.ts",
    test: "A6: the driver forwards the cancellation signal and the campaign's REMAINING time to every unit",
    catchExpectation: "a unit in flight receives no cancellation handle, so an operator's stop cannot reach the running case",
  },
  {
    id: "a4-formal-path-build-binding-removed",
    // 移除正式路径的构建身份绑定
    planWording: "移除正式路径的构建身份绑定",
    round: "A7",
    file: "scripts/e4/r97-campaign-driver.mjs",
    // MEASURED DEFECT F4, formal-path half (plan §A4 做什么 3). The build identity
    // was derived correctly and the WORKER refused a mismatched
    // `approvedBuildDigest` — but only where a caller opted in, because the driver
    // never passed it. Measured before the fix (`a4/probe-optin.log`): the omitted,
    // empty and whitespace spellings of the field all reported
    // `refusalFired: false`, so a plan could be approved with nothing binding the
    // bytes that run a case — and `dist/` is gitignored, so neither the sha nor the
    // git-derived plan digest could notice a rebuilt executor.
    //
    // This mutation restores the pre-fix behaviour exactly: the approved build
    // digest is not forwarded to the unit, so the worker has nothing to compare
    // against and runs whatever bytes are on disk.
    find: `            ...(typeof plan.authorization.arms?.[arm]?.buildDigest === "string"
              ? { approvedBuildDigest: plan.authorization.arms[arm].buildDigest }
              : {}),`,
    replace: `            // A7 mutation: the approved build digest is not forwarded (pre-A4 behaviour)`,
    suite: "packages/evaluation/src/r97-driver-closed-loop.test.ts",
    test: "A4: the driver forwards the APPROVED build digest to every unit, so a rebuilt arm is refused",
    catchExpectation:
      "a unit runs bytes nobody approved: the arm's build digest is never handed to the worker, so a rebuilt dist/ executes under an old approval",
  },
  {
    id: "a1-worker-settlement-failure-refunded",
    // 已进入但未结算的调用被退款 (the worker-level half of A1/F1)
    planWording: "已进入但未结算的调用被退款",
    round: "A7",
    file: "scripts/e4/r97-arm-worker.mjs",
    // THE WORKER-LEVEL HALF OF A1/F1, and the residual gap the report names at
    // `docs/E4-R99-R101-report.md:2370`:
    //
    //   "worker 级的 settlement-write-failure 分支未被端到端覆盖（只在 channel 层覆盖）"
    //
    // The channel already settles in a `finally` and records the failure on its live
    // `stats`; `a1-skip-generator-finally-settlement` above covers THAT half. What
    // was uncovered is the WORKER's response to the measured fact
    // `dispatches[0] = { entered: true, settled: false }`: STEP 5 must take the Case-3
    // branch and keep the allowance outstanding. This mutation restores the pre-A1
    // behaviour for exactly that fact — the entered-but-unsettled dispatch falls
    // through to the `ledger.abandon(...)` refund path, which (on a deleted ledger)
    // fails and folds "could not be returned" over the refusal.
    //
    // `&& false` rather than deleting the branch: the narrowing expression and the
    // block stay intact, so the mutation changes the BEHAVIOUR under test instead of
    // tripping an unused-local/unreachable-code diagnostic. A mutation that fails to
    // compile would test the toolchain, not the defect — and the gate reports that as
    // a broken mutation rather than as a catch.
    find: `    if (unitDispatch.entered === true) {`,
    replace: `    if (unitDispatch.entered === true && false) { // A7 mutation: an entered-but-unsettled dispatch is refunded (pre-A1 behaviour)`,
    suite: "packages/evaluation/src/r97-arm-worker-contract.test.ts",
    test: "a SETTLEMENT write failure on an ENTERED call",
    catchExpectation:
      "an ENTERED call whose settlement write failed is routed to the refund path instead of being kept outstanding, so the worker reports `could not be returned` and silently re-grants a spend that may already have been billed",
  },
  // =========================================================================
  // THE N2 COUNTEREXAMPLE MUTATION (plan §N2 / finding F2).
  // =========================================================================
  {
    id: "n2-child-runner-outside-driver-identity",
    // 被 spawn 的 child runner 不在批准构建身份内
    planWording: "被 spawn 的 child runner 不在批准构建身份内",
    round: "N2",
    file: "packages/evaluation/src/r97-plan.ts",
    // FINDING F2. `r97-arm-worker.mjs` runs each case in a separate process by
    // spawning `scripts/e4/r97-arm-child-runner.mjs`, whose path is a bare STRING
    // argument to `spawn` — not an ESM import — so the import walker could not reach
    // it. Dropping the DECLARED entry restores the pre-fix behaviour: the runner's
    // bytes fall out of the approved driver build identity, editing them leaves
    // `driverBuildDigest` unchanged, and an OLD approval keeps running the MODIFIED
    // script. The two-line anchor is required because the single line also appears
    // inside the entry's own doc comment, where a one-line anchor would not be unique.
    find: `  "scripts/e4/r97-arm-exec.mjs",
  "scripts/e4/r97-arm-child-runner.mjs",`,
    replace: `  "scripts/e4/r97-arm-exec.mjs",`,
    suite: "packages/evaluation/src/r97-plan.test.ts",
    test: "6h. the child runner the ARM WORKER SPAWNS is inside the driver identity",
    catchExpectation:
      "the spawned child runner falls outside the approved driver build identity, so editing its bytes leaves driverBuildDigest unchanged and an old approval keeps executing the modified script",
  },
];

/**
 * Decide whether a mutation's target is ALREADY in its mutated state.
 *
 * MEASURED DEFECT (this round). `runOne`'s restoration proof is SELF-REFERENTIAL: it
 * reads the file at the start and compares the file against that same text after
 * writing it back. A target that was ALREADY mutated when the gate started therefore
 * has `original` == the MUTATED text, the restore "succeeds", the per-file hashes
 * agree, and the mutation is reported `restored: true` — while the defect it models
 * stays LIVE. Three targets were found in exactly that state this round
 * (`a2-deleted-root-can-be-reclaimed`, `a3-formal-clock-reverts-to-plan-snapshot`,
 * `a5-verdict-overwrite-restored`), each silently reverting a fix this campaign had
 * closed. The whole-run `treeRestored` check could not see them either: it compares
 * `git status --porcelain`, which carries only path+status, and the repo is
 * deliberately dirty — so a content change inside a file already listed as ` M`
 * produces a byte-identical porcelain line.
 *
 * The mutated state is `find` ABSENT and `replace` PRESENT. BOTH halves are required,
 * and the reason is MEASURED rather than assumed: `a2-deleted-root-can-be-reclaimed`
 * has a `replace` that is a strict SUBSTRING of its `find` (the mutation drops the
 * second line of a two-line anchor), so on a HEALTHY tree that anchor counts
 * `find=1, replace=1`. A check on `replace` alone would therefore report a
 * false-positive on a perfectly healthy checkout and wedge the gate. (Measured over
 * the gate's own list, `a2` is the only such case — the condition is stated for the
 * general shape rather than for that one entry.)
 *
 * Exported as a pure function so both directions can be pinned by a test rather than
 * only observed when a mutation happens to misfire.
 */
export function isPreexistingMutation(opts) {
  const { findCount, replaceCount } = opts;
  return findCount === 0 && replaceCount >= 1;
}

/** The refusal text for a pre-existing mutation, naming the live defect. */
export function preexistingMutationReason(mutation, replaceCount) {
  return `the target is ALREADY in its mutated state: the fixed text is ABSENT and the MUTATED text appears ${replaceCount} time(s) in ${mutation.file} BEFORE this gate wrote anything — the defect this mutation models is LIVE in the tree right now, so no result from this gate can be trusted until the fixed text is restored`;
}

/** sha256 of a file, so a restoration can be PROVED rather than assumed. */
function hashOf(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

/**
 * Reduce a string's line endings to LF.
 *
 * WHY THIS EXISTS (MEASURED, CI run 35560959837)
 * ----------------------------------------------
 * The gate originally compared its anchors with a plain `source.split(find)`. Two
 * of the five anchors span more than one line, so they contain an interior `\n` —
 * and `\n` is not what a Windows checkout holds. `git ls-files --eol` reports
 * `i/lf` for all five target files, but `core.autocrlf=true` (true in this repo and
 * in a fresh clone) rewrites a Windows working tree to CRLF, so those two anchors
 * matched 0 times and the gate refused to run:
 *
 *   skip-verifier: the anchor appears 0 time(s) in scripts/e4/r97-arm-worker.mjs
 *
 * That failed the `r97-r98 closed loop (windows-latest)` job AND the Windows
 * `Unit and integration tests` job, while ubuntu-latest — which checks out LF —
 * passed. The line ending a checkout happens to use is not part of the program, so
 * the matcher must not treat it as significant.
 */
export function normalizeEol(text) {
  return String(text).replace(/\r\n/g, "\n");
}

/**
 * The original index of every character of `normalizeEol(text)`.
 *
 * Normalizing only ever DROPS a `\r`, so the normalized text is a subsequence of
 * the original and each normalized index maps to exactly one original index. The
 * mapping is what lets the mutation be applied to the ORIGINAL bytes: every byte
 * outside the replaced span is preserved exactly, so a file with mixed line
 * endings is not silently rewritten end to end.
 */
function normalizedIndexMap(text) {
  const map = [];
  for (let i = 0; i < text.length; i += 1) {
    if (text[i] === "\r" && text[i + 1] === "\n") continue;
    map.push(i);
  }
  return map;
}

/**
 * How many times `find` occurs in `source`, ignoring a line-ending difference
 * between the two. This is the count the gate's "exactly once" rule is about.
 */
export function anchorOccurrences(source, find) {
  const needle = normalizeEol(find);
  if (needle === "") return 0;
  return normalizeEol(source).split(needle).length - 1;
}

/**
 * Apply a mutation, tolerating a line-ending difference between the anchor and the
 * file. Returns `{ ok, occurrences, text }`; when `ok` is false, `text` is the
 * input unchanged, so a caller cannot accidentally write a half-applied mutation.
 */
export function applyAnchor(source, find, replace) {
  const hay = normalizeEol(source);
  const needle = normalizeEol(find);
  const occurrences = needle === "" ? 0 : hay.split(needle).length - 1;
  if (occurrences !== 1) return { ok: false, occurrences, text: source };
  const map = normalizedIndexMap(source);
  const at = hay.indexOf(needle);
  const start = map[at];
  const end = map[at + needle.length - 1] + 1;
  // The replacement adopts the FILE's line endings, so a mutated CRLF checkout
  // stays uniformly CRLF rather than gaining mixed endings.
  const body = /\r\n/.test(source) ? normalizeEol(replace).replace(/\n/g, "\r\n") : replace;
  return { ok: true, occurrences, text: source.slice(0, start) + body + source.slice(end) };
}

/**
 * Apply a mutation, run its test, and restore the file.
 *
 * The restoration is in a `finally`, so an exception thrown by the test run cannot
 * leave the tree mutated. The post-restore hash is compared with the pre-mutation
 * hash and a mismatch is reported as a CONFIG failure — a mutation gate that
 * damaged the source would be worse than no gate.
 */
function runOne(mutation) {
  const target = join(REPO_ROOT, mutation.file);
  const original = readFileSync(target, "utf8");
  const originalHash = hashOf(target);

  // ---- A TARGET ALREADY IN ITS MUTATED STATE IS A REFUSAL, NOT A CATCH. ----
  //
  // MEASURED DEFECT (this round). The restoration proof below is SELF-REFERENTIAL:
  // it reads `original` at the start and compares the file against `original` after
  // writing it back. A file that was ALREADY mutated when the gate started therefore
  // has `original` == the MUTATED text, the restore "succeeds", the hashes agree, and
  // the mutation is reported `restored: true` — while the tree stays mutated and the
  // defect the mutation models stays LIVE. Three targets were found in exactly that
  // state (`a2-deleted-root-can-be-reclaimed`, `a3-formal-clock-reverts-to-plan-snapshot`,
  // `a5-verdict-overwrite-restored`), each silently reverting a fix this campaign
  // closed, and the whole-run `treeRestored` check could not see them either because
  // `git status --porcelain` carries only path+status — and a content change inside a
  // file ALREADY listed as ` M` produces an identical porcelain line.
  //
  // So the two anchors are counted BEFORE anything is written. The mutated state is
  // exactly `find` ABSENT and `replace` PRESENT. Both halves are required, and the
  // reason is MEASURED: `a2-deleted-root-can-be-reclaimed`'s `replace` is a strict
  // SUBSTRING of its `find`, so on a healthy tree that anchor counts `find=1,
  // replace=1` — a `replace`-only check would false-positive there and wedge the gate.
  //
  // A refused run names the real condition instead of being reported as a MISS with a
  // misleading "the anchor appears 0 time(s) ... ambiguous or a no-op" — which reads
  // like an upstream rename and, crucially, was never repaired.
  const findCount = anchorOccurrences(original, mutation.find);
  const replaceCount = anchorOccurrences(original, mutation.replace);
  if (isPreexistingMutation({ findCount, replaceCount })) {
    return {
      id: mutation.id,
      planWording: mutation.planWording,
      round: mutation.round,
      file: mutation.file,
      ok: false,
      applied: false,
      preexistingMutation: true,
      reason: preexistingMutationReason(mutation, replaceCount),
    };
  }

  const applied = applyAnchor(original, mutation.find, mutation.replace);
  if (!applied.ok) {
    return {
      id: mutation.id,
      planWording: mutation.planWording,
      round: mutation.round,
      ok: false,
      applied: false,
      reason: `the mutation anchor appears ${applied.occurrences} time(s) in ${mutation.file}; exactly 1 is required, so the mutation would be ambiguous or a no-op`,
    };
  }

  let result;
  try {
    writeFileSync(target, applied.text, "utf8");
    // The mutated code must be TYPED, not just textual: the tests import the BUILT
    // evaluation package, so a mutation applied to `src` is invisible until the
    // package is rebuilt. A build failure is reported as a broken mutation rather
    // than being counted as the test catching it.
    const buildResult = build();
    const testRun = buildResult.code === 0 ? runVitest(mutation.suite, mutation.test) : null;
    result = { buildCode: buildResult.code, buildOut: tail(buildResult.out), testRun };
  } finally {
    writeFileSync(target, original, "utf8");
    // Rebuilding from the RESTORED source is what makes the restoration complete:
    // leaving a mutated `dist` behind would poison every later run.
    build();
  }

  const restoredHash = hashOf(target);
  if (restoredHash !== originalHash) {
    return {
      id: mutation.id,
      planWording: mutation.planWording,
      round: mutation.round,
      ok: false,
      applied: true,
      reason: `RESTORATION FAILED: ${mutation.file} hashes ${restoredHash} but was ${originalHash} before the mutation`,
    };
  }

  if (result.buildCode !== 0) {
    return {
      id: mutation.id,
      planWording: mutation.planWording,
      round: mutation.round,
      ok: false,
      applied: true,
      reason: `the mutation does not COMPILE, so it tests the type system rather than the behaviour: ${result.buildOut}`,
    };
  }

  // ---- WHAT COUNTS AS "CAUGHT" (plan §A7 怎么做 4). ------------------------
  //
  //   "断言对应测试真正 RED，不接受语法错误、构建失败或 unrelated timeout 冒充捕获了
  //    缺陷."
  //
  // A non-zero exit is NOT sufficient evidence. `vitest` exits non-zero for a build
  // failure, a collection error, an unhandled exception, and a timeout — none of
  // which says anything about the assertion under test. The decision is delegated to
  // `classifyCatch`, which is exported so its refusals can be pinned by a test
  // rather than only observed when a mutation happens to misfire.
  const output = result.testRun.out;
  const verdict = classifyCatch({
    exitCode: result.testRun.code,
    output,
    testFilter: mutation.test,
  });
  return {
    id: mutation.id,
    planWording: mutation.planWording,
    round: mutation.round,
    file: mutation.file,
    suite: mutation.suite,
    test: mutation.test,
    catchExpectation: mutation.catchExpectation,
    ok: verdict.caught,
    applied: true,
    restored: true,
    restoredHash,
    testExitCode: result.testRun.code,
    // The facts that make the verdict auditable rather than a bare boolean.
    failedTestNamed: verdict.failedTestNamed,
    ...(verdict.caught ? {} : { reason: verdict.reason }),
    ...(verdict.caught ? { evidence: tail(output, 12) } : { output: tail(output, 20) }),
  };
}

/**
 * Remove ANSI SGR/CSI escape sequences from a string.
 *
 * WHY THIS EXISTS (MEASURED, CI run 35972462139): vitest colors its reporter when
 * stdout looks like a terminal, and a GitHub runner makes it look like one. The
 * verbose reporter's failing-test line is then
 *
 *   "\u001b[41m\u001b[1m FAIL \u001b[22m\u001b[49m packages/… > … > <name>"
 *
 * so any matcher anchored on a line START (like `/^\s*FAIL\s+\S/m`) silently stops
 * matching — the gate reported 0/12 caught on BOTH platforms while every mutated test
 * was in fact failing correctly. Locally vitest emits no color (stdout is not a TTY),
 * which is exactly why this was invisible before the push.
 *
 * Only escape sequences are removed; the surrounding text is untouched, so a stripped
 * and an unstripped run produce the same verdict.
 */
export function stripAnsi(text) {
  // CSI sequences (SGR color, cursor moves) and the two-character ESC forms.
  // eslint-disable-next-line no-control-regex
  return String(text).replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, "").replace(/\u001b[@-Z\\-_]/g, "");
}

/**
 * Decide whether a mutated run really CAUGHT the defect (plan §A7 怎么做 4).
 *
 *   "断言对应测试真正 RED，不接受语法错误、构建失败或 unrelated timeout 冒充捕获了
 *    缺陷."
 *
 * A non-zero exit is not sufficient. `vitest` also exits non-zero for a build
 * failure, a collection error, an unhandled exception and a timeout — none of which
 * says anything about the assertion under test. So a catch requires ALL of:
 *
 *   * a non-zero exit;
 *   * the verbose reporter's per-test FAILED marker (`FAIL <file> > <name>`), which
 *     is emitted for a failing TEST and not for an infrastructure abort;
 *   * the selected filter's own text in the output, so the failure is the test that
 *     was asked for rather than another test in the same file;
 *   * no collection-error signature, which would mean the suite never loaded and any
 *     exit code is meaningless.
 *
 * Exported so the refusals are pinned by a test: a gate whose "caught" rule is only
 * exercised when a mutation happens to misfire has an untested decision at its core.
 */
export function classifyCatch(opts) {
  const { exitCode, output, testFilter } = opts;
  // ---- THE PER-TEST FAILED MARKER MUST BE FOUND IN COLORED OUTPUT TOO. -------
  //
  // MEASURED DEFECT (CI run 35972462139, BOTH platforms, 0/12 "caught"): vitest
  // colors its reporter when it believes stdout is a terminal, and on a GitHub
  // runner it does. The verbose reporter's failing-test line then arrives as
  //
  //   "\u001b[41m\u001b[1m FAIL \u001b[22m\u001b[49m packages/… > … > <name>"
  //
  // — the literal `FAIL` is preceded by ANSI SGR sequences, so `/^\s*FAIL\s+\S/m`
  // did not match, `failedTestMarker` was false, and EVERY mutation was reported as
  // "exited 1 with no per-test FAILED marker … an infrastructure abort or a timeout".
  // The suite was not broken: the stored output for `same-build-for-both-arms` shows
  // the correct assertion failing (`expected 1 to be 2`) on the correct test.
  //
  // This is why the failure was invisible locally and appeared only in CI: vitest
  // omits color when stdout is not a TTY, so the same gate passed on this machine.
  // The ANSI sequences are stripped before matching, so the marker is recognized
  // identically in a colored and an uncolored run.
  const plain = stripAnsi(output);
  const failedTestMarker = /^\s*FAIL\s+\S/m.test(plain);
  const namesTheFilteredTest = plain.includes(testFilter);
  const collectionError = /No test files found|No tests found|Failed to load|Cannot find module/i.test(plain);
  const failedTestNamed = failedTestMarker && namesTheFilteredTest;
  if (exitCode === 0) {
    return {
      caught: false,
      failedTestNamed,
      reason: "the test PASSED with the mutation applied — it does not catch this defect",
    };
  }
  if (collectionError) {
    return {
      caught: false,
      failedTestNamed,
      reason:
        "the suite did not COLLECT (a load/module error), so its exit code says nothing about the assertion under test — " +
        "a collection failure does not count as catching the defect",
    };
  }
  if (!failedTestMarker) {
    return {
      caught: false,
      failedTestNamed,
      reason:
        `the run exited ${exitCode} with no per-test FAILED marker, which is what an infrastructure abort or a timeout ` +
        `looks like — an unrelated failure does not count as catching the defect`,
    };
  }
  if (!namesTheFilteredTest) {
    return {
      caught: false,
      failedTestNamed,
      reason:
        `the run failed a DIFFERENT test: the selected filter ${JSON.stringify(testFilter)} does not appear in the output, ` +
        `so the mutation was caught by something other than the test bound to it`,
    };
  }
  return { caught: true, failedTestNamed, reason: null };
}

/**
 * The working tree as `git status --porcelain`, or `null` when git cannot answer.
 *
 * Plan §A7 怎么做 4 requires the working tree to be verified RESTORED when the gate
 * finishes. The repo is expected to be DIRTY during this round (the round's own
 * changes are uncommitted), so "clean" is the wrong assertion — what must hold is
 * that the gate left the tree EXACTLY as it found it. That is a before/after
 * comparison of this string, not a cleanliness test.
 */
function treeState() {
  const res = run("git", ["status", "--porcelain"]);
  return res.code === 0 ? res.out : null;
}

/**
 * Rebuild the workspace with `tsc -b`, through TypeScript's own JS entry.
 *
 * MEASURED: `pnpm` cannot be spawned with `shell: false` at all — `pnpm.cmd` gives
 * `EINVAL` on Node 24 and a bare `pnpm` gives `ENOENT` on Windows. `shell: true`
 * would work but reintroduces the platform dependency the closed-loop runner was
 * written to remove, and this gate must be runnable on both platforms. TypeScript's
 * `bin/tsc` is a plain JS file, so `process.execPath` runs it directly.
 *
 * The rebuild matters for CORRECTNESS, not just for compilation: the tests import
 * `packages/evaluation/dist`, so a mutation applied to `src` is invisible until the
 * package is rebuilt — and the restoration is incomplete until it is rebuilt again.
 */
function build() {
  return run(process.execPath, [join(REPO_ROOT, "node_modules", "typescript", "bin", "tsc"), "-b"], 900_000);
}

/** Run a command, returning `{ code, out }`. A non-zero exit is data. */
function run(cmd, args, timeout, extraEnv) {
  try {
    const out = execFileSync(cmd, args, {
      cwd: REPO_ROOT,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout,
      maxBuffer: 128 * 1024 * 1024,
      shell: false,
      env: extraEnv === undefined ? process.env : { ...process.env, ...extraEnv },
    });
    return { code: 0, out: String(out) };
  } catch (err) {
    return {
      code: typeof err?.status === "number" ? err.status : 1,
      out: `${String(err?.stdout ?? "")}\n${String(err?.stderr ?? err?.message ?? "")}`,
    };
  }
}

/**
 * Run vitest's real `.mjs` entry directly (no `.cmd` shim, which needs a shell).
 *
 * COLOR IS FORCED OFF, AND THAT IS A CORRECTNESS REQUIREMENT RATHER THAN TIDINESS.
 * CI run 35972462139 reported `0/12` caught on BOTH platforms: on a GitHub runner
 * vitest believes stdout is a terminal, colors the reporter, and the verbose failing
 * line becomes `"\u001b[41m\u001b[1m FAIL \u001b[22m\u001b[49m …"` — which the
 * line-anchored `/^\s*FAIL\s+\S/m` did not match, so every mutation was rejected as
 * "an infrastructure abort or a timeout" while the mutated tests were failing
 * correctly. Locally stdout is not a TTY, so no color was emitted and the gate passed;
 * the defect was only reachable in CI.
 *
 * `classifyCatch` also strips ANSI (belt and braces, and it is pinned by a test), but
 * the PARSER must not depend on a heuristic the environment can flip. `NO_COLOR` is
 * the conventional opt-out vitest honours; `FORCE_COLOR=0` covers the other direction.
 * With both set the reporter's text is the same bytes on a laptop and on a runner.
 */
function runVitest(suite, testFilter) {
  return run(
    process.execPath,
    [join(REPO_ROOT, "node_modules", "vitest", "vitest.mjs"), "run", suite, "-t", testFilter, "--reporter=verbose"],
    900_000,
    { NO_COLOR: "1", FORCE_COLOR: "0" },
  );
}

function tail(text, lines = 25) {
  return String(text)
    .split(/\r?\n/)
    .filter((l) => l.trim() !== "")
    .slice(-lines)
    .join("\n");
}

export function parseArgs(argv) {
  const value = (name) => {
    const i = argv.indexOf(name);
    if (i < 0) return undefined;
    const v = argv[i + 1];
    if (v === undefined || v.startsWith("--")) throw new Error(`${name} requires a value`);
    return v;
  };
  return { only: value("--only"), out: value("--out") };
}

export async function main(argv) {
  let parsed;
  try {
    parsed = parseArgs(argv);
  } catch (err) {
    process.stderr.write(`r101-mutation: ${err instanceof Error ? err.message : String(err)}\n`);
    return EXIT_CONFIG;
  }
  const selected = parsed.only === undefined ? MUTATIONS : MUTATIONS.filter((m) => m.id === parsed.only);
  if (selected.length === 0) {
    process.stderr.write(`r101-mutation: --only ${String(parsed.only)} matches no mutation\n`);
    return EXIT_CONFIG;
  }

  // ---- THE WORKING TREE, BEFORE AND AFTER (plan §A7 怎么做 4). -------------
  //
  //   "mutation 在隔离副本执行，结束校验工作树恢复."
  //
  // The per-file hash above proves the ONE mutated file came back. It cannot prove
  // the gate left nothing else behind — a mutation applied to the wrong path, or a
  // build that rewrote a tracked file, would be invisible to it. So the whole
  // TRACKED tree is snapshotted before the first mutation and compared after the
  // last. The repo is legitimately dirty during this round, so the assertion is
  // "unchanged", not "clean": comparing the two snapshots is what catches a leak
  // without demanding a pristine checkout.
  const treeBefore = treeState();

  const results = [];
  for (const mutation of selected) {
    process.stdout.write(`[..] applying ${mutation.id} (${mutation.planWording})\n`);
    const result = runOne(mutation);
    results.push(result);
    process.stdout.write(
      `[${result.ok ? "CAUGHT" : "MISSED"}] ${mutation.id}` +
        (result.ok ? `  -> ${mutation.suite} fails as required\n` : `  ${result.reason ?? ""}\n`),
    );
  }

  const treeAfter = treeState();
  const treeRestored = treeBefore !== null && treeAfter !== null && treeBefore === treeAfter;
  const treeDiff =
    treeRestored || treeBefore === null || treeAfter === null
      ? null
      : treeBefore
          .split(/\r?\n/)
          .filter((l) => l.trim() !== "" && !treeAfter.split(/\r?\n/).includes(l))
          .concat(
            treeAfter
              .split(/\r?\n/)
              .filter((l) => l.trim() !== "" && !treeBefore.split(/\r?\n/).includes(l)),
          )
          .slice(0, 20)
          .join("\n");
  // Fail-closed, and SAY WHICH failure it was. `git` being unavailable is not the
  // same fact as the tree having changed, and an operator debugging a red gate needs
  // to know which one they have.
  const treeReason = treeRestored
    ? null
    : treeBefore === null || treeAfter === null
      ? "git could not report the working tree (`git status --porcelain` failed), so the restoration could not be verified — refusing to report success without the check plan §A7 怎么做 4 requires"
      : "the tracked working tree DIFFERS after the run: the gate did not leave it as it found it";

  const report = {
    schema: "e4-r101-mutation-report-v1",
    mutationVersion: MUTATION_VERSION,
    platform: process.platform,
    totalMutations: results.length,
    caught: results.filter((r) => r.ok).length,
    // The rounds are reported SEPARATELY as well as in total, so "12/12 caught"
    // cannot hide a regression in one set behind another set's size.
    t6Mutations: results.filter((r) => r.round === "T6").length,
    t6Caught: results.filter((r) => r.round === "T6" && r.ok).length,
    a7Mutations: results.filter((r) => r.round === "A7").length,
    a7Caught: results.filter((r) => r.round === "A7" && r.ok).length,
    mutations: results,
    // The whole-tree restoration, reported separately from the per-file hashes.
    treeRestored,
    treeDiff,
    ...(treeReason === null ? {} : { treeReason }),
    ok: results.every((r) => r.ok) && treeRestored,
    scopeNote:
      "Each mutation was applied to the real production source, the named test was run, and the source was restored and re-hashed. A CAUGHT mutation means the SELECTED test FAILED with the mutation applied — a non-zero exit from a build or collection error does NOT count — which is what makes the test a real check rather than a description. treeRestored compares the tracked working tree before and after the whole run.",
  };
  if (parsed.out !== undefined) {
    const out = resolve(parsed.out);
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  }
  if (!treeRestored) {
    process.stdout.write(
      `\n[FAIL] the working tree was NOT restored: ${treeReason}\n${treeDiff ?? ""}\n`,
    );
  }
  process.stdout.write(
    `\nr101-mutation: ${report.caught}/${report.totalMutations} mutation(s) CAUGHT by their tests ` +
      `(T6 ${report.t6Caught}/${report.t6Mutations}, A7 ${report.a7Caught}/${report.a7Mutations}), ` +
      `working tree ${treeRestored ? "RESTORED" : "NOT RESTORED"}\n`,
  );
  return report.ok ? EXIT_OK : EXIT_FAILED;
}

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === (await import("node:url")).pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  process.exitCode = await main(process.argv.slice(2));
}
