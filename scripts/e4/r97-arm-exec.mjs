// E4-R98-A / E4-R100-A — THE ARM EXECUTOR.
//
// Executes ONE case inside ONE arm's OWN build, in-process, under the shared
// campaign budget, and returns the arm CLI's REAL report.
//
// WHY THIS REPLACES THE CHILD-CLI DISPATCH (plan T1 怎么做 3 and §0.4)
// ------------------------------------------------------------------
// The previous worker spawned `node <arm>/apps/cli/dist/main.js benchmark …` and
// parsed the report the child wrote. That route made "the arm's own build ran"
// mechanically true, but it made the BUDGET unenforceable: the child resolved
// its own provider from its own environment, so the parent could not count, cap,
// or reserve anything. The ledger could therefore only be charged per UNIT —
// measured defect N1:
//
//   "`reservationCount=1`、默认 `maxModelCalls=10`、dispatch 后固定 `consumed=1`；
//    未读取实际 model_calls/retries … 账本统计的是案例启动次数，不能证明模型调用
//    上限."
//
// Plan §0.4 identified the existing interface that removes that limitation, and
// T1 怎么做 3 directs us to use it:
//
//   "先用各 arm 已导出的 runBenchmarkCommand(argv, scriptedProvider) 验证多轮离线
//    路径."
//
// Both frozen arms export it from their OWN build:
//
//   export async function runBenchmarkCommand(argv, providerOverride) { … }
//
// so this module loads THAT arm's `apps/cli/dist/benchmark-command.js`, injects a
// provider wrapped in the campaign budget channel, and drives the REAL request,
// tool loop and TaskVerifier. Every `generate()` now reserves from the ledger
// before it can leave, which is what makes a model-call ceiling provable.
//
// THE PROVIDER-OVERRIDE IDENTITY CONTRACT (plan §0.4, explicit)
// ------------------------------------------------------------
//   "该旧接口把 providerOverride 标为 offline-test。不能给它塞真实付费 provider 后
//    仍保留 offline-test 身份。"
//
// This module ONLY ever injects an OFFLINE provider: a `ScriptedModelProvider`
// loaded from the arm's own `packages/model/dist`, wrapped in the ledger budget
// channel. It never reads a key, never constructs a network transport, and never
// opens a socket. Because the CLI derives `billingClass = "offline-test"` when a
// provider is injected, the identity it records is TRUE for what this module
// does. Wiring a real billed provider through this seam would require the
// adapter to carry its own ABI + source SHA + adapter/build digest and generate a
// NEW plan (plan T4 怎么做 13); that is deliberately NOT done here, and the
// module refuses to pretend otherwise: see `assertOfflineProvider`.
//
// WHAT IS CAPTURED, AND WHY (plan T4 怎么做 4)
// -------------------------------------------
//   "为两个 r98-fixtures 配置不同脚本响应：一组产生真实文件工具调用后结束，另一组
//    只有完成文本。捕获实际模型输入及工具动作，不能用两个不同 caseId 产生不同
//    resultHash 代替上下文验证."
//
// The executor records, per case, the ACTUAL `ModelRequest` messages that entered
// `generate()` and the tool calls the arm's runtime executed. A test can then
// prove the two cases entered DIFFERENT contexts, rather than inferring it from
// two different result hashes.

