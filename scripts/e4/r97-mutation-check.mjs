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
 * A7's SECOND batch (plan §A7 怎么做 3, second half) adds SEVEN more, each undoing
 * the FIX a named A-round counterexample test pins: forged evidence accepted,
 * `resume=false` reusing old records, a lost cost ledger re-created as a fresh
 * allowance, the duration dimension left at zero, an escape-equivalent duplicate
 * key, the legacy candidate paid path re-opened, and the release adapter never
 * executing. `同一构建两臂` is the eighth name on that list and is ALREADY covered
 * by `same-build-for-both-arms` (T6), so it is not duplicated. Coverage is
 * reported PER ROUND, so a regression in one batch cannot hide behind another.
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
 *   node scripts/e4/r97-mutation-check.mjs --force-unlock   # drop a lock whose holder
 *                                                           # pid was recycled; it says so
 *
 * Exit codes: 0 = every mutation was caught · 1 = a mutation was NOT caught (or a
 * mutation could not be applied) · 2 = usage error · 3 = REFUSED, another live gate
 * holds the lock · 4 = REFUSED, the working tree is not clean.
 *
 * CONCURRENCY (E4-R17) — THE HAZARD THIS FILE NOW GUARDS AGAINST
 * -------------------------------------------------------------
 * MEASURED (E4-R14 report §4): a stray `node scripts/e4/r97-mutation-check.mjs` was
 * still walking the mutation list while another suite ran. That suite reported FOUR
 * failures naming `a2`'s anchor as absent — the modified file changed between
 * attempts (`r97-budget-channel.ts` EOL-only → `r97-budget-ledger.ts` →
 * `tool-call-efficiency-paired-campaign.ts` with a real mutation). After the process
 * was killed and the tree restored, the IDENTICAL command returned 47 passed (47).
 *
 * Those failures were not defects in the suite and not defects in the fixture: they
 * were a CONCURRENCY artifact. Because this gate writes to the real production
 * source, ANY other reader of the tree — a suite, a builder, a second gate — can
 * observe mutated bytes and be told it failed. So the gate now:
 *
 *   1. takes a MUTUAL-EXCLUSION LOCK (pid + host + start time + the file currently
 *      mutated) before its first write, and REFUSES to start while a live holder
 *      exists, naming the holder's pid and target;
 *   2. RECLAIMS a stale lock (holder pid not alive, or written by another host, or
 *      not a readable record) so a killed run can never deadlock CI;
 *   3. releases the lock on EVERY exit path — normal finish, thrown error, SIGINT,
 *      SIGTERM and `process.on("exit")` — restoring every file it wrote first;
 *   4. refuses to start at all on a DIRTY tree, which is what makes "restore" a
 *      provable operation instead of a destructive guess;
 *   5. fails LOUDLY and distinctly when its own anchored mutation did not land, or
 *      when a file it did not mutate changed underneath it.
 *
 * All five are driven through injectable seams (`main(argv, overrides)`, `acquireLock`,
 * `createExitGuard`, …) so they are covered by tests that never mutate a real
 * production file.
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  linkSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { hostname } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(here, "..", "..");

export const MUTATION_VERSION = "e4-r101-mutation-check-v1";

export const EXIT_OK = 0;
export const EXIT_FAILED = 1;
export const EXIT_CONFIG = 2;
/**
 * E4-R17: REFUSED — another live mutation gate holds the lock. Distinct from
 * `EXIT_CONFIG` because it is not a bad invocation: the invocation is fine and the
 * TREE is the problem. An operator (or a CI log reader) must be able to tell "you
 * typed it wrong" from "someone else is mutating production sources right now".
 */
export const EXIT_REFUSED = 3;
/**
 * E4-R17: REFUSED — the pre-flight found a working tree that is not clean. Also
 * distinct, because the repair is different: `EXIT_REFUSED` is fixed by waiting for
 * the other gate, this one by committing/stashing/checking out the dirty paths.
 */
export const EXIT_DIRTY_TREE = 4;

/** The lock record's schema tag, so a foreign or truncated file is recognizably not ours. */
export const LOCK_SCHEMA = "e4-r97-mutation-lock-v1";
/**
 * WHERE THE LOCK LIVES, AND WHY IT IS THERE.
 *
 * `.ci/` is already in `.gitignore`, which is load-bearing rather than tidy: the gate's
 * pre-flight refuses a dirty working tree, so a lock file that showed up in
 * `git status --porcelain` would make the gate refuse to start — and the SECOND gate
 * (the one the lock exists to refuse) would then be refused for the wrong reason and
 * report a dirty tree instead of a live holder. A gitignored location keeps the lock
 * invisible to the very check it must not perturb.
 */
