// E4-R99 — the ARM WORKER: one unit = (caseId, arm, repetition) executed inside
// ONE arm's own checkout, under the shared R97/R98 budget and execution state.
//
// WHY THIS FILE EXISTS (plan §0.1 finding F1, priority P0)
// -------------------------------------------------------
// The R97 driver dispatched a FIXED `messages:[{role:"user",content:"r97"}]`
// once per (arm, case). It never loaded the case request, never materialised a
// fixture, never ran the tool loop, and never ran a verifier. The `arm` label
// affected only looping/budget bookkeeping. So the campaign was NOT a
// two-version A/B, and `COMPLETE` did not prove that any case executed.
//
// Plan §R99 做什么 states the replacement:
//
//   1. "替换固定 `messages:[{role:"user",content:"r97"}]` 的占位执行."
//   3. "执行实际两臂 build；一个 model client 加 arm 标签不构成版本 A/B."
//   5. "明确运行完整度、任务通过率和机制改善是不同字段."
//   6. "加入真正的超时/取消和错误脱敏."
//
// and §R99 怎么验收:
//
//   "两臂均加载自身构建，结果记录 observed build identity；故意互换 worker 构建时失败."
//   "至少一个 case 需要多轮 generate，全部计入共享预算."
//   "error、异常、流中断、hang、timeout/cancel 均留下正确终态和预算."
//   "错误 canary 不出现在 stdout/stderr、结果、事件、approval 文件中."
//
// EXECUTION STRATEGY (chosen deliberately — see the honest limitation below)
// -------------------------------------------------------------------------
// `runArmUnit` dispatches THE ARM CHECKOUT'S OWN CLI as a child process:
//
//   node <checkoutDir>/apps/cli/dist/main.js benchmark \
//     --suite <suite> --cases <staged single-case dir> \
//     --provider <id> --model <id> --plan-digest <digest> \
//     --max-model-calls <n> --out <outDir>
//
// The `--provider`/`--model` pair is the APPROVED identity, passed through from
// the plan (plan §T4 怎么做 6). It is never defaulted here: a worker that invented
// a provider or model would execute a different identity than the one approved,
// which is measured defect N6 ("driver 不把批准的 provider/model/endpoint 传给
// worker").
//
// and then parses the REAL report that CLI writes. The alternative — driving
// `runOneCase` in-process — is not reachable from here at all: `runOneCase` is
// module-private in `apps/cli/src/benchmark-command.ts` and is NOT re-exported
// from `apps/cli/dist/index.js`, so an in-process call would mean either
// modifying an existing file (out of scope) or re-implementing the benchmark
// path (exactly the "two sets of task logic" plan §R99 line 145 forbids:
// "fake/real 只替换 provider transport，不能走两套任务逻辑"). Dispatching each
// arm's OWN built CLI is the smallest adapter that keeps ONE task logic — the
// benchmark path the project already trusts — and it is what makes acceptance
// bullet 1 ("两臂均加载自身构建") mechanically true rather than asserted.
//
// HONEST LIMITATIONS OF THIS ROUTE (stated, not hidden):
//
//   a. The child CLI resolves its OWN provider from its OWN environment. This
//      module never imports or constructs a provider and never opens a socket,
//      but it also cannot inject one: `--provider` accepts only the id the
//      build supports, and the transport is chosen inside the child. A test
//      must therefore NOT set `OPENAI_API_KEY`; a child started with one would
//      reach a real, billed provider. `runArmUnit` deletes that variable from
//      the child environment it builds, but it does not police the operator.
//
//   b. A unit is ONE logical model call by contract (`reserved = 1`), not a
//      measured total: plan §R99 怎么验收 ("至少一个 case 需要多轮 generate") and
//      §R98 ("不能假设一例恰好一次调用") both say a case may need several, but the
//      hard tooling fact is that the child CLI's `--max-model-calls` is a
//      PREFLIGHT ESTIMATE bound, and its own estimate is 10 calls per case
//      (`PREFLIGHT_ESTIMATE.callsPerCaseRun`). This module therefore reserves
//      one logical call per unit and lets the child enforce the real bound: if
//      the case needs more than the campaign can afford, the CHILD refuses, and
//      that refusal is recorded as a `budget` verdict rather than a pass. The
//      honest consequence is stated rather than hidden: `reserved` is the
//      campaign's promise per unit, and a case that needs several calls is
//      visible in the child's report (`model_calls`) even though the ledger
//      charged the unit once.
//
//      EARLIER REVISION OF THIS NOTE WAS WRONG, and the correction matters:
//      it claimed `--plan-digest` could not be passed to a keyless child. That
//      is false — the CLI exempts `--dry-run` from the digest requirement and
//      requires the digest only for the actual `external-billed` execution,
//      which is exactly the run this module performs. The digest IS passed
//      (see `dispatchArgs`); omitting it made every dispatch fail with
//      "a paid (external-billed) run must pass --plan-digest <digest>".
//
//   c. JSON does not support comments, so a plan digest cannot be left "unused"
//      the way a TypeScript parameter could. That is why (b) exists.
//
// STYLE DISCIPLINE: this worker keeps the driver's conventions — the `E4-R98:`
// error-message prefix, the `REDACT`-before-truncate approach, `EXIT_OK` /
// `EXIT_REFUSED` / `EXIT_CONFIG`, and the single-JSON-object-on-stdout CLI. It
// does NOT re-implement the ledger or the execution state: both are imported
// from the BUILT evaluation package (`<repoRoot>/packages/evaluation/dist/
// index.js`) via `pathToFileURL`, exactly as the driver loads them.

import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { cp, mkdir, readFile, readdir, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  ARM_EXEC_VERSION,
  armExecutionDigest,
  armIsBuilt,
  loadArmModules,
  readCaseDef,
  runArmCaseInProcess,
  withArmExecTag,
} from "./r97-arm-exec.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(here, "..", "..");

/** The worker's own identity, recorded on every unit so a paired report can
 *  name the executor that produced a row (plan §R99: a report must bind the
 *  thing that executed, not just a version string of the driver). */
export const ARM_WORKER_VERSION = "e4-r98-arm-worker-v2";

/** Exit codes, matching the driver: 0 ok · 1 refused/error · 2 config/usage. */
export const EXIT_OK = 0;
export const EXIT_REFUSED = 1;
export const EXIT_CONFIG = 2;

/**
 * The artifacts `buildDigest` covers.
 *
 * Plan §R100 怎么做 (line 209) draws the line this list respects: "支持由清晰
 * 构建产物清单界定 hash 范围，不搞整个工作区不可控 hash." Hashing a whole
 * checkout would be slow, would change when unrelated files (logs, caches,
 * `.git`) are touched, and would therefore make a build identity that says
 * nothing about what actually EXECUTES a case. These files ARE the executable
 * surface of one arm.
 *
 * ---- E4-R100-A (T4): WHY THIS LIST GREW, AND WHY IT IS NOW BYTES ONLY ------
 *
 * MEASURED DEFECT N7 (plan §0.2): "armBuildIdentity 漏掉实际导入的执行模块."
 * The previous list was TWO paths, and only ONE of them (`main.js`) was hashed by
 * content — everything else entered the digest as `size:mtime`. Two consequences,
 * both fatal to the property the digest exists for:
 *
 *   1. The module that actually RUNS a case is `benchmark-command.js` (the
 *      exported `runBenchmarkCommand` seam, plan §0.4), and it was not covered at
 *      all. A rewritten executor left the approved build identity UNCHANGED.
 *   2. A rebuild preserving size and mtime (a checkout restored from an archive,
 *      a fast incremental build) left `main.js`'s contribution unchanged too.
 *
 * Plan §T4 怎么做 8 states the rule this now follows:
 *
 *   "构建摘要覆盖实际加载的执行产物及必要本地依赖，使用字节 hash，不依赖 mtime/size.
 *    至少覆盖 benchmark-command、runtime、provider/verification 的实际执行依赖与
 *    adapter；范围用构建清单定义."
 *
 * So: EVERY entry is now hashed by content, and the list names the modules the
 * executor really imports — the CLI entry, the CLI's own exported benchmark seam,
 * the model package (the provider the runtime calls), the evaluation package (the
 * verifier/decision code), and the core runtime that drives the tool loop. The
 * scope is still an EXPLICIT manifest rather than the whole workspace, which is
 * the boundary the same paragraph draws.
 *
 * A missing entry still makes `buildDigest` `null` — the fail-closed rule is
 * unchanged, because "the build cannot be established" must never be represented
 * by a digest of the files that happen to be there.
 */
/**
 * ---- E4-R104 (A4): THE MANIFEST IS DECLARED, THE COVERAGE IS DERIVED --------
 *
 * MEASURED DEFECT F4 (plan §A4): "armBuildIdentity 的 BUILD_ARTIFACT_PATHS 是手写的
 * 五个文件名；packages/core/dist/runtime/runtime.js、packages/evaluation/dist/
 * r97-budget-channel.js 等真正执行 case 的模块既不在清单里、也不在其传递闭包里。
 * 改写它们不会移动 buildDigest，旧批准继续有效."
 *
 * The list below is therefore the DECLARED ENTRY list and nothing more. It is what
 * the walk STARTS from; what the digest COVERS is the closure DERIVED from those
 * entries by `computeExecutionIdentityV1` — the shared contract in
 * `packages/evaluation/dist/r97-plan.js`, which the driver's `driverBuildDigest`,
 * the plan's pre-execution re-check, this worker's record and the campaign
 * evidence all use. Plan §A4 怎么做 5: "让计划生成、执行前复核、worker record 和
 * evidence 使用同一身份合同." Plan §A4 怎么做 2: "不能以转导出的 index.js 代替其下层
 * 模块" — which is exactly what a derived closure fixes and a file list cannot.
 *
 * `R97_ARM_BUILD_ENTRIES` in the plan names the three modules the OFFLINE EXECUTOR
 * loads directly; the two extra entries here (`packages/core/dist/index.js` and
 * `packages/evaluation/dist/index.js`) are the runtime and verifier barrels the
 * plan's acceptance criteria name explicitly, and declaring them makes them
 * entries in their own right rather than reachable-only-by-accident. The closure
 * is a SUPERSET of either list, so declaring more can only widen coverage.
 *
 * A missing entry, a missing relative dependency, an unreadable file or a
 * dependency that resolves outside the checkout still makes `buildDigest` `null`:
 * the fail-closed rule is unchanged, because "the build cannot be established"
 * must never be represented by a digest of the files that happen to be there.
 */
/** Exported so a test can assert WHICH modules the build identity covers rather
 *  than trusting the digest to reveal an omission. */
export const BUILD_ARTIFACT_PATHS = [
  ["apps", "cli", "dist", "main.js"],
  ["apps", "cli", "dist", "benchmark-command.js"],
  ["packages", "model", "dist", "index.js"],
  ["packages", "evaluation", "dist", "index.js"],
  ["packages", "core", "dist", "index.js"],
];

/** The shared identity contract, loaded from THIS repo's built evaluation package.
 *
 *  ---- WHY THIS IS A TOP-LEVEL `await import` AND NOT A `require` -------------
 *
 *  `armBuildIdentity` is SYNCHRONOUS by contract — the CLI, `refuseIdentity` and
 *  the contract tests all read it without awaiting, and a promise there would turn
 *  every refusal path into an async one — so the module is loaded ONCE, before any
 *  caller can run, and the binding below is then a plain synchronous lookup.
 *
 *  `require` would be the obvious way to load an ESM module synchronously (Node 24
 *  supports `require(esm)`), and it works under plain Node. It does NOT work under
 *  the test runner: the workspace packages declare a `"development"` export
 *  condition ahead of `"default"`
 *  (`packages/contracts/package.json`: `exports["."].development = "./src/index.ts"`),
 *  the runner activates that condition, and the `require` path then loads
 *  `packages/contracts/src/index.ts`, whose `./ids.js` specifier has no on-disk
 *  `.js` sibling — measured: `Cannot find module '...\packages\contracts\src\ids.js'
 *  imported from ...\packages\contracts\src\index.ts`. The dynamic-import path
 *  applies the source↔artifact extension mapping and loads cleanly, so it is the
 *  path that works in BOTH environments.
 *
 *  A load failure is RECORDED rather than thrown: an unbuilt evaluation package
 *  must make the build identity NOT ESTABLISHED (fail closed, `buildDigest: null`),
 *  not make the worker module itself unimportable. */
let identityContract = null;
let identityContractError = null;
try {
  identityContract = await import(
    pathToFileURL(join(REPO_ROOT, "packages", "evaluation", "dist", "r97-plan.js")).href
  );
} catch (err) {
  identityContractError = err;
}

/** The DECLARED entry list, as root-relative POSIX paths. */
function armBuildEntries() {
  return BUILD_ARTIFACT_PATHS.map((parts) => parts.join("/"));
}

/**
 * The DERIVED closure of one arm checkout — the files the build identity covers.
 *
 * THROWS when the closure cannot be established (a missing entry, an unresolvable
 * relative dependency, an unreadable file, a dependency outside the checkout), so
 * every caller decides for itself whether that is a `null` identity or an error.
 *
 * `unresolvableBareSpecifier: "external"` is the ARM-side policy, and it is
 * deliberately NOT the driver's: an arm checkout is a build-output tree whose own
 * modules are resolved relatively and must therefore all be present, while a bare
 * specifier names a `node_modules` dependency. The real arms carry their own
 * `node_modules` (see `r97-observe-arms.mjs`: `pnpm install` then `pnpm build`), so
 * this policy is inert for them — every bare specifier resolves exactly as it does
 * on the driver side. It matters only for a synthetic or archived tree that
 * carries no `node_modules`, where the honest statement is "this checkout's own
 * bytes are all covered, and here are the bare dependencies it names but does not
 * carry" rather than either a fabricated file set or a refusal that would make the
 * tree's identity unobservable.
 */
export function armBuildClosure(checkoutDir) {
  if (identityContract === null) {
    throw new Error(
      `E4-R104: the shared identity contract could not be loaded from ` +
        `${join(REPO_ROOT, "packages", "evaluation", "dist", "r97-plan.js")} — the build identity cannot be ` +
        `established: ${identityContractError instanceof Error ? identityContractError.message : String(identityContractError)}`,
    );
  }
  return identityContract.computeExecutionIdentityV1({
    rootDir: resolve(checkoutDir),
    entries: armBuildEntries(),
    unresolvableBareSpecifier: "external",
  });
}

/** The root-relative POSIX paths of that closure, for a caller that has to
 *  materialise the same tree (the contract suite's fixtures). */
export function armBuildClosurePaths(checkoutDir) {
  return armBuildClosure(checkoutDir).files.map((file) => file.path);
}

/**
 * Backstop for the per-unit deadline when the caller supplies none.
 *
 * WHY IT IS SO LARGE: the child CLI's preflight ESTIMATES 10 model calls per
 * case (PREFLIGHT_ESTIMATE.callsPerCaseRun) and refuses a run whose estimate
 * exceeds `--max-model-calls`, so a real single-case dispatch needs a real
 * allowance — and on Windows the harness's own process spawning dominates the
 * wall clock far more than the model does. The R98 fixtures were measured at
 * roughly 3.5s per case with the offline stub. 15 minutes is therefore a
 * backstop against a HUNG child, not a performance budget; callers that want a
 * tighter bound pass `timeoutMs`.
 */
const DEFAULT_TIMEOUT_MS = 900_000;

/** Kill-grace before SIGKILL. A provider stream that ignores SIGTERM must not
 *  keep the unit (and its reservation) alive forever.
 *
 * ---- E4-R99-B (T5): THIS CONSTANT WAS DECLARED AND NEVER READ ---------------
 *
 * MEASURED DEFECT N8 (plan §0.2): "runChild 只发送 SIGTERM，SIGKILL_GRACE_MS 未使用."
 * `runChild`'s only stop was `controller.abort()`, which signals the child and
 * then waits forever, so a child that installed a SIGTERM handler kept the
 * promise — and therefore the unit, its reservation and the whole campaign —
 * alive indefinitely. This value is now the real grace in `boundedStop` below:
 * the polite signal goes first, and a forced kill follows after exactly this
 * long.
 *
 * TWO SECONDS, AND WHY THAT IS THE RIGHT ORDER OF MAGNITUDE: a cooperative child
 * needs long enough to flush its report and exit cleanly, and a hostile one must
 * not hold a campaign hostage. The value is small because it is a GRACE, not a
 * budget — the deadline has already elapsed by the time it starts. */
export const SIGKILL_GRACE_MS = 2_000;

/**
 * The byte ceiling for one child's captured stdout or stderr.
 *
 * ---- E4-R99-B (T5): A BYTE LIMIT, NOT A CHUNK COUNT -------------------------
 *
 * MEASURED DEFECT N8: the old check was `if (stdoutChunks.length < MAX_BUFFER)`,
 * comparing a COUNT OF CHUNKS against a constant documented as bytes. Both
 * directions were wrong: ONE 64 MiB chunk was accepted whole (one chunk is well
 * under any count limit), and 33 million one-byte chunks were accepted whole too
 * (the array only stops growing once it reaches the limit, by which point the
 * process has already buffered far more than the limit). `ByteCap` accumulates
 * `Buffer.byteLength`, so the bound is the number it claims to be.
 */
export const MAX_CHILD_OUTPUT_BYTES = 33_554_432;