import { createHash } from "node:crypto";
import { readFile, readdir, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

/** The arm-executor's own identity, recorded so a report names the adapter that
 *  produced a row rather than only the worker version. */
export const ARM_EXEC_VERSION = "e4-r98-arm-exec-v1";

/** Directories never descended into when collecting the arm's executed bytes. */
const DENIED = new Set(["node_modules", ".git"]);

/**
 * Load the ARM'S OWN built entry points.
 *
 * Three separate imports, all from the arm's tree, all from `dist` (the artifact
 * a campaign would actually run — never `src`, which may be newer than the
 * build):
 *
 *   - `benchmark-command.js` — the exported `runBenchmarkCommand` (plan §0.4).
 *   - `model/dist/index.js`  — the arm's own `ScriptedModelProvider`, so the
 *     provider object the arm's runtime consumes is built by the arm's own code.
 *
 * A missing entry is a NAMED failure: a campaign must not silently fall back to
 * another tree's build, which is how an A/B becomes one harness run twice.
 */
export async function loadArmModules(checkoutDir) {
  const dir = resolve(checkoutDir);
  const cliUrl = pathToFileURL(join(dir, "apps", "cli", "dist", "benchmark-command.js")).href;
  const modelUrl = pathToFileURL(join(dir, "packages", "model", "dist", "index.js")).href;

  let cli;
  let model;
  try {
    cli = await import(cliUrl);
  } catch (err) {
    throw new Error(
      `E4-R98: arm ${dir} has no loadable apps/cli/dist/benchmark-command.js — run \`pnpm build\` in that checkout (${err instanceof Error ? err.message : String(err)})`,
    );
  }
  if (typeof cli.runBenchmarkCommand !== "function") {
    throw new Error(
      `E4-R98: arm ${dir} builds apps/cli/dist/benchmark-command.js but does not export runBenchmarkCommand — the offline execution seam (plan §0.4) requires that export`,
    );
  }
  try {
    model = await import(modelUrl);
  } catch (err) {
    throw new Error(
      `E4-R98: arm ${dir} has no loadable packages/model/dist/index.js (${err instanceof Error ? err.message : String(err)})`,
    );
  }
  if (typeof model.ScriptedModelProvider !== "function") {
    throw new Error(`E4-R98: arm ${dir} builds packages/model/dist/index.js but exports no ScriptedModelProvider`);
  }
  return { dir, runBenchmarkCommand: cli.runBenchmarkCommand, ScriptedModelProvider: model.ScriptedModelProvider, cli };
}

/**
 * Refuse to run a provider that is not provably offline.
 *
 * Plan §0.4: the exported seam labels an injected provider `offline-test`, and
 * that label must not be worn by a real billed transport. This module injects
 * exactly one kind of provider — a scripted local object — and this guard makes
 * that a checked property rather than a comment: a provider that declares a
 * network-ish identity, or that carries an API key, is refused BEFORE any case
 * runs.
 *
 * The check is deliberately about IDENTITY AND CONSTRUCTION, not about behaviour
 * it cannot observe: the point is that a caller cannot pass a real provider and
 * keep the offline label, which is the specific confusion the plan names.
 */
export function assertOfflineProvider(provider) {
  const id = typeof provider?.id === "string" ? provider.id : "";
  if (id === "") throw new Error("E4-R98: the injected provider must declare a non-empty id");
  // The scripted provider is the only offline transport this module constructs.
  // A different id is not automatically wrong, but it must not be a billed one.
  if (id === "openai" || id === "stub" || id === "real") {
    throw new Error(
      `E4-R98: refusing to inject provider id ${JSON.stringify(id)} through the offline-test seam — plan §0.4 forbids giving a real billed provider the offline-test identity`,
    );
  }
  if (provider?.apiKey !== undefined || provider?.key !== undefined) {
    throw new Error("E4-R98: refusing to inject a provider that carries a credential — this executor is offline by construction");
  }
  return provider;
}

/**
 * The scripted response for ONE case, derived from the case's OWN request.
 *
 * The two r98 fixtures demand DIFFERENT files with DIFFERENT content, so the
 * script is read out of the case rather than hardcoded per case id. That is what
 * makes the captured contexts genuinely different inputs instead of two labels
 * over one script.
 *
 * Two shapes, and the plan asks for exactly this pair (T4 怎么做 4):
 *
 *   - `write-then-stop`  — a real `write_file` tool call, then a completing
 *     text turn. The TaskVerifier sees the file and PASSES.
 *   - `text-only`        — a completing text turn and nothing else. The
 *     TaskVerifier finds no file and FAILS. This is the "只说完成但未写文件"
 *     negative control, and it is what proves the verifier is really running.
 *
 * THE BOUNDED TAIL, and why it is not a fudge. `ScriptedModelProvider` indexes
 * its scripts by call number and yields NOTHING once the list is exhausted. A
 * well-formed script must therefore cover every turn the runtime takes — a
 * truncated one produces an empty stream, which the budget channel correctly
 * classifies as an UNKNOWN outcome (a request that left and whose result nobody
 * saw). That classification is right for a real transport but WRONG here: the
 * transport did not fail, the fixture simply ran out of lines.
 *
 * The fix is to make the fixture well-formed rather than to weaken the channel:
 * after the meaningful prefix, every further turn gets a plain completing text
 * ("nothing more to do"), so a runtime that takes an extra turn for its own
 * reasons still reaches a clean terminal event. The prefix is what the case
 * demands; the tail only guarantees the stream is total. Feeding a longer script
 * is NOT an adapter and changes no arm byte — the arm's own provider object and
 * its own parsing are untouched.
 */
const TAIL_COMPLETIONS = 8;

export function scriptForCase(caseDef, shape) {
  const target = caseDef.writeTarget;
  let prefix;
  if (shape === "text-only" || target === null) {
    // Claim completion, write nothing.
    //
    // MEASURED DEFECT this branch fixes (plan §T6 怎么做 5): a case that declares
    // ONLY a `kind:"command"` verifier — five of the eight frozen R87 cases — has
    // no artifact path to write to, and the previous version THREW here. The
    // worker's catch-all turned that throw into `infrastructure`, so the case
    // never reached its own verifier and the unit measured nothing. Claiming
    // completion instead drives the case to its REAL verifier: measured, all five
    // of those commands genuinely fail against the as-staged fixtures, so each
    // becomes an honest `case_failed` negative rather than a phantom
    // infrastructure failure. A `case_failed` unit is a VALID NEGATIVE that the
    // driver deliberately excludes from `failures[]`, so the campaign can still
    // reach COMPLETE without any case being silently dropped.
    prefix = [["text", `done: ${caseDef.caseId}`]];
  } else {
    prefix = [
      ["tool", { path: target.path, content: target.content }],
      ["text", `wrote ${target.path}`],
    ];
  }
  const tail = Array.from({ length: TAIL_COMPLETIONS }, () => ["text", "nothing further to do"]);
  return [...prefix, ...tail];
}

/**
 * The banner written when a case demands an artifact but its own files carry no
 * literal the seam can recover.
 *
 * WHY A BANNER AND NOT A THROW OR A `null`: `write_file`'s own schema is
 * `content: z.string()`, so `content: null` is REFUSED and the tool call fails.
 * MEASURED with a probe against the baseline arm: the failed write still left the
 * artifact verifier PASSING whenever the fixture file already existed, because
 * `TaskVerifier`'s artifact rule is `exists && (mustChange !== true || touched)`
 * and `touched` comes from ATTEMPTED `write_file` requests rather than verified
 * writes — a false pass produced by a write that never happened. Supplying REAL
 * non-null bytes makes the write genuinely succeed, so the pass is real under the
 * verifier's actual contract.
 *
 * The banner NAMES ITSELF so the pass cannot be mistaken for model output: the
 * frozen artifact verifiers only require the path to exist and to have been
 * touched, so these passes are WEAK, and the campaign summary says so.
 */
export function offlineBannerFor(caseId, artifactPath) {
  return [
    "offline-acceptance banner — no model authored this file.",
    "",
    `case: ${caseId}`,
    `artifact: ${artifactPath}`,
    "",
    "Written by the scripted provider of the E4-R101 offline acceptance run",
    "(scripts/e4/r97-offline-acceptance.mjs). Its purpose is to prove that the",
    "arm's own build really executes the case, that the write reaches the",
    "sandboxed workspace, and that the case's own verifier then runs.",
    "",
    "It is NOT a solution to this case. The frozen artifact verifier requires only",
    "that this path exists and was touched, so a pass here is a WEAK pass and is",
    "reported as such; it supports no claim about model capability.",
    "",
  ].join("\n");
}

/**
 * Extract the (path, content) a case's OWN verification demands.
 *
 * The `command` verification spec embeds an exact expected string (see the r98
 * fixtures' own `case.json`), and the `artifact` spec names the file.
 * Reading them from the case keeps the script and the verifier bound to the same
 * source of truth: a script that wrote something else would fail verification,
 * which is the property we want rather than a script that trivially satisfies a
 * hardcoded expectation.
 */
export function writeTargetOf(caseDef, ctx) {
  const specs = Array.isArray(caseDef?.verification) ? caseDef.verification : [];
  const artifact = specs.find((s) => s?.kind === "artifact" && typeof s.path === "string");
  if (artifact === undefined) return null;
  let content = null;
  for (const spec of specs) {
    if (spec?.kind !== "command" || !Array.isArray(spec.args)) continue;
    // The fixture's inline node check compares against a literal; recover it
    // without executing anything.
    for (const arg of spec.args) {
      if (typeof arg !== "string") continue;
      const m = /!==\s*'([^']*)'/.exec(arg);
      if (m !== null) {
        content = m[1];
        break;
      }
    }
    if (content !== null) break;
  }
  if (content !== null) {
    return { path: artifact.path, content, contentSource: "command-literal" };
  }
  // ---- MEASURED DEFECT (plan §T6 怎么做 5): `content: null` ------------------
  //
  // Three of the eight frozen cases declare an artifact verifier and NO command
  // verifier, so no literal exists to recover and the previous version returned
  // `content: null`. `write_file`'s schema is `content: z.string()`, so that call
  // FAILED — and the artifact verifier still reported PASS whenever the fixture
  // file already existed, because `changedPaths` is built from ATTEMPTED writes.
  // Real bytes are therefore supplied instead, labelled as what they are.
  return {
    path: artifact.path,
    content: offlineBannerFor(ctx?.caseId ?? "unknown-case", artifact.path),
    contentSource: "offline-banner",
  };
}