export const LOCK_RELPATH = join(".ci", "e4-r97-mutation-check", "gate.lock.json");

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
  // =========================================================================
  // THE N5 MUTATIONS (plan §N5 怎么做): the FIVE invariants the pre-registration
  // closed loop exists to enforce. Each one breaks a different production guard,
  // so a suite that still passes proves the loop is only described, not enforced.
  //   "至少证明测试能捕获：executor 跳过 preregistration 验证、budget 改用低估值、
  //    decision 允许 1 repetition、case digest 不验证、provider 在 preflight 前构造."
  // =========================================================================
  {
    id: "n5-formal-gate-skips-preregistration-validation",
    // executor 跳过 preregistration 验证
    planWording: "executor 跳过 preregistration 验证",
    round: "N5",
    file: "packages/evaluation/src/tool-call-efficiency-preregistration-v2.ts",
    // The FORMAL execution entry point is the ONE place every paid/preflight path
    // goes through. This mutation makes it trust the artifact bytes verbatim, so
    // a v1 artifact (or a tampered derived field) is accepted instead of refused.
    find: `export function assertFormalExecutionPreregistration(json: string): ToolCallEfficiencyPreregistrationV2 {
  return parseAndValidatePreregistrationV2(json);
}`,
    replace: `export function assertFormalExecutionPreregistration(json: string): ToolCallEfficiencyPreregistrationV2 {
  // N5 mutation: the formal-execution gate trusts the artifact bytes.
  return JSON.parse(json) as ToolCallEfficiencyPreregistrationV2;
}`,
    suite: "packages/evaluation/src/tool-call-efficiency-preregistration-v2.test.ts",
    test: "refuses a v1 artifact outright",
    catchExpectation: "the formal gate no longer refuses a v1 artifact, so any schema can reach formal execution",
  },
  {
    id: "n5-budget-from-low-estimate",
    // budget 改用低估值
    planWording: "budget 改用低估值",
    round: "N5",
    file: "packages/evaluation/src/tool-call-efficiency-preregistration-v2.ts",
    // FINDING F3: the campaign budget must be the REAL worst case
    // (maxModelCallsPerRun × logical runs), never a caller/v1-style estimate of
    // 1 call per run. This mutation restores the v1 `?? 1` estimate.
    find: `  const campaignWorstCaseModelCalls = budget.maxModelCallsPerRun * derived.logicalRuns;`,
    replace: `  const campaignWorstCaseModelCalls = derived.logicalRuns; // N5 mutation: a low estimate of 1 call per run`,
    suite: "packages/evaluation/src/tool-call-efficiency-preregistration-v2.test.ts",
    test: "derives logical runs and worst case from the REAL per-run ceiling",
    catchExpectation: "the campaign worst case no longer reflects the real per-run ceiling, so the budget is a low estimate",
  },
  {
    id: "n5-decision-allows-one-repetition",
    // decision 允许 1 repetition
    planWording: "decision 允许 1 repetition",
    round: "N5",
    file: "packages/evaluation/src/champion-decision-v3.ts",
    // FINDING F2: the champion decision requires repetitions >= 2. This mutation
    // restores the permissive `>= 1`, so a single-run campaign can be concluded.
    find: `    repetitionSufficient: input.repetitions >= 2 && !input.recommendsRepetition,`,
    replace: `    repetitionSufficient: input.repetitions >= 1 && !input.recommendsRepetition, // N5 mutation: a single run is sufficient`,
    suite: "packages/evaluation/src/champion-decision-v3.test.ts",
    test: "golden: single run 32 cases",
    catchExpectation: "a single-run campaign is no longer refused for repetition, so a non-decision-ready plan can conclude",
  },
  {
    id: "n5-case-content-digest-not-verified",
    // case digest 不验证
    planWording: "case digest 不验证",
    round: "N5",
    file: "packages/evaluation/src/tool-call-efficiency-formal-run.ts",
    // FINDING F4: freezing a case ID is not enough — the CONTENT digest must be
    // re-observed and compared. This mutation drops that comparison, so a
    // rewritten case body no longer drifts and the run proceeds past the boundary.
    find: "      cmp(`dataset.cases.${c.caseId}.contentDigest`, c.contentDigest, obs.caseContentDigests[c.caseId]);",
    replace: "      void c; // N5 mutation: the per-case content digest is not verified",
    suite: "apps/cli/src/prereg-command.test.ts",
    test: "refuses a changed case content digest",
    catchExpectation: "a changed case body no longer drifts from the pre-registration, so the run reaches the provider",
  },
  {
    id: "n5-provider-constructed-before-preflight",
    // provider 在 preflight 前构造
    planWording: "provider 在 preflight 前构造",
    round: "N5",
    file: "packages/evaluation/src/tool-call-efficiency-formal-run.ts",
    // The plan requires a refusal to happen BEFORE the provider factory is even
    // called (constructing a provider can read a key or probe the network).
    // This mutation constructs it at STEP 0, before every preflight.
    find: `  // STEP 0: experiment-semantic overrides are refused. Only the artifact may
  // determine cases / repetitions / provider / model / budget.`,
    replace: `  void (await opts.makeProvider()); // N5 mutation: the provider is constructed BEFORE any preflight
  // STEP 0: experiment-semantic overrides are refused. Only the artifact may
  // determine cases / repetitions / provider / model / budget.`,
    suite: "apps/cli/src/prereg-command.test.ts",
    test: "refuses a source-sha drift",
    catchExpectation: "the provider factory is invoked before any identity check, so a refusal constructs a provider",
  },
  // =========================================================================
  // THE S0/S2 WIRING MUTATIONS — the release-CLI + evidence invariants the S0
  // reproducers pin. Each one undoes a guard added this round, so the reproducer
  // written for that guard must go RED.
  // =========================================================================
  {
    id: "s2-prereg-not-dispatched-before-provider",
    // prereg 在 provider 解析之后才分发
    planWording: "prereg 在 provider 解析之后才分发",
    round: "S0",
    file: "apps/cli/src/main.ts",
    // F1a: `main()` must dispatch the `prereg` chain BEFORE `createDefaultDeps()`
    // (which resolves a model provider from the environment). This mutation makes
    // the pre-provider predicate always false, so `prereg validate` falls through
    // to the interactive host and a billable provider is resolved first.
    //
    // `&& false` rather than deleting the condition: `args` stays referenced, so
    // the mutation changes the BEHAVIOUR under test instead of tripping an
    // unused-parameter diagnostic.
    find: `  return args[0] === "prereg";`,
    replace: `  return args[0] === "prereg" && false; // S0 mutation: prereg is dispatched after the provider is resolved`,
    suite: "apps/cli/src/prereg-production-wiring.test.ts",
    // NOTE: the `-t` filter is a REGEX, so it must not carry the test title's
    // parentheses — `(0-call command)` would be read as a group and match nothing,
    // skipping every test in the file and reporting a false MISS. This is the
    // title's prefix, which is unique and matches verbatim.
    test: "prereg validate resolves NO provider",
    catchExpectation:
      "a 0-call prereg command resolves/constructs a provider first, so the release path builds a billable provider before dispatch",
  },
  {
    id: "s4-contamination-ignores-evidence",
    // 污染不再由证据推导
    planWording: "污染不再由证据推导",
    round: "S0",
    file: "packages/evaluation/src/tool-call-efficiency-paired-campaign.ts",
    // F2/S4: contamination is a NON-NULL request-bound activation digest on a
    // baseline record, DERIVED from evidence — never a self-reported flag. This
    // mutation stops deriving it, so a baseline that observed a candidate event
    // is no longer disqualified and the pair can be concluded.
    find: `    .filter((r) => r.armId === "baseline" && (r.outcome.evidence?.activationEvidenceDigest ?? null) !== null)`,
    replace: `    .filter(() => false) // S0 mutation: contamination is no longer derived from evidence`,
    suite: "packages/evaluation/src/tool-call-efficiency-formal-gaps.test.ts",
    test: "treats a baseline activation digest as contamination and refuses ACCEPT",
    catchExpectation:
      "a baseline that observed a candidate event is no longer contaminating, so a contaminated pair reaches a decision",
  },
  // =========================================================================
  // THE A7 COUNTEREXAMPLE MUTATIONS — the second half of plan §A7 怎么做 3. The
  // plan names eight behaviours a suite must be able to catch:
  //
  //   "假 evidence 被接受、resume=false 偷用旧结果、cost budget 无法原子恢复、
  //    tool/duration 未计量、转义等价重复 key、旧 candidate 旁路、同一构建两臂、
  //    真实 CLI adapter 从未跑通."
  //
  // `同一构建两臂` is ALREADY covered by `same-build-for-both-arms` (T6) in this
  // same list, so it is not duplicated. The other SEVEN each undo the FIX that a
  // specific A-round test was written for and are bound to THAT test, so the pair
  // checks the fix rather than the file it happens to live in.
  // =========================================================================
  {
    id: "a6-forged-evidence-accepted",
    // 假 evidence 被接受
    planWording: "假 evidence 被接受",
    round: "A7",
    // =====================================================================
    // MEASURED HISTORY, and the R14 resolution.
    //
    // a85db6dc → 27/27 CAUGHT. After the R1/R2 merges this check went DEAD
    // (26/27), and R13 measured exactly why by applying this mutation and
    // instrumenting the decision:
    //   decision = INVALID, reasonCodes = ["COST_CEILING_EXCEEDED", "INCOMPARABLE"]
    //   gates.artifactIntegrity    = true   (the corroboration defeat DID work)
    //   gates.costBounded          = false
    //   gates.provenanceComparable = false
    // So the fixture was refused by TWO gates independent of evidence, and
    // flipping the verdict would have needed a compound mutation of three
    // unrelated invariants — not a minimal expression of this defect.
    //
    // R14 DECISION (with the evidence recorded in the R14 report): the cost rule
    // was NOT introduced to reject this fixture. It refuses a JOURNAL-LESS
    // campaign, which is what R2 mandatorily changed ("a missing ledger must not
    // degrade to 0"; "no journal => not proven cost-safe even when the outcome
    // delta is 0"), and this fixture simply predates the `readCostJournal`
    // wiring every production caller uses. The property the test asserts never
    // moved; the fixture only stopped isolating it.
    //
    // R14 REPAIR (in the TEST FIXTURE, not here): the fixture now hands the
    // aggregate the durable ledger the campaign really produced — a corroborated
    // ZERO (the forged runner never calls `ctx.provider`: no call, no charge, no
    // entry), which is the one zero the cost rule permits. Cost and provenance
    // therefore PASS, artifact corroboration is again the sole blocker, and this
    // one-site mutation is load-bearing once more. This anchor is unchanged; the
    // mutation was not deleted, weakened or re-pointed.
    // =====================================================================
    file: "packages/evaluation/src/prereg-run-evidence.ts",
    // A6/F4: a run's DECLARED evidence is trusted only after its raw artifacts
    // are read back and hashed. This mutation reports every claim as corroborated,
    // so a forged `traceDigest: "a".repeat(64)` with no manifest/verifier/
    // activation bytes on disk is stamped `evidenceVerified`, and the fabricated
    // pair reaches ACCEPT.
    find: `  return { verified: problems.length === 0, problems };`,
    replace: `  return { verified: true, problems }; // A7 mutation: the declared evidence is trusted without reading the raw artifacts`,
    suite: "apps/cli/src/prereg-formal-gaps.test.ts",
    test: "forged 64-hex evidence with no real trace cannot ACCEPT",
    catchExpectation:
      "a fabricated outcome with no raw trace/verifier/activation bytes is stamped verified, so the forged pair reaches ACCEPT",
  },
  {
    id: "a6-resume-false-reuses-records",
    // resume=false 偷用旧结果
    planWording: "resume=false 偷用旧结果",
    round: "A7",
    file: "packages/evaluation/src/tool-call-efficiency-paired-campaign.ts",
    // A6/F5: a FIRST run (`resume:false`) must not adopt records it did not
    // write. This mutation disables the guard, so an existing results directory is
    // silently reused and no arm is ever re-run.
    find: `  if (!resume && recordFiles.length > 0) {`,
    replace: `  if (recordFiles.length > 0 && false && !resume) { // A7 mutation: a first run silently adopts an existing results directory`,
    suite: "apps/cli/src/prereg-formal-gaps.test.ts",
    test: "resume:false must not reuse an existing run record",
    catchExpectation:
      "a first run adopts records it was never authorized to reuse instead of refusing with RESUME_NOT_REQUESTED",
  },
  {
    id: "a4-cost-budget-resume-creates-fresh-allowance",
    // cost budget 无法原子恢复（resume 重新领取额度）
    planWording: "cost budget 无法原子恢复",
    round: "A7",
    file: "packages/evaluation/src/tool-call-efficiency-formal-run.ts",
    // A4: a cost ledger lost between `rm` and `rename` is a LOSS, never a fresh
    // allowance. This mutation removes the `allowCreate` gate, so a resume over a
    // deleted `cost-budget.json` opens a brand-new full allowance instead of
    // refusing the re-open.
    find: `        if (!opts.allowCreate) {`,
    replace: `        if (false && !opts.allowCreate) { // A7 mutation: a resume may recreate a missing allowance`,
    suite: "packages/evaluation/src/tool-call-efficiency-formal-gaps.test.ts",
    test: "refuses a re-open that would recreate a deleted cost budget",
    catchExpectation:
      "a campaign whose cost ledger was lost mid-crash re-opens with a FRESH allowance instead of treating the loss as a refusal",
  },
  {
    id: "a4-duration-dimension-unmetered",
    // tool/duration 未计量
    planWording: "tool/duration 未计量",
    round: "A7",
    file: "packages/evaluation/src/tool-call-efficiency-formal-run.ts",
    // A4/F3: the duration dimension is a real ledger dimension charged from the
    // ACTUAL elapsed time. This mutation settles it at 0, so `maxDurationMs` is
    // never exercised and the cap can never bind.
    //
    // R12 anchor repair: the R2 x R3 merge resolution moved this settlement into
    // a guarded state machine (`let view: CostBudgetView; try { view = await
    // opts.costBudget.settle(...) } catch { ... }`), so the pre-merge anchor text
    // (`const view = await opts.costBudget.settle(...)`) no longer existed and the
    // mutation landed 0 times — a silent no-op, not a caught mutation. The anchor
    // below is the SAME settlement call in its current shape; the replacement is
    // unchanged, so the defeat condition (duration settled at 0) is identical.
    find: `              view = await opts.costBudget.settle(primary, {
                inputTokens,
                outputTokens,
                durationMs,
                usdMicros: chargedMicros,
              });`,
    replace: `              view = await opts.costBudget.settle(primary, {
                inputTokens,
                outputTokens,
                durationMs: 0, // A7 mutation: the duration dimension is never charged
                usdMicros: chargedMicros,
              });`,
    suite: "apps/cli/src/prereg-formal-gaps.test.ts",
    test: "the duration dimension is charged, not left at zero",
    catchExpectation:
      "a completed call charges 0ms, so maxDurationMs is never exercised and the duration cap cannot bind",
  },
  {
    id: "a3-authorization-escape-equivalent-key",
    // 转义等价重复 key
    planWording: "转义等价重复 key",
    round: "A7",
    file: "packages/evaluation/src/tool-call-efficiency-preregistration-v2.ts",
    // A3/F7: the canonical-input scan must compare the DECODED key, not the raw
    // escape text — otherwise `{"paid":false,"\u0070aid":true}` (ONE key after
    // decoding) slips a second value past `JSON.parse`. This mutation restores the
    // raw-fragment comparison. It is bound to the AUTHORIZATION boundary because
    // that document has no canonical-bytes check to mask the defect; the
    // pre-registration's own escaped-key test is also caught by
    // `CANONICAL_BYTES_REQUIRED`, so it cannot isolate this behaviour.
    find: `    const decoded: unknown = JSON.parse(\`"\${raw}"\`);
    return typeof decoded === "string" ? decoded : raw;`,
    replace: `    return raw; // A7 mutation: the key is compared as raw escape TEXT, so an escape-equivalent duplicate is missed`,
    suite: "packages/evaluation/src/tool-call-efficiency-formal-run.test.ts",
    test: "rejects a duplicate object key",
    catchExpectation:
      "an authorization whose repeated key is spelled with a \\u escape is accepted, because the scanner compares the escape text instead of the decoded key",
  },
  {
    id: "a3-legacy-candidate-paid-path-open",
    // 旧 candidate 旁路
    planWording: "旧 candidate 旁路",
    round: "A7",
    file: "apps/cli/src/benchmark-command.ts",
    // A3: the legacy `benchmark --candidate tool_call_efficiency_v1` billed entry
    // is closed before any provider construction. This mutation removes that
    // refusal, so the pre-registered candidate runs through the legacy paid path
    // again (its own plan-digest/cap guards are not the v2 gate).
    find: `  if (opts.candidate === TOOL_CALL_EFFICIENCY_CANDIDATE_ID_V2 && billingClass === "external-billed") {`,
    replace: `  if (false && opts.candidate === TOOL_CALL_EFFICIENCY_CANDIDATE_ID_V2 && billingClass === "external-billed") { // A7 mutation: the legacy candidate paid path is open again`,
    suite: "apps/cli/src/benchmark-command.test.ts",
    test: "a billed legacy run is refused before provider construction",
    catchExpectation:
      "the pre-registered candidate reaches the legacy billed path again, so the v2 pre-registration gate is bypassed",
  },
  {
    id: "a5-real-cli-adapter-never-wired",
    // 真实 CLI adapter 从未跑通
    planWording: "真实 CLI adapter 从未跑通",
    round: "A7",
    file: "apps/cli/src/prereg-production-runner.ts",
    // A5/F1: the release adapter's `runArm` is the REAL executor. This mutation
    // restores the pre-A5 `ARM_EXECUTOR_NOT_WIRED` stop, so a legal experiment can
    // be admitted and then never executed. `void executorFor;` keeps the local
    // helper referenced so the mutation changes BEHAVIOUR rather than tripping an
    // unused-local diagnostic (which would test the toolchain, not the defect).
    //
    // N2 — the anchor tracks the CURRENT production text: `runArm` now builds the
    // executor from the isolation contract the driver forwarded on the run
    // context (`ctx.isolation`) instead of a default this adapter chose. The
    // MUTATED behaviour is unchanged (the arm is never executed).
    find: `    runArm: (arm, ctx) => executorFor(ctx.isolation)(arm, ctx),`,
    replace: `    // A7 mutation: the release CLI never executes an arm (pre-A5 behaviour).
    runArm: async () => {
      void executorFor;
      throw new Error(\`\${ARM_EXECUTOR_NOT_WIRED}: A7 mutation — the release CLI never executes an arm\`);
    },`,
    suite: "apps/cli/src/prereg-formal-gaps.test.ts",
    test: "the production adapter refuses without a checkout and EXECUTES a real case with one",
    catchExpectation:
      "the release adapter refuses with ARM_EXECUTOR_NOT_WIRED even when a real frozen checkout exists, so a legal experiment can never execute",
  },
  {
    id: "s7-level-scoping-downgrades-every-problem",
    planWording: "把 bundle 复验的等级归属放宽到所有问题码",
    round: "S7",
    // The join attributes ONLY a closed set of ARM-PAIR codes to
    // `realBuildOfflineReady`; everything else must still refuse at every level.
    // Dropping the closed-set test turns the scoping into a blanket waiver, which
    // would let a bundle with NO PLATFORM — the exact CI wiring defect this round
    // fixed — pass a fixture-only run.
    file: "scripts/e4/dual-platform-acceptance.mjs",
    find: `      REAL_ARM_PAIR_ONLY_CODES.has(codeOfProblem(problem)) &&`,
    replace: `      true &&`,
    suite: "apps/cli/src/dual-platform-acceptance.test.ts",
    test: "DP-U",
    catchExpectation:
      "IDENTITY_PLATFORM_MISSING is attributed to realBuildOfflineReady, so a platform-less bundle is accepted by a fixture-only run",
  },
  {
    id: "s7-join-refuses-on-any-bundle-problem",
    planWording: "把 bundle 复验的拒绝范围还原成“任何问题都拒绝”",
    round: "S7",
    // The pre-fix behaviour: any bundle problem refuses, regardless of which
    // level it speaks to. This is what made the CI join unsatisfiable, because
    // requiring a real arm pair of a SYNTHETIC_FIXTURE_BUILD run asks for
    // something that run is defined not to have.
    file: "scripts/e4/dual-platform-acceptance.mjs",
    find: `      if (classified.blocksAll.length > 0) {`,
    replace: `      if (bundle.problems.length > 0) {`,
    suite: "apps/cli/src/dual-platform-acceptance.test.ts",
    test: "DP-S",
    catchExpectation:
      "BASELINE_/CANDIDATE_SOURCE_SHA_INVALID refuse a run that requires only fixtureProtocolReady, so the join is unsatisfiable in CI",
  },
  {
    id: "s7-ledger-lock-eperm-not-retried",
    planWording: "把 Windows 上的锁竞争 EPERM 当成致命错误",
    round: "S7",
    // `open(path,"wx")` reports contention as EPERM on Windows when the name is
    // transiently unavailable — a state the lock's OWN release `rm` creates by
    // racing another acquirer. Narrowing the absorbed set back to EEXIST alone
    // restores the defect: a live campaign aborts instead of retrying.
    file: "packages/evaluation/src/r97-budget-ledger.ts",
    find: `    if (code !== "EEXIST" && code !== "EPERM") throw err;`,
    replace: `    if (code !== "EEXIST") throw err;`,
    suite: "packages/evaluation/src/r97-budget-ledger-lock-eperm.test.ts",
    test: "[EPERM-1] concurrent acquire/release of ONE lock path never throws a raw EPERM",
    catchExpectation:
      "a raw EPERM escapes the retry/deadline machinery, so a wedged-looking lock aborts the campaign on Windows",
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

/* ===========================================================================
 * E4-R17 — THE CONCURRENCY GUARD.
 *
 * Everything in this block exists because this gate writes to the REAL
 * production source. The restoration discipline was already strong for the ONE
 * file the gate mutates; what was missing is a defence against the OTHER
 * process. Each function below is exported and takes its effects (fs, clock,
 * pid probe, process handle) as arguments, so the five behaviours can be pinned
 * by tests that never touch a real production file. The seams are `deps`, not
 * module-level singletons, for exactly that reason.
 * =========================================================================== */

/**
 * Is `pid` a live process? `process.kill(pid, 0)` sends no signal and only probes.
 *
 * `EPERM` means the process EXISTS but belongs to another user — treating that as
 * dead would let this gate start on top of a live gate owned by someone else, which
 * is the one thing the lock exists to prevent.
 */
export function defaultIsProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err && err.code === "EPERM";
  }
}