/**
 * A bounded byte accumulator for one child stream.
 *
 * INVARIANT: `bytes <= limit`, ALWAYS. `bytes` is what was RETAINED, so a reader
 * who asks "how much output do I have" gets an answer that respects the bound.
 * The total that was offered is reported separately as `offered`, so dropping is
 * visible rather than silent.
 *
 * Keeping `bytes` bounded matters because it is the field a caller would use to
 * decide whether more output can be accepted. Reporting the OFFERED total there
 * would make the accumulator's own accounting exceed its own ceiling — the
 * arithmetic form of the defect this replaces.
 *
 * `push` accepts a Buffer or a string; a string is measured by its UTF-8 encoding,
 * never by `String.length` (a character count would let a multi-byte stream
 * through at up to 4x the limit).
 *
 * A partial chunk is retained up to the remaining allowance, and the slice is
 * taken on the BUFFER so a multi-byte character is never split.
 *
 * ---- E4-R99-B (T5): BOUNDING MEMORY IS NOT STOPPING THE CHILD ----------------
 *
 * MEASURED DEFECT: this class bounded `bytes` correctly and then said nothing, so
 * `BOUNDED_STOP_REASONS` listed `output_limit` while nothing ever settled with it.
 * A child that flooded stdout kept running until the DEADLINE killed it, which
 * made plan §T5 怎么验收 5 ("超时、取消和超量输出都能结束执行") false for the third
 * case: the cap bounded memory and did not end execution.
 *
 * `onLimit` is the seam that closes it. It is called AT MOST ONCE, on the
 * transition from "under the cap" to "over it", so the stop it triggers is a
 * one-shot event rather than a callback fired per dropped chunk. It is optional:
 * a bare `ByteCap` (as the byte-accounting tests use) stays a pure accumulator.
 */
export class ByteCap {
  constructor(limit, onLimit) {
    this.limit = Math.max(0, Number(limit));
    /** Retained bytes. Never exceeds `limit`. */
    this.bytes = 0;
    /** Every byte offered, including those dropped. */
    this.offered = 0;
    this.truncated = false;
    this.chunks = [];
    /** The one-shot "the cap was exceeded" signal, or `null` for a pure
     *  accumulator. */
    this.onLimit = typeof onLimit === "function" ? onLimit : null;
    /** Guards `onLimit` so it cannot fire twice, however many chunks follow. */
    this.signalled = false;
  }

  /** Fire the one-shot limit signal. Idempotent by construction. */
  signalLimit() {
    if (this.onLimit === null || this.signalled) return;
    this.signalled = true;
    this.onLimit();
  }

  push(chunk) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), "utf8");
    this.offered += buf.length;
    const room = this.limit - this.bytes;
    if (room <= 0) {
      // Already at the ceiling and more arrived: dropped, and the cap is
      // exceeded. `signalLimit` is what turns that fact into a bounded stop.
      if (buf.length > 0) {
        this.truncated = true;
        this.signalLimit();
      }
      return;
    }
    if (buf.length <= room) {
      this.chunks.push(buf);
      this.bytes += buf.length;
      return;
    }
    this.chunks.push(buf.subarray(0, room));
    this.bytes += room;
    this.truncated = true;
    this.signalLimit();
  }

  text() {
    // Decoded once, at the end. `toString` on the concatenated buffer keeps a
    // truncated multi-byte tail from becoming a replacement character mid-stream.
    return Buffer.concat(this.chunks).toString("utf8");
  }
}

/** The closed set of reasons a bounded stop can report.
 *
 * Plan §T5 怎么做 5 requires the three start cases be told apart — "区分确定未启动、
 * 已启动已发送、结果未知" — and §怎么做 7 requires an interrupt be named rather than
 * disguised as `case_failed` or a verified pass. A caller switches on this value,
 * so it is an enumerated set, not free text.
 */
export const BOUNDED_STOP_REASONS = ["exited", "timeout", "cancelled", "spawn_failed", "output_limit"];

/**
 * Run a child under a REAL deadline, a REAL cancellation handle and a REAL byte
 * cap, and ALWAYS return within a bounded time.
 *
 * ---- E4-R99-B (T5): WHY THIS REPLACES `runChild` ---------------------------
 *
 * Plan §T5 怎么做 2 states the required sequence exactly:
 *
 *   "实现有界停止流程：请求取消→有限宽限→平台适配的强制结束→等待 close/回收."
 *
 * `runChild` did the FIRST step and then waited forever. This function performs
 * the whole sequence:
 *
 *   1. the deadline (or the caller's `signal`) asks the child to stop;
 *   2. a bounded grace of `graceMs` lets a cooperative child flush and exit;
 *   3. a PLATFORM-ADAPTED forced kill ends the whole TREE — `taskkill /t /f` on
 *      Windows, a process-group `SIGKILL` on POSIX — so a tool grandchild cannot
 *      keep writing after its parent is gone (plan §T5 怎么做 2: "不要只停止父进程
 *      而留下工具子孙进程继续写文件");
 *   4. `close` is awaited so the exit is RECORDED, not merely requested.
 *
 * The promise settles EXACTLY ONCE. `close`, `error`, the deadline, the abort
 * signal and the forced kill can all race; whichever arrives first wins and every
 * timer and listener is released, so a unit cannot be resolved twice or leak a
 * listener into the next unit.
 *
 * `started` distinguishes "definitely never launched" from "launched and
 * signalled", which is what lets a caller settle an interrupted attempt honestly
 * instead of guessing.
 *
 * Returns `{ reason, started, exitCode, signal, stdout, stderr, truncated, bytes,
 * forced, durationMs, spawnError? }`.
 */
export function boundedStop(opts) {
  const deadlineMs = Number.isFinite(opts.deadlineMs) ? opts.deadlineMs : DEFAULT_TIMEOUT_MS;
  const graceMs = Number.isFinite(opts.graceMs) ? opts.graceMs : SIGKILL_GRACE_MS;
  const capLimit = Number.isFinite(opts.maxOutputBytes) ? opts.maxOutputBytes : MAX_CHILD_OUTPUT_BYTES;
  const started = Date.now();
  // ---- THE CAP'S STOP SEAM, HOISTED SO THE CAPS CAN CARRY IT (T5) ----------
  //
  // `ByteCap` must be constructed before the spawn, but the stop sequence it has
  // to trigger is defined inside the promise body (it closes over the child, the
  // timers and `settle`). This indirection is the minimal way to give the cap the
  // EXISTING stop machinery rather than a second mechanism: the caps call
  // `onOutputLimit`, which the promise body points at `beginStop("output_limit")`
  // as soon as that function exists. Before that point no data event can arrive,
  // because no child exists yet.
  let onOutputLimit = () => {};
  const outCap = new ByteCap(capLimit, () => onOutputLimit());
  const errCap = new ByteCap(capLimit, () => onOutputLimit());

  // ---- AN ADOPTED CHILD (E4-R106 / A6). ------------------------------------
  //
  // A caller that has ALREADY spawned the process it wants stopped — because it had
  // to put a payload on that process's stdin, which cannot be done through an argv
  // after the fact — hands it over here instead of letting this function spawn a
  // second one. Re-spawning would run the case TWICE, and on a billed path running
  // the same case twice is the worst bug available.
  //
  // The stop contract is identical either way: the same polite signal, the same
  // bounded grace, the same forced TREE kill and the same single settle. Adoption
  // changes only WHO created the process, never how it is ended.
  const adopted = opts.adopt ?? null;

  return new Promise((resolvePromise) => {
    let settled = false;
    let forced = false;
    let reason = null;
    let spawnError = null;
    let child = null;
    let deadlineTimer = null;
    let graceTimer = null;
    let hardSettleTimer = null;
    const listeners = [];

    // ---- AN ALREADY-CANCELLED CALL MUST NOT LAUNCH ANYTHING -----------------
    //
    // Plan §T5 怎么做 5: "区分确定未启动、已启动已发送、结果未知." A caller who
    // cancelled before this function was entered must not have a process started
    // on their behalf — starting one and immediately killing it would report
    // `started: true` for work that provably never had to happen, and on a billed
    // path "immediately killed" is not the same fact as "never dispatched".
    if (opts.signal !== undefined && opts.signal.aborted) {
      resolvePromise({
        reason: "cancelled",
        started: false,
        exitCode: null,
        signal: null,
        stdout: "",
        stderr: "",
        truncated: false,
        bytes: { stdout: 0, stderr: 0, offered: { stdout: 0, stderr: 0 } },
        forced: false,
        durationMs: Date.now() - started,
      });
      return;
    }

    const cleanup = () => {
      if (deadlineTimer !== null) clearTimeout(deadlineTimer);
      if (graceTimer !== null) clearTimeout(graceTimer);
      if (hardSettleTimer !== null) clearTimeout(hardSettleTimer);
      for (const off of listeners.splice(0)) {
        try {
          off();
        } catch (err) {
          process.stderr.write(`[degraded] r99b.bounded-stop.cleanup: ${err instanceof Error ? err.message : String(err)}\n`);
        }
      }
    };

    const settle = (over) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolvePromise({
        reason: reason ?? over.reason ?? "exited",
        started: child !== null && child.pid !== undefined,
        exitCode: over.exitCode ?? null,
        signal: over.signal ?? null,
        stdout: outCap.text(),
        stderr: errCap.text(),
        truncated: outCap.truncated || errCap.truncated,
        bytes: { stdout: outCap.bytes, stderr: errCap.bytes, offered: { stdout: outCap.offered, stderr: errCap.offered } },
        forced,
        durationMs: Date.now() - started,
        ...(spawnError === null ? {} : { spawnError }),
      });
    };

    /**
     * Kill the child AND ITS DESCENDANTS, adapted per platform.
     *
     * A parent-only kill is the specific failure plan §T5 怎么做 2 names: a tool
     * grandchild would survive and keep writing files after the unit was reported
     * as stopped. `taskkill /t /f` walks the Windows tree; on POSIX the child is
     * spawned `detached` so it leads its own process group and the whole group can
     * be signalled at once.
     */
    const killTree = () => {
      if (child === null || child.pid === undefined) return;
      forced = true;
      try {
        if (process.platform === "win32") {
          // `taskkill` is the platform's own tree-kill. `/t` includes descendants,
          // `/f` forces. It is spawned detached and unref'd so the killer itself
          // cannot hold this promise open.
          const killer = spawn("taskkill", ["/pid", String(child.pid), "/t", "/f"], {
            stdio: "ignore",
            windowsHide: true,
          });
          killer.on("error", (err) => {
            process.stderr.write(`[degraded] r99b.bounded-stop.taskkill: ${err instanceof Error ? err.message : String(err)}\n`);
            try {
              child.kill("SIGKILL");
            } catch {
              // The child is already gone; nothing to escalate to.
            }
          });
          killer.unref();
        } else {
          // `detached: true` made the child a process-group leader, so a negative
          // pid signals the whole group — the POSIX equivalent of `taskkill /t`.
          try {
            process.kill(-child.pid, "SIGKILL");
          } catch {
            child.kill("SIGKILL");
          }
        }
      } catch (err) {
        process.stderr.write(`[degraded] r99b.bounded-stop.kill: ${err instanceof Error ? err.message : String(err)}\n`);
        try {
          child.kill("SIGKILL");
        } catch {
          // Already dead.
        }
      }
    };

    /** The one shared stop sequence: polite signal, bounded grace, forced kill. */
    const beginStop = (why) => {
      if (settled || reason !== null) return;
      reason = why;
      // STEP 1: ask the child to stop. On POSIX this is the process GROUP when the
      // child leads one, so a tool grandchild gets the polite signal too.
      try {
        if (process.platform !== "win32" && child !== null && child.pid !== undefined) {
          try {
            process.kill(-child.pid, "SIGTERM");
          } catch {
            child.kill("SIGTERM");
          }
        } else {
          child?.kill("SIGTERM");
        }
      } catch {
        // A child that is already gone needs no signal; `close` will settle us.
      }
      // STEP 2 + 3: after the grace, force the TREE down. The timer is what makes
      // the stop BOUNDED rather than a hope that the child cooperates.
      graceTimer = setTimeout(() => {
        killTree();
        // STEP 4, the last line of the bound: `close` is AWAITED, but if the OS
        // never reports it (a wedged handle on a killed tree), the promise still
        // settles from what was measured. Without this the "bounded" stop would
        // depend on the very event whose absence caused the original hang.
        hardSettleTimer = setTimeout(() => settle({}), Math.max(250, graceMs));
        hardSettleTimer.unref?.();
      }, Math.max(0, graceMs));
      graceTimer.unref?.();
    };

    // ---- THE CAP'S STOP SEAM, WIRED TO THE ONE EXISTING SEQUENCE (T5) -------
    //
    // Plan §T5 怎么验收 5 requires the excess-output case to END execution, not
    // only to bound memory. This is that wiring: exceeding either byte cap calls
    // the SAME `beginStop` the deadline and the abort signal call, with the
    // reason the closed set already names. No second stop mechanism exists, so
    // the guarantees are inherited rather than re-implemented — the polite
    // signal, the bounded grace, the forced tree kill, the `close` await, the
    // single `settle`, and `cleanup()` of every timer and listener.
    //
    // `beginStop` is itself guarded by `settled || reason !== null`, and `ByteCap`
    // fires `onLimit` at most once, so a flood cannot resolve twice.
    onOutputLimit = () => beginStop("output_limit");

    try {
      child =
        adopted ??
        spawn(opts.file, opts.args ?? [], {
          cwd: opts.cwd,
          env: opts.env,
          stdio: ["ignore", "pipe", "pipe"],
          windowsHide: true,
          // POSIX only: a process-group leader is what makes a tree kill possible.
          detached: process.platform !== "win32",
        });
    } catch (err) {
      spawnError = redact(err);
      reason = "spawn_failed";
      settle({});
      return;
    }

    child.stdout?.on("data", (chunk) => outCap.push(chunk));
    child.stderr?.on("data", (chunk) => errCap.push(chunk));

    // `error` before `close` means the launch itself failed (ENOENT, EACCES). It
    // is `spawn_failed`, DISTINCT from a timeout: nothing ran, so nothing is
    // outstanding.
    child.on("error", (err) => {
      // An AbortError is our own deadline firing, which `beginStop` already
      // classified; it must not be re-reported as a launch failure.
      if (err?.name === "AbortError") return;
      if (reason === null) reason = "spawn_failed";
      spawnError = redact(err);
      settle({});
    });

    child.on("close", (code, signal) => {
      if (reason === null) reason = "exited";
      settle({ exitCode: code, signal: signal ?? null });
    });

    deadlineTimer = setTimeout(() => beginStop("timeout"), deadlineMs);

    // The caller's cancellation handle (plan §T5 怎么做 4). `once` plus the
    // explicit listener removal in `cleanup` keeps a long campaign from
    // accumulating one listener per unit. An already-aborted signal was handled
    // before the spawn, so by here the signal is live.
    if (opts.signal !== undefined) {
      const onAbort = () => beginStop("cancelled");
      opts.signal.addEventListener("abort", onAbort, { once: true });
      listeners.push(() => opts.signal.removeEventListener("abort", onAbort));
    }
  });
}

/**
 * ONE deadline shared by every phase of a unit, so no phase can re-grant itself a
 * full allowance.
 *
 * ---- E4-R99-B (T5): WHY A SHARED BUDGET, NOT A PER-PHASE TIMEOUT -------------
 *
 * Plan §T5 怎么做 4 is explicit:
 *
 *   "给外层调用提供 AbortSignal 或等价明确取消句柄。dry-run/staging/dispatch 共用剩余
 *    总期限，不能每个阶段重新获得一整份 campaign 时间."
 *
 * A per-phase `setTimeout(fullTimeout)` is a subtle way for a bound to be untrue:
 * a unit whose deadline is 900s could spend 900s in the dry run, then get a fresh
 * 900s for the dispatch, then a fresh 900s in cleanup — a "900-second" unit that
 * runs for 45 minutes. This object is created ONCE per unit and every phase reads
 * `remainingForPhase()`, so the phases SHARE the total rather than each receiving
 * a copy of it.
 *
 * It also carries the `signal` a phase passes to `boundedStop`, so the campaign
 * deadline and a user cancellation reach the actual execution instead of stopping
 * at the worker's own bookkeeping.
 */
export class DeadlineBudget {
  /**
   * @param totalMs the whole unit's allowance, in milliseconds
   * @param now injectable clock, so a test can advance time without sleeping
   */
  constructor(totalMs, now = () => Date.now()) {
    this.now = now;
    this.startedAt = now();
    this.totalMs = Math.max(0, Number(totalMs));
    this.controller = new AbortController();
    this.fired = false;
    this.timer = null;
    if (this.totalMs > 0) {
      this.timer = setTimeout(() => {
        this.fired = true;
        this.controller.abort();
      }, this.totalMs);
      // A pending deadline must not be the reason the process stays alive: the
      // worker may finish a unit early and exit.
      this.timer.unref?.();
    } else {
      this.fired = true;
      this.controller.abort();
    }
  }

  /** Milliseconds left in the shared allowance; never negative. */
  remaining() {
    return Math.max(0, this.totalMs - (this.now() - this.startedAt));
  }

  /** What a phase may use. Identical to `remaining()` — the point is that the
   *  name says the phase inherits the remainder instead of a fresh allowance, so
   *  a reader cannot mistake it for a per-phase budget. */
  remainingForPhase() {
    return this.remaining();
  }

  /** True once the shared allowance is spent. */
  expired() {
    return this.fired || this.remaining() <= 0;
  }

  /** The cancellation handle a phase passes to `boundedStop`. */
  get signal() {
    return this.controller.signal;
  }

  /** Cancel early (a user cancellation), reporting the same reason a deadline
   *  does not: the caller distinguishes them by reading `reason`. */
  cancel() {
    if (!this.controller.signal.aborted) this.controller.abort();
  }

  /** Release the timer. Called in a `finally`, so a finished unit leaves nothing
   *  armed and no listener behind. */
  dispose() {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
  }
}

/**
 * A child process whose output is BOUNDED BY BYTES, under the same stop contract
 * as `boundedStop`.
 *
 * Kept as a named wrapper because callers (and tests) read better with it, and
 * because it is the seam a future in-process provider deadline would use.
 */
export function runChild(opts) {
  return boundedStop({
    file: opts.file ?? process.execPath,
    args: opts.args,
    cwd: opts.cwd,
    env: opts.env,
    deadlineMs: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    graceMs: opts.graceMs ?? SIGKILL_GRACE_MS,
    maxOutputBytes: opts.maxOutputBytes,
    signal: opts.signal,
  });
}