/**
 * How much a PASS on this case actually proves.
 *
 * MEASURED, from the real acceptance run's own per-unit table: of sixteen units,
 * six passed — and the six are NOT the same kind of pass.
 *
 *   `"strong"` — the case's own `kind:"command"` verifier embeds the exact literal
 *                the seam writes (`!== '<content>'`). The case's OWN command
 *                checked the bytes, so a pass means the artifact really held what
 *                the case demanded. (The two R98 fixture cases.)
 *
 *   `"weak"`   — the case declares an artifact verifier and no recoverable
 *                literal, so the seam wrote a labelled banner. `TaskVerifier`'s
 *                artifact rule is `exists && (mustChange !== true || touched)`,
 *                which checks that the path EXISTS and was touched — never what
 *                it CONTAINS. So the pass is real under the verifier's actual
 *                contract but proves only that the write reached the workspace.
 *                (The three artifact-only frozen cases.)
 *
 *   `null`     — the seam wrote nothing (a command-only case, scripted as the
 *                claim-only negative control), so this seam produced no pass at
 *                all. Any verdict such a case reaches is its own verifier's.
 *
 * Reporting one undifferentiated `verifiedPasses` number would present a weak
 * pass as evidence a case was solved. Plan §T6 怎么做 8 requires exactly this kind
 * of distinction for the campaign as a whole ("已有 keyless MODEL_ERROR 冒烟"
 * 不等于"成功工具链验收"); it applies one level down too.
 */