/**
 * Decide whether an existing lock record may be RECLAIMED (stale) or must be
 * RESPECTED (live).
 *
 * "Stale" is deliberately generous, because the contract is the other way round: a
 * leftover file must never deadlock a CI run, while a live holder must never be
 * overwritten. So every condition that cannot PROVE a live holder on THIS host is
 * treated as stale — an unreadable record, a foreign host (whose pids cannot be
 * probed from here), a missing pid, this very process, and a pid that is not alive.
 *
 * `env.pid === record.pid` is stale rather than live on purpose: it means the same
 * process is trying to take the lock twice, which is a re-entrant bug in the caller,
 * not a concurrent gate.
 */
export function lockStaleness(record, env) {
  if (record === null || typeof record !== "object" || Array.isArray(record)) {
    return {
      stale: true,
      because: "the lock file is not a readable lock RECORD (it is empty, truncated, or not JSON)",
    };
  }
  if (record.schema !== LOCK_SCHEMA) {
    return {
      stale: true,
      because: `the lock file is not a ${LOCK_SCHEMA} record (schema=${JSON.stringify(record.schema ?? null)})`,
    };
  }
  if (record.host !== env.host) {
    return {
      stale: true,
      because: `it was written by host ${JSON.stringify(record.host ?? null)}, not ${JSON.stringify(env.host)}, so its pid cannot be probed from here`,
    };
  }
  if (!Number.isInteger(record.pid) || record.pid <= 0) {
    return { stale: true, because: `it carries no usable pid (pid=${JSON.stringify(record.pid ?? null)})` };
  }
  if (record.pid === env.pid) {
    return { stale: true, because: `pid ${record.pid} is THIS process, so the lock was taken twice` };
  }
  if (!env.isProcessAlive(record.pid)) {
    return { stale: true, because: `its holder pid ${record.pid} is not alive on ${env.host}` };
  }
  return { stale: false, because: null };
}

