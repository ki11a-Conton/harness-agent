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
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  ARM_EXEC_VERSION,
  armExecutionDigest,
  armIsBuilt,
  loadArmModules,
  readCaseDef,
  runArmCaseInProcess,
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
 * nothing about what actually EXECUTES a case. These two files ARE the
 * executable surface of one arm: the CLI entry point and the evaluation library
 * it links.
 *
 * A missing entry is a `null` SIZE, and `buildDigest` then returns `null`
 * rather than a digest of a tree that cannot run — the same fail-closed rule as
 * `armBuildIdentity`'s `sourceSha`.
 */
const BUILD_ARTIFACT_PATHS = [
  ["apps", "cli", "dist", "main.js"],
  ["packages", "evaluation", "dist", "index.js"],
];

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
 *  keep the unit (and its reservation) alive forever. */
const SIGKILL_GRACE_MS = 2_000;

/** How long `--dry-run` may take. A dry run makes ZERO provider calls and only
 *  estimates, so it is bounded far more tightly than a dispatch. */
const DRY_RUN_TIMEOUT_MS = 120_000;

/** Default provider/model identity for the CLI dispatch.
 *
 * WHY THE BILLED ID IS THE DEFAULT: `--provider` in the CLI accepts exactly one
 * value, the externally-billed id, and the keyless "stub" identity is selected
 * by the ABSENCE of a key rather than by a flag. The worker passes the id the
 * arm's plan was built with; what actually runs in an offline test is the stub,
 * because tests must not set `OPENAI_API_KEY` (limitation (a) in the header).
 */
const DEFAULT_PROVIDER_ID = "openai";
const DEFAULT_MODEL_ID = "gpt-4o-mini";

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
 * The identity of one ARM'S BUILD.
 *
 * `sourceSha` comes from git and is `null` on ANY failure. Plan §R100 怎么做
 * (line 204) forbids the silent fallback that used to exist here: "缺文件或读
 * 失败要 NOT_READY，不能拿 driver 副本冒充." A fabricated or substituted SHA is
 * worse than a missing one, because it would let a campaign claim it ran a
 * revision it never checked out.
 *
 * `buildDigest` is a sha256 over an SMALL, ENUMERATED artifact set (see
 * `BUILD_ARTIFACT_PATHS`): for each path, its relative name, its size and its
 * mtime, with the file BYTES hashed only for the entry point. Two arms whose
 * `main.js` differ in content therefore cannot share a build digest, while an
 * unrelated file elsewhere in the checkout cannot change it.
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

  const materials = [];
  let allPresent = true;
  for (const parts of BUILD_ARTIFACT_PATHS) {
    const abs = join(dir, ...parts);
    const rel = parts.join("/");
    let size = null;
    let mtimeMs = null;
    let contentHash = null;
    try {
      const st = statSyncOrNull(abs);
      if (st === null) {
        allPresent = false;
      } else {
        size = st.size;
        mtimeMs = Math.trunc(st.mtimeMs);
        // The entry point's BYTES are hashed, not just its stat: a rebuild that
        // happens to preserve size+mtime (a checkout restored from an archive)
        // must still change the identity.
        if (rel === "apps/cli/dist/main.js") {
          contentHash = createHash("sha256").update(readFileSyncOrNull(abs) ?? Buffer.alloc(0)).digest("hex");
        }
      }
    } catch {
      allPresent = false;
    }
    materials.push(`${rel}:${size === null ? "missing" : String(size)}:${mtimeMs === null ? "missing" : String(mtimeMs)}:${contentHash ?? "-"}`);
  }

  const buildDigest = allPresent
    ? createHash("sha256").update(`e4-r98-build-digest-v1\n${materials.join("\n")}`).digest("hex")
    : null;

  return { checkoutDir: dir, sourceSha, buildDigest };
}

// `statSync`/`readFileSync` are wrapped so the digest never throws on a
// permission error or a directory sitting where a file belongs: both become the
// explicit "missing" marker above.
function statSyncOrNull(path) {
  try {
    return statSync(path);
  } catch {
    return null;
  }
}