export function passStrengthOf(writeTarget) {
  if (writeTarget === null || writeTarget === undefined) return null;
  if (writeTarget.contentSource === "command-literal") return "strong";
  if (writeTarget.contentSource === "offline-banner") return "weak";
  return null;
}

/** Read one case's own files, so the executor knows what the case asks for. */
export async function readCaseDef(caseDir, caseId) {
  const raw = await readFile(join(caseDir, "case.json"), "utf8");
  const parsed = JSON.parse(raw);
  const writeTarget = writeTargetOf(parsed, { caseId });
  return {
    caseId,
    requestMd: await readFile(join(caseDir, "request.md"), "utf8").catch(() => ""),
    expectedMd: await readFile(join(caseDir, "expected.md"), "utf8").catch(() => ""),
    verification: parsed.verification ?? [],
    writeTarget,
    // Travelling WITH the case definition rather than re-derived by a later
    // reader: the strength describes what THIS seam did, and a consumer holding
    // only the executed record must be able to state it.
    passStrength: passStrengthOf(writeTarget),
  };
}

/**
 * Prefix a message with this executor's tag, exactly once.
 *
 * MEASURED DEFECT (plan §T6 怎么做 5): the driver's reason line read
 *   "arm baseline case regression/reg-03-add-import failed: E4-R98: E4-R98: …"
 * because the worker's catch-all prefixes `E4-R98: ` onto a message that already
 * carries the tag. The doubled tag is the signature of a pass-through nobody
 * read, and it makes a log harder to scan for the real failure. Collapsing it is
 * a presentation fix, not a change to any verdict.
 */
export function withArmExecTag(message) {
  const text = String(message).trim();
  const tag = "E4-R98:";
  let body = text;
  while (body.startsWith(tag)) body = body.slice(tag.length).trim();
  return `${tag} ${body}`;
}

/**
 * Digest of the arm's ACTUAL executed bytes.
 *
 * Plan T4 怎么做 8 requires the build identity to cover the artifacts that really
 * execute a case — "使用字节 hash，不依赖 mtime/size" — and N7 records the measured
 * defect that `armBuildIdentity` hashed only `apps/cli/dist/main.js`:
 *
 *   "armBuildIdentity 漏掉实际导入的执行模块."
 *
 * The in-process seam imports `apps/cli/dist/benchmark-command.js` and
 * `packages/model/dist/index.js`, so those bytes ARE the execution surface. This
 * hashes them by CONTENT, and — because a module can pull in further files — also
 * hashes every built `.js` under the two packages the CLI entry links, so
 * changing an imported dependency invalidates the identity rather than slipping
 * through. The list is enumerated from the filesystem but bounded to those trees,
 * which is the "清晰构建产物清单" plan §R100 line 209 asks for.
 */
/**
 * The relative paths `armExecutionDigest` covers, in digest order.
 *
 * Exported separately from the digest so a test (or an operator) can assert WHICH
 * modules the identity covers rather than inferring an omission from a hash that
 * merely looks different. Plan §T4 怎么做 8 names the required scope —
 * "benchmark-command、runtime、provider/verification 的实际执行依赖与 adapter" — and
 * a list is the only form in which that claim can be checked directly.
 */
export async function executionManifest(checkoutDir) {
  const dir = resolve(checkoutDir);
  const files = [];
  for (const tree of EXECUTION_DIGEST_TREES) {
    for (const rel of await listJsFiles(join(dir, ...tree))) files.push(rel);
  }
  files.sort();
  return files.map((abs) => abs.slice(dir.length + 1).replace(/\\/g, "/"));
}

