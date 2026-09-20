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
  if (shape === "text-only") {
    // Claim completion, write nothing.
    prefix = [["text", `done: ${caseDef.caseId}`]];
  } else if (target === null) {
    throw new Error(`E4-R98: case ${caseDef.caseId} declares no artifact path, so a write script cannot be derived from it`);
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
 * Extract the (path, content) a case's OWN verification demands.
 *
 * The `command` verification spec embeds an exact expected string (see the r98
 * fixtures' own `case.json`), and the `artifact` spec names the file.
 * Reading them from the case keeps the script and the verifier bound to the same
 * source of truth: a script that wrote something else would fail verification,
 * which is the property we want rather than a script that trivially satisfies a
 * hardcoded expectation.
 */
export function writeTargetOf(caseDef) {
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
  return { path: artifact.path, content };
}

/** Read one case's own files, so the executor knows what the case asks for. */
export async function readCaseDef(caseDir, caseId) {
  const raw = await readFile(join(caseDir, "case.json"), "utf8");
  const parsed = JSON.parse(raw);
  return {
    caseId,
    requestMd: await readFile(join(caseDir, "request.md"), "utf8").catch(() => ""),
    expectedMd: await readFile(join(caseDir, "expected.md"), "utf8").catch(() => ""),
    verification: parsed.verification ?? [],
    writeTarget: writeTargetOf(parsed),
  };
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
export async function armExecutionDigest(checkoutDir) {
  const dir = resolve(checkoutDir);
  const trees = [
    join(dir, "apps", "cli", "dist"),
    join(dir, "packages", "model", "dist"),
    join(dir, "packages", "core", "dist"),
    join(dir, "packages", "evaluation", "dist"),
    join(dir, "packages", "contracts", "dist"),
    join(dir, "packages", "tools", "dist"),
    join(dir, "packages", "harness", "dist"),
  ];
  const files = [];
  for (const tree of trees) {
    for (const rel of await listJsFiles(tree)) files.push(rel);
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

  // ---- Capture the ACTUAL requests and tool actions. ----------------------
  const capturedRequests = [];
  const capturing = {
    id: provider.id,
    listModels: () => provider.listModels(),
    createClient(modelRef, config) {
      const c = provider.createClient(modelRef, config);
      return {
        async *generate(request, signal) {
          capturedRequests.push(summarizeRequest(request));
          yield* c.generate(request, signal);
        },
      };
    },
  };

  const args = [
    "--suite", opts.suite,
    "--cases", opts.stagedCasesDir,
    "--provider", "openai",
    "--model", opts.modelId ?? "gpt-4o-mini",
    "--max-model-calls", String(opts.maxModelCalls ?? 10),
    "--out", opts.outDir,
    "--allow-stub",
  ];

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
    // The arm's own executed bytes, hashed by content (N7 / T4 怎么做 8).
    execution: await armExecutionDigest(arm.checkoutDir),
  };
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