/** ---- E4-R106 (A6 / F6): THE TERMINABLE EXECUTION BOUNDARY -------------------
 *
 * MEASURED DEFECT F6 (plan §A6):
 *
 *   "boundedStop 工具已经能杀进程，但实际 worker 改成进程内 await
 *    runBenchmarkCommand" — a cancel at 40 ms still PASSES ~412 ms later; a unit
 *    timeout of 80 ms returns ~421 ms later.
 *
 * `runArmCaseInProcess` awaits the arm's exported `runBenchmarkCommand` INSIDE the
 * worker process. `boundedStop` can end a PROCESS, but an `await` is not a process,
 * so nothing could terminate that call: a dry run or a dispatch that never returns
 * kept the unit, its reservation and the whole campaign alive indefinitely.
 *
 * WHY THIS IS A CHILD PROCESS AND NOT A `Promise.race`. Plan §A6 怎么做 5 is
 * explicit: "单独 Promise.race 返回后放任后台执行继续，不算修复." A race would
 * resolve the unit and leave the hung provider's `setInterval`, its open handles and
 * its grandchildren WRITING FILES afterwards — the unit would be *reported* stopped
 * while the work carried on, which is worse than an honest hang. A child process is
 * the only boundary here that can end code which ignores `AbortSignal` ENTIRELY,
 * because the operating system, not the code, is what stops it.
 *
 * WHAT THE CHILD OWNS, AND WHAT IT MUST NOT. The child loads the SPECIFIED arm's own
 * `benchmark-command.js` export (`arm.checkoutDir`), runs the ONE case, and reports
 * its `ArmCaseResult` back as JSON on stdout. It is handed the SAME ledger directory
 * as the parent, so every `generate()` still reserves through the campaign's single
 * ledger implementation and the per-call ceiling is unchanged (plan §A6 怎么做 7:
 * "不能为隔离而退回'每 unit 固定收费 1'或绕过预算"). Isolation must not buy a second
 * budget implementation, so the child re-enters the SAME A1 channel rather than a
 * simplified one.
 *
 * THE SETTLE-ONCE CONTRACT IS INHERITED, NOT REIMPLEMENTED. `boundedStop` already
 * performs polite signal → bounded grace → forced process-TREE kill → await `close`
 * → settle exactly once and release every timer and listener. Reusing it is what
 * makes a provider, a verifier, a tool AND their descendants stop together, and what
 * gives this boundary its `reason` (`timeout` / `cancelled` / `output_limit`) rather
 * than a guess.
 *
 * The runner is passed as a `--eval`-free FILE path so nothing about the case's
 * payload has to survive an argv round trip, and the case is handed over on stdin as
 * JSON so a large or hostile case definition cannot be mangled by shell quoting.
 */
export const ARM_CHILD_RUNNER_REL = join("scripts", "e4", "r97-arm-child-runner.mjs");

/** The stdout marker the boundary child prefixes its one result line with.
 *
 * A SENTINEL rather than bare JSON, because the child loads a third-party arm build
 * that may print whatever it likes; the last line carrying this marker is the result
 * and nothing else can be mistaken for it. Shared as a constant so the runner and the
 * parser cannot drift apart. */
export const ARM_CHILD_SENTINEL = "__A6_RESULT__";

/**
 * The effective unit deadline: `min(unit cap, campaign remaining)`.
 *
 * Plan §A6 怎么做 2: "effective unit deadline 取 unit 上限与 campaign 剩余时间的较小
 * 值，并保留触发原因."
 *
 * THE CAUSE IS THE POINT. When the campaign's remaining time is the smaller value,
 * the stop is the CAMPAIGN's deadline (`CAMPAIGN_DEADLINE_EXCEEDED`), not the unit's
 * own cap — and a cancellation outranks both, because an operator's explicit stop is
 * a more specific fact than a clock. Collapsing the three into one number would lose
 * exactly the distinction plan §A6 怎么做 9 requires be preserved.
 *
 * Returns `{ deadlineMs, cause }` where `cause` is `"cancelled"`, `"campaign_deadline"`
 * or `"unit_cap"`. `campaignRemainingMs` may be `null` (no campaign bound), which is
 * how an unmodified caller keeps its previous single-bound behaviour.
 */
export function effectiveUnitDeadline(opts) {
  const unitCapMs = Number.isFinite(opts.unitCapMs) ? Math.max(0, opts.unitCapMs) : DEFAULT_TIMEOUT_MS;
  const remaining = Number.isFinite(opts.campaignRemainingMs) ? Math.max(0, opts.campaignRemainingMs) : null;
  if (opts.signal !== undefined && opts.signal !== null && opts.signal.aborted) {
    return { deadlineMs: 0, cause: "cancelled" };
  }
  if (remaining !== null && remaining < unitCapMs) {
    return { deadlineMs: remaining, cause: "campaign_deadline" };
  }
  return { deadlineMs: unitCapMs, cause: "unit_cap" };
}

/** The verdict a boundary stop produces, from its cause alone.
 *
 * Plan §A6 怎么验收 5: "判定原因分别为 timeout/cancelled/output_limit." The category a
 * caller sees is `timeout` for BOTH a unit-cap expiry and a campaign-deadline
 * expiry, because the campaign's remaining time IS the unit's effective deadline —
 * the two are the same clock seen from two places, and plan §A6 怎么做 2 requires the
 * SMALLER of the two be applied while the trigger is preserved. `cancelled` is kept
 * distinct, because "the operator stopped it" and "the clock ran out" are different
 * facts about a campaign.
 *
 * The detail NAMES the cause, so an operator reading the record can tell a unit cap
 * from a campaign deadline without cross-referencing the driver's report.
 */
export function stoppedVerdictOf(stop) {
  if (stop === null || stop === undefined) return null;
  if (stop.reason === "cancelled") {
    return { category: "timeout", detail: `E4-R106: the unit was cancelled while it was executing (${stop.detail ?? ""})`.trim() };
  }
  if (stop.reason === "output_limit") {
    return { category: "infrastructure", detail: `E4-R106: the unit exceeded its output bound while it was executing (${stop.detail ?? ""})`.trim() };
  }
  if (stop.reason === "spawn_failed" || stop.reason === "runner_failed") {
    return { category: "infrastructure", detail: `E4-R106: the unit's execution boundary could not complete the case (${stop.detail ?? ""})`.trim() };
  }
  // `timeout` — the effective deadline expired, whether it came from the unit's cap
  // or from the campaign's remaining time.
  return { category: "timeout", detail: `E4-R106: the unit's deadline expired while it was executing (${stop.detail ?? ""})`.trim() };
}

/**
 * Run ONE case behind a terminable process boundary, and say exactly how it ended.
 *
 * Plan §A6 怎么做 4: "对实际 arm 执行建立可终止的隔离边界，优先复用现有 child
 * runner/boundedStop. 独立子进程加载指定 arm 的导出入口并复用同一 ledger."
 *
 * Returns `{ executed, stop, dispatched }`:
 *
 *   * `executed`  — the arm's `ArmCaseResult` when the child FINISHED and reported
 *                   one, else `null`.
 *   * `stop`      — `null` when the child ran to completion; otherwise
 *                   `{ reason, cause, detail, forced, durationMs, exitCode, signal }`
 *                   naming WHY it was ended. Plan §A6 怎么做 9 requires this be a
 *                   preserved cause rather than an inference from a missing report.
 *   * `dispatched` — whether a provider call was ADMITTED before the stop, read from
 *                   the LEDGER rather than self-reported, because plan §A6 怎么验收 6
 *                   splits "never dispatched ⇒ release the reservation" from
 *                   "dispatched then killed ⇒ do not refund" on exactly this fact.
 *
 * WHY THE CHILD'S OWN WORD IS NOT TRUSTED FOR THE STOP. A killed process writes
 * nothing. So the ORDER is: if the child reported a result, that result is the
 * execution (even if the process then died); only when NO result arrived does the
 * stop reason decide the unit's fate. That ordering is what keeps a case that
 * legitimately finished — and merely took a while — from being reported as a
 * timeout, and what keeps a hang from being reported as a missing report.
 */
export async function runArmCaseAtBoundary(opts) {
  const repoRoot = opts.repoRoot ?? REPO_ROOT;
  // The ledger's real filename, supplied by the caller that opened it (the worker
  // reads it from the loaded evaluation build). Guessing it here silently broke
  // the "was a call admitted?" measurement — see `ledgerHasEntries`.
  const ledgerFilename = opts.ledgerFilename ?? "budget-ledger.json";
  const child = spawn(process.execPath, [join(repoRoot, ARM_CHILD_RUNNER_REL)], {
    cwd: repoRoot,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
    // `detached` makes the child the leader of its own process GROUP on POSIX, which
    // is what lets the forced kill reach its descendants as a group. On Windows
    // `taskkill /t` walks the tree instead. Both are the existing platform adaptation
    // inside `boundedStop`, reused rather than duplicated.
    detached: process.platform !== "win32",
  });

  const payload = JSON.stringify({
    evaluationDir: join(repoRoot, "packages", "evaluation", "dist"),
    execDir: join(repoRoot, "scripts", "e4"),
    checkoutDir: opts.arm.checkoutDir,
    arm: opts.arm.label,
    caseDef: opts.caseDef,
    scriptShape: opts.scriptShape,
    stagedCasesDir: opts.stagedCasesDir,
    outDir: opts.outDir,
    suite: opts.suite,
    providerId: opts.providerId,
    modelId: opts.modelId,
    endpointBaseUrl: opts.endpointBaseUrl,
    maxModelCalls: opts.maxModelCalls,
    ledgerDir: opts.ledgerDir,
    planDigest: opts.planDigest,
    campaignModelCalls: opts.campaignModelCalls,
    firstReservationId: opts.firstReservationId,
  });
  child.stdin.end(payload, "utf8");

  // The effective bound: `min(unit cap, campaign remaining)`, with the cause kept
  // (plan §A6 怎么做 2).
  const effective = effectiveUnitDeadline({
    unitCapMs: opts.deadline === null || opts.deadline === undefined ? DEFAULT_TIMEOUT_MS : opts.deadline.remainingForPhase(),
    campaignRemainingMs: opts.campaignRemainingMs ?? null,
    signal: opts.signal ?? null,
  });

  // ADOPT the process spawned above rather than spawning a second one: the payload
  // is already on its stdin, so a re-spawn would run the case twice — which on a
  // billed path is the worst possible bug.
  const outcome = await boundedStop({
    file: process.execPath,
    args: [],
    cwd: repoRoot,
    env: process.env,
    deadlineMs: effective.deadlineMs,
    graceMs: opts.graceMs ?? SIGKILL_GRACE_MS,
    maxOutputBytes: opts.maxOutputBytes ?? MAX_CHILD_OUTPUT_BYTES,
    signal: opts.signal ?? undefined,
    adopt: child,
  });

  const result = parseArmChildResult(outcome.stdout);
  const dispatched = await ledgerHasEntries(opts.ledgerDir, ledgerFilename);
  if (result !== null && result.ok) {
    return { executed: result.executed, stats: result.stats ?? null, stop: null, dispatched };
  }

  // ---- TWO DIFFERENT FACTS, AND THEY MUST NOT BE CONFLATED. ---------------
  //
  //   1. THE RUNNER REACHED ITS OWN CONCLUSION (`result.ok === false`). The child
  //      loaded, ran, and FAILED — so the child's report is the cause, and the unit
  //      is an infrastructure failure of the execution, not a stop. This is the case
  //      the boundary cannot distinguish from a `close` event alone: the child exits
  //      normally (code 1) after reporting.
  //   2. NOTHING WAS REPORTED (`result === null`). The child was killed mid-case (or
  //      could not start), so the STOP is the only fact available and it decides the
  //      unit's fate — plan §A6 怎么做 9 ("异常发生在 deadline 之后也不能统统落入
  //      infrastructure catch").
  //
  // Reading (1) as a `timeout` would blame the clock for a genuine failure; reading
  // (2) as an infrastructure fault is the defect A6 exists to remove. So the reason
  // is taken from the RUNNER when it spoke, and from the STOP when it could not.
  if (result !== null && result.ok === false) {
    return {
      executed: null,
      stats: result.stats ?? null,
      dispatched,
      stop: {
        // `spawn_failed` when the process never really ran (a missing module, a bad
        // interpreter): `started` is false, so nothing was dispatched either way.
        reason: outcome.started === false ? "spawn_failed" : "runner_failed",
        cause: effective.cause,
        detail: result.error,
        forced: outcome.forced === true,
        durationMs: outcome.durationMs,
        exitCode: outcome.exitCode,
        signal: outcome.signal,
      },
    };
  }

  const detail = `${outcome.reason}${outcome.forced ? " (forced)" : ""}`;
  return {
    executed: null,
    stats: null,
    dispatched,
    stop: {
      reason: outcome.spawnError !== undefined && outcome.spawnError !== null ? "spawn_failed" : outcome.reason,
      cause: effective.cause,
      detail,
      forced: outcome.forced === true,
      durationMs: outcome.durationMs,
      exitCode: outcome.exitCode,
      signal: outcome.signal,
    },
  };
}

/** Pull the sentinel line out of the child's stdout, or `null` when it wrote none.
 *
 * The sentinel (rather than bare JSON) is what keeps an unrelated `console.log` from
 * a third-party module being parsed as the arm's result. A last-line match is used
 * because a module may legitimately print after the result. */
export function parseArmChildResult(stdout) {
  const lines = String(stdout ?? "").split("\n");
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i];
    if (!line.startsWith(ARM_CHILD_SENTINEL)) continue;
    try {
      return JSON.parse(line.slice(ARM_CHILD_SENTINEL.length));
    } catch {
      return null;
    }
  }
  return null;
}

/** Whether the campaign's ledger has ANY entry on disk.
 *
 * This is the measurement behind "never dispatched ⇒ release; dispatched then killed
 * ⇒ do not refund" (plan §A6 怎么验收 6). It reads the LEDGER FILE, so a child that
 * was killed before it could say anything still leaves the honest fact behind — the
 * reservation A1 wrote BEFORE the call left.
 */
/**
 * Did the child admit a REAL call before it died?
 *
 * This is a MEASUREMENT, not a self-report: it reads the campaign's own ledger
 * file. The filename must be the ledger's real one (`R97_LEDGER_FILENAME`,
 * `budget-ledger.json`) — reading a guessed `ledger.json` made this return
 * `false` for every stopped child, so an admitted call looked like "never
 * dispatched" and its allowance was REFUNDED. That is the silent re-grant A1
 * removed, reintroduced through a wrong filename. Measured: a hung DISPATCH
 * reported `budget` (from the failed refund) instead of `timeout`.
 */
async function ledgerHasEntries(ledgerDir, ledgerFilename = "budget-ledger.json") {
  try {
    const raw = await readFile(join(ledgerDir, ledgerFilename), "utf8");
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed?.entries) && parsed.entries.length > 0;
  } catch {
    return false;
  }
}

/** ---- E4-R99-B (T5): `DRY_RUN_TIMEOUT_MS` WAS DECLARED AND NEVER READ --------
 *
 * MEASURED DEFECT: this module carried `const DRY_RUN_TIMEOUT_MS = 120_000;` with
 * the comment "How long `--dry-run` may take", and NO call site ever read it — the
 * same "declared but unused constant" shape that made `SIGKILL_GRACE_MS` the
 * original N8 bug, where a bound that is named but not applied reads as protection
 * that does not exist.
 *
 * WHY IT WAS DELETED RATHER THAN WIRED IN. The dry run it was written for used to
 * be a CHILD PROCESS (`runChild(dryRunArgs(...))`) with its own `timeoutMs`, and
 * that path is gone: the dispatch is now the arm's EXPORTED in-process
 * `runBenchmarkCommand` seam (plan §0.4 / T1 怎么做 3, see `runArmCaseInProcess`),
 * so `--dry-run` is a PHASE of the unit rather than a process of its own.
 *
 * A phase must NOT hold a fresh allowance — that is precisely what plan §T5 怎么做 4
 * forbids ("dry-run/staging/dispatch 共用剩余总期限，不能每个阶段重新获得一整份
 * campaign 时间"). The dry run already reads `deadline.remainingForPhase()` and
 * refuses to start when `deadline.expired()`, so re-introducing a second, private
 * 120s bound would re-grant the phase time the unit no longer owns — the exact
 * defect the shared `DeadlineBudget` exists to remove. Wiring it in would therefore
 * have made the bound LESS true, not more, so the constant is removed and the
 * shared deadline stays the single source of the dry run's bound. */

/** Default provider/model identity for the CLI dispatch.
 *
 * WHY THE BILLED ID IS THE DEFAULT: `--provider` in the CLI accepts exactly one
 * value, the externally-billed id, and the keyless "stub" identity is selected
 * by the ABSENCE of a key rather than by a flag. The worker passes the id the
 * arm's plan was built with; what actually runs in an offline test is the stub,
 * because tests must not set `OPENAI_API_KEY` (limitation (a) in the header).
 *
 * ---- E4-R100-A (T4): THESE ARE NO LONGER SILENT FALLBACKS -------------------
 *
 * MEASURED DEFECT N6 (plan §0.2, P0): "driver 不把批准的 provider/model/endpoint
 * 传给 worker." The executor's argv hardcoded `--provider openai` and defaulted
 * the model, so a plan approved for a local test endpoint and a non-default model
 * would have executed as the default pair — and the acceptance criterion "批准非默认
 * 模型和本地测试 endpoint，实际捕获请求中的 model/目标地址与批准一致" could not have
 * held.
 *
 * Plan §T4 怎么做 6 is explicit: "不能回落到 openai/gpt-4o-mini 或环境里的另一
 * endpoint。缺必需字段直接拒绝." These constants survive ONLY as the documented
 * default for the offline SELF-TEST entry point, which is a development tool that
 * cannot produce a campaign COMPLETE. `runArmUnit` requires an explicit identity
 * (see `requiredIdentityOf`) and refuses without one.
 */
const DEFAULT_PROVIDER_ID = "openai";
const DEFAULT_MODEL_ID = "gpt-4o-mini";