/** The refusal text for a LIVE holder, naming the pid and the file it is mutating. */
export function lockRefusalReason(record) {
  const mutating =
    record && typeof record.mutating === "string" && record.mutating !== ""
      ? record.mutating
      : "nothing right now (it is between two mutations)";
  const startedAt = record && typeof record.startedAt === "string" ? record.startedAt : "NOT_OBSERVED";
  return (
    `REFUSING TO START: another mutation gate is LIVE and holds ${LOCK_RELPATH}. ` +
    `holder pid ${record?.pid ?? "NOT_OBSERVED"} on host ${record?.host ?? "NOT_OBSERVED"}, started ${startedAt}, ` +
    `currently mutating: ${mutating}. ` +
    `This gate writes to PRODUCTION sources, so with two gates running every other suite's ` +
    `failures are meaningless — they are observing mutated bytes. Wait for pid ${record?.pid ?? "?"} to finish, ` +
    `or kill it and re-run (a DEAD holder is reclaimed automatically; if the pid was recycled by an unrelated ` +
    `process, re-run with --force-unlock, which prints what it removes).`
  );
}

/**
 * Take the lock, or refuse.
 *
 * ATOMICITY. The record is written to a unique temp file FIRST and then `link`ed into
 * place: `link` fails with `EEXIST` when the name is taken, and — unlike a bare
 * `open(wx)` followed by a write — the record that becomes visible is never
 * half-written, so a concurrent reader can never see an empty file and call it stale
 * while the holder is in fact live. Where hard links are unavailable
 * (`EPERM`/`ENOSYS`/`EXDEV`), the `wx` create is still atomic as a CREATE, which is
 * the exclusion that matters.
 *
 * STALE RECLAIM is bounded (3 attempts), so processes racing to reclaim the same dead
 * lock cannot spin forever. The reclaim is MOVE→VERIFY→UNLINK rather than a bare
 * unlink: a blind unlink can delete a lock that another process created at the same
 * path between the read and the unlink, which would admit two gates. See the reclaim
 * block below. The loser of such a race sees the winner's LIVE record and refuses.
 */
export function acquireLock(deps) {
  const { lockPath, fs, env, force = false, notice = () => {} } = deps;
  fs.mkdirSync(dirname(lockPath), { recursive: true });

  const readRaw = () => {
    if (!fs.existsSync(lockPath)) return undefined;
    try {
      return fs.readFileSync(lockPath, "utf8");
    } catch {
      return null;
    }
  };

  const readRecord = () => {
    const text = readRaw();
    if (text === undefined || text === null) return text === undefined ? undefined : null;
    try {
      return JSON.parse(text);
    } catch {
      return null;
    }
  };

  if (force) {
    const held = readRecord();
    if (held !== undefined) {
      notice(
        `--force-unlock: removing ${lockPath} — holder pid ${held?.pid ?? "NOT_OBSERVED"}, ` +
          `host ${held?.host ?? "NOT_OBSERVED"}, started ${held?.startedAt ?? "NOT_OBSERVED"}, ` +
          `last mutating ${held?.mutating ?? "NOT_OBSERVED"}`,
      );
      fs.unlinkSync(lockPath);
    } else {
      notice(`--force-unlock: no lock at ${lockPath}; nothing to remove`);
    }
  }

  const body = (mutating) =>
    `${JSON.stringify(
      {
        schema: LOCK_SCHEMA,
        pid: env.pid,
        host: env.host,
        startedAt: env.now(),
        mutating: mutating ?? null,
        repoRoot: deps.repoRoot ?? null,
      },
      null,
      2,
    )}\n`;

  let reclaimedBecause = null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const text = body(null);
    const tmp = `${lockPath}.${env.pid}.${attempt}.tmp`;
    let created = false;
    try {
      fs.writeFileSync(tmp, text, "utf8");
      try {
        fs.linkSync(tmp, lockPath);
        created = true;
      } catch (err) {
        if (err && err.code === "EEXIST") {
          created = false;
        } else {
          try {
            fs.writeFileSync(lockPath, text, { encoding: "utf8", flag: "wx" });
            created = true;
          } catch (err2) {
            if (err2 && err2.code === "EEXIST") created = false;
            else throw err2;
          }
        }
      }
    } finally {
      try {
        if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
      } catch {
        /* the temp file is a scratch name; leaving it is not worth failing a gate */
      }
    }

    if (created) return { acquired: true, record: JSON.parse(text), reclaimedBecause, lockPath };

    const held = readRecord();
    const staleness = lockStaleness(held, {
      host: env.host,
      pid: env.pid,
      isProcessAlive: env.isProcessAlive,
    });
    if (!staleness.stale) {
      return { acquired: false, holder: held, reason: lockRefusalReason(held) };
    }
    reclaimedBecause = staleness.because;
    // The EXACT bytes judged stale, captured before anything is moved: the reclaim
    // below verifies that these are still the bytes it is removing.
    const staleRaw = readRaw();
    notice(
      `reclaiming a STALE lock at ${lockPath}: ${staleness.because}` +
        (held && typeof held.mutating === "string" && held.mutating !== ""
          ? `; its record says it was mutating ${held.mutating}, so the tree may still be DIRTY — the pre-flight will say so`
          : ""),
    );
    // ---- RACE-SAFE RECLAIM: MOVE, VERIFY, UNLINK — NEVER A BLIND UNLINK. --------
    //
    // A bare `unlink` here is a real hole, not a theoretical one. Between the read
    // above and the unlink, another reclaimer can delete the stale file and CREATE its
    // own live lock; a blind unlink then deletes a LIVE lock and admits a THIRD gate —
    // the opposite of what this file is for. So the file is MOVED to a private
    // quarantine name (a move cannot clobber, because the name is unique to this pid
    // and attempt) and then VERIFIED to still be the exact bytes judged stale. If it is
    // not — a lock someone else had just created — it is moved BACK, so the live holder
    // keeps what it took and this process loses the race and refuses.
    const quarantine = `${lockPath}.${env.pid}.${attempt}.stale`;
    let moved = false;
    try {
      fs.renameSync(lockPath, quarantine);
      moved = true;
    } catch (err) {
      if (!err || err.code !== "ENOENT") {
        /* the next attempt re-reads the path and reports the real state */
      }
    }
    if (moved) {
      let movedRaw = null;
      try {
        movedRaw = fs.readFileSync(quarantine, "utf8");
      } catch {
        movedRaw = null;
      }
      if (typeof staleRaw === "string" && movedRaw === staleRaw) {
        try {
          fs.unlinkSync(quarantine);
        } catch {
          /* the quarantine name is scratch; the lock path is already free */
        }
      } else {
        try {
          fs.renameSync(quarantine, lockPath);
        } catch (err) {
          try {
            fs.unlinkSync(quarantine);
          } catch {
            /* best effort */
          }
          notice(
            `WARNING: the lock at ${lockPath} was replaced while it was being reclaimed and could not be put ` +
              `back (${err && err.code ? err.code : "unknown"}). A displaced live lock may exist; re-run the gate ` +
              `and check \`git status --porcelain\`.`,
          );
        }
      }
    }
  }
  return {
    acquired: false,
    holder: readRecord(),
    reason:
      `could not take the lock at ${lockPath} after 3 attempts — another process kept recreating it, ` +
      `so this gate cannot prove it is alone in the tree`,
  };
}

/**
 * Publish the file currently being mutated, into the lock record.
 *
 * This is metadata for the REFUSAL message ("currently mutating: X"), so a failure to
 * write it must never fail a run. It is also identity-checked: if another process
 * reclaimed the lock while we were thought dead, writing our record over theirs would
 * hide THEIR holder from a third gate.
 */