/** The built trees whose bytes can execute a benchmark case. */
const EXECUTION_DIGEST_TREES = [
  ["apps", "cli", "dist"],
  ["packages", "model", "dist"],
  ["packages", "core", "dist"],
  ["packages", "evaluation", "dist"],
  ["packages", "contracts", "dist"],
  ["packages", "tools", "dist"],
  ["packages", "harness", "dist"],
];

export async function armExecutionDigest(checkoutDir) {
  const dir = resolve(checkoutDir);
  const files = [];
  for (const tree of EXECUTION_DIGEST_TREES) {
    for (const rel of await listJsFiles(join(dir, ...tree))) files.push(rel);
  }
  if (files.length === 0) return null;
  files.sort();
  const h = createHash("sha256");
  h.update(`e4-r98-arm-exec-digest-v1\n${ARM_EXEC_VERSION}\n`);
  for (const abs of files) {
    const rel = abs.slice(dir.length + 1).replace(/\\/g, "/");
    let bytes;
    try {
      bytes = await readFile(abs);
    } catch {
      // A file that cannot be read is a build that cannot be trusted.
      return null;
    }
    h.update(`${rel}:${createHash("sha256").update(bytes).digest("hex")}\n`);
  }
  return { digest: h.digest("hex"), files: files.length };
}

/** Every `*.js` under a tree, recursively, excluding denied directories. */
async function listJsFiles(root) {
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const out = [];
  for (const e of entries) {
    if (DENIED.has(e.name)) continue;
    const abs = join(root, e.name);
    if (e.isDirectory()) {
      out.push(...(await listJsFiles(abs)));
    } else if (e.isFile() && e.name.endsWith(".js")) {
      out.push(abs);
    }
  }
  return out;
}

/**
 * Execute ONE case in the arm's own build, under the campaign budget.
 *
 * ORDER IS THE CONTRACT, mirroring the worker:
 *
 *   1. `runBenchmarkCommand` is driven with `--dry-run` FIRST, so the plan and
 *      its digest are the arm's own (and a bad case set fails before any call).
 *   2. The provider is wrapped in the ledger budget channel, with the caller's
 *      pre-taken reservation adopted for the first call.
 *   3. The real run executes the request, the tool loop and the TaskVerifier.
 *   4. The REAL report is returned, with the captured contexts and the arm's
 *      own executed-bytes digest.
 *
 * The provider is constructed HERE, from the arm's own `ScriptedModelProvider`,
 * and `assertOfflineProvider` refuses anything else.
 */