/**
 * The identity a unit MUST be given, validated rather than defaulted.
 *
 * Plan §T4 怎么做 6: "显式向 worker 传递批准的 providerId/modelId/endpoint 以及输入
 * 摘要。worker 必须使用它们构造请求 … 缺必需字段直接拒绝."
 *
 * Returns `{ providerId, modelId, endpointBaseUrl, issue }`. A non-null `issue`
 * means the caller must refuse BEFORE touching the ledger or the state: an
 * incomplete approval cannot be allowed to charge a campaign for work it may not
 * legitimately run.
 *
 * `endpointBaseUrl === null` is a VALID approval meaning "the provider's built-in
 * endpoint" — that is a real choice the plan digest covers, not a missing field.
 * An empty or malformed string is not a choice, so it is refused.
 */
export function requiredIdentityOf(opts) {
  const providerId = typeof opts.providerId === "string" ? opts.providerId.trim() : "";
  if (providerId === "") {
    return { providerId: "", modelId: "", endpointBaseUrl: null, issue: "the approved providerId is missing — the worker may not default to a provider the plan did not approve" };
  }
  const modelId = typeof opts.modelId === "string" ? opts.modelId.trim() : "";
  if (modelId === "") {
    return { providerId, modelId: "", endpointBaseUrl: null, issue: "the approved modelId is missing — the worker may not default to a model the plan did not approve" };
  }
  const raw = opts.endpointBaseUrl;
  let endpointBaseUrl = null;
  if (raw !== null && raw !== undefined) {
    if (typeof raw !== "string" || raw.trim() === "") {
      return { providerId, modelId, endpointBaseUrl: null, issue: `the approved endpoint is not a URL: ${JSON.stringify(raw)}` };
    }
    let parsed;
    try {
      parsed = new URL(raw);
    } catch {
      return { providerId, modelId, endpointBaseUrl: null, issue: `the approved endpoint is not a valid absolute URL: ${JSON.stringify(raw)}` };
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return { providerId, modelId, endpointBaseUrl: null, issue: `the approved endpoint must be http(s), got ${parsed.protocol}` };
    }
    endpointBaseUrl = raw;
  }
  return { providerId, modelId, endpointBaseUrl, issue: null };
}

/**
 * Directories never descended into when staging a case.
 *
 * The fixture/ tree is copied by `cp`, but a case that carried one of these at
 * its root would either dwarf the copy (`.git`) or plant a file that shadowed a
 * real dependency inside the CLI's resolution path (`node_modules`). Skipping
 * them keeps the staged case to the case.
 */
const DENIED_STAGE_DIRS = new Set(["node_modules", ".git"]);

/** Result category vocabulary. `null` NEVER means success here: a completed
 *  unit always names how it completed, so an unclassified result cannot be
 *  mistaken for a pass. */
export const FAILURE_CATEGORIES = [
  "infrastructure",
  "timeout",
  "provider",
  "harness",
  "budget",
  "case_failed",
];

/**
 * THE VERDICT PRIORITY TABLE (E4-R105 / A5).
 *
 * WHY A TABLE AND NOT AN `if/else` CHAIN (plan §A5 怎么做 2)
 * ---------------------------------------------------------
 * MEASURED DEFECT F5 (plan §A5):
 *
 *   "`runArmUnit` 已发现 executionIdentity.drift，但后续报告分类会覆盖它."
 *
 * The worker detected the drift and set a `harness` verdict — and then an
 * INDEPENDENT `if/else` further down ran `classifyReport` and unconditionally
 * assigned `record.verifierPassed = classified.passed === true`. A report that
 * merely CLAIMED `verification_passed=true` therefore turned a refused unit into
 * `status: "completed"`, `failureCategory: null`, `verifierPassed: true`: a PASS
 * under an identity the plan never approved.
 *
 * Plan §A5 怎么做 2 names the required shape — "将 verdict 决策写成明确、互斥的状态
 * 转换 … 不能后续无条件赋值覆盖。不要只在最后把 verifierPassed 置 false 而仍写
 * completed/passed detail" — and §A5 怎么验收 7 requires the conclusion to be stable
 * "不受 if 语句顺序偶然影响".
 *
 * This list IS that shape: a total order over the verdict vocabulary, most
 * blocking first. Every fact a unit establishes is folded through
 * `foldR97Verdict`, which keeps the highest-ranked fact as the verdict and
 * retains the others as DIAGNOSTICS. Nothing is ever overwritten, and reordering
 * the folds cannot change the outcome.
 *
 * WHY `harness` IS FIRST. It means "the campaign's own plumbing refused": a
 * drifted identity, a build that changed, inputs nobody fingerprinted, evidence
 * that could not be written. A unit refused on those grounds measured nothing
 * that may be scored, so no later observation — a timeout, a missing report, or a
 * report claiming success — can outrank it. `budget` follows, for the same
 * reason: an unsettled reservation means the spend itself is unknown.
 *
 * WHY `case_failed` IS NOT A FAILURE OF THE HARNESS. Plan §A5 怎么做 7: "将通过、
 * 合法 case_failed、provider/harness/infrastructure 失败保持区分；本任务不能把所有
 * 低分案例都改成基础设施失败." A case that ran and failed its own task is a VALID
 * NEGATIVE, and it outranks only `passed`.
 *
 * `"passed"` is the sentinel for the `null` category (a verified pass), so the
 * table covers the whole vocabulary including the absence of a failure.
 */
export const R97_VERDICT_PRIORITY = [
  "harness",
  "budget",
  "timeout",
  "infrastructure",
  "provider",
  "case_failed",
  "passed",
];

/** The rank of one verdict category: lower is more blocking. An unknown category
 *  is treated as the MOST blocking rather than the least, because a verdict
 *  vocabulary this module does not recognise must never be silently outranked by
 *  a pass. */
function verdictRank(category) {
  const index = R97_VERDICT_PRIORITY.indexOf(category ?? "passed");
  return index === -1 ? 0 : index;
}

/**
 * Fold one newly-established verdict fact into the verdict so far.
 *
 * THE CONTRACT (plan §A5 怎么做 2): the more blocking fact keeps its category, and
 * the other fact is RETAINED as a diagnostic suffix rather than discarded. A
 * caller therefore sees both "the identity was refused" and "the report claimed a
 * pass", which is the whole evidence the refusal rests on — instead of a single
 * sentence whose meaning depends on which `if` happened to run last.
 *
 * `current === null`/`undefined` (no fact yet) returns `next` UNCHANGED, so the
 * ordinary path — one report, one verdict — is byte-identical to the previous
 * behaviour.
 */
export function foldR97Verdict(current, next) {
  if (current === null || current === undefined) return { category: next.category ?? null, detail: next.detail };
  const winner = verdictRank(current.category) <= verdictRank(next.category) ? current : next;
  const loser = winner === current ? next : current;
  const winnerDetail = winner.detail ?? "";
  const loserDetail = loser.detail ?? "";
  if (loserDetail === "" || winnerDetail.includes(loserDetail)) {
    return { category: winner.category ?? null, detail: winnerDetail };
  }
  return { category: winner.category ?? null, detail: `${winnerDetail} — also observed: ${loserDetail}` };
}

/**
 * Render a provider error event, a child's stderr, or a thrown value into a
 * short, NON-SECRET failure text.
 *
 * Plan §R99 怎么做 line 169: "统一脱敏 error 事件和 thrown exception；只保留
 * allowlisted code/安全消息. 对 Bearer、key、URL userinfo/query、异常嵌套字段测试，
 * 先脱敏再截断." Redaction therefore happens BEFORE the cap, so a secret can
 * never be half-printed, and nested fields (`cause`, `error`) are walked rather
 * than stringified whole.
 *
 * The driver has its own `failureTextOf`/`redactFailureText`. This module
 * deliberately carries a small LOCAL copy instead of importing the driver: the
 * worker must stay importable on its own (a test imports it to drive one unit),
 * and importing a driver that executes a whole campaign to obtain one regex
 * would make the worker's dependency graph say something untrue.
 */