export function writeLockMutation(deps) {
  const { lockPath, fs, identity, mutating } = deps;
  try {
    if (!fs.existsSync(lockPath)) return { updated: false, because: "the lock file is gone" };
    const held = JSON.parse(fs.readFileSync(lockPath, "utf8"));
    if (!held || held.pid !== identity.pid || held.startedAt !== identity.startedAt) {
      return { updated: false, because: "the lock at that path is no longer ours" };
    }
    held.mutating = mutating ?? null;
    fs.writeFileSync(lockPath, `${JSON.stringify(held, null, 2)}\n`, "utf8");
    return { updated: true, because: null };
  } catch (err) {
    return { updated: false, because: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Release the lock — ONLY when it is still OURS.
 *
 * If the holder was thought dead and another gate reclaimed the lock, deleting it here
 * would let a THIRD gate start on top of the second one. So the release is
 * identity-checked (pid + host + start time) and reports why it declined.
 */
export function releaseLock(deps) {
  const { lockPath, fs, identity } = deps;
  let held;
  try {
    if (!fs.existsSync(lockPath)) return { released: false, because: "the lock file was already gone" };
    held = JSON.parse(fs.readFileSync(lockPath, "utf8"));
  } catch {
    return { released: false, because: "the lock file could not be read" };
  }
  if (
    !held ||
    held.pid !== identity.pid ||
    held.host !== identity.host ||
    held.startedAt !== identity.startedAt
  ) {
    return {
      released: false,
      because: `the lock at ${lockPath} is no longer ours (holder pid ${held?.pid ?? "NOT_OBSERVED"}); it was NOT removed`,
    };
  }
  fs.unlinkSync(lockPath);
  return { released: true, because: null };
}

/**
 * An exact-bytes journal of every file this gate writes.
 *
 * WHY EXACT BYTES AND NOT `git checkout -- .`. The signal path must put the tree back
 * BEFORE it releases the lock, and it must do so from a signal handler where an
 * exception would escape. `git checkout -- .` would also work here (the pre-flight
 * guarantees a clean tree), but it discards anything the operator did concurrently,
 * and it cannot run at all if git is unavailable. The journal restores precisely what
 * this gate changed and touches nothing else, which is the narrower claim — and the
 * narrower claim is the one that is safe inside a signal handler.
 */
export function createJournal(fs = { writeFileSync }) {
  const entries = new Map();
  return {
    record(path, text) {
      if (!entries.has(path)) entries.set(path, text);
    },
    commit(path) {
      entries.delete(path);
    },
    size() {
      return entries.size;
    },
    paths() {
      return [...entries.keys()];
    },
    /**
     * Put every recorded file back and clear the journal. Best-effort per file: one
     * un-restorable path must not prevent the others from being repaired.
     */
    restoreAll() {
      const restored = [];
      for (const [path, text] of entries) {
        try {
          fs.writeFileSync(path, text, "utf8");
          restored.push(path);
        } catch {
          /* reported by the caller through the count it gets back */
        }
      }
      entries.clear();
      return restored;
    },
  };
}

/** The conventional `128 + signum` exit code, so a shell can tell a signal from a FAIL. */
export function signalExitCode(signal) {
  if (signal === "SIGINT") return 130;
  if (signal === "SIGTERM") return 143;
  return 128;
}

/**
 * The single exit path shared by normal completion, a throw, SIGINT, SIGTERM and
 * `process.on("exit")`.
 *
 * ORDER IS THE CONTRACT: restore the tree FIRST, release the lock SECOND. Releasing
 * first would publish "the tree is free" while a mutated file was still on disk — the
 * exact window in which another suite reads mutated code and is told it failed.
 * `used` makes it idempotent, because a signal followed by `exit` must not restore
 * twice or unlink a lock that a reclaiming process now owns.
 */
export function createExitGuard(deps) {
  const { journal, release, warn = () => {}, exit } = deps;
  let used = false;
  const restore = () => {
    if (used) return [];
    used = true;
    const restored = journal === undefined || journal === null ? [] : journal.restoreAll();
    try {
      release();
    } catch {
      /* the guard must not throw from an exit path; the lock's staleness covers a failure here */
    }
    return restored;
  };
  return {
    restoreAll: restore,
    handleExit() {
      restore();
    },
    handleSignal(signal) {
      const restored = restore();
      warn(
        `r101-mutation: received ${signal} — restored ${restored.length} file(s) this gate had written` +
          (restored.length === 0 ? "" : ` (${restored.join(", ")})`) +
          ` and released the gate lock. The tree is as it was found; NO result is reported for this run.\n`,
      );
      exit(signalExitCode(signal));
    },
  };
}

/** The dirty paths in a `git status --porcelain` blob, in porcelain order. */
export function dirtyTreePaths(porcelain) {
  return String(porcelain)
    .split(/\r?\n/)
    .map((line) => line.replace(/\s+$/, ""))
    .filter((line) => line.trim() !== "")
    .map((line) => line.slice(3).trim())
    .filter((path) => path !== "");
}

/** Strip the quotes git puts around a path containing spaces or non-ASCII bytes. */
function unquotePath(path) {
  const trimmed = String(path).trim();
  if (trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

/**
 * The paths `git diff --numstat` reports with ZERO added and ZERO deleted lines.
 *
 * THE DELIBERATE DECISION THE LEAD ASKED FOR (E4-R17), stated here rather than left
 * implicit: an EOL-only rewrite — `git status --porcelain` says ` M` while the file's
 * line-level diff is EMPTY — is TOLERATED, not refused. The reasoning is measured
 * rather than convenient:
 *
 *   * `anchorOccurrences` normalizes line endings on BOTH sides (`normalizeEol`), and
 *     the X5 tests pin that a CRLF checkout still matches every anchor. So an EOL
 *     difference cannot make anchor matching meaningless — the stated reason the
 *     pre-flight exists.
 *   * the restore is BYTE-EXACT (the file is read before the write and written back
 *     from that exact text, then re-hashed), so it does not depend on the tree being
 *     clean. Nothing about `git checkout` semantics is used to put the tree back.
 *   * this repo is on Windows with `core.autocrlf=true`, so EOL-only entries are
 *     LIKELY in normal operation, not exotic. A pre-flight that refuses them is a
 *     FALSE refusal on a harmless state — and a gate that refuses for no reason is a
 *     gate operators learn to bypass, which is worse for the hazard being fixed.
 *
 * The tolerance is NARROW, and that is what keeps it from being a hole: only a
 * ` M` (unstaged modification) whose numstat is literally `0 0` qualifies. A staged
 * change, an untracked file, a deletion, a binary diff (`- -`) and any line-level
 * change at all are REAL dirt and still refuse. The classification is a pure function
 * of git's own output, so it is pinned by tests in both directions.
 */
export function eolOnlyPaths(numstatText) {
  const paths = new Set();
  for (const line of String(numstatText ?? "").split(/\r?\n/)) {
    if (line.trim() === "") continue;
    const parts = line.split("\t");
    if (parts.length < 3) continue;
    const [added, deleted] = parts;
    const path = unquotePath(parts.slice(2).join("\t"));
    if (added === "0" && deleted === "0") paths.add(path.replace(/\\/g, "/"));
  }
  return paths;
}

/**
 * Split a dirty tree into what BLOCKS the gate and what is tolerated as EOL/stat-only.
 *
 * Returns `{ clean, tolerated, blocking }`; `clean` is true only for an EMPTY
 * porcelain. A tolerated entry is still DIRT: it is reported and recorded in the JSON
 * report, so the run never claims it started from a pristine checkout.
 */
export function preflightVerdict(porcelain, numstatText) {
  const lines = String(porcelain ?? "")
    .split(/\r?\n/)
    .map((line) => line.replace(/\s+$/, ""))
    .filter((line) => line.trim() !== "");
  if (lines.length === 0) return { clean: true, tolerated: [], blocking: [] };
  const eolOnly = eolOnlyPaths(numstatText);
  const tolerated = [];
  const blocking = [];
  for (const line of lines) {
    const status = line.slice(0, 2);
    const path = line.slice(3).trim();
    const normalized = unquotePath(path).replace(/\\/g, "/");
    const isEolOnlyEntry = status === " M" && eolOnly.has(normalized);
    (isEolOnlyEntry ? tolerated : blocking).push({ line, path, normalized });
  }
  return { clean: false, tolerated, blocking };
}

/**
 * The pre-flight refusal, for a tree whose dirt is REAL (a content change, a staged
 * change, an untracked file, a deletion).
 *
 * `git` is the authority: the paths are reported verbatim, because "the tree is dirty"
 * without the names is a message an operator cannot act on. The closing sentence is
 * the repair. EOL/stat-only entries, which are the one class this gate tolerates and
 * says so in its output, are listed separately so the message never hides dirt.
 */
export function dirtyTreeReason(verdict) {
  const blocking = verdict.blocking ?? [];
  const tolerated = verdict.tolerated ?? [];
  const shown = blocking.slice(0, 20).map((entry) => `\n  ${entry.line.trim()}`).join("");
  const more = blocking.length > 20 ? `\n  … and ${blocking.length - 20} more` : "";
  const toleratedNote =
    tolerated.length === 0
      ? ""
      : `\n(${tolerated.length} further path(s) are EOL/stat-only entries — \` M\` with an EMPTY ` +
        `line-level diff — which this gate tolerates because the anchor matcher is EOL-insensitive and ` +
        `the restore is byte-exact: ${tolerated
          .slice(0, 10)
          .map((entry) => entry.path)
          .join(", ")})`;
  return (
    `REFUSING TO START: the working tree is NOT clean — ${blocking.length} path(s) carry a REAL change ` +
    `(content, staged state, deletion or an untracked file) against HEAD:${shown}${more}${toleratedNote}\n` +
    `A mutation is applied to the REAL production source and then restored, so on a tree that is already ` +
    `dirty the gate cannot prove its restore put things back, and anchor matching against a modified file ` +
    `is meaningless. Repair: commit or stash these paths, or \`git checkout -- <paths>\`. CI runs on a clean ` +
    `checkout, so this refusal does not affect it. NOTHING was modified by this run.`
  );
}

/**
 * Did the anchored mutation actually LAND on disk?
 *
 * MEASURED DEFECT this hardens against: an anchor that silently does not match (an
 * upstream rename, an EOL difference the matcher could not absorb, a build step that
 * rewrites the file) leaves the tree UNMUTATED, the bound test PASSES, and the run
 * reports a MISS that reads like a defect in the test. The inverse is worse: a write
 * that did not take, followed by a "restore" of a file nobody changed, would report a
 * catch for a mutation that was never applied.
 *
 * THE RULE IS BYTE EQUALITY, and that is a MEASURED decision rather than the obvious
 * one. The first version of this check required "the `find` anchor is ABSENT and the
 * `replace` text is PRESENT", and the gate's own full run rejected a CORRECT
 * application with it:
 *
 *   [MISSED] n5-provider-constructed-before-preflight  THE MUTATION DID NOT LAND …
 *            found the anchor 1 time(s) and the mutated text 1 time(s)
 *
 * `n5-provider-constructed-before-preflight` is INSERT-style: its `replace` PREPENDS a
 * line to the commented block its `find` matches, so the replacement CONTAINS the
 * anchor and the anchor count correctly STAYS at 1. The absent-anchor rule therefore
 * rejected a mutation that had landed perfectly. Comparing the file against the exact
 * text the gate produced is both simpler and strictly stronger: it says "the bytes on
 * disk are the bytes this gate wrote", which is the property that matters, and it is
 * true for insert-style and replace-style anchors alike.
 *
 * `findCount`/`replaceCount` are still reported, for DIAGNOSIS only. Exported as a pure
 * function so both directions are pinned by a test rather than only observed when an
 * anchor rots.
 */
export function verifyMutationLanded(opts) {
  const { mutation, intendedText, afterText } = opts;
  if (afterText === intendedText) {
    return {
      landed: true,
      findCount: anchorOccurrences(intendedText, mutation.find),
      replaceCount: anchorOccurrences(intendedText, mutation.replace),
      reason: null,
    };
  }
  const findCount = anchorOccurrences(afterText, mutation.find);
  const replaceCount = anchorOccurrences(afterText, mutation.replace);
  return {
    landed: false,
    findCount,
    replaceCount,
    reason:
      `THE MUTATION DID NOT LAND: after writing ${mutation.file} the gate re-read the file and it is NOT the ` +
      `text the gate produced (${afterText.length} bytes on disk vs ${intendedText.length} intended; the ` +
      `anchor now appears ${findCount} time(s) and the mutated text ${replaceCount} time(s)). This gate wrote ` +
      `those bytes, so the file on disk is not the file this gate produced — either another process is editing ` +
      `the same tree or the write did not take. No result from this mutation can be trusted.`,
  };
}

/**
 * Is the mutation STILL on disk by the time the build has finished?
 *
 * MEASURED (independent verification at `9da441bf`). A foreign writer that puts the
 * ORIGINAL bytes back over the target DURING `tsc -b` produced a plausible, and
 * wrong, verdict:
 *
 *   [MISSED] a6-forged-evidence-accepted  the test PASSED with the mutation applied —
 *            it does not catch this defect
 *
 * with no `[ABORT]` and no sibling-change flag. The explanation is false: the test did
 * not run against the mutation at all, it ran against the RESTORED source. Two
 * existing checks cannot see this by construction — `verifyMutationLanded` samples the
 * file immediately after the write, which is too early for a revert that lands during
 * the build, and the sibling-change check EXCLUDES the target file, because the target
 * is legitimately dirty for as long as the mutation is applied.
 *
 * So the target is sampled a SECOND time, after the build and immediately before the
 * test run, and must still be the exact text the gate wrote. This is a DISTINCT
 * failure from `verifyMutationLanded` (the reason text differs), because the operator
 * needs to know which of the two happened: "my write never took" and "someone else
 * overwrote it while I held it" have different repairs.
 *
 * HONEST LIMIT, stated rather than papered over: a foreign writer that reverts AND
 * re-applies inside the same window leaves both samples equal to the intended text and
 * is invisible to any point-sampling check. What this closes is the PERSISTENT revert —
 * the form that was measured.
 */
export function verifyMutationStillApplied(opts) {
  const { mutation, intendedText, afterBuildText } = opts;
  if (afterBuildText === intendedText) return { landed: true, reason: null };
  return {
    landed: false,
    reason:
      `THE MUTATION DID NOT STAY APPLIED: ${mutation.file} did hold the text this gate wrote when it was ` +
      `first re-read, but by the time the workspace build finished it did NOT any more (` +
      (afterBuildText === null
        ? "the file could not be read"
        : `${afterBuildText.length} bytes on disk vs ${intendedText.length} intended`) +
      `). The bound test would then run against bytes this gate did not write, so its result must NOT be ` +
      `reported as "the test does not catch this defect" — nobody showed that. Another process is writing the ` +
      `SAME file the gate is mutating, and the sibling-change check cannot see it because the target is ` +
      `excluded there by construction. No result from this mutation can be trusted.`,
  };
}

/** The porcelain lines that differ between two `git status --porcelain` snapshots. */
export function changedPorcelainLines(before, after) {
  const a = String(before).split(/\r?\n/).filter((line) => line.trim() !== "");
  const b = String(after).split(/\r?\n/).filter((line) => line.trim() !== "");
  const inB = new Set(b);
  const inA = new Set(a);
  return [...new Set([...a.filter((line) => !inB.has(line)), ...b.filter((line) => !inA.has(line))])];
}

/**
 * The changed paths that are NOT the file this mutation was supposed to touch.
 *
 * This is the false-failure detector. `treeRestored` (before/after the WHOLE run)
 * cannot see it: the repo's porcelain carries path+status only, so a content change
 * inside a file that is ALREADY listed produces a byte-identical line — the R14 report
 * measured exactly that (`a2`'s modified file changed between attempts while a stray
 * gate walked the list). A per-mutation comparison that names the unexpected path turns
 * "the suite failed for no reason" into "another process is editing the tree".
 */
export function unexpectedChangedPaths(before, after, expectedFile) {
  const want = String(expectedFile).replace(/\\/g, "/");
  return changedPorcelainLines(before, after)
    .map((line) => ({ line, path: line.slice(3).trim().replace(/\\/g, "/") }))
    .filter((entry) => entry.path !== want);
}

/** The loud, DISTINCT failure for "a file the gate did not mutate changed". */
export function notMutatedFileChangedReason(mutation, treeNow, unexpected) {
  if (treeNow === null) {
    return (
      `A FILE THE GATE DID NOT MUTATE COULD NOT BE CHECKED: \`git status --porcelain\` failed after ${mutation.id}, ` +
      `so the gate cannot tell whether another process changed the tree. The remaining mutations are not run and ` +
      `no number from this run is trustworthy.`
    );
  }
  const lines = unexpected.map((entry) => `\n  ${entry.line.trim()}`).join("");
  return (
    `A FILE THE GATE DID NOT MUTATE CHANGED during ${mutation.id}, which only writes ${mutation.file}:${lines}\n` +
    `That is the FALSE-FAILURE mode this guard exists for: another process is editing the same working tree ` +
    `(a leftover mutation gate, or a suite that writes sources), so every result here — and every suite ` +
    `running right now — is observing bytes nobody agreed on. Aborting instead of reporting a number.`
  );
}

/**
 * A CONTENT witness for the paths the pre-flight TOLERATED.
 *
 * WHY PORCELAIN ALONE IS NOT ENOUGH (adversarial review, E4-R17). `git status
 * --porcelain` carries path+status only, so a CONTENT change inside a file that is
 * ALREADY listed as modified produces a byte-identical line. The pre-flight makes that
 * blind spot almost unreachable — a pre-dirtied file with a real content diff is
 * refused outright — but the ONE class that can be ` M` at the baseline is the
 * EOL/stat-only entry this gate tolerates, and that class is therefore exactly where
 * porcelain stops being able to see a foreign content change. Hashing those files'
 * bytes closes it, and costs nothing in the normal case: the tolerated set is empty on
 * a clean checkout, so nothing is hashed at all.
 *
 * A path whose digest cannot be read contributes its own literal `NOT_OBSERVED` rather
 * than a zero or an empty string, so an unreadable file can never compare equal to a
 * readable one by accident.
 */
export function toleratedDirtDigest(paths, digestOf) {
  return [...paths]
    .sort()
    .map((path) => `${path}:${digestOf(path) ?? "NOT_OBSERVED"}`)
    .join("\n");
}

/** The loud, DISTINCT failure for "a tolerated entry's CONTENT changed". */
export function toleratedDirtChangedReason(paths) {
  return (
    `A FILE THE GATE DID NOT MUTATE CHANGED: the pre-flight TOLERATED ${paths.length} EOL/stat-only ` +
    `entry(ies) (${paths.join(", ")}) and the CONTENT digest of at least one of them changed during the run. ` +
    `\`git status --porcelain\` CANNOT see this — a content change inside a file that is ALREADY listed as ` +
    `modified yields a byte-identical porcelain line, which is the R14 blind spot — so the digest is the check ` +
    `that detects it. Another process is editing this working tree; aborting instead of reporting a number.`
  );
}

/**
 * Apply a mutation, run its test, and restore the file.
 *
 * The restoration is in a `finally`, so an exception thrown by the test run cannot
 * leave the tree mutated. The post-restore hash is compared with the pre-mutation
 * hash and a mismatch is reported as a CONFIG failure — a mutation gate that
 * damaged the source would be worse than no gate.
 */
function runOne(mutation, ctx = {}) {
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

  const journal = ctx.journal ?? null;
  const noteMutating = ctx.noteMutating ?? (() => {});

  let result;
  try {
    // The exact pre-mutation bytes are journalled BEFORE the first write, so the
    // signal/exit guard can put this file back even if the process is torn down
    // between here and the `finally` below (E4-R17).
    if (journal !== null) journal.record(target, original);
    writeFileSync(target, applied.text, "utf8");
    // Publish the target into the lock record, so a refused second gate names the
    // file that is mutated RIGHT NOW rather than only the holder's pid.
    noteMutating(mutation.file);

    // ---- DID THE ANCHORED MUTATION ACTUALLY LAND? (E4-R17) ------------------
    //
    // The write above is re-read and compared BYTE-FOR-BYTE against the text this gate
    // produced. A write that silently did not take would otherwise make the bound test
    // PASS and be reported as a MISS that reads like a defect in the test — and, worse,
    // a restore of a file nobody changed would report a catch for a mutation never
    // applied. Byte equality rather than "the anchor is absent" because MEASURED, this
    // round: `n5-provider-constructed-before-preflight` is insert-style and its replace
    // CONTAINS its find, so the anchor legitimately survives the mutation.
    const landed = verifyMutationLanded({
      mutation,
      intendedText: applied.text,
      afterText: readFileSync(target, "utf8"),
    });
    if (!landed.landed) {
      result = {
        didNotLand: true,
        reason: landed.reason,
        landedFindCount: landed.findCount,
        landedReplaceCount: landed.replaceCount,
      };
    } else {
      // The mutated code must be TYPED, not just textual: the tests import the BUILT
      // evaluation package, so a mutation applied to `src` is invisible until the
      // package is rebuilt. A build failure is reported as a broken mutation rather
      // than being counted as the test catching it.
      const buildResult = build();
      // ---- IS THE MUTATION STILL ON DISK NOW THAT THE BUILD HAS RUN? (E4-R17b) --
      //
      // MEASURED by independent verification: a foreign writer that reverted the TARGET
      // during `tsc -b` produced a plausible `[MISSED] … the test PASSED with the
      // mutation applied — it does not catch this defect`, which was a false explanation
      // — the test ran against the restored source. Sampling again here, immediately
      // before the test run, is what makes that case a distinct failure instead.
      const stillApplied = verifyMutationStillApplied({
        mutation,
        intendedText: applied.text,
        afterBuildText: readFileSync(target, "utf8"),
      });
      if (!stillApplied.landed) {
        result = { targetChanged: true, reason: stillApplied.reason, buildCode: buildResult.code };
      } else {
        const testRun = buildResult.code === 0 ? runVitest(mutation.suite, mutation.test) : null;
        result = { buildCode: buildResult.code, buildOut: tail(buildResult.out), testRun };
      }
    }
  } finally {
    writeFileSync(target, original, "utf8");
    if (journal !== null) journal.commit(target);
    noteMutating(null);
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

  // THE TARGET WAS OVERWRITTEN UNDER THE GATE, between the write and the test run. This
  // is checked FIRST because it invalidates everything downstream: the test did not run
  // against the mutation, so "the test does not catch this defect" would be a lie.
  if (result.targetChanged === true) {
    return {
      id: mutation.id,
      planWording: mutation.planWording,
      round: mutation.round,
      file: mutation.file,
      suite: mutation.suite,
      test: mutation.test,
      ok: false,
      applied: true,
      targetChanged: true,
      reason: result.reason,
    };
  }

  if (result.didNotLand === true) {
    return {
      id: mutation.id,
      planWording: mutation.planWording,
      round: mutation.round,
      file: mutation.file,
      suite: mutation.suite,
      test: mutation.test,
      ok: false,
      applied: true,
      didNotLand: true,
      reason: result.reason,
      landedFindCount: result.landedFindCount,
      landedReplaceCount: result.landedReplaceCount,
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
 * `git diff --numstat` for the unstaged tree, or `null` when git cannot answer.
 *
 * This is what separates a REAL content change from an EOL/stat-only entry in the
 * pre-flight: an EOL-only rewrite is reported by `git status --porcelain` as ` M`
 * while its line-level numstat is literally `0\t0`. The pre-flight tolerates exactly
 * that class (see `eolOnlyPaths`) and refuses everything else. `null` is NOT treated
 * as "no diff": it fails the pre-flight closed, so git being unavailable can never be
 * mistaken for a clean tree.
 */
function diffNumstat() {
  const res = run("git", ["diff", "--numstat"]);
  return res.code === 0 ? res.out : null;
}

/**
 * sha256 of a file's bytes, or `null` when it cannot be read.
 *
 * `null` is NOT `0` and NOT `""`: an unreadable file must never compare equal to a
 * readable one, which is why `toleratedDirtDigest` renders it as the literal
 * `NOT_OBSERVED`.
 */
function fileDigest(path) {
  try {
    return hashOf(path);
  } catch {
    return null;
  }
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
  const flag = (name) => argv.includes(name);
  return { only: value("--only"), out: value("--out"), forceUnlock: flag("--force-unlock") };
}

/**
 * Run the gate.
 *
 * `overrides` IS THE INJECTABLE SEAM (E4-R17). Every effect the concurrency guard
 * depends on — the lock path and the filesystem it is created on, the pid/host/clock
 * probes, the process handle that receives signals, `git`'s tree snapshot, and the
 * per-mutation runner — can be replaced. That is what lets the five guard behaviours
 * be covered by tests that never mutate a real production file and never touch the
 * repository's own lock.
 */
export async function main(argv, overrides = {}) {
  const deps = {
    repoRoot: REPO_ROOT,
    proc: process,
    stdout: process.stdout,
    stderr: process.stderr,
    pid: process.pid,
    host: hostname(),
    now: () => new Date().toISOString(),
    isProcessAlive: defaultIsProcessAlive,
    lockPath: join(REPO_ROOT, LOCK_RELPATH),
    fs: { existsSync, readFileSync, writeFileSync, unlinkSync, mkdirSync, linkSync, renameSync },
    treeState: () => treeState(),
    diffNumstat: () => diffNumstat(),
    fileDigest: (path) => fileDigest(path),
    runOne: (mutation, ctx) => runOne(mutation, ctx),
    ...overrides,
  };
  const say = (text) => deps.stdout.write(text);
  const warn = (text) => deps.stderr.write(text);

  let parsed;
  try {
    parsed = parseArgs(argv);
  } catch (err) {
    warn(`r101-mutation: ${err instanceof Error ? err.message : String(err)}\n`);
    return EXIT_CONFIG;
  }
  const selected = parsed.only === undefined ? MUTATIONS : MUTATIONS.filter((m) => m.id === parsed.only);
  if (selected.length === 0) {
    warn(`r101-mutation: --only ${String(parsed.only)} matches no mutation\n`);
    return EXIT_CONFIG;
  }

  // ==========================================================================
  // STEP 1 — TAKE THE MUTUAL-EXCLUSION LOCK BEFORE THE FIRST WRITE. (E4-R17)
  //
  // WHY THE LOCK COMES FIRST AND THE TREE CHECK SECOND: a live holder is, by
  // construction, mid-mutation, so the tree is DIRTY for as long as it holds the lock.
  // A tree check that ran first would report "dirty tree" and hide the real cause — a
  // second gate running on top of a first, which is the measured R14 hazard. The lock
  // answers "is anyone else here"; only then does the tree check answer "is the state
  // I am starting from trustworthy".
  //
  // The holder is identified ONLY by the pid/host/start-time recorded IN the lock file
  // and probed with `process.kill(pid, 0)`. There is deliberately no process-list scan
  // anywhere in this file: a filter over the OS process table's command lines matched its own
  // query string and produced a false "live gate process" alarm this round, and a
  // lock file plus a pid probe cannot make that mistake.
  // ==========================================================================
  const lock = acquireLock({
    repoRoot: deps.repoRoot,
    lockPath: deps.lockPath,
    fs: deps.fs,
    env: { pid: deps.pid, host: deps.host, now: deps.now, isProcessAlive: deps.isProcessAlive },
    force: parsed.forceUnlock === true,
    notice: (text) => say(`[lock] ${text}\n`),
  });
  if (!lock.acquired) {
    warn(`r101-mutation: ${lock.reason}\n`);
    return EXIT_REFUSED;
  }
  const lockIdentity = lock.record;
  say(`[lock] held ${deps.lockPath} (pid ${lockIdentity.pid} on host ${lockIdentity.host})\n`);

  // ==========================================================================
  // STEP 2 — ARRANGE THAT EVERY EXIT PATH RESTORES THE TREE, THEN RELEASES.
  //
  // Registered BEFORE the first mutation, so there is no window in which a signal or
  // a throw can leave a mutated file on disk with no owner. `process.on("exit")` is
  // the last resort: it runs for `process.exit()` from anywhere, including a signal
  // handler, and cannot be skipped by an exception.
  // ==========================================================================
  const journal = createJournal(deps.fs);
  let released = false;
  const release = () => {
    if (released) return { released: false, because: "already released" };
    released = true;
    return releaseLock({ lockPath: deps.lockPath, fs: deps.fs, identity: lockIdentity });
  };
  const exitGuard = createExitGuard({
    journal,
    release,
    warn,
    exit: (code) => deps.proc.exit(code),
  });
  for (const signal of ["SIGINT", "SIGTERM"]) {
    deps.proc.on(signal, () => exitGuard.handleSignal(signal));
  }
  deps.proc.on("exit", () => exitGuard.handleExit());

  try {
    // ========================================================================
    // STEP 3 — PRE-FLIGHT: THE TREE MUST BE TRUSTWORTHY BEFORE THE FIRST WRITE.
    //
    // Fail-closed on BOTH git queries: "git could not answer" is not the same fact
    // as "the tree is clean", and treating them alike is how a guard becomes
    // decorative. The EOL/stat-only class is the ONE tolerance, it is measured from
    // git's own numstat rather than assumed, it is printed loudly, and it is
    // recorded in the report so a run never claims a pristine start.
    // ========================================================================
    const treeBefore = deps.treeState();
    if (treeBefore === null) {
      warn(
        "r101-mutation: REFUSING TO START: `git status --porcelain` could not report the working tree, so " +
          "this gate cannot prove it will restore what it changes. NOTHING was modified.\n",
      );
      return EXIT_DIRTY_TREE;
    }
    const numstat = deps.diffNumstat();
    if (numstat === null) {
      warn(
        "r101-mutation: REFUSING TO START: `git diff --numstat` could not report the working tree, so the " +
          "pre-flight cannot tell a real content change from an EOL-only entry. NOTHING was modified.\n",
      );
      return EXIT_DIRTY_TREE;
    }
    const verdict = preflightVerdict(treeBefore, numstat);
    if (verdict.blocking.length > 0) {
      warn(`r101-mutation: ${dirtyTreeReason(verdict)}\n`);
      return EXIT_DIRTY_TREE;
    }
    if (!verdict.clean) {
      say(
        `[preflight] the tree is NOT pristine, but every dirty entry is EOL/stat-only (\` M\` with an EMPTY ` +
          `line-level diff) and is TOLERATED: ${verdict.tolerated.map((entry) => entry.path).join(", ")}\n`,
      );
    }

    const noteMutating = (file) =>
      writeLockMutation({ lockPath: deps.lockPath, fs: deps.fs, identity: lockIdentity, mutating: file });

    // ---- THE CONTENT WITNESS FOR THE TOLERATED ENTRIES (adversarial review). ----
    //
    // Porcelain cannot see a content change inside a file that is ALREADY ` M`, and the
    // tolerated set is exactly the class that can be ` M` at the baseline. Hashing those
    // bytes once here and re-checking after every mutation closes the one blind spot the
    // pre-flight leaves open. On a clean checkout the set is EMPTY, so this costs
    // nothing at all.
    const toleratedPaths = verdict.tolerated.map((entry) => entry.path);
    const digestTolerated = () =>
      toleratedDirtDigest(toleratedPaths, (path) => deps.fileDigest(join(deps.repoRoot, path)));
    const toleratedAtStart = digestTolerated();
    let toleratedContentChanged = false;

    // ---- THE WORKING TREE, BEFORE AND AFTER (plan §A7 怎么做 4). -------------
    //
    //   "mutation 在隔离副本执行，结束校验工作树恢复."
    //
    // The per-file hash inside `runOne` proves the ONE mutated file came back. It
    // cannot prove the gate left nothing else behind — a mutation applied to the wrong
    // path, or a build that rewrote a tracked file, would be invisible to it. So the
    // whole TRACKED tree is snapshotted before the first mutation and compared after
    // EVERY mutation, not only after the last: comparing only the endpoints cannot see
    // a concurrent writer whose change is reverted before the gate finishes, which is
    // exactly the R14 signature (the modified file changed between two attempts and was
    // clean again at the end). The assertion is "unchanged", not "clean", so an
    // EOL-only entry the pre-flight tolerated stays tolerated.
    const results = [];
    let siblingChange = null;
    for (const mutation of selected) {
      say(`[..] applying ${mutation.id} (${mutation.planWording})\n`);
      const result = deps.runOne(mutation, { journal, noteMutating });
      const treeNow = deps.treeState();
      const unexpected = treeNow === null ? [] : unexpectedChangedPaths(treeBefore, treeNow, mutation.file);
      if (treeNow === null || unexpected.length > 0) {
        // A FILE THIS MUTATION DID NOT TOUCH CHANGED. Not a mutation result: the tree
        // is being edited by something else, so every remaining result would be a
        // number over bytes nobody agreed on. Abort LOUDLY and distinctly instead.
        const reason = notMutatedFileChangedReason(mutation, treeNow, unexpected);
        results.push({ ...result, ok: false, siblingFileChanged: true, reason });
        siblingChange = { mutationId: mutation.id, expected: mutation.file, unexpected };
        say(`[ABORT] ${mutation.id}: ${reason}\n`);
        break;
      }
      // The tolerated entries' BYTES, which porcelain cannot see through.
      if (digestTolerated() !== toleratedAtStart) {
        toleratedContentChanged = true;
        const reason = toleratedDirtChangedReason(toleratedPaths);
        results.push({ ...result, ok: false, siblingFileChanged: true, reason });
        siblingChange = {
          mutationId: mutation.id,
          expected: mutation.file,
          unexpected: toleratedPaths.map((path) => ({ line: ` M ${path} (content digest changed)`, path })),
        };
        say(`[ABORT] ${mutation.id}: ${reason}\n`);
        break;
      }
      results.push(result);
      say(
        `[${result.ok ? "CAUGHT" : "MISSED"}] ${mutation.id}` +
          (result.ok ? `  -> ${mutation.suite} fails as required\n` : `  ${result.reason ?? ""}\n`),
      );
    }

    const treeAfter = deps.treeState();
    const treeRestored = treeBefore !== null && treeAfter !== null && treeBefore === treeAfter;
    const treeDiff =
      treeRestored || treeBefore === null || treeAfter === null
        ? null
        : changedPorcelainLines(treeBefore, treeAfter).slice(0, 20).join("\n");
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
      // N5 (plan §N5): the five invariants of the pre-registration closed loop.
      n5Mutations: results.filter((r) => r.round === "N5").length,
      n5Caught: results.filter((r) => r.round === "N5" && r.ok).length,
      // S0 (plan §S0): the release-CLI wiring + evidence invariants the S0
      // reproducers pin (F1a pre-provider dispatch, F2/S4 evidence-derived
      // contamination).
      s0Mutations: results.filter((r) => r.round === "S0").length,
      s0Caught: results.filter((r) => r.round === "S0" && r.ok).length,
      mutations: results,
      // ---- THE CONCURRENCY GUARD'S OWN FACTS (E4-R17). Recorded so the report is
      // auditable: which lock was held, whether a stale one was reclaimed, which
      // EOL-only entries were tolerated, and whether either hardening check fired.
      // A run never claims a pristine start it did not have.
      lockPath: deps.lockPath,
      lockReclaimedBecause: lock.reclaimedBecause ?? null,
      preexistingEolOnlyDirt: verdict.tolerated.map((entry) => entry.path),
      eolOnlyDirtContentChanged: toleratedContentChanged,
      // `mutationsNotLanded` is the UNION of every way a mutation failed to reach the
      // test, so a reader grepping this one field for "did not land" cannot see zero
      // while an anchor refused to apply. MEASURED by independent verification: the
      // anchor-check and pre-existing-mutation branches (`applied: false`) were NOT
      // counted here, and a renamed anchor produced `mutationsNotLanded: 0` next to a
      // loud `the mutation anchor appears 0 time(s)`. The components are reported
      // separately so the count stays auditable rather than becoming a catch-all.
      mutationsNotLanded: results.filter(
        (r) => r.applied !== true || r.didNotLand === true || r.targetChanged === true,
      ).length,
      mutationsWriteClobbered: results.filter((r) => r.didNotLand === true).length,
      mutationsTargetChangedUnderGate: results.filter((r) => r.targetChanged === true).length,
      mutationsWithSiblingChange: results.filter((r) => r.siblingFileChanged === true).length,
      ...(siblingChange === null ? {} : { siblingChange }),
      // The whole-tree restoration, reported separately from the per-file hashes.
      treeRestored,
      treeDiff,
      ...(treeReason === null ? {} : { treeReason }),
      ok: results.every((r) => r.ok) && treeRestored && siblingChange === null,
      scopeNote:
        "Each mutation was applied to the real production source, the named test was run, and the source was restored and re-hashed. A CAUGHT mutation means the SELECTED test FAILED with the mutation applied — a non-zero exit from a build or collection error does NOT count — which is what makes the test a real check rather than a description. treeRestored compares the tracked working tree before and after the whole run. E4-R17: the run held an exclusive lock (pid/host/start-time recorded in the lock file), the pre-flight refused real dirt, and a mutation whose anchor did not land — or a file the gate did not mutate changing — is a DISTINCT failure rather than a silent MISS.",
    };
    if (parsed.out !== undefined) {
      const out = resolve(parsed.out);
      mkdirSync(dirname(out), { recursive: true });
      writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    }
    if (!treeRestored) {
      say(`\n[FAIL] the working tree was NOT restored: ${treeReason}\n${treeDiff ?? ""}\n`);
    }
    if (siblingChange !== null) {
      say(
        `\n[FAIL] ABORTED after ${report.totalMutations} of ${selected.length} mutation(s): a file this gate ` +
          `did NOT mutate changed during ${siblingChange.mutationId} (${siblingChange.unexpected
            .map((entry) => entry.path)
            .join(", ")}). This is the concurrency hazard E4-R17 guards against, NOT a mutation result.\n`,
      );
    }
    // A mutation that never reached its test must not be summarised as "the test did not
    // catch it": nobody showed that. Both of these get their own line in the tail, not
    // only a per-mutation reason an operator has to scroll back for.
    const didNotLand = results.filter((r) => r.didNotLand === true || r.targetChanged === true);
    if (didNotLand.length > 0) {
      say(
        `\n[FAIL] ${didNotLand.length} mutation(s) never reached their test on disk ` +
          `(${didNotLand.map((r) => r.id).join(", ")}). Their results say NOTHING about whether the bound tests ` +
          `catch the defect. This is the concurrency hazard E4-R17 guards against, NOT a mutation result.\n`,
      );
    }
    // RELEASED EXPLICITLY HERE, on the normal path, AFTER the report is written and
    // the tree has been verified — then again (idempotently) in the `finally`, which is
    // what covers the early refusals and a throw from `runOne`.
    const releaseOutcome = release();
    if (releaseOutcome.released) say(`[lock] released ${deps.lockPath}\n`);
    say(
      `\nr101-mutation: ${report.caught}/${report.totalMutations} mutation(s) CAUGHT by their tests ` +
        `(T6 ${report.t6Caught}/${report.t6Mutations}, A7 ${report.a7Caught}/${report.a7Mutations}, ` +
        `N5 ${report.n5Caught}/${report.n5Mutations}, S0 ${report.s0Caught}/${report.s0Mutations}), ` +
        `working tree ${treeRestored ? "RESTORED" : "NOT RESTORED"}\n`,
    );
    return report.ok ? EXIT_OK : EXIT_FAILED;
  } finally {
    // IDEMPOTENT SAFETY NET. This is what releases the lock when the pre-flight
    // refused, and when `runOne` threw: without it, a rejected run would leave the
    // lock on disk and the NEXT run would refuse to start against a holder that no
    // longer exists — the deadlock the stale-reclaim path exists to prevent, but which
    // should never be needed on a path the gate itself controls.
    release();
  }
}

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === (await import("node:url")).pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  process.exitCode = await main(process.argv.slice(2));
}