export async function runArmCaseInProcess(opts) {
  const { evaluation, arm, caseDef, scriptShape } = opts;
  const modules = opts.modules ?? (await loadArmModules(arm.checkoutDir));

  // ---- THE SHARED DEADLINE (T5 怎么做 4). -----------------------------------
  //
  // `opts.deadline` is the unit's ONE deadline object, created by the worker
  // BEFORE this phase and shared with staging and the arm's own dry run. Reading
  // `remainingForPhase()` here — rather than starting a fresh timer — is what
  // makes "dry-run/staging/dispatch 共用剩余总期限" true: a case that begins after
  // the dry run has already spent most of the allowance inherits only what is
  // left.
  //
  // This module deliberately does NOT construct a default by importing the
  // worker: the worker imports THIS module, so the dependency runs one way and a
  // cycle would make the executor unloadable on its own. The seam is instead an
  // explicit, minimal contract — `{ remainingForPhase(), expired(), signal }` —
  // which the worker's `DeadlineBudget` satisfies and a test can satisfy with a
  // four-line stub.
  const deadline = opts.deadline ?? null;

  // The arm's own scripted provider, in the arm's own object shape.
  const SP = modules.ScriptedModelProvider;
  const script = scriptForCase(caseDef, scriptShape);
  const events = script.map(([kind, payload]) =>
    kind === "tool"
      ? SP.toolCall("write_file", { path: payload.path, content: payload.content })
      : SP.text(payload),
  );
  const inner = new SP(events);
  assertOfflineProvider(inner);

  // The budget channel comes from the REPO's evaluation build (this module is
  // the campaign's executor, not the arm's), so the ledger protocol is the
  // campaign's single implementation.
  const { provider, stats } = evaluation.createLedgerBudgetedProvider({
    provider: inner,
    ledger: opts.ledger,
    arm: arm.label,
    ...(opts.firstReservationId === undefined ? {} : { firstReservationId: opts.firstReservationId }),
  });

  // ---- Capture the ACTUAL requests, tool actions and MODEL REF. -----------
  //
  // `createClient(modelRef, config)` is called by the CORE RUNTIME with the
  // agent's own model (`runtime.ts`: `this.modelProvider.createClient(ctx.agent.model, {})`),
  // so `modelRef` is the identity the runtime ACTUALLY resolved — not a
  // restatement of the argv this module passed. Capturing it is what makes the
  // acceptance criterion "实际捕获请求中的 model/目标地址与批准一致" measurable
  // rather than assumed: if the CLI ignored `--model` and fell back to its own
  // default, the ref captured here would show it.
  const capturedRequests = [];
  let executedModelRef = null;
  // Set when the shared deadline stopped a call. Reported so the worker can
  // classify the unit as `timeout` rather than inferring a failure from a
  // truncated stream or a missing report.
  let deadlineStop = null;
  const capturing = {
    id: provider.id,
    listModels: () => provider.listModels(),
    createClient(modelRef, config) {
      if (executedModelRef === null && modelRef !== null && typeof modelRef === "object") {
        executedModelRef = {
          providerId: typeof modelRef.providerId === "string" ? modelRef.providerId : null,
          modelId: typeof modelRef.modelId === "string" ? modelRef.modelId : null,
        };
      }
      const c = provider.createClient(modelRef, config);
      return {
        async *generate(request, signal) {
          // ---- THE DEADLINE REACHES THE ACTUAL CALL (T5 怎么做 1/7). --------
          //
          // Plan §T5 做什么 1 requires the campaign deadline to be able to end the
          // REAL execution, and §怎么验收 2 lists "provider 流 hang" as a case that
          // must end. Checking here — at the point the arm's own provider is about
          // to be driven — is what makes a hung provider stream stop: the check is
          // inside the loop the arm drives, so it cannot be outlived by a provider
          // that never yields.
          //
          // The check runs BEFORE the request is recorded, so a refused call is not
          // counted as one that left.
          if (deadline !== null && deadline.expired()) {
            deadlineStop = "the unit's shared deadline expired before the next provider call";
            throw new Error(`E4-R99-B: ${deadlineStop}`);
          }
          capturedRequests.push(summarizeRequest(request));
          // The arm's own signal and the unit's shared deadline are BOTH honoured:
          // a provider that respects its signal now also stops when the campaign
          // says so, rather than only when the arm decides to give up.
          const merged = mergeSignals(signal, deadline === null ? undefined : deadline.signal);
          yield* c.generate(request, merged);
          if (deadline !== null && deadline.expired() && deadlineStop === null) {
            deadlineStop = "the unit's shared deadline expired during the provider call";
          }
        },
      };
    },
  };

  // ---- THE APPROVED IDENTITY, passed to the arm's own CLI. ----------------
  //
  // MEASURED DEFECT N6 (plan §0.2, P0): this argv hardcoded `"--provider",
  // "openai"` and defaulted the model, so a plan approved for a local test
  // endpoint and a non-default model executed as the default pair. Plan §T4
  // 怎么做 6: "worker 必须使用它们构造请求；不能回落到 openai/gpt-4o-mini 或环境里的
  // 另一 endpoint."
  //
  // `--endpoint` is passed ONLY when the approval names one. Omitting it lets the
  // CLI fall back to `OPENAI_BASE_URL`, which is precisely the "另一 endpoint"
  // the plan forbids: an approval that names NO endpoint means the provider's
  // built-in default, so the environment must not be able to redirect it.
  const args = [
    "--suite", opts.suite,
    "--cases", opts.stagedCasesDir,
    "--provider", opts.providerId,
    "--model", opts.modelId,
    "--max-model-calls", String(opts.maxModelCalls ?? 10),
    "--out", opts.outDir,
    "--allow-stub",
  ];
  if (typeof opts.endpointBaseUrl === "string" && opts.endpointBaseUrl !== "") {
    args.push("--endpoint", opts.endpointBaseUrl);
  }

  // ---- The PLAN the arm itself built for this exact argv. ----------------
  //
  // A `--dry-run` over the SAME argv makes the arm's own CLI print the execution
  // plan it derived — including the `providerId`, `modelId` and normalized
  // `endpointIdentity` it will bind. That is the arm's MEASUREMENT of the
  // approval, made by the code that will execute it, and it costs ZERO provider
  // calls. Reading the identity out of this instead of echoing the caller's own
  // argv is the difference between "the flag was passed" and "the arm resolved
  // the identity the plan approved".
  // The DRY RUN is a phase of the same unit, so it draws on the SAME allowance
  // (T5 怎么做 4). A dry run is refused outright when the allowance is already
  // spent: it costs zero provider calls but it is not free — it is wall clock the
  // dispatch then does not have, and letting it run would re-grant the phase a
  // window the unit no longer owns.
  if (deadline !== null && deadline.expired()) {
    return {
      execVersion: ARM_EXEC_VERSION,
      arm: arm.label,
      checkoutDir: modules.dir,
      exitCode: null,
      lines: [],
      report: null,
      reportPath: null,
      capturedRequests: [],
      budget: { ...stats },
      scriptShape,
      executionIdentity: null,
      execution: null,
      deadlineStop: "the unit's shared deadline expired before the arm's dry run",
    };
  }
  const dryRun = await modules.runBenchmarkCommand([...args, "--dry-run"], capturing);
  const declaredPlan = parseDryRunPlan(dryRun.lines);

  // A dispatch is only attempted while the unit still owns time. `deadlineStop`
  // is what the worker turns into a `timeout` verdict, so an expired unit is
  // reported as stopped rather than as a case that mysteriously produced no
  // report (T5 怎么做 7: "记录 timeout/cancel/output_limit，而非伪装为 case_failed
  // 或 verified pass").
  if (deadline !== null && deadline.expired()) {
    return {
      execVersion: ARM_EXEC_VERSION,
      arm: arm.label,
      checkoutDir: modules.dir,
      exitCode: null,
      lines: dryRun.lines,
      report: null,
      reportPath: null,
      capturedRequests,
      budget: { ...stats },
      scriptShape,
      executionIdentity: null,
      execution: null,
      deadlineStop: "the unit's shared deadline expired between the dry run and the dispatch",
    };
  }

  const res = await modules.runBenchmarkCommand(args, capturing);

  // The arm's own report is the ONLY source of the verdict — never synthesised.
  // The naming mirrors the CLI's own `writeBaselineFiles`: `baseline.json` for
  // regression, `<suite>.json` otherwise.
  const reportPath = join(resolve(opts.outDir), opts.suite === "regression" ? "baseline.json" : `${opts.suite}.json`);
  let report = null;
  try {
    report = JSON.parse(await readFile(reportPath, "utf8"));
  } catch {
    report = null;
  }

  // The identity the unit ACTUALLY executed under. Three independent sources are
  // reported so a caller can see any disagreement rather than only one view:
  //
  //   declared  — what the ARM'S OWN dry-run plan bound for this argv;
  //   runtime   — the ModelRef the CORE RUNTIME handed to `createClient`;
  //   approved  — what the caller said was approved.
  //
  // THE MODEL AND THE ENDPOINT MUST MATCH THE APPROVAL EXACTLY. They are the two
  // facts the acceptance criterion names — "实际捕获请求中的 model/目标地址与批准一致"
  // — so a disagreement is real drift and the worker refuses the unit rather than
  // reporting a pass under an identity nobody approved.
  //
  // THE PROVIDER ID IS DELIBERATELY NOT COMPARED. On the offline path the
  // approved provider id is the BILLED identity the plan digest binds (the CLI
  // accepts exactly one, `openai`), while the transport that actually runs is the
  // injected scripted provider — that substitution IS the offline seam, and
  // `assertOfflineProvider` above proves the substitute cannot reach the network
  // (it refuses the real ids and any provider carrying a key). Flagging it as
  // drift would refuse every legitimate offline run. The relationship is still
  // RECORDED, so a reader sees both facts and can judge them.
  const executionIdentity = {
    declaredProviderId: declaredPlan?.providerId ?? null,
    declaredModelId: declaredPlan?.modelId ?? null,
    declaredEndpointIdentity: declaredPlan?.endpointIdentity ?? null,
    runtimeProviderId: executedModelRef?.providerId ?? null,
    runtimeModelId: executedModelRef?.modelId ?? null,
    approvedProviderId: opts.providerId,
    approvedModelId: opts.modelId,
    approvedEndpointIdentity: evaluation.captureEndpointIdentity(opts.endpointBaseUrl ?? null),
    // The provider that actually ran, and whether it is provably offline.
    executingProviderId: inner.id,
    providerIsOfflineSubstitute: inner.id !== opts.providerId,
    drift: [],
  };
  if (executionIdentity.declaredModelId !== null && executionIdentity.declaredModelId !== opts.modelId) {
    executionIdentity.drift.push(`the arm bound model ${executionIdentity.declaredModelId} but the approval names ${opts.modelId}`);
  }
  // The RUNTIME's own model ref is a second, independent measurement: the CLI's
  // plan could name the approved model while the runtime quietly asked for
  // another. A disagreement here is drift even if the plan agreed.
  if (executionIdentity.runtimeModelId !== null && executionIdentity.runtimeModelId !== opts.modelId) {
    executionIdentity.drift.push(`the runtime asked for model ${executionIdentity.runtimeModelId} but the approval names ${opts.modelId}`);
  }
  if (
    executionIdentity.declaredEndpointIdentity !== null &&
    executionIdentity.declaredEndpointIdentity !== executionIdentity.approvedEndpointIdentity
  ) {
    executionIdentity.drift.push(
      `the arm bound endpoint ${executionIdentity.declaredEndpointIdentity} but the approval names ${String(executionIdentity.approvedEndpointIdentity)}`,
    );
  }

  return {
    execVersion: ARM_EXEC_VERSION,
    arm: arm.label,
    checkoutDir: modules.dir,
    exitCode: res.exitCode,
    lines: res.lines,
    report,
    reportPath,
    capturedRequests,
    budget: { ...stats },
    scriptShape,
    // WHAT A PASS ON THIS CASE WOULD PROVE (T6 怎么做 5). Recorded with the run so
    // a summary can report strong and weak passes apart instead of presenting a
    // weak pass as evidence the case was solved.
    passStrength: caseDef.passStrength ?? passStrengthOf(caseDef.writeTarget),
    // The identity the request ACTUALLY carried, measured rather than assumed.
    executionIdentity,
    // The arm's own executed bytes, hashed by content (N7 / T4 怎么做 8).
    execution: await armExecutionDigest(arm.checkoutDir),
    // Non-null when the SHARED deadline stopped this unit mid-phase (T5). The
    // worker reads it to report `timeout` rather than inferring a cause.
    deadlineStop,
  };
}