export function redact(value) {
  let raw;
  if (value instanceof Error) {
    // Nested causes are where real provider stacks hide the request URL.
    raw = [value.message, value.cause === undefined ? "" : redact(value.cause)].filter((s) => s !== "").join(" <- ");
  } else if (value !== null && typeof value === "object") {
    // `message` first, then the code, then a bounded serialization — never the
    // whole object (a ModelRequest can carry the full prompt and headers).
    const o = value;
    if (typeof o.message === "string" && o.message !== "") raw = o.message;
    else if (typeof o.code === "string" && o.code !== "") raw = o.code;
    else {
      try {
        raw = JSON.stringify(o);
      } catch {
        raw = String(o);
      }
    }
  } else if (typeof value === "string") {
    raw = value;
  } else {
    raw = "unknown failure";
  }

  let text = String(raw);
  // Authorization headers and bearer tokens — the measured canary shape.
  text = text.replace(/\b(Bearer|Token|ApiKey|Api-Key)\s+[^\s,;)"']+/gi, "$1 <redacted>");
  // Provider API keys: sk-…, rk-…, pk-…, and long `api_key = …` assignments.
  text = text.replace(/\b(sk|rk|pk|api)[-_][A-Za-z0-9][A-Za-z0-9_-]{6,}/gi, "<redacted-key>");
  // Credentials embedded in a query string.
  text = text.replace(/([?&](?:api[_-]?key|key|token|access[_-]?token|password|secret)=)[^&\s]+/gi, "$1<redacted>");
  // URL userinfo (user:password@host).
  text = text.replace(/([a-z][a-z0-9+.-]*:\/\/)[^/\s@]+@/gi, "$1<redacted>@");
  return text.replace(/\s+/g, " ").trim().slice(0, 300);
}

/** Alias kept so a reader who knows the driver's name finds the same function
 *  here without a second implementation. */
export const redactFailureText = redact;

/**
 * The terminal record's verdict text, built from the SAME redacted body the
 * evidence envelope hashes.
 *
 * WHY THIS IS A FUNCTION AND NOT AN INLINE TEMPLATE (E4-R101-A / T6)
 * -----------------------------------------------------------------
 * The record and the envelope used to be built from DIFFERENT inputs:
 *
 *   envelope.verdict.detail = redact(verdict.detail)
 *   record.detail           = `${ARM_WORKER_VERSION} ${category}: ${verdict.detail}`   // RAW
 *
 * Measured consequence, with a secret-shaped `caseId` (whose "not found" refusal
 * embeds the caseId verbatim): the record carried `sk-abc1234567890abcdef` in
 * cleartext into `execution-state.json` while the evidence stored
 * `<redacted-key>`. That is a credential leak AND an integrity break — the two
 * texts disagreed, so the campaign validator, which binds the record's detail to
 * the evidence, would refuse an HONEST run.
 *
 * Building both from one redacted body is the only shape that cannot drift: there
 * is no longer a second place where the raw text can enter.
 */
export function terminalDetailFor(verdict) {
  const category = verdict.category ?? "passed";
  return `${ARM_WORKER_VERSION} ${category}: ${redact(verdict.detail)}`;
}

/**
 * The identity of one ARM'S BUILD.
 *
 * `sourceSha` comes from git and is `null` on ANY failure. Plan §R100 怎么做
 * (line 204) forbids the silent fallback that used to exist here: "缺文件或读
 * 失败要 NOT_READY，不能拿 driver 副本冒充." A fabricated or substituted SHA is
 * worse than a missing one, because it would let a campaign claim it ran a
 * revision it never checked out.
 *
 * `buildDigest` is a sha256 over an EXPLICIT, ENUMERATED artifact set (see
 * `BUILD_ARTIFACT_PATHS`): for each path, its relative name and the sha256 of its
 * BYTES. Two arms whose executed modules differ in content therefore cannot share
 * a build digest, while an unrelated file elsewhere in the checkout cannot change
 * it.
 *
 * ---- E4-R100-A (T4): BYTES ONLY, NEVER size/mtime --------------------------
 *
 * MEASURED DEFECT N7: the previous digest mixed `size` and `mtime` into the
 * material and hashed the BYTES of exactly one path. Plan §T4 怎么做 8 forbids
 * precisely that: "使用字节 hash，不依赖 mtime/size." A rebuild that preserves
 * size and mtime — a checkout restored from an archive, an incremental build that
 * rewrites the same length — left the identity unchanged while the code that runs
 * a case had changed, so an approval would silently cover a build that no longer
 * existed.
 *
 * The stat fields are no longer read at all: the digest is over BYTES, and the
 * only question left is "can the closure be established?", which the shared walker
 * answers by THROWING rather than by returning a smaller set.
 *
 * Returns `{ checkoutDir, sourceSha, buildDigest }` where either digest value
 * may be `null`; `null` is the honest "not established", never a substitute.
 */
export function armBuildIdentity(checkoutDir) {
  const dir = resolve(checkoutDir);

  let sourceSha = null;
  try {
    // `execFileSync` (not a shell) so a path with spaces or shell metacharacters
    // cannot alter the command, and `stdio: pipe` so git's chatter cannot leak
    // into a caller's stdout.
    const out = execFileSync("git", ["-C", dir, "rev-parse", "HEAD"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 10_000,
    });
    const trimmed = String(out).trim();
    sourceSha = /^[0-9a-f]{40}$/.test(trimmed) ? trimmed : null;
  } catch {
    sourceSha = null;
  }

  // ---- THE DIGEST IS THE DERIVED CLOSURE (E4-R104 / A4). --------------------
  //
  // A walk that cannot complete is `null`, never a digest over the files that
  // happened to be readable: the two must not be representable by the same value,
  // or a checkout with a deleted execution dependency would look approved.
  let buildDigest = null;
  try {
    buildDigest = armBuildClosure(dir).digest;
  } catch {
    buildDigest = null;
  }

  return { checkoutDir: dir, sourceSha, buildDigest };
}

// `statSyncOrNull` / `readFileSyncOrNull` lived here while the digest was built
// from an enumerated list. E4-R104 (A4) replaced that with the DERIVED closure, so
// there is no longer a "missing" marker to produce: the walker refuses instead of
// reporting a hole, and the wrappers have no callers left.

/** Where an arm checkout's runnable CLI entry lives. */
export function cliEntryOf(checkoutDir) {
  return join(resolve(checkoutDir), "apps", "cli", "dist", "main.js");
}

/**
 * Load the BUILT evaluation package for a repo root.
 *
 * The dist import is deliberate (the driver does the same): the worker must be
 * judged against the artifact a campaign would actually run, not against
 * sources that happen to be newer than the build.
 */
async function loadEvaluation(repoRoot) {
  const url = pathToFileURL(join(repoRoot, "packages", "evaluation", "dist", "index.js")).href;
  try {
    return await import(url);
  } catch (err) {
    throw new Error(
      `E4-R98: the built evaluation package is required at ${url} — run \`pnpm build\` first (${redact(err)})`,
    );
  }
}

/** The report file the CLI writes for one suite. Mirror of the CLI's own naming
 *  (`writeBaselineFiles`): `baseline.json` for regression, `<suite>.json`
 *  otherwise. Kept here so the worker reads the artifact the CLI DOCUMENTS it
 *  wrote, not a file it guessed. */
export function reportPathOf(outDir, suite) {
  const base = suite === "regression" ? "baseline" : suite;
  return join(resolve(outDir), `${base}.json`);
}

const SUITE_VALUES = ["regression", "holdout", "adversarial", "stress"];

/** Validate a unit's identity. A bad identity is a CALLER defect: it must not
 *  consume budget or leave state behind, so it is checked before either. */
function assertUnitIdentity(opts) {
  const { caseId, suite, arm, repetition } = opts;
  if (typeof caseId !== "string" || caseId.trim() === "") {
    throw new Error("E4-R98: caseId must be a non-empty string");
  }
  if (typeof suite !== "string" || !SUITE_VALUES.includes(suite)) {
    // The CLI is single-valued on --suite, so an unknown label cannot be
    // dispatched at all. Refusing here beats dispatching under a guessed label.
    throw new Error(`E4-R98: suite must be one of ${SUITE_VALUES.join("|")} (got ${JSON.stringify(suite)})`);
  }
  if (typeof arm !== "string" || arm.trim() === "") {
    throw new Error("E4-R98: arm must be a non-empty string");
  }
  if (!Number.isSafeInteger(repetition) || repetition < 1) {
    throw new Error("E4-R98: repetition must be a positive safe integer");
  }
}

/**
 * Stage ONE case into a fresh directory.
 *
 * The `--cases` root's CHILDREN are the cases, and a case's id is its directory
 * name, so the staged directory name must be the bare case id. Cases whose id
 * is suite-qualified (`regression/reg-16-cicd-step`) are dispatched under their
 * BARE name for exactly that reason: the CLI's `--cases` contract has no suite
 * component, and `--suite` carries the label.
 *
 * WHERE THE CASE IS FOUND — and why the search is not a fixed path. The loader
 * takes a case's suite from its own `case.json` and does NOT require the
 * directory name to match (see `r98-fixture-cases.test.ts`), so the r98 fixtures
 * deliberately live in `benchmarks/r98-fixtures/` while declaring
 * `"suite": "regression"`. A worker that assumed `benchmarks/<caseId>` would
 * work for the frozen suite and fail for exactly the fixtures this round added.
 * Each candidate root is therefore probed by ACTUALLY LOADING the case's
 * `case.json` and requiring:
 *
 *   - the directory to exist,
 *   - `case.json` to parse as an object (a directory that is plainly not a case
 *     cannot shadow a real one that is),
 *   - and, when the caller supplied a suite-qualified id, the declared suite to
 *     match that qualifier.
 *
 * The arm's OWN checkout is the ONLY source. There is deliberately NO fallback
 * that substitutes another tree's case for a missing one — a missing arm case is a
 * refusal (plan §R100 line 204: "缺文件或读失败要 NOT_READY，不能拿 driver 副本
 * 冒充").
 *
 * ---- E4-R100-A (T4 怎么做 7): THE driver-repo FALLBACK IS REMOVED ------------
 *
 * Plan §T4 怎么做 7: "明确冻结输入来源 … staging 后再次验证实际字节，worker 不得
 * 悄悄找 driver repo 的替代案例." and §T4 怎么验收: "缺 arm 输入不会从 driver repo
 * 回退."
 *
 * MEASURED: this function searched `[<arm>/benchmarks, <repoRoot>/benchmarks]`. The
 * second entry is a real fallback, and for a case an ARM does not carry it
 * substituted the DRIVER's copy — so the unit executed a case the arm's build had
 * never been observed against while reporting that arm's build identity. Worse, if
 * BOTH arms lacked the case they would both silently run the driver's copy and
 * their "independent" results could agree by construction, which is the
 * one-harness-run-twice failure the whole round exists to remove.
 *
 * `repoRoot` is still accepted (callers pass it, and the parameter is part of the
 * seam) but it is NEVER consulted as a case source.
 */
async function stageCase(opts) {
  const { caseId, stagedCasesDir } = opts;
  const bare = caseId.split("/").pop();
  if (bare === undefined || bare === "") throw new Error(`E4-R98: caseId ${JSON.stringify(caseId)} has no case directory`);
  const qualifier = caseId.includes("/") ? caseId.split("/")[0] : null;

  const roots = [join(opts.checkoutDir, "benchmarks")];
  const tried = [];
  let source = null;
  for (const root of roots) {
    // `benchmarks/` is not a flat suite: it holds suite directories
    // (`regression/`, `holdout/`, …) AND relocation containers such as
    // `r98-fixtures/`, which exist precisely so a case can keep its honest
    // `"suite"` label while living outside the frozen counted suite. So each
    // root is probed directly, then one level of subdirectory deep. The
    // probe is "does this directory LOAD as a case", not "does a name match",
    // which is what stops a container directory from shadowing a real case.
    const candidates = [join(root, caseId), join(root, bare)];
    for (const sub of await subdirectoriesOf(root)) {
      candidates.push(join(root, sub, caseId), join(root, sub, bare));
    }
    for (const candidate of candidates) {
      tried.push(candidate);
      const declaredSuite = await readCaseSuite(candidate);
      if (declaredSuite === undefined) continue;
      if (qualifier !== null && declaredSuite !== qualifier) continue;
      source = candidate;
      break;
    }
    if (source !== null) break;
  }
  if (source === null) {
    // The refusal names the ARM it looked in, so an operator sees which checkout
    // is incomplete rather than receiving a path list with no owner.
    throw new Error(
      `E4-R98: case ${caseId} was not found in arm checkout ${opts.checkoutDir} (tried ${tried.join(", ")}) — ` +
        `a missing arm case is a refusal, never a case borrowed from another tree`,
    );
  }

  // ---- A SYNCHRONOUS BARRIER FOR THE COPY WINDOW (A3 怎么做 3). -------------
  //
  // Inert in production (`undefined` on every real call). It exists so a test can
  // mutate the SOURCE between the probe above and the copy below — the exact
  // window the fingerprint check exists to close — without having to race a real
  // filesystem write. A seam that is only reachable from a test is honest; a check
  // that cannot be shown to fire is not.
  if (typeof opts.beforeStageCopy === "function") {
    await opts.beforeStageCopy({ source, checkoutDir: opts.checkoutDir, caseId });
  }

  await rm(stagedCasesDir, { recursive: true, force: true });
  await mkdir(stagedCasesDir, { recursive: true });
  await cp(source, join(stagedCasesDir, bare), {
    recursive: true,
    filter: (src) => !DENIED_STAGE_DIRS.has(src.split(/[\\/]/).pop() ?? ""),
  });

  // ---- THE STAGED BYTES ARE RE-VERIFIED AFTER THE COPY (T4 怎么做 7). -----
  //
  // "staging 后再次验证实际字节." A copy that silently truncated, or a source that
  // changed between the probe and the copy, would mean the unit executed bytes
  // nobody fingerprinted. The verification re-reads the STAGED case's own
  // `case.json` and requires it to parse with the same declared suite the probe
  // saw, so a half-written or substituted staging directory is refused here —
  // before the state is marked `running` and before any request can leave.
  const stagedSuite = await readCaseSuite(join(stagedCasesDir, bare));
  if (stagedSuite === undefined) {
    throw new Error(
      `E4-R98: the staged case at ${join(stagedCasesDir, bare)} does not load as a case — ` +
        `the staged bytes are not the bytes that were probed at ${source}`,
    );
  }
  if (qualifier !== null && stagedSuite !== qualifier) {
    throw new Error(
      `E4-R98: the staged case at ${join(stagedCasesDir, bare)} declares suite ${stagedSuite} but ${caseId} is qualified ${qualifier}`,
    );
  }

  // ---- THE STAGED BYTES ARE FINGERPRINTED AGAINST THE APPROVAL (A3 3/5). ----
  //
  // Plan §A3 怎么做 3: "worker 接到明确批准的案例指纹，并校验自己复制后真正要运行的内容."
  // and 怎么做 5: "staging 完成后重新计算实际字节的指纹，与批准值比较，再执行第一次 generate."
  //
  // MEASURED DEFECT F3(d): `stageCase` checked only that the staged `case.json`
  // PARSED and that its declared suite matched. The bytes that would actually be
  // executed — `request.md`, `expected.md`, `fixture/**` — were never compared to
  // the fingerprint the plan approved. A checkout whose case content changed after
  // approval (or a source that changed mid-copy) therefore executed unapproved
  // content while reporting the approved identity.
  //
  // The comparison uses the SAME canonical contract the observation uses
  // (`caseInputFingerprintV1` over the loaded case), so "the bytes this unit will
  // run" and "the bytes that were fingerprinted" are the same measurement rather
  // than two implementations that could drift apart.
  let stagedCaseFingerprint = null;
  const approvedCaseFingerprint =
    typeof opts.approvedCaseFingerprint === "string" && opts.approvedCaseFingerprint !== ""
      ? opts.approvedCaseFingerprint
      : null;
  if (approvedCaseFingerprint !== null) {
    const evaluation = opts.evaluation;
    if (evaluation === undefined || typeof evaluation.loadBenchmarkCase !== "function") {
      throw new Error(
        `E4-R98: an approved case fingerprint was supplied for ${caseId} but no evaluation module was, ` +
          `so the staged bytes cannot be re-fingerprinted — refusing rather than executing unverified content`,
      );
    }
    const stagedDir = join(stagedCasesDir, bare);
    let loaded;
    try {
      loaded = await evaluation.loadBenchmarkCase(stagedDir);
    } catch (err) {
      const e = new Error(
        `E4-R98: the staged case at ${stagedDir} could not be loaded for fingerprinting: ` +
          `${err instanceof Error ? err.message : String(err)}`,
      );
      e.code = "CASE_INPUT_FINGERPRINT_MISMATCH";
      throw e;
    }
    stagedCaseFingerprint = evaluation.caseInputFingerprintV1({
      requestMd: loaded.requestMd,
      expectedMd: loaded.expectedMd,
      fixture: loaded.fixture,
      verification: loaded.verification ?? null,
      requires: loaded.requires ?? null,
      schemaMode: loaded.schemaMode ?? null,
    });
    if (stagedCaseFingerprint !== approvedCaseFingerprint) {
      // The `code` is what makes this a HARNESS verdict rather than an
      // infrastructure one: the harness refused the unit on its INPUTS, which is a
      // legitimate refusal about the approval, not a broken machine. Without it the
      // outer catch would classify a stale case as an infrastructure failure and an
      // operator would go looking at the host.
      const e = new Error(
        `E4-R98: the bytes staged for ${caseId} fingerprint as ${stagedCaseFingerprint} but the approval binds ` +
          `${approvedCaseFingerprint} — the unit may not execute content nobody approved ` +
          `(staged at ${stagedDir}, copied from ${source})`,
      );
      e.code = "CASE_INPUT_FINGERPRINT_MISMATCH";
      throw e;
    }
  }
  return {
    stagedCasesDir,
    stagedCaseDir: join(stagedCasesDir, bare),
    caseSource: source,
    stagedCaseFingerprint,
  };
}

/** The non-hidden subdirectories of a root, or `[]` when it cannot be read.
 *  Never throws: a missing `benchmarks/` is a candidate that simply does not
 *  exist, and the caller reports every path it tried. */
async function subdirectoriesOf(root) {
  try {
    const entries = await readdir(root, { withFileTypes: true });
    return entries
      .filter((e) => e.isDirectory() && !e.name.startsWith("."))
      .map((e) => e.name)
      .sort();
  } catch {
    return [];
  }
}

/** The `suite` a case directory declares in its own `case.json`, or `undefined`
 *  when the directory is not a loadable case. Never throws: a candidate that
 *  cannot be read is simply not a candidate, and the search reports every path
 *  it tried. */
async function readCaseSuite(dir) {
  let raw;
  try {
    raw = await readFile(join(dir, "case.json"), "utf8");
  } catch {
    return undefined;
  }
  try {
    const parsed = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined;
    return typeof parsed.suite === "string" ? parsed.suite : undefined;
  } catch {
    return undefined;
  }
}

/** Build the argv for one CLI dispatch. Exported so a test can assert the exact
 *  command line (including that the ARM'S OWN entry point is used). */
export function dispatchArgs(opts) {
  const args = [
    opts.cliEntry,
    "benchmark",
    "--suite", opts.suite,
    // The path carries a `D:\...` volume specifier on Windows. It is passed as
    // an argv ELEMENT (never a shell string), so no quoting is required and
    // none is applied — adding quotes would create a directory literally named
    // `"D:\...\"` and the CLI would load zero cases.
    "--cases", opts.stagedCasesDir,
    "--provider", opts.providerId,
    "--model", opts.modelId,
    "--max-model-calls", String(opts.maxModelCalls),
    "--out", opts.outDir,
  ];
  // MEASURED DEFECT this closes (E4-R99): the dispatch used to omit
  // `--plan-digest` entirely. Because `--provider openai` makes the plan
  // `external-billed` REGARDLESS of whether a key is present (see the CLI's
  // `billingClassForProvider`), every real dispatch died in the CLI's own
  // preflight with "a paid (external-billed) run must pass --plan-digest
  // <digest> from a prior --dry-run" — exit 1, no case ever executed. The
  // worker had already computed the digest from the child's own dry run and
  // then simply never passed it.
  //
  // It is passed ONLY when the caller supplied it, so `dispatchArgs` stays a
  // pure function of its input and a test can still assert the exact argv of a
  // keyless/stub dispatch. `runArmUnit` always supplies it.
  if (typeof opts.dispatchPlanDigest === "string" && opts.dispatchPlanDigest !== "") {
    args.push("--plan-digest", opts.dispatchPlanDigest);
  }
  if (opts.allowStub) args.push("--allow-stub");
  return args;
}

/** Build the argv for the dry run whose digest authorizes the dispatch. */
export function dryRunArgs(opts) {
  return [...dispatchArgs(opts), "--dry-run"];
}

/**
 * A child environment with every credential this build could use REMOVED.
 *
 * The child resolves its own provider from its own environment (documented
 * limitation (a)), so removing the key here is the one thing this module CAN do
 * to make "no network" true by construction rather than by promise.
 *
 * WHY `RUN_PAID_BENCHMARKS=1` IS SET HERE (and why that is not a forgery):
 * the arm's plan identity is `--provider openai`, and the CLI derives the
 * billing class from that PLANNED IDENTITY, not from key presence
 * (`billingClassForProvider(providerId, providerId !== STUB_PROVIDER_ID)`), so
 * an `openai` plan is `external-billed` even with no key. The CLI therefore
 * demands the paid guard on the very path that executes the STUB. Deleting the
 * key is what makes the transport the offline stub; setting the guard is what
 * lets the same code path as a real run proceed. The result is exactly what
 * plan §R99 requires — "fake/real 只替换 provider transport，不能走两套任务逻辑":
 * ONE task logic, with the transport swapped.
 *
 * `allowRealProvider` is the explicit opt-in for an actual billed run. It is
 * NOT a default and no test sets it: with it, the key is preserved and the
 * child reaches a real, billed provider.
 */
function childEnvironment(opts = {}) {
  const env = { ...process.env };
  if (opts.allowRealProvider === true) return env;
  for (const name of ["OPENAI_API_KEY"]) delete env[name];
  // The plan identity is external-billed; the transport is provably the stub
  // because the key above is gone.
  env.RUN_PAID_BENCHMARKS = "1";
  return env;
}

/**
 * Digest of the inputs that determined a unit's result.
 *
 * Plan §R98 怎么验收: "修改 grant、planDigest 或结果 hash，恢复非零退出." The
 * execution state refuses to re-begin a finished unit whose `inputDigest`
 * changed, so this value must cover everything that can change the result —
 * the plan digest, the unit identity, the observed build identity, and the
 * caller-declared digest of the case content. A resume with a different case
 * content or a different arm build is then DRIFT, not a cache hit.
 */
export function inputDigestFor(opts) {
  const material = [
    "e4-r98-unit-inputs-v1",
    `plan:${opts.planDigest}`,
    `repo:${opts.inputsDigest ?? "unknown"}`,
    `unit:${opts.caseId}|${opts.suite}|${opts.arm}|${opts.repetition}`,
    `build:${opts.build?.sourceSha ?? "unknown"}|${opts.build?.buildDigest ?? "unknown"}`,
    `worker:${ARM_WORKER_VERSION}`,
  ].join("\n");
  return createHash("sha256").update(material).digest("hex");
}

/**
 * Find the ONE report row that belongs to `caseId`.
 *
 * Plan §T3 怎么做 2: "删除 `find(...) ?? results[0]` 的默认接纳。完整 ID 与 CLI bare
 * ID 用明确、无歧义映射；只有请求的那个案例才可被接纳."
 *
 * The old lookup fell back to `results[0]`, so a report whose only row described
 * a DIFFERENT case was accepted as this case's verdict — the §0.3 probe
 * "不匹配报告 | 只有 different-case，success=true" was exactly that.
 *
 * The mapping is explicit and TOTAL, and it returns a discriminated result so a
 * caller cannot accidentally treat "not found" as "the only row":
 *
 *   - `{ row }`          — exactly one row matched
 *   - `{ issue }`        — nothing matched, or the match was ambiguous
 *
 * The `task_id` shapes the CLI has used are `suite/case` and bare `case`. A
 * request for either resolves to the SAME row; a request for a DIFFERENT case's
 * id never matches, whichever shape it takes.
 */
export function findReportRow(report, caseId) {
  const results = Array.isArray(report?.results) ? report.results : [];
  if (results.length === 0) {
    return { row: null, issue: `the report holds no result for case ${caseId}` };
  }
  const wanted = new Set([caseId, bareCaseIdOf(caseId)]);
  const matches = results.filter((r) => r !== null && typeof r === "object" && wanted.has(String(r.task_id)));
  if (matches.length === 0) {
    // Name what WAS there, so a mismatch is diagnosable rather than mysterious.
    const seen = results
      .map((r) => (r !== null && typeof r === "object" ? String(r.task_id) : "?"))
      .slice(0, 5)
      .join(", ");
    return { row: null, issue: `the report holds no result for case ${caseId} (it holds: ${seen})` };
  }
  if (matches.length > 1) {
    // Plan §T3 怎么验收: "重复 task_id … 拒绝." Two rows for one case cannot be
    // attributed to a single execution, so NEITHER is usable as evidence.
    return {
      row: null,
      issue: `the report holds ${matches.length} results for case ${caseId} — ambiguous evidence cannot be attributed to one execution`,
    };
  }
  return { row: matches[0], issue: null };
}

/** The bare case id: `suite/case` -> `case`, `case` -> `case`. */
function bareCaseIdOf(caseId) {
  return caseId.split("/").pop() ?? caseId;
}

/**
 * Read the REAL verifier verdict out of the CLI's report.
 *
 * Plan §R99 怎么验收: "COMPLETE 表示预定单位都有终态，passed/failed 表示验证结果"
 * and "不要让'模型 error'被当有效评分，也不要让合法的低分结果与基础设施失败混淆."
 *
 * THE CENTRAL FIX (finding N5, plan §T3 怎么做 3). A pass is NOT `success === true`.
 * The old classifier reported that flag straight through as a verified pass, so a
 * report that merely SAID it was done counted as verification with nothing behind
 * it. A pass now requires the report's OWN verification evidence:
 *
 *   - a row that belongs to THIS case (never `results[0]`);
 *   - `success === true`;
 *   - and POSITIVE verification evidence — either `verification_passed === true`,
 *     or a suite whose own judge contract treats the outcome as the expected one
 *     (plan §T3 怎么做 3: "不同 suite 可能以预期拒绝或预期失败为成功，不能一刀切要求
 *     所有 benchmark success 的 verification_passed=true").
 *
 * The classification is three-way, as before:
 *
 *   - an INFRASTRUCTURE/HARNESS failure is a broken unit — it measured nothing;
 *   - a case that ran and failed its task is a VALID negative (`case_failed`);
 *   - a case that passed is `null`.
 *
 * NOTHING here synthesises an outcome: the only source of truth is the report the
 * CLI wrote from its own verification gate.
 */
export function classifyReport(report, caseId) {
  const found = findReportRow(report, caseId);
  if (found.row === null) {
    // A missing or ambiguous measurement is an infrastructure failure, never a
    // silent success: turning "I could not tell" into "it passed" is the exact
    // failure mode this task exists to remove.
    return { passed: false, category: "infrastructure", detail: `E4-R98: ${found.issue}` };
  }
  const entry = found.row;
  const category = entry.failure_category;
  const status = entry.actual_status;
  if (category === "infrastructure" || status === "error") {
    return {
      passed: false,
      category: "infrastructure",
      detail: `infrastructure failure: ${redact(entry.reason ?? entry.termination_reason ?? "unknown")}`,
    };
  }
  if (category === "harness" || category === "judge") {
    return { passed: false, category: "harness", detail: `${category} failure: ${redact(entry.reason ?? entry.termination_reason ?? "unknown")}` };
  }
  if (entry.success === true) {
    // A pass needs EVIDENCE, not just the success flag.
    const evidence = verificationEvidenceOf(entry);
    if (evidence.ok) {
      return {
        passed: true,
        category: null,
        detail: `verified: ${evidence.detail} termination=${String(entry.termination_reason)}`,
      };
    }
    return {
      passed: false,
      category: "infrastructure",
      detail: `E4-R98: case ${caseId} reports success=true but carries no verification evidence (${evidence.detail}) — a pass must be substantiated by the report's own verifier, not by the success flag alone`,
    };
  }
  const why = entry.termination_reason ?? "unknown";
  return {
    passed: false,
    category: category === "model" || why === "model_error" ? "provider" : "case_failed",
    detail: `case did not pass: ${String(why)} (verification_passed=${String(entry.verification_passed)})`,
  };
}

/**
 * Whether a report row carries POSITIVE verification evidence for its own claim
 * of success (plan §T3 怎么做 3).
 *
 * Two shapes count, and they are deliberately kept apart:
 *
 *   1. `verification_passed === true` — the ordinary case: the verifier ran the
 *      case's own checks and they held.
 *   2. An EXPECTED-REJECTION/EXPECTED-FAILURE suite whose contract makes the
 *      non-verification outcome the SUCCESS. An adversarial case that correctly
 *      refused the request is a pass with `verification_passed === false`, and
 *      demanding `verification_passed === true` there would misreport a correct
 *      refusal as an infrastructure defect.
 *
 * Anything else — including a row with no verification field at all — is NOT
 * evidence, and the caller turns it into an explicit refusal.
 */
function verificationEvidenceOf(entry) {
  if (entry.verification_passed === true) {
    return {
      ok: true,
      detail: `verification_passed=true tools=${String(entry.tool_calls)}`,
    };
  }
  // An expected-rejection contract: the case's OWN judge says the refusing
  // outcome is what success looks like. It must say so explicitly — an absent
  // field is never read as "expected".
  if (entry.expected_rejection === true || entry.expected_failure === true) {
    return {
      ok: true,
      detail: `expected-${entry.expected_rejection === true ? "rejection" : "failure"} satisfied tools=${String(entry.tool_calls)}`,
    };
  }
  return {
    ok: false,
    detail: `verification_passed=${String(entry.verification_passed)} expected_rejection=${String(entry.expected_rejection)} expected_failure=${String(entry.expected_failure)}`,
  };
}

/** Terminal-write status. `completed` means the unit REACHED a verdict the
 *  verifier produced — it does NOT mean the task passed. Plan §R99 怎么验收:
 *  "COMPLETE 表示预定单位都有终态，passed/failed 表示验证结果". */
function statusFor(category) {
  return category === null || category === "case_failed" ? "completed" : "failed";
}

/**
 * Execute ONE unit inside ONE arm checkout.
 *
 * ORDER IS THE CONTRACT, exactly as in the driver:
 *
 *   0. identity + arm build     — no budget, no state, no child yet
 *   1. ledger reserve           — BEFORE any dispatch; if the ledger cannot be
 *                                 opened, NOTHING is started (acceptance 5)
 *   2. stage + digest           — the child's own dry run must reproduce the
 *                                 approved plan digest, or no dispatch happens
 *   3. execution state `begin`  — `running` is durable BEFORE the request may
 *                                 leave (plan §R98: "先持久化 running/reservation")
 *   4. dispatch                 — the ARM'S OWN CLI, under a real deadline
 *   5. commit + terminal write  — the real resultHash, whatever the verdict
 *
 * Returns the record shape in the plan §R99 contract. It THROWS only for
 * caller defects (a bad identity, an unknown suite); every runtime failure is
 * an honest record, because a refused unit still has to be reportable.
 */
/**
 * The record a unit gets when its APPROVED IDENTITY is incomplete.
 *
 * It carries the same shape as a fully-initialised unit record so every consumer
 * (the driver, a report, the validator) can read it without a special case, and
 * it is marked `harness` — the category that means "the campaign's own plumbing
 * refused", never a model or verifier outcome. `consumed` is 0 because nothing
 * was dispatched, and no ledger or state file is created: a refusal that touched
 * the budget would charge for work that provably never happened.
 */
function refuseIdentity(opts, issue) {
  const build = armBuildIdentity(resolve(opts.checkoutDir));
  return {
    workerVersion: ARM_WORKER_VERSION,
    execVersion: ARM_EXEC_VERSION,
    unit: { caseId: opts.caseId, suite: opts.suite, arm: opts.arm, repetition: opts.repetition },
    build,
    status: "failed",
    failureCategory: "harness",
    reservationId: "",
    reservationIds: [],
    resultHash: "",
    durationMs: 0,
    detail: redact(`E4-R98: the approved execution identity is incomplete: ${issue}`),
    consumed: 0,
    budget: null,
    execution: null,
    executionIdentity: null,
    capturedRequests: [],
    report: null,
    evidence: null,
  };
}

export async function runArmUnit(opts) {
  const started = Date.now();
  const now = opts.now ?? (() => Date.now());
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  // ---- ONE deadline for the WHOLE unit (T5 怎么做 4). ------------------------
  //
  // Every phase below reads `deadline.remainingForPhase()` and passes
  // `deadline.signal` to the execution seam, so staging, the arm's dry run, the
  // dispatch and the evidence write all draw on the SAME allowance. A per-phase
  // `setTimeout(timeoutMs)` would let a "900s" unit run for 45 minutes by
  // re-granting itself a full window at each step, which is the specific way plan
  // §T5 怎么做 4 says a bound must not be implemented.
  //
  // The budget is created BEFORE the identity check so a caller's cancellation is
  // honoured even for a unit that refuses, and disposed in a `finally` at the end
  // of this function.
  const deadline = new DeadlineBudget(timeoutMs, now);
  const repoRoot = opts.repoRoot ?? REPO_ROOT;
  const checkoutDir = resolve(opts.checkoutDir);
  // ---- STEP 0: the APPROVED identity, validated BEFORE anything else. ------
  //
  // Plan §T4 怎么做 6: "worker 必须使用它们构造请求；不能回落到 openai/gpt-4o-mini
  // 或环境里的另一 endpoint。缺必需字段直接拒绝." This runs before the ledger, the
  // state and any child process, so an incomplete approval cannot charge a
  // campaign for a unit it may not legitimately run.
  const identity = requiredIdentityOf(opts);
  if (identity.issue !== null) {
    // A REFUSAL, not a throw: an incomplete approval is an operator-visible
    // verdict about a unit, and a thrown error would bypass the report.
    deadline.dispose();
    return refuseIdentity(opts, identity.issue);
  }
  const providerId = identity.providerId;
  const modelId = identity.modelId;
  const endpointBaseUrl = identity.endpointBaseUrl;
  const maxModelCalls = opts.maxModelCalls ?? 10;
  const allowStub = opts.allowStub ?? true;
  // The number of logical calls this unit reserves UP FRONT, before `begin`.
  //
  // WHY EXACTLY ONE, AND WHY THAT IS NOT THE OLD DEFECT. The execution state's
  // `running` record must carry a REAL reservation id that was taken BEFORE the
  // dispatch (plan §R98: "先持久化 running/reservation"), but how many calls a
  // case will need is unknowable until it has made them. So the unit reserves
  // ONE call, records it on `begin`, and hands it to the budget channel as the
  // pre-taken reservation for the FIRST call; every SUBSEQUENT call reserves its
  // own. The ledger therefore bounds real `generate()` attempts — which is what
  // the old `reservationCount = 1` + `consumed = 1` pair did NOT do, because it
  // charged one call per UNIT no matter how many the arm actually made
  // (measured defect N1).
  const reservationCount = 1;

  // ---- The unit's whole body runs under ONE deadline (T5 怎么做 4). ---------
  //
  // The `finally` releases the shared timer on EVERY exit path — an early refusal,
  // a thrown assertion, or the normal terminal record — so a finished unit leaves
  // nothing armed and no abort listener behind.
  try {
  assertUnitIdentity(opts);

  const build = armBuildIdentity(checkoutDir);
  const unit = { caseId: opts.caseId, suite: opts.suite, arm: opts.arm, repetition: opts.repetition };
  // The execution state keys a unit by `experimentId | caseId | suite | arm |
  // repetition` (see `unitKeyOf`), and the driver binds `experimentId` to the
  // plan digest. The worker must use the IDENTICAL binding or its records would
  // be invisible to the driver's `isDone` and the two stores would disagree
  // about what has run. `unit` itself stays the pure identity a report quotes.
  const unitKey = { experimentId: opts.planDigest, ...unit };

  const record = {
    workerVersion: ARM_WORKER_VERSION,
    execVersion: ARM_EXEC_VERSION,
    unit,
    build,
    status: "failed",
    failureCategory: "infrastructure",
    reservationId: "",
    // Every reservation this unit took, in order. The FIRST is the one recorded
    // on the durable `running` record; the rest were taken by the budget channel
    // as the case made further calls. A report can therefore show that a
    // multi-round case really did take multiple reservations, instead of one
    // unit-level charge standing in for them.
    reservationIds: [],
    resultHash: "",
    durationMs: 0,
    detail: null,
    // Set on every return path: how many logical model calls this unit actually
    // charged. `0` for a unit that never dispatched.
    consumed: 0,
    // The MEASURED per-call accounting, when the unit reached the executor.
    budget: null,
    // The arm's own executed-bytes digest (N7: the previous identity covered
    // only main.js and missed the modules that actually run the case).
    execution: null,
    // The identity the unit ACTUALLY executed under, read back from the arm's
    // own plan/report rather than restated from the caller's argv (T4 / N6).
    executionIdentity: null,
    // The ACTUAL model contexts this case entered, so a test can prove two
    // cases differ rather than inferring it from two result hashes.
    capturedRequests: [],
    // How much a PASS on this unit would prove (T6 怎么做 5): "strong" when the
    // case's own command verifier checks the written bytes, "weak" when the
    // artifact verifier only checks existence/touch, `null` when the seam wrote
    // nothing. Set from the executed result; stays `null` for a refused unit.
    passStrength: null,
    // The arm CLI's REAL per-case report row, persisted by T3 as evidence.
    report: null,
    // The link the terminal record carries to that evidence (T3): its
    // campaign-relative path and the sha256 of the bytes on disk.
    evidence: null,
    // The fingerprint of the bytes this unit ACTUALLY staged, when an approved
    // fingerprint was supplied (A3 3/5). `null` for a standalone call that had no
    // approval to compare against.
    stagedCaseFingerprint: null,
  };

  const finish = (failureCategory, detail) => {
    record.status = statusFor(failureCategory);
    record.failureCategory = failureCategory;
    record.durationMs = Math.max(0, now() - started);
    // ALWAYS redacted, ALWAYS before it can reach a caller's stdout.
    record.detail = detail === null ? null : redact(detail);
    return record;
  };

  // ---- THE APPROVED CASE FINGERPRINT IS REQUIRED ON THE FORMAL PATH (A3 3). --
  //
  // Plan §A3 怎么做 5: "将 approved case fingerprint / inputsDigest 显式传给 worker；
  // 缺少必需摘要直接拒绝. 消除 `repo:unknown` 可以用于正式执行的路径."
  //
  // MEASURED DEFECT F3(b): `inputDigestFor` builds `repo:${opts.inputsDigest ?? "unknown"}`
  // and the formal caller never passed one, so EVERY formal unit's durable input
  // digest was the literal `repo:unknown`. The execution state's drift check then
  // had a constant to compare, and a resume could not tell a changed case from an
  // unchanged one.
  //
  // The requirement is OPT-IN (`requireInputsDigest`) rather than unconditional:
  // `runArmUnit` is also a library seam that standalone harnesses call without a
  // plan, and turning those into refusals would change what they measure. The
  // FORMAL entry — `r97-campaign-driver.mjs --arm-worker` — always sets it, so the
  // `unknown` fallback is unreachable from the formal path.
  const approvedInputsDigest =
    typeof opts.inputsDigest === "string" && opts.inputsDigest.trim() !== "" ? opts.inputsDigest : null;
  if (opts.requireInputsDigest === true && approvedInputsDigest === null) {
    // Before the ledger, before the state, before any child process: an
    // unapproved input digest is a contract defect, and it must not be able to
    // charge a campaign for a unit whose inputs nobody approved.
    return finish(
      "harness",
      `E4-R98: this unit was dispatched with NO approved case fingerprint (inputsDigest absent) — ` +
        `the durable input digest would fall back to "repo:unknown", which can never describe an approved ` +
        `case, so the unit is refused before it can be dispatched`,
    );
  }

  const cliEntry = cliEntryOf(checkoutDir);
  if (!existsSync(cliEntry)) {
    // Acceptance 1: the ARM'S OWN build must execute. There is deliberately no
    // fallback to `repoRoot`'s tree — a fallback here is how a campaign ends up
    // reporting an A/B that ran one harness twice.
    return finish(
      "infrastructure",
      `E4-R98: the arm checkout ${checkoutDir} has no built CLI at ${cliEntry} — refusing to substitute another tree's build`,
    );
  }
  // The budgeted execution seam needs the arm's EXPORTED entry points, not just
  // its runnable main.js: `runBenchmarkCommand` (plan §0.4) and its own
  // `ScriptedModelProvider`. A build that has one but not the others cannot be
  // driven under a budget, and substituting the repo's copies would make the
  // arm's identity a claim rather than a fact.
  if (!armIsBuilt(checkoutDir)) {
    return finish(
      "infrastructure",
      `E4-R98: the arm checkout ${checkoutDir} does not export the offline execution seam (apps/cli/dist/benchmark-command.js + packages/model/dist/index.js) — the budgeted path cannot run this arm's own build`,
    );
  }
  if (build.buildDigest === null || build.sourceSha === null) {
    return finish(
      "infrastructure",
      `E4-R98: the arm build identity is incomplete (sourceSha=${String(build.sourceSha)}, buildDigest=${String(build.buildDigest)}) — a unit may not run under an unestablished build`,
    );
  }

  // ---- THE ARM BUILD BINDING, decided BEFORE any child process exists. -----
  //
  // Plan §R99 怎么验收: "两臂均加载自身构建，结果记录 observed build identity；故意
  // 互换 worker 构建时失败." The approved `sourceSha` for THIS arm comes from the
  // authorization envelope; the OBSERVED sha comes from this checkout's own git
  // HEAD. Swapping the two arms' builds — or running a third revision — makes
  // them differ, and the unit refuses without dispatching anything.
  //
  // `sourceSha` is the right binding and the per-case CLI plan digest is not:
  // the approved execution-plan digest covers the FULL frozen case set, while a
  // unit stages ONE case, and the CLI's digest binds the case set (measured).
  // The sha is per-BUILD, so it is comparable at any granularity.
  const approvedSha = opts.approvedSourceSha ?? null;
  const buildMismatch =
    approvedSha === null
      ? null
      : build.sourceSha !== approvedSha
        ? `this checkout's HEAD is ${build.sourceSha} but the approval binds arm ${opts.arm} to ${approvedSha}`
        : null;
  if (buildMismatch !== null) {
    return finish("harness", `E4-R98: ${buildMismatch} — a unit may only run under the build it was approved for`);
  }

  // ---- THE APPROVED BUILD DIGEST, re-derived and compared (E4-R104 / A4). ---
  //
  // Plan §A4 做什么 1: "批准材料包含实际执行字节的稳定 manifest/digest；正式执行在加载/
  // 调用前重新计算并比较." Plan §A4 怎么验收: "改 core runtime 的被导入模块、入口不变：
  // digest 变化；旧计划在第一调用前被拒绝."
  //
  // WHY THE SOURCE SHA IS NOT ENOUGH. `sourceSha` binds a REVISION, and a revision
  // is a claim about the working tree that git does not verify: a checkout whose
  // `dist` was rebuilt, patched or restored from an archive keeps the same HEAD
  // while the bytes that execute a case change. The digest is the binding that
  // actually moves in that case — measured by the two RED fixtures this change
  // closes (a same-length, same-mtime rewrite of `packages/core/dist/runtime/
  // runtime.js`, and a deletion of it).
  //
  // OPT-IN, exactly like `requireInputsDigest`, and for the same reason: this is
  // the FORMAL caller's declaration. `r97-campaign-driver.mjs --arm-worker` passes
  // the digest its authorization envelope approved; a standalone harness that has
  // no approval to compare against omits the field and keeps its previous
  // behaviour. The requirement is never silently satisfied by the absence of a
  // value.
  //
  // ORDER: after the revision binding (a swapped checkout is the coarser refusal
  // and names both SHAs, which is the more actionable message) and BEFORE
  // `loadEvaluation` and the ledger open below — so a changed build can never
  // charge a campaign, and `existsSync(<ledgerDir>)` stays false on this path.
  const approvedBuildDigest =
    typeof opts.approvedBuildDigest === "string" && opts.approvedBuildDigest.trim() !== ""
      ? opts.approvedBuildDigest
      : null;
  if (approvedBuildDigest !== null && approvedBuildDigest !== build.buildDigest) {
    return finish(
      "harness",
      `E4-R98: the observed build digest ${String(build.buildDigest)} is not the approved build digest ` +
        `${approvedBuildDigest} for arm ${opts.arm} — the bytes that execute a case changed under an ` +
        `unchanged revision, so the old approval no longer covers this build and the unit is refused ` +
        `before anything is loaded, dispatched or charged`,
    );
  }

  const evaluation = await loadEvaluation(repoRoot);

  // ---- STEP 1: the shared budget, BEFORE anything can be dispatched. -------
  //
  // The campaign LIFECYCLE wraps the ledger (plan T1 / finding N2). The worker
  // used to open the raw ledger with `mode: "auto"`, which could CREATE a fresh
  // full allowance whenever the file was absent — including on a restart whose
  // ledger had been deleted. `openR97Campaign` keeps a durable header in the
  // campaign root, so a lost ledger is BUDGET_STATE_MISSING and a relocated copy
  // is CAMPAIGN_ROOT_MISMATCH, while a genuine first run still works.
  let ledger;
  let campaign = null;
  // THE RESOLVED CAMPAIGN GRANT, not the caller's raw option.
  //
  // The ledger is opened with `opts.campaignModelCalls ?? maxModelCalls`, so the
  // file on disk records the RESOLVED allowance. A child that is handed the raw
  // `opts.campaignModelCalls` (often `undefined`) then declares a different grant
  // and is refused with `BUDGET_STATE_MISMATCH: the budget ledger grants 10 calls
  // but this authorization declares undefined — a process must never re-grant
  // itself a different allowance`. Measured on the ordinary happy path. The child
  // must therefore be given the SAME number the parent opened with.
  const resolvedCampaignModelCalls = opts.campaignModelCalls ?? maxModelCalls;
  try {
    campaign = await evaluation.openR97Campaign(opts.ledgerDir, {
      planDigest: opts.planDigest,
      campaignModelCalls: resolvedCampaignModelCalls,
      // See R97LedgerOpenMode. The worker cannot know whether the DRIVER is
      // starting the campaign or resuming it, and guessing "first-run" would let
      // a relocated output directory mint a second allowance for the same
      // authorization — the exact double-spend the mode exists to stop. "auto"
      // now fails closed BY CONSTRUCTION: the header, not a guess, decides
      // whether this is a creation or a recovery.
      mode: "auto",
    });
    ledger = campaign.ledger;
  } catch (err) {
    // Acceptance 5: no ledger, no child. Not one process is started.
    return finish("budget", `E4-R98: the budget ledger could not be opened: ${redact(err)}`);
  }

  let reservation;
  try {
    reservation = await ledger.reserve(opts.arm, reservationCount);
  } catch (err) {
    return finish("budget", `E4-R98: reserving ${reservationCount} call(s) failed: ${redact(err)}`);
  }
  if (reservation.ok !== true || reservation.reservationId === null) {
    return finish("budget", `E4-R98: the budget refused this unit: ${redact(reservation.reason)}`);
  }
  record.reservationId = reservation.reservationId;

  // ---- STEP 2: stage the case and prepare the execution seam. --------------
  const scratch = join(resolve(opts.outDir), ".r98-work", `${opts.arm}-${opts.caseId.replace(/[\\/]/g, "-")}`);
  const stagedCasesDir = join(scratch, "cases");
  const runOutDir = join(scratch, "run");

  let verdict;
  let consumed = 0;
  // Per-call, never module-level: two units (or two arms) may run concurrently
  // in one process, and a shared `attemptId` would let one unit's terminal
  // write land on another unit's record.
  let execState = null;
  let attemptId = null;
  // ---- THE LIVE BUDGET-CHANNEL STATE (A1 / F1). -----------------------------
  //
  // MEASURED DEFECT F1 (plan §0.2): the worker inferred "nothing was dispatched"
  // from `budgetStats === null`, but `budgetStats` was only assigned on the
  // executor's SUCCESSFUL return. An exception after a real dispatch therefore
  // left it `null`, and `ledger.abandon()` refunded a call that really entered
  // the provider.
  //
  // `budgetState` is the fix: a holder the worker creates BEFORE the arm call and
  // the executor fills in with the channel's LIVE `stats` object as soon as the
  // channel exists. The object keeps being mutated as the call proceeds, so it is
  // readable even when the executor throws. `stats.dispatches` is the explicit
  // per-reservation state (not-entered / entered / completed / settled) that the
  // settlement below is decided on — never on a missing return value.
  const budgetState = { stats: null };
  // ---- THE EXECUTION BOUNDARY'S STOP (E4-R106 / A6). ------------------------
  //
  // Set when the case was ended by the terminable boundary rather than by finishing.
  // It carries the CAUSE (`reason` + which bound produced it) and whether a call had
  // been ADMITTED, because plan §A6 怎么验收 6 splits the two budget outcomes on
  // exactly that fact: never dispatched ⇒ release the reservation; dispatched then
  // killed ⇒ do NOT refund. Kept OUT of `budgetState` so it cannot be confused with
  // the channel's own accounting.
  let stoppedByBoundary = null;
  try {
    await mkdir(runOutDir, { recursive: true });
    // WHICH case source was chosen is recorded: a run whose case silently came
    // from somewhere other than intended is exactly the class of defect this
    // whole round exists to remove, so it is evidence rather than an internal.
    const staged = await stageCase({
      repoRoot,
      checkoutDir,
      caseId: opts.caseId,
      stagedCasesDir,
      // ---- A3 3/5: THE APPROVED FINGERPRINT, AND THE MODULE THAT MEASURES IT.
      // The worker re-fingerprints the bytes it ACTUALLY staged and refuses a
      // mismatch BEFORE the first `generate()`.
      evaluation,
      approvedCaseFingerprint: approvedInputsDigest,
      beforeStageCopy: opts.beforeStageCopy,
    });
    record.caseSource = staged.caseSource;
    record.stagedCaseFingerprint = staged.stagedCaseFingerprint;

    // ---- STEP 3: `running` becomes durable BEFORE the request may leave. ---
    //
    // The reservation taken above is handed to the budget channel as the
    // PRE-TAKEN reservation for this unit's first call, so the durable record's
    // `reservationId` names a real ledger entry that provably precedes the
    // dispatch, while every FURTHER call the case makes reserves its own.
    {
      const inputDigest = inputDigestFor({
        planDigest: opts.planDigest,
        inputsDigest: approvedInputsDigest,
        ...unit,
        build,
      });
      execState = await evaluation.openR97ExecutionState(opts.executionStateDir, {
        experimentId: opts.planDigest,
        planDigest: opts.planDigest,
      });
      if (await execState.isDone(unitKey)) {
        // The driver decided to dispatch, so a terminal record already present
        // means the durable state is ahead of the caller. Re-running would
        // double-charge the campaign for work it already has.
        verdict = { category: "harness", detail: `E4-R98: unit ${unitKeyText(unitKey)} already has a terminal record — refusing to re-execute it` };
      } else if (await execState.mustNotRetry(unitKey)) {
        verdict = {
          category: "harness",
          detail: `E4-R98: unit ${unitKeyText(unitKey)} is outcome_unknown — it requires an explicit reconciliation decision before it may run again`,
        };
      } else {
        // `now` is a FUNCTION on the state handle and a NUMBER on `begin`;
        // passing the function made every `startedAt` the literal 0 (finding N3
        // item 9: "修复 worker 传 `now` 函数给 begin 的 `now?: number` 字段的问题").
        attemptId = await execState.begin(unitKey, { reservationId: reservation.reservationId, inputDigest, now: now() });

        // ---- STEP 4: the REAL execution, inside the ARM'S OWN build, under the
        // shared campaign budget. -------------------------------------------
        //
        // Plan §0.4 / T1 怎么做 3: drive each arm's EXPORTED `runBenchmarkCommand`
        // with an injected offline provider, so the real request, tool loop and
        // TaskVerifier run while every `generate()` reserves from the ledger
        // BEFORE it leaves. The child-CLI route this replaces could not enforce a
        // per-call ceiling at all: the child resolved its own transport, so the
        // parent could only charge the unit (measured defect N1).
        const bareCase = opts.caseId.split("/").pop() ?? opts.caseId;
        const caseDef = await readCaseDef(join(stagedCasesDir, bareCase), opts.caseId);
        // ---- E4-R106 (A6 / F6): THE EXECUTION RUNS BEHIND A REAL BOUNDARY ----
        //
        // MEASURED DEFECT F6 (plan §A6): the arm used to run HERE, in this process,
        // as `await runArmCaseInProcess(...)`. `boundedStop` could end a PROCESS, but
        // an `await` is not a process — so a dry run or a dispatch that never
        // returned kept the unit, its reservation and the campaign alive forever, and
        // both the unit deadline and an operator's cancellation were merely
        // outlived.
        //
        // The case now runs in a CHILD PROCESS (`r97-arm-child-runner.mjs`) under
        // `boundedStop`, which supplies the whole stop sequence the campaign already
        // relies on: polite signal → bounded grace → forced process-TREE kill → await
        // `close` → settle exactly once. That is the ONLY boundary that can end code
        // ignoring `AbortSignal`, and it ends its descendants with it (plan §A6
        // 怎么做 4-6).
        const boundary = await runArmCaseAtBoundary({
          evaluation,
          repoRoot,
          arm: { label: opts.arm, checkoutDir },
          caseDef,
          scriptShape: opts.scriptShape ?? "write-then-stop",
          stagedCasesDir,
          outDir: runOutDir,
          suite: opts.suite,
          providerId,
          modelId,
          endpointBaseUrl,
          maxModelCalls,
          // The SAME ledger directory the parent already opened: the child shares
          // the campaign's ledger rather than opening its own, so a unit that
          // dispatched a real call is still charged exactly once (plan §A6 怎么做 4).
          ledgerDir: opts.ledgerDir,
          ledgerFilename: evaluation.R97_LEDGER_FILENAME,
          planDigest: opts.planDigest,
          campaignModelCalls: resolvedCampaignModelCalls,
          firstReservationId: reservation.reservationId,
          // THE UNIT'S ONE DEADLINE, now enforced where it can actually bite: the
          // child's whole process tree, from staging through the dry run, the
          // dispatch and the cleanup (plan §A6 怎么做 2).
          deadline,
          // The caller's cancellation handle for THIS unit — the campaign's stop and
          // an operator's SIGINT reach the running case through this, instead of
          // only refusing the NEXT unit (plan §A6 怎么做 1).
          signal: opts.signal,
          // The LIVE channel state, published by the executor BEFORE the arm can
          // run (see the `budgetState` declaration above).
          budgetState,
        });
        const executed = boundary.executed;
        // A STOP IS NOT AN EXECUTION RESULT, and it must not be read as one.
        //
        // Plan §A6 怎么做 9: "统一 timeout/cancelled/output_limit 的原因与证据. 异常
        // 发生在 deadline 之后也不能统统落入 infrastructure catch." The boundary names
        // the cause, so the unit's verdict is derived from THAT rather than from the
        // missing report a killed child leaves behind — which is what used to make a
        // deadline look like an `infrastructure` fault.
        if (boundary.stop !== null) {
          record.execution = null;
          record.capturedRequests = [];
          // THE RESERVATION'S FATE IS DECIDED BY WHAT REALLY HAPPENED, not by the
          // fact that the process died (plan §A6 怎么验收 6): a call admitted before
          // the stop is spent; a stop that provably preceded any dispatch releases
          // it. `boundary.dispatched` is measured from the ledger's own on-disk
          // entries, so this is not a self-report.
          stoppedByBoundary = { ...boundary.stop, dispatched: boundary.dispatched };
          // The child may have been killed AFTER it admitted a call, in which case
          // the LIVE channel stats it published on its way out are the only record of
          // that spend. Re-publishing them into `budgetState` is what lets the
          // existing A1 settlement below see the truth; without it, a killed child
          // would look like a channel that never existed and the reservation would be
          // refunded — the exact silent re-grant A1 removed.
          if (boundary.stats !== null && budgetState.stats === null) budgetState.stats = boundary.stats;
          verdict = stoppedVerdictOf(stoppedByBoundary);
        } else {
        // THE CHILD'S CHANNEL STATS ARE THIS PROCESS'S ONLY RECORD OF THE SPEND.
        //
        // The case ran in the CHILD, so the parent never held the channel and
        // `budgetState.stats` is `null` on the ordinary success path. The A1
        // settlement below reads that object to decide whether the pre-taken
        // reservation was ever adopted; without the child's stats it concludes
        // "Case 1: provably never dispatched" and tries to `abandon` a reservation
        // the child already COMMITTED — which throws and folds a `budget` verdict
        // over a real pass. Measured: `verification_passed=true, consumed=2` with
        // `failureCategory=budget`. Publishing the child's own accounting is what
        // makes the parent's settlement read the truth.
        if (boundary.stats !== null && budgetState.stats === null) budgetState.stats = boundary.stats;
        record.execution = executed.execution;
        record.capturedRequests = executed.capturedRequests;
        // WHAT A PASS HERE PROVES (T6 怎么做 5): "strong" when the case's own
        // command verifier checks the written bytes, "weak" when the artifact
        // verifier only checks existence/touch, `null` when this seam wrote
        // nothing. Carried on the record so the campaign summary can report the
        // two apart instead of presenting a weak pass as a solved case.
        record.passStrength = executed.passStrength ?? null;
        // ---- THE IDENTITY THE REQUEST ACTUALLY CARRIED ------------------
        //
        // Plan §T4 怎么做 6: the worker must USE the approved identity, not fall
        // back to a default. `executed.executionIdentity` is measured by the arm's
        // own CLI (its dry-run plan) and by the core runtime (the ModelRef it
        // handed to `createClient`), so a disagreement with the approval is a
        // REAL drift rather than a restatement. A drifted unit is refused with a
        // `harness` verdict: reporting a pass under an identity nobody approved
        // would make the campaign's evidence describe a run that never happened.
        record.executionIdentity = executed.executionIdentity;
        // ---- THE IDENTITY REFUSAL IS FOLDED IN, NEVER OVERWRITTEN (F5). ----
        //
        // Plan §A5 怎么做 1: "身份、预算、执行停止等拒绝不能被成功报告覆盖."
        //
        // MEASURED DEFECT F5: this branch set the `harness` verdict and then the
        // report classification BELOW reassigned `verdict` and
        // `record.verifierPassed` unconditionally, so a report claiming
        // `verification_passed=true` reported the unit as a completed pass under an
        // identity the plan never approved.
        //
        // The fact is now FOLDED through the priority table, so `harness` keeps its
        // rank no matter what the report later says, and the report's own claim is
        // retained as a diagnostic instead of replacing it.
        //
        // `executed.identityRefusal` is the structured FIRST blocking identity fact
        // (A5 怎么做 3/4): a failed or unparseable dry run, a missing model in the
        // plan, or a model ref the boundary guard refused before `inner.generate`
        // was entered. `drift` remains the diagnostic list, so a refusal reached
        // only AFTER execution is still refused here (A5 怎么做 5).
        const identityRefusal = typeof executed.identityRefusal === "string" && executed.identityRefusal !== "" ? executed.identityRefusal : null;
        const drift = Array.isArray(executed.executionIdentity?.drift) ? executed.executionIdentity.drift : [];
        if (identityRefusal !== null || drift.length > 0) {
          // The structured refusal is the FIRST fact, so it leads the sentence. The
          // remaining drift is appended as the ADDITIONAL measurements it is —
          // deduplicated against the refusal, because the executor records the
          // boundary refusal in `drift` too and repeating one sentence twice would
          // make the verdict read as two separate findings.
          const rest = drift.filter((d) => d !== identityRefusal);
          const body = identityRefusal ?? rest.join("; ");
          verdict = foldR97Verdict(verdict, {
            category: "harness",
            detail: `E4-R98: the arm executed under an identity the plan did not approve — ${body}${
              identityRefusal !== null && rest.length > 0 ? ` (also measured: ${rest.join("; ")})` : ""
            }`,
          });
        }
        // The channel's own count of admitted calls is the MEASURED spend for
        // this unit. It is read from the channel rather than from the arm's
        // self-report (`model_calls`), which is exactly the field plan §T1
        // 怎么做 1 says must not be the basis of the accounting.
        consumed = executed.budget.logicalCalls;
        record.reservationIds = [...executed.budget.reservationIds];

        // ---- THE DEADLINE STOP IS ITS OWN VERDICT (T5 怎么做 7). -----------
        //
        // Plan §T5 怎么做 7: "记录 timeout/cancel/output_limit，而非伪装为
        // case_failed 或 verified pass." A unit stopped by the shared deadline is
        // reported as `timeout`, NOT as a case that failed and NOT as a pass: the
        // arm never got to produce a verdict, so claiming one would invent a fact.
        //
        // This is checked BEFORE the report, because a unit stopped mid-call may
        // still have written a PARTIAL report — and classifying that partial report
        // would let an interrupted run be scored as if it had finished.
        //
        // It is FOLDED rather than assigned (A5 怎么做 2): an identity refusal
        // already established above outranks it, and the stop is retained as a
        // diagnostic. Plan §A5 怎么验收 7 requires exactly that stability when
        // "身份失败与 timeout 同时出现".
        if (typeof executed.deadlineStop === "string" && executed.deadlineStop !== "") {
          verdict = foldR97Verdict(verdict, { category: "timeout", detail: `E4-R98: ${executed.deadlineStop}` });
        } else if (executed.report === null) {
          // A run that produced no report measured nothing, whatever its exit
          // code. Never a pass.
          verdict = foldR97Verdict(verdict, {
            category: "infrastructure",
            detail: `E4-R98: the arm's benchmark run wrote no report at ${executed.reportPath} (exit ${String(executed.exitCode)}): ${firstUsefulLine((executed.lines ?? []).join("\n")) ?? "no output"}`,
          });
        } else {
          const classified = classifyReport(executed.report, opts.caseId);
          // ---- THE REPORT IS EVIDENCE, NOT THE AUTHORITY (A5 怎么做 6). -----
          //
          // "确保保存的 report 是诊断证据，不是覆盖身份失败的权威." The row is
          // persisted FIRST and the verdict is FOLDED, so a report that claims
          // `verification_passed=true` cannot outrank a refusal already
          // established. `record.verifierPassed` is derived from the FINAL verdict
          // further below rather than assigned here, which is what makes the
          // record's `status`, its `failureCategory`, its `verifierPassed` and its
          // evidence envelope describe ONE conclusion (A5 怎么做 3).
          record.report = reportRowFor(executed.report, opts.caseId);
          verdict = foldR97Verdict(verdict, { category: classified.category, detail: classified.detail });
        }
        }
      }
    }
  } catch (err) {
    // A refusal about the INPUTS is a HARNESS verdict, not an infrastructure one
    // (A3 怎么做 5): "the bytes staged for this case are not the bytes the approval
    // fingerprints" is a fact about the approval and the checkout, and classifying
    // it as infrastructure would send an operator to inspect a host that is fine.
    const category = err !== null && typeof err === "object" && err.code === "CASE_INPUT_FINGERPRINT_MISMATCH"
      ? "harness"
      : "infrastructure";
    // FOLDED, never assigned (A5 怎么做 2): an identity refusal established earlier
    // in the unit must survive a later infrastructure fault, and both facts must
    // remain readable in the verdict.
    verdict = foldR97Verdict(verdict, { category, detail: withArmExecTag(redact(err)) });
  } finally {
    // Only the STAGED CASE is a working file, and only it is removed. The arm's
    // own report is EVIDENCE and is preserved on the record (finding N5: the
    // previous version deleted the only copy of the report here).
    await rm(stagedCasesDir, { recursive: true, force: true }).catch((cleanupErr) => {
      // P14-6: a best-effort cleanup failure must be OBSERVABLE, never swallowed.
      process.stderr.write(
        `[degraded] r97-arm-worker.staging-cleanup: ${cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr)}\n`,
      );
    });
  }

  // ---- STEP 5: settle the budget, then write the terminal record. ----------
  //
  // THE PRE-TAKEN RESERVATION IS OWNED BY THE CHANNEL once the channel has
  // ADOPTED it as the first call. Whether it did is read from the channel's own
  // explicit dispatch record — a MEASURED fact that survives an exception — not
  // inferred from whether a stats object came back (finding F1).
  //
  // Three cases, and only the first is legal for `abandon`:
  //
  //   1. the channel never took this reservation -> nothing entered the provider,
  //      so the unused allowance is RETURNED;
  //   2. the channel took it and settled it     -> the channel owns it, done;
  //   3. the channel took it and the settlement write FAILED -> the allowance is
  //      NOT returned (it may already have been billed) and the unit is refused
  //      rather than reported as a success; the entry stays outstanding so
  //      `recover()` or a human decision can resolve it.
  const liveStats = budgetState.stats;
  if (liveStats !== null) {
    // The MEASURED accounting, available even when the executor threw: the
    // channel's live object was created before the arm call and mutated as the
    // call proceeded.
    record.budget = { ...liveStats };
    record.reservationIds = [...(liveStats.reservationIds ?? [])];
    consumed = Number(liveStats.logicalCalls ?? 0);
  }
  const unitDispatch =
    liveStats === null
      ? null
      : ((liveStats.dispatches ?? []).find((d) => d !== null && d !== undefined && d.reservationId === reservation.reservationId) ?? null);

  // A STOPPED CHILD'S DISPATCH IS MEASURED FROM THE LEDGER, NOT FROM MEMORY.
  //
  // When the boundary KILLED the child, this process never held the channel, so
  // `liveStats` is `null` and `unitDispatch` is `null` — which used to mean "Case
  // 1: provably never dispatched", and therefore "abandon the unused
  // reservation". That is wrong for a stopped child that DID admit a call: the
  // child had already settled the entry, so `abandon` THREW ("already unknown")
  // and the throw folded a `budget` verdict OVER the correct stop cause.
  // Measured: a hung DISPATCH reported `budget` instead of `timeout`.
  //
  // `boundary.dispatched` is read from the ledger's own on-disk entries, so it is
  // the measurement, not a self-report. A call that may already have been billed
  // is never refunded (plan §A6 怎么验收 6), and settlement bookkeeping must not
  // manufacture a new fault over the STOP's named cause (plan §A5 怎么做 2).
  const boundarySaysDispatched = stoppedByBoundary !== null && stoppedByBoundary.dispatched === true;

  if (boundarySaysDispatched && unitDispatch === null) {
    // The allowance stays spent and the STOP's verdict stands unchanged. The
    // entry remains outstanding for `recover()` or a human decision, exactly as
    // Case 3 treats a settlement that could not be written.
  } else if (unitDispatch === null) {
    // Case 1: provably never dispatched through the channel.
    try {
      await ledger.abandon(reservation.reservationId);
    } catch (err) {
      verdict = foldR97Verdict(verdict, {
        category: "budget",
        detail: `E4-R98: the unused reservation could not be returned: ${redact(err)}`,
      });
    }
  } else if (unitDispatch.settled !== true) {
    if (unitDispatch.entered === true) {
      // Case 3: a REAL call whose terminal write failed. Refuse to report a
      // success, and keep the allowance — refunding it would be exactly the
      // silent re-grant this whole channel exists to prevent.
      //
      // FOLDED, not assigned (A5 怎么做 2): `budget` outranks a report's claim of
      // success, but it does not outrank an identity refusal, which must survive.
      verdict = foldR97Verdict(verdict, {
        category: "budget",
        detail: `E4-R98: reservation ${reservation.reservationId} entered the provider but could not be settled; it is kept outstanding for reconciliation (${redact(
          liveStats === null ? null : liveStats.lastSettlementError,
        )})`,
      });
    } else {
      // Never entered, so returning it is still correct; a failed return is
      // reported rather than hidden.
      try {
        await ledger.abandon(reservation.reservationId);
      } catch (err) {
        verdict = foldR97Verdict(verdict, {
          category: "budget",
          detail: `E4-R98: the unused reservation could not be returned: ${redact(err)}`,
        });
      }
    }
  }

  // ---- STEP 5a: the EVIDENCE, written and hashed BEFORE the record names it.
  //
  // ORDER IS THE CONTRACT: the file must exist and be hashed before the terminal
  // record points at it, so a record whose evidence is absent is a NAMED loss
  // (`EVIDENCE_MISSING`) rather than a record that was never linked. The reverse
  // order would make "the campaign died between the two writes" indistinguishable
  // from "the evidence was deleted", and only one of those is tampering.
  //
  // The evidence is written for EVERY terminal unit, including a refused one: a
  // unit that never dispatched has no report, and that absence is itself the fact
  // its verdict rests on.
  let resultHash = resultHashFor({ unit, build, verdict });
  let evidenceLink = null;
  if (attemptId !== null) {
    try {
      const envelope = evaluation.buildUnitEvidence({
        attemptId,
        unit,
        build: { sourceSha: build.sourceSha, buildDigest: build.buildDigest },
        // The SAME redacted body the terminal record carries (`terminalDetailFor`),
        // so the record and its evidence cannot disagree. See that function's note.
        verdict: { category: verdict.category ?? null, detail: redact(verdict.detail) },
        report: record.report ?? null,
      });
      const written = await evaluation.writeUnitEvidence(opts.ledgerDir, envelope);
      evidenceLink = { path: written.relPath, sha256: written.sha256 };
      // THE RECORD'S RESULT **IS** THE EVIDENCE'S RESULT. They are the same
      // digest over the same facts (unit, build, verdict, report row), and
      // having ONE value is what lets a validator recompute it from the envelope
      // and compare it to the record. Two independently-derived digests over
      // overlapping facts would be equal for honest runs and different for
      // nothing useful — and the validator could never check either.
      resultHash = envelope.resultHash;
    } catch (err) {
      // The evidence could not be persisted, so the verdict cannot be
      // substantiated. The unit is re-classified rather than silently recording
      // an unverifiable pass, and the result hash is recomputed over the verdict
      // that is actually being recorded.
      verdict = foldR97Verdict(verdict, {
        category: "harness",
        detail: `E4-R98: the unit's evidence could not be persisted: ${redact(err)}`,
      });
      resultHash = resultHashFor({ unit, build, verdict });
    }
  }

  if (attemptId !== null && execState !== null) {
    const terminalDetail = terminalDetailFor(verdict);
    try {
      if (statusFor(verdict.category) === "completed") {
        await execState.complete(attemptId, {
          resultHash,
          detail: terminalDetail,
          now: now(),
          ...(evidenceLink === null ? {} : { evidence: evidenceLink }),
        });
      } else {
        await execState.fail(attemptId, {
          resultHash,
          detail: terminalDetail,
          now: now(),
          ...(evidenceLink === null ? {} : { evidence: evidenceLink }),
        });
      }
    } catch (err) {
      verdict = foldR97Verdict(verdict, {
        category: "harness",
        detail: `E4-R98: the terminal record could not be written: ${redact(err)}`,
      });
    }
  }

  record.resultHash = resultHash;
  // The link the terminal record carries, exposed so the driver can verify the
  // chain from its own side rather than trusting that the write happened.
  record.evidence = evidenceLink;
  // ---- THE ONE PLACE `verifierPassed` IS DECIDED (E4-R105 / A5 怎么做 2). ----
  //
  // MEASURED DEFECT F5: `verifierPassed` used to be assigned in FOUR independent
  // places — the drift branch, the timeout branch, the report branch and the budget
  // branch — each of them an unconditional write. The LAST one to run won, so the
  // report classification silently overwrote an identity refusal. Deriving it ONCE,
  // from the FINAL verdict, is what makes the record's `status`, its
  // `failureCategory`, its `verifierPassed` and its evidence envelope describe the
  // SAME conclusion (plan §A5 怎么做 3), and it is why no later fact can flip a
  // refusal into a pass.
  //
  // A verified pass is exactly "the verdict established no failure category": the
  // `null` category means the arm's own report carried positive verification
  // evidence (see `classifyReport`), and every other category — `case_failed`
  // included — is not a pass.
  record.verifierPassed = verdict.category === null;
  // The MEASURED logical calls this unit charged to the campaign. Exposed so a
  // caller (the driver, or a report) can total real spend instead of inferring
  // it from the number of units: a refused unit charges 0 and a dispatched one
  // charges 1, and those are different facts.
  record.consumed = consumed;
  return finish(verdict.category, verdict.detail);
  } finally {
    // ONE release point for the shared deadline. On every path — refusal, throw
    // or terminal record — the timer is cleared, so a completed unit cannot leave
    // a pending abort that fires during a LATER unit and cancels it.
    deadline.dispose();
  }
}

/** Digest of the unit's stored result. It commits to the verdict, NOT to a
 *  fabricated success: a resume re-reads it and stops when it changed. */
function resultHashFor(opts) {
  const material = [
    "e4-r98-unit-result-v1",
    `${opts.unit.caseId}|${opts.unit.suite}|${opts.unit.arm}|${opts.unit.repetition}`,
    `build:${opts.build.sourceSha}|${opts.build.buildDigest}`,
    `verdict:${opts.verdict.category ?? "passed"}`,
    `detail:${opts.verdict.detail}`,
  ].join("\n");
  return createHash("sha256").update(material).digest("hex");
}

/**
 * The arm's OWN report row for one case, kept as durable evidence (finding N5).
 *
 * Plan T3 做什么 1: "持久保存本次单例报告、必要事件和结果身份，不在 finally 中删除
 * 唯一证据." The previous worker deleted the entire scratch tree — including the
 * only copy of the arm CLI's report — in `finally`, so nothing on disk could
 * substantiate a verdict after the fact and an independent validator had no
 * artifact to re-derive from.
 *
 * This extracts the ONE row that belongs to this case, redacted and bounded, so
 * the campaign keeps the evidence that produced the verdict without storing a
 * whole report per unit. `reportHash` is the sha256 of the ROW as stored, which
 * is what a resume re-computes to detect tampering (T3 怎么验收: "修改/删除任意已
 * 关联原始报告或 resultHash，恢复及独立 validator 都非零退出").
 *
 * The row is found by EXACT `task_id` match — never `results[0]` (finding N5:
 * "classifyReport 找不到 task_id 时使用 results[0]").
 */
export function reportRowFor(report, caseId) {
  // The SAME strict lookup `classifyReport` uses, so the row that produced the
  // verdict and the row that is STORED as its evidence can never diverge. A
  // fallback to `results[0]` here would persist another case's row as this
  // case's evidence — the stored proof would not be the proof that was used.
  const found = findReportRow(report, caseId);
  if (found.row === null) return null;
  const entry = found.row;
  // Only the fields that describe the MEASUREMENT are kept: no prompts, no
  // headers, no paths outside the run. A report row carries no credential, but
  // it is bounded anyway so one row cannot flood the campaign journal.
  const row = {
    task_id: entry.task_id ?? null,
    suite: entry.suite ?? null,
    judge_version: entry.judge_version ?? null,
    success: entry.success === true,
    actual_status: entry.actual_status ?? null,
    verification_passed: entry.verification_passed === true,
    verification_failures: entry.verification_failures ?? null,
    model_calls: entry.model_calls ?? null,
    tool_calls: entry.tool_calls ?? null,
    retries: entry.retries ?? null,
    termination_reason: entry.termination_reason ?? null,
    failure_category: entry.failure_category ?? null,
    duration_ms: entry.duration_ms ?? null,
    // The expected-outcome contract is part of the EVIDENCE: it is what makes a
    // `verification_passed=false` success legitimate, so a validator re-deriving
    // the verdict needs it. Omitting it would make the stored row unable to
    // reproduce the classification it is supposed to substantiate.
    expected_rejection: entry.expected_rejection === true,
    expected_failure: entry.expected_failure === true,
  };
  // The hash covers EVERY stored field (finding N5: "resultHash 仅摘要化描述文本").
  // The key order is fixed by the literal above, so the digest is stable across
  // runs while still changing whenever any stored value does.
  return { ...row, reportHash: createHash("sha256").update(JSON.stringify(row)).digest("hex") };
}

function unitKeyText(unit) {
  return `${unit.caseId}|${unit.suite}|${unit.arm}|${unit.repetition}`;
}

/** The plan digest a CLI emits. `--dry-run` prints the canonical plan with its
 *  digest; both the nested and the top-level shape are accepted because the
 *  entry point has changed shape before and a parser that only knows one is a
 *  silent "no digest" waiting to happen. */
export function parsePlanDigest(stdout) {
  let parsed;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return null;
  }
  const candidates = [parsed?.planDigest, parsed?.digest, parsed?.plan?.planDigest];
  for (const value of candidates) {
    if (typeof value === "string" && /^[0-9a-f]{64}$/.test(value)) return value;
  }
  return null;
}