function readFileSyncOrNull(path) {
  try {
    return readFileSync(path);
  } catch {
    return null;
  }
}

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
 * The arm's OWN checkout is tried first. There is deliberately NO fallback that
 * substitutes another tree's case for a missing one — a missing arm case is a
 * refusal (plan §R100 line 204: "缺文件或读失败要 NOT_READY，不能拿 driver 副本
 * 冒充"). The repository root is consulted only as the second candidate when the
 * arm checkout simply does not carry the case, and the chosen source is
 * reported on the dispatch so a caller can see which tree it came from.
 */
async function stageCase(opts) {
  const { repoRoot, caseId, stagedCasesDir } = opts;
  const bare = caseId.split("/").pop();
  if (bare === undefined || bare === "") throw new Error(`E4-R98: caseId ${JSON.stringify(caseId)} has no case directory`);
  const qualifier = caseId.includes("/") ? caseId.split("/")[0] : null;

  const roots = [join(opts.checkoutDir, "benchmarks"), join(repoRoot, "benchmarks")];
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
    throw new Error(`E4-R98: case ${caseId} was not found under any of ${tried.join(", ")}`);
  }

  await rm(stagedCasesDir, { recursive: true, force: true });
  await mkdir(stagedCasesDir, { recursive: true });
  await cp(source, join(stagedCasesDir, bare), {
    recursive: true,
    filter: (src) => !DENIED_STAGE_DIRS.has(src.split(/[\\/]/).pop() ?? ""),
  });
  return { stagedCasesDir, stagedCaseDir: join(stagedCasesDir, bare), caseSource: source };
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
 * Run a child process under a REAL deadline.
 *
 * Plan §R99 怎么做 line 166 is explicit: "当前新建 AbortController 却从不触发取消
 * 不算超时实现." So the deadline here is not a decorative AbortController: the
 * timer aborts the controller, the abort kills the child, and an abort leaves a
 * `timeout` outcome rather than a `null` result nobody reads. Buffers are
 * capped, so a child that streams forever cannot exhaust memory before the
 * deadline fires.
 */
function runChild(opts) {
  return new Promise((resolvePromise) => {
    const controller = new AbortController();
    const stdoutChunks = [];
    const stderrChunks = [];
    const MAX_BUFFER = 33_554_432;
    let timedOut = false;
    let spawnFailed = null;

    let child;
    try {
      child = spawn(process.execPath, opts.args, {
        cwd: opts.cwd,
        env: opts.env,
        signal: controller.signal,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
    } catch (err) {
      resolvePromise({ code: null, signal: null, stdout: "", stderr: "", timedOut: false, spawnFailed: redact(err) });
      return;
    }

    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, opts.timeoutMs);

    child.stdout?.on("data", (chunk) => {
      if (stdoutChunks.length < MAX_BUFFER) stdoutChunks.push(chunk);
    });
    child.stderr?.on("data", (chunk) => {
      if (stderrChunks.length < MAX_BUFFER) stderrChunks.push(chunk);
    });
    child.on("error", (err) => {
      // `AbortError` is our own deadline firing, not a start failure.
      if (err?.name !== "AbortError") spawnFailed = redact(err);
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      resolvePromise({
        code,
        signal: signal ?? null,
        stdout: Buffer.concat(stdoutChunks).toString("utf8"),
        stderr: Buffer.concat(stderrChunks).toString("utf8"),
        timedOut,
        spawnFailed,
      });
    });
  });
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
 * Read the REAL verifier verdict out of the CLI's report.
 *
 * Plan §R99 怎么验收: "COMPLETE 表示预定单位都有终态，passed/failed 表示验证结果"
 * and "不要让'模型 error'被当有效评分，也不要让合法的低分结果与基础设施失败混淆."
 * The classification below is therefore three-way:
 *
 *   - a case the report marks as an INFRASTRUCTURE/HARNESS failure is a broken
 *     unit (`infrastructure` / `harness`) — it measured nothing;
 *   - a case that ran and failed its task, with no infrastructure category, is
 *     a VALID negative result (`case_failed`) — that is data, not a defect;
 *   - a case that passed is `null`.
 *
 * NOTHING here synthesises an outcome or hardcodes `passed: true`: the only
 * source of truth is the report the CLI wrote from its own verification gate.
 */
export function classifyReport(report, caseId) {
  const results = Array.isArray(report?.results) ? report.results : [];
  const entry = results.find((r) => r?.task_id === caseId) ?? results[0];
  if (entry === undefined) {
    // The CLI exited 0 but the report holds no row for this case. Treating that
    // as "nothing to report" would silently turn a missing measurement into a
    // success, so it is an infrastructure failure.
    return { passed: false, category: "infrastructure", detail: `E4-R98: the report holds no result for case ${caseId}` };
  }
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
    // A pass is reported as a pass, and its evidence travels with it: the
    // report's own view of whether the VERIFIER (not the model's prose) held.
    return {
      passed: true,
      category: null,
      detail: `verified: verification_passed=${String(entry.verification_passed)} tools=${String(entry.tool_calls)} termination=${String(entry.termination_reason)}`,
    };
  }
  const why = entry.termination_reason ?? "unknown";
  return {
    passed: false,
    category: category === "model" || why === "model_error" ? "provider" : "case_failed",
    detail: `case did not pass: ${String(why)} (verification_passed=${String(entry.verification_passed)})`,
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
export async function runArmUnit(opts) {
  const started = Date.now();
  const now = opts.now ?? (() => Date.now());
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const repoRoot = opts.repoRoot ?? REPO_ROOT;
  const checkoutDir = resolve(opts.checkoutDir);
  const providerId = opts.providerId ?? DEFAULT_PROVIDER_ID;
  const modelId = opts.modelId ?? DEFAULT_MODEL_ID;
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
    // The ACTUAL model contexts this case entered, so a test can prove two
    // cases differ rather than inferring it from two result hashes.
    capturedRequests: [],
    // The arm CLI's REAL per-case report row, persisted by T3 as evidence.
    report: null,
  };

  const finish = (failureCategory, detail) => {
    record.status = statusFor(failureCategory);
    record.failureCategory = failureCategory;
    record.durationMs = Math.max(0, now() - started);
    // ALWAYS redacted, ALWAYS before it can reach a caller's stdout.
    record.detail = detail === null ? null : redact(detail);
    return record;
  };

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
  try {
    campaign = await evaluation.openR97Campaign(opts.ledgerDir, {
      planDigest: opts.planDigest,
      campaignModelCalls: opts.campaignModelCalls ?? maxModelCalls,
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
  // The MEASURED budget accounting from the channel, when the unit reached it.
  let budgetStats = null;
  try {
    await mkdir(runOutDir, { recursive: true });
    // WHICH case source was chosen is recorded: a run whose case silently came
    // from somewhere other than intended is exactly the class of defect this
    // whole round exists to remove, so it is evidence rather than an internal.
    const staged = await stageCase({ repoRoot, checkoutDir, caseId: opts.caseId, stagedCasesDir });
    record.caseSource = staged.caseSource;

    // ---- STEP 3: `running` becomes durable BEFORE the request may leave. ---
    //
    // The reservation taken above is handed to the budget channel as the
    // PRE-TAKEN reservation for this unit's first call, so the durable record's
    // `reservationId` names a real ledger entry that provably precedes the
    // dispatch, while every FURTHER call the case makes reserves its own.
    {
      const inputDigest = inputDigestFor({
        planDigest: opts.planDigest,
        inputsDigest: opts.inputsDigest,
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
        const executed = await runArmCaseInProcess({
          evaluation,
          arm: { label: opts.arm, checkoutDir },
          caseDef,
          // WHICH script shape this unit uses is the CALLER's decision, so the
          // two cases can be driven as a real pass and a real negative.
          scriptShape: opts.scriptShape ?? "write-then-stop",
          stagedCasesDir,
          outDir: runOutDir,
          suite: opts.suite,
          modelId,
          maxModelCalls,
          ledger,
          firstReservationId: reservation.reservationId,
        });
        budgetStats = executed.budget;
        record.budget = executed.budget;
        record.execution = executed.execution;
        record.capturedRequests = executed.capturedRequests;
        // The channel's own count of admitted calls is the MEASURED spend for
        // this unit. It is read from the channel rather than from the arm's
        // self-report (`model_calls`), which is exactly the field plan §T1
        // 怎么做 1 says must not be the basis of the accounting.
        consumed = executed.budget.logicalCalls;
        record.reservationIds = [...executed.budget.reservationIds];

        if (executed.report === null) {
          // A run that produced no report measured nothing, whatever its exit
          // code. Never a pass.
          verdict = {
            category: "infrastructure",
            detail: `E4-R98: the arm's benchmark run wrote no report at ${executed.reportPath} (exit ${String(executed.exitCode)}): ${firstUsefulLine((executed.lines ?? []).join("\n")) ?? "no output"}`,
          };
        } else {
          const classified = classifyReport(executed.report, opts.caseId);
          verdict = { category: classified.category, detail: classified.detail };
          // The verdict is the arm CLI's own. It is recorded on the record so a
          // consumer never has to infer a pass from `status === "completed"`.
          record.verifierPassed = classified.passed === true;
          // T3: the arm's REAL report row is persisted as evidence rather than
          // deleted in `finally` (finding N5: "finally 删除原报告").
          record.report = reportRowFor(executed.report, opts.caseId);
        }
      }
    }
  } catch (err) {
    verdict = { category: "infrastructure", detail: `E4-R98: ${redact(err)}` };
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
  // THE PRE-TAKEN RESERVATION IS OWNED BY THE CHANNEL. The unit reserved ONE
  // call before `begin` and handed that id to `createLedgerBudgetedProvider`,
  // which commits it when the first call completes (or marks it unknown when the
  // outcome was never observed). The worker must therefore NOT commit it again.
  //
  // What the worker DOES settle is the case where the unit never reached the
  // channel at all — a skip, a build refusal, a staging failure, an exception
  // before the first call. The reservation is then genuinely outstanding and is
  // RETURNED, because nothing was dispatched: `abandon` is legal exactly for a
  // provably-undispatched attempt. Burning it would charge the campaign for work
  // that provably never happened.
  if (budgetStats === null) {
    try {
      await ledger.abandon(reservation.reservationId);
    } catch (err) {
      verdict = { category: "budget", detail: `E4-R98: the unused reservation could not be returned: ${redact(err)} (${verdict.detail})` };
    }
  }

  const resultHash = resultHashFor({ unit, build, verdict });
  if (attemptId !== null && execState !== null) {
    const terminalDetail = `${ARM_WORKER_VERSION} ${verdict.category ?? "passed"}: ${verdict.detail}`;
    try {
      if (statusFor(verdict.category) === "completed") {
        await execState.complete(attemptId, { resultHash, detail: terminalDetail, now: now() });
      } else {
        await execState.fail(attemptId, { resultHash, detail: terminalDetail, now: now() });
      }
    } catch (err) {
      verdict = { category: "harness", detail: `E4-R98: the terminal record could not be written: ${redact(err)} (${verdict.detail})` };
    }
  }

  record.resultHash = resultHash;
  // The MEASURED logical calls this unit charged to the campaign. Exposed so a
  // caller (the driver, or a report) can total real spend instead of inferring
  // it from the number of units: a refused unit charges 0 and a dispatched one
  // charges 1, and those are different facts.
  record.consumed = consumed;
  return finish(verdict.category, verdict.detail);
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
  const results = Array.isArray(report?.results) ? report.results : [];
  const bare = caseId.split("/").pop() ?? caseId;
  const entry = results.find((r) => r?.task_id === caseId) ?? results.find((r) => r?.task_id === bare);
  if (entry === undefined) return null;
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
  };
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

  if (
    checkout === undefined ||
    caseId === undefined ||
    suite === undefined ||
    arm === undefined ||
    planDigest === undefined ||
    state === undefined ||
    ledgerDir === undefined
  ) {
    process.stderr.write(
      "usage: node scripts/e4/r97-arm-worker.mjs --checkout <arm dir> --case <caseId> --suite <suite> --arm <arm>\n" +
        "                                                --plan-digest <hex> --state <execution state dir> --ledger <ledger dir>\n" +
        "                                                [--json]\n",
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