/**
 * The execution plan the arm's own CLI printed for a `--dry-run`.
 *
 * The CLI emits the plan as a single JSON document on its own stdout (see
 * `buildDryRunPlan` / `runBenchmarkCommand`'s dry-run branch). A line that is not
 * JSON, or a document without the identity fields, yields `null`: this is a
 * MEASUREMENT, so "the arm did not tell us" must not be silently filled in from
 * the caller's argv — that is exactly the substitution the identity check exists
 * to prevent.
 */
export function parseDryRunPlan(lines) {
  const text = (Array.isArray(lines) ? lines : []).join("\n");
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  return {
    planDigest: typeof parsed.planDigest === "string" ? parsed.planDigest : null,
    providerId: typeof parsed.providerId === "string" ? parsed.providerId : null,
    modelId: typeof parsed.modelId === "string" ? parsed.modelId : null,
    endpointIdentity: typeof parsed.endpointIdentity === "string" ? parsed.endpointIdentity : null,
  };
}

/**
 * Combine the arm's own cancellation signal with the unit's shared deadline.
 *
 * The arm's provider contract takes ONE `AbortSignal`, but two independent things
 * must be able to stop a call: the arm's own decision (it may give up on its own)
 * and the campaign's deadline (T5: "campaign deadline ... 均可终止实际执行"). This
 * returns a signal that aborts when EITHER does, so neither reason is lost and the
 * arm cannot outlive the campaign by ignoring the one it was handed.
 *
 * The merged signal is returned as-is when only one input exists, so the common
 * path allocates nothing.
 */