/** The first line of a child's output that carries information, with the
 *  harness's own informational stderr prefix skipped. */
function firstUsefulLine(text) {
  if (typeof text !== "string") return null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === "") continue;
    if (line.startsWith("[harness]") || line.startsWith("[degraded]")) continue;
    return line;
  }
  return null;
}

async function readJsonOrNull(path) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    return null;
  }
}

/**
 * CLI entry. Prints ONE JSON object on stdout.
 *
 * Missing required flags are a USAGE error (exit 2 with the usage line on
 * stderr), never a guess: a worker that invented a ledger directory or an
 * execution-state directory would spend an approval against state nobody
 * approved. Default with no flags is a refusal, matching the driver.
 */
export async function main(argv) {
  const flag = (name) => {
    const i = argv.indexOf(name);
    return i >= 0 && i + 1 < argv.length ? argv[i + 1] : undefined;
  };

  const checkout = flag("--checkout");
  const caseId = flag("--case");
  const suite = flag("--suite");
  const arm = flag("--arm");
  const planDigest = flag("--plan-digest");
  const state = flag("--state");
  const ledgerDir = flag("--ledger");
  const scriptShape = flag("--script-shape");
  // ---- THE APPROVED IDENTITY (T4 怎么做 6). --------------------------------
  //
  // These are REQUIRED, not optional: `runArmUnit` refuses a unit without them
  // rather than defaulting to `openai`/`gpt-4o-mini` (measured defect N6), and the
  // CLI must not offer a way around that by omitting the flags. `--endpoint` is
  // optional in the sense that its ABSENCE is itself an approval (the provider's
  // built-in endpoint); an empty string is not.
  const providerId = flag("--provider");
  const modelId = flag("--model");
  const endpointBaseUrl = flag("--endpoint");
  const approvedSourceSha = flag("--source-sha");

  if (
    checkout === undefined ||
    caseId === undefined ||
    suite === undefined ||
    arm === undefined ||
    planDigest === undefined ||
    state === undefined ||
    ledgerDir === undefined ||
    providerId === undefined ||
    modelId === undefined
  ) {
    process.stderr.write(
      "usage: node scripts/e4/r97-arm-worker.mjs --checkout <arm dir> --case <caseId> --suite <suite> --arm <arm>\n" +
        "                                                --provider <id> --model <id> [--endpoint <url>]\n" +
        "                                                --plan-digest <hex> --state <execution state dir> --ledger <ledger dir>\n" +
        "                                                [--source-sha <40-hex>] [--script-shape write-then-stop|text-only] [--json]\n" +
        "\n" +
        "The approved --provider/--model are REQUIRED: a worker that defaulted them would execute a\n" +
        "different identity than the plan approved (plan T4 怎么做 6).\n",
    );
    return EXIT_CONFIG;
  }

  let record;
  try {
    record = await runArmUnit({
      checkoutDir: checkout,
      repoRoot: REPO_ROOT,
      caseId,
      suite,
      arm,
      repetition: 1,
      planDigest,
      // The approved identity, passed through unchanged (T4 / N6).
      providerId,
      modelId,
      ...(endpointBaseUrl === undefined ? {} : { endpointBaseUrl }),
      ...(approvedSourceSha === undefined ? {} : { approvedSourceSha }),
      executionStateDir: state,
      ledgerDir,
      inputsDigest: null,
      // WHICH scripted response this unit uses. It is a caller decision because
      // the campaign drives two cases as a real PASS and a real NEGATIVE
      // control (plan T4 怎么做 4 / T6 验收矩阵 "写文件成功 / 只说完成但未写文件").
      scriptShape: scriptShape ?? "write-then-stop",
      outDir: join(resolve(state), "..", "r98-worker-units"),
    });
  } catch (err) {
    process.stderr.write(`E4-R98: ${redact(err)}\n`);
    return EXIT_REFUSED;
  }

  process.stdout.write(`${JSON.stringify(record)}\n`);
  return record.status === "completed" ? EXIT_OK : EXIT_REFUSED;
}

// Run only when invoked directly, so the module stays importable by tests.
const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  process.exitCode = await main(process.argv.slice(2));
}