export function mergeSignals(armSignal, deadlineSignal) {
  if (deadlineSignal === undefined) return armSignal;
  if (armSignal === undefined) return deadlineSignal;
  if (armSignal === deadlineSignal) return armSignal;
  if (typeof AbortSignal !== "undefined" && typeof AbortSignal.any === "function") {
    return AbortSignal.any([armSignal, deadlineSignal]);
  }
  // Fallback for a runtime without `AbortSignal.any`: a small controller that
  // follows both, with the listeners removed once it aborts so a long campaign
  // does not accumulate them.
  const controller = new AbortController();
  const follow = (sig) => {
    if (sig.aborted) {
      controller.abort();
      return;
    }
    const onAbort = () => controller.abort();
    sig.addEventListener("abort", onAbort, { once: true });
  };
  follow(armSignal);
  follow(deadlineSignal);
  return controller.signal;
}

/**
 * A bounded, non-secret summary of one model request.
 *
 * The full `ModelRequest` carries the whole prompt and headers; the campaign
 * needs enough to prove WHICH context a case entered — the message contents —
 * without storing anything a credential could hide in. Only `role` and a bounded
 * `content` are kept.
 */
export function summarizeRequest(request) {
  const messages = Array.isArray(request?.messages) ? request.messages : [];
  return {
    messageCount: messages.length,
    messages: messages.map((m) => ({
      role: typeof m?.role === "string" ? m.role : "unknown",
      content: typeof m?.content === "string" ? m.content.slice(0, 600) : "",
    })),
    // A stable digest of the whole message list, so two contexts can be compared
    // without storing either in full.
    digest: createHash("sha256")
      .update(JSON.stringify(messages.map((m) => ({ role: m?.role ?? null, content: m?.content ?? null }))))
      .digest("hex"),
  };
}

/** Does a directory hold a built arm? Used by the CLI to fail fast. */
export function armIsBuilt(checkoutDir) {
  return (
    existsSync(join(resolve(checkoutDir), "apps", "cli", "dist", "benchmark-command.js")) &&
    existsSync(join(resolve(checkoutDir), "packages", "model", "dist", "index.js"))
  );
}

/** Whether a path is a readable file. Kept so a caller can report NOT_READY
 *  rather than throw for a merely missing artifact. */
export async function isFile(path) {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}
