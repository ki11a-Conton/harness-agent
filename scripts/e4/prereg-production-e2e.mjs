#!/usr/bin/env node
/**
 * A7 — the PRODUCTION-OFFLINE end-to-end gate for the release entry point.
 *
 * WHY THIS EXISTS
 * ---------------
 * The N5 closed loop proves the pre-registration chain works when a TEST injects
 * `CommandDeps.preregRunner`, and the S0 wiring suite proves `main()` dispatches
 * `prereg` before it resolves a provider. Neither runs the SHIPPED artifact
 * (`node apps/cli/dist/main.js`) against the REAL frozen selection, the REAL
 * observer and the REAL arm executor. So "the release CLI can walk the formal
 * chain offline" was an inference, not a measurement. This script measures it.
 *
 * TWO PHASES, TWO KINDS OF EVIDENCE
 * --------------------------------
 *   NEG (release CLI, real subprocesses) — the F1/F6/F7 preflight counterexamples
 *       are refused by the SHIPPED entry point, and a LOCAL COUNTING HTTP STUB
 *       proves the physical transport saw ZERO requests. A refusal that reached
 *       the network would not be a refusal.
 *   POS (release CLI, real subprocesses) — `prereg build` writes a canonical
 *       artifact from the REAL frozen selection, and `prereg validate` certifies
 *       the CURRENT execution identity against it. Both are 0-provider commands;
 *       the HTTP stub stays at 0.
 *   POS-EXEC (in-process, the SAME production adapter) — the full paired schedule
 *       of the frozen experiment is executed through `createProductionPreregRunner`
 *       (the shipped `runArm`, the shipped observer), a real frozen case and the
 *       real verifier, with a COUNTING fake provider as the transport. Every arm's
 *       raw evidence is re-verified from the bytes it wrote. Kept as a UNIT
 *       regression (it exercises the adapter in the test process). R1: this phase
 *       is a TEST COMPOSITION ROOT — it injects the two capabilities the release
 *       CLI cannot accept (a non-billable transport and pinned fixture checkouts).
 *   POS-FWD (release CLI, real subprocess) — R1 CHANGED WHAT THIS PROVES. It used
 *       to run the full frozen schedule through the shipped subprocess over
 *       synthesized fixture checkouts. The release CLI accepts NO fixture-bypass
 *       configuration, so a subprocess cannot be handed the trust capability that
 *       admits fixture code, and the SHIPPED entry point now REFUSES that campaign
 *       BEFORE any request (measured: non-zero exit, 0 HTTP against the loopback
 *       counting stub, no per-arm record). This phase therefore asserts a SECURITY
 *       property (fail-closed, pre-request) rather than a forward run; the positive
 *       closed loop is POS-EXEC. A sanctioned trusted-fixture mode for the release
 *       CLI must enter the preregistration and the approval itself (R5) and is NOT
 *       claimed here.
 *
 * HONEST COUNTS (plan §A7)
 * ------------------------
 * Every number in the report is either MEASURED here (the HTTP stub's counter, the
 * fake provider's counter, vitest-style derived digests) or explicitly
 * `NOT_OBSERVED`. A literal `0` for something this script never measured would be
 * an unverifiable claim dressed as evidence.
 *
 * CLEAN-TREE PRECONDITION
 * -----------------------
 * The formal gate's observer derives `cleanTree` from `git status --porcelain`
 * and refuses a dirty checkout (`require-clean`). POS/POS-EXEC therefore REQUIRE a
 * clean tracked tree; NEG runs anywhere. The script reports the dirty-tree case as
 * an explicit refusal (`CLEAN_TREE_REQUIRED`), never as a pass.
 *
 * ZERO COST: the script REFUSES to run if a paid provider key or the paid switch
 * is selectable, and every provider/transport below is local and counted.
 *
 * Usage: node scripts/e4/prereg-production-e2e.mjs [--out <path>]
 *          [--run-id <id>] [--attempt <n>] [--platform windows|ubuntu]
 *          [--evidence-root <dir>]
 *
 * E-R16/F3 — RUN IDENTITY AND DUAL-BUILD EVIDENCE
 * ----------------------------------------------
 * The `--e2e` artifact now carries the fields `scripts/e4/ci-readiness.mjs`
 * verifies for `realBuildOfflineReady`: `runId`, `attempt`, `platform`,
 * `dualBuild` and `evidenceRoot`. Each is emitted ONLY from a real source
 * (`--flag` or the `GITHUB_*` CI variable, real arm directories, a real
 * verification pass, a real bundle), and each is OMITTED otherwise, with the
 * reason recorded in `omittedEvidenceFields`.
 *
 * AN OMITTED FIELD IS `NOT_PROVEN`; A FABRICATED ONE IS THE F3 DEFECT. Omitting
 * makes the readiness consumer report `NO_ARTIFACT_RUN_ID` /
 * `NO_ARTIFACT_ATTEMPT` / `NO_ARTIFACT_PLATFORM` / `NO_DUAL_BUILD_EVIDENCE` /
 * `NO_RAW_EVIDENCE` and `realBuildOfflineReady: NOT_PROVEN` — the correct,
 * honest state for a local run, and NOT a regression.
 */

import { execFileSync, spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(here, "..", "..");
const CLI_ENTRY = join(REPO_ROOT, "apps", "cli", "dist", "main.js");
const EVAL_ENTRY = join(REPO_ROOT, "packages", "evaluation", "dist", "index.js");
const RUNNER_ENTRY = join(REPO_ROOT, "apps", "cli", "dist", "prereg-production-runner.js");
const IDENTITY_ENTRY = join(REPO_ROOT, "apps", "cli", "dist", "prereg-execution-identity.js");
/** N5 — the executor that OWNS the fixture-marker rule; the fixture writer must
 *  use its constant rather than a copy, so the two cannot drift apart. */
const EXECUTOR_ENTRY = join(REPO_ROOT, "apps", "cli", "dist", "prereg-arm-executor.js");

/** R0/S1 — the declared arm build entry the isolated worker loads. POSIX on
 *  purpose: it must equal the `R97_ARM_BUILD_ENTRIES` row the executor compares
 *  against, and `path.join` accepts forward slashes on Windows too. */
const ARM_ENTRY_REL = "apps/cli/dist/benchmark-command.js";
/** R0/S1 Phase G — the absolute path of the same entry. The fixture arm imports
 *  `R97_ARM_ABI` from here so its declared capability list cannot drift from the
 *  one `prereg-arm-executor` requires. */
const CLI_BENCHMARK_ENTRY = join(REPO_ROOT, "apps", "cli", "dist", "benchmark-command.js");
/** Phase G — the built `@ar/tools` entry. The fixture arm needs it to construct a
 *  REAL `ToolOrchestrator`, which is what makes its `tool-budget-rpc-v1` claim
 *  true rather than merely asserted. Embedded as a `file://` URL: the value goes
 *  into generated module source, and Node's ESM loader rejects a bare Windows
 *  absolute path (`ERR_UNSUPPORTED_ESM_URL_SCHEME: Received protocol 'c:'`). */
const TOOLS_DIST = pathToFileURL(join(REPO_ROOT, "packages", "tools", "dist", "index.js")).href;
/** B3 — the versioned mechanism probe every real arm build must export. */
const ARM_PROBE_EXPORT = "R97_ARM_PROBE";
/** TEST_ONLY sentinel: an invalid key that can never bill anything. The ONLY
 *  endpoint any phase may reach is the loopback counting stub below. */
const TEST_ONLY_API_KEY = "TEST_ONLY-not-a-real-key";
const R97_LEDGER_FILE = "budget-ledger.json";

const SCHEMA = "prereg-production-offline-e2e-v1";
/** S6b/Phase H — the schema `scripts/e4/readiness-evidence-verify.mjs` requires
 *  in EVERY bundle root file (`identity.json`, `schedule.json`, `aggregate.json`,
 *  `cost-journal.json`). Declared here as a literal because the verifier's own
 *  export is ESM-only and this script must not import it (that would make the
 *  producer depend on the verifier it is being checked by). */
const READINESS_EVIDENCE_SCHEMA = "prereg-readiness-evidence-v1";
const WORKSPACE = join(REPO_ROOT, ".ci", "prereg-production-e2e");

/**
 * S3/F4 (Phase F) — THE ONE INJECTED CLOCK.
 *
 * WHY THIS IS NOT A FROZEN CONSTANT ANY MORE
 * ------------------------------------------
 * It used to be `1_700_000_000_000` (2023-11-14T22:13:20Z). The formal gate
 * freezes the durable campaign deadline as `clock() + caps.maxDurationMs`, i.e.
 * `1_700_000_000_000 + 600_000` = 2023-11-14T22:23:20Z, and S2 (F2) made that
 * deadline REAL: `prereg-arm-executor.ts` now refuses a campaign whose deadline
 * has already passed rather than silently re-deriving a fresh window. A fixture
 * pinned ~2 years in the PAST therefore fails with `ARM_DEADLINE_EXCEEDED` at
 * the first arm. That refusal is CORRECT — the FIXTURE was wrong.
 *
 * So the wall-clock anchor is now OPEN (read once, here, at process start) while
 * everything determinism actually depends on — token counts, digests, ids,
 * repetitions, the frozen case set — stays fixed. `assertCampaignClockIsOpen`
 * below makes a regression loud instead of silent.
 *
 * ONE CLOCK, ALWAYS: every `now: () => NOW` in this script reads THIS constant.
 * There is deliberately no second epoch and no phase that uses raw `Date.now()`
 * for a deadline comparison — mixing an open clock with a frozen one is exactly
 * the inconsistency that produced the CI failure.
 */
const NOW = Date.now();

/** The declared campaign duration the artifact binds (`budget.maxDurationMs`).
 *  The gate freezes `campaignDeadlineAtMs = clock() + THIS`, so the guard below
 *  must use the same number or it would validate a deadline nobody creates. */
const DECLARED_MAX_DURATION_MS = 600_000;

/**
 * FAIL LOUDLY if this script's OWN injected clock would place the campaign
 * deadline in the past. This is an ASSERTION, not a comment: a frozen past
 * `NOW` must break the run here, with a message naming the cause, instead of
 * surfacing 1,000 lines later as an opaque `ARM_DEADLINE_EXCEEDED` from inside
 * the executor — or, worse, only in CI on a clean tree where the positive
 * phases actually execute.
 *
 * `issuedAtMs` is deliberately NOT checked for "in the past": the formal gate
 * compares it as `nowMs < auth.issuedAtMs` → `AUTHORIZATION_NOT_YET_VALID`, so
 * the authorization epoch is REQUIRED to be at or before the injected clock.
 */
function assertCampaignClockIsOpen() {
  const deadlineAtMs = NOW + DECLARED_MAX_DURATION_MS;
  if (!Number.isFinite(NOW) || !Number.isSafeInteger(NOW)) {
    throw new Error(`FIXTURE_CLOCK_INVALID: the injected clock ${String(NOW)} is not a safe integer epoch`);
  }
  if (deadlineAtMs <= Date.now()) {
    throw new Error(
      `FIXTURE_CLOCK_CLOSED: the injected clock NOW=${NOW} (${new Date(NOW).toISOString()}) places the campaign ` +
        `deadline at ${deadlineAtMs} (${new Date(deadlineAtMs).toISOString()}), which is already in the past ` +
        `relative to ${new Date(Date.now()).toISOString()}. The arm executor would (correctly) refuse with ` +
        `ARM_DEADLINE_EXCEEDED before the first model request. Derive NOW from the real clock at process start ` +
        `(see the NOW declaration) rather than pinning a past epoch.`,
    );
  }
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const out = {};
  // Both spellings are accepted (`--flag value` and `--flag=value`): CI scripts
  // commonly use the `=` form, and silently ignoring it would drop a real run
  // identity and degrade it to an honest-but-unnecessary NOT_PROVEN.
  const flags = {
    "--out": "out",
    "--run-id": "runId",
    "--attempt": "attempt",
    "--platform": "platform",
    "--evidence-root": "evidenceRoot",
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (typeof arg !== "string") continue;
    const eq = arg.indexOf("=");
    const name = eq === -1 ? arg : arg.slice(0, eq);
    const key = flags[name];
    if (key === undefined) continue;
    if (eq !== -1) {
      out[key] = arg.slice(eq + 1);
    } else {
      out[key] = argv[i + 1];
      i += 1;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// F3/E-R16 — THE RUN-IDENTITY AND DUAL-BUILD BLOCK
// ---------------------------------------------------------------------------

/**
 * THE GOVERNING PRINCIPLE OF THIS BLOCK:
 *
 *   AN OMITTED FIELD IS `NOT_PROVEN`. A FABRICATED ONE IS THE F3 DEFECT.
 *
 * `ci-readiness.mjs` treats a MISSING key as an explicit failure with a named
 * reason code (`NO_ARTIFACT_RUN_ID`, `NO_ARTIFACT_ATTEMPT`, `NO_ARTIFACT_PLATFORM`,
 * `NO_DUAL_BUILD_EVIDENCE`, `NO_RAW_EVIDENCE`) and reports
 * `realBuildOfflineReady: NOT_PROVEN`. That is the CORRECT current state for a
 * local run, and it is NOT a regression. What this script must never do is emit
 * `""`, `"unknown"`, `"x"` or a `process.platform` value such as `win32`/`linux`
 * — the consumer's closed enum is `"windows" | "ubuntu"`, so `win32` would be a
 * *present but wrong* value, which is strictly worse than omitting it.
 *
 * Every field below is therefore added ONLY when it was genuinely established,
 * and the reason for every omission is recorded in `omittedEvidenceFields` so a
 * reader can tell "not measured here" from "lost".
 */

/** The closed enum the readiness consumer accepts. `process.platform` is NOT it. */
const PLATFORM_ENUM = ["windows", "ubuntu"];

/**
 * The run identity. `--flag` wins over the CI environment variable; when neither
 * exists the key is OMITTED (never `""`, never a placeholder).
 */
function collectRunIdentity(args) {
  const omitted = [];
  const identity = {};

  const runId = nonEmpty(args.runId) ?? nonEmpty(process.env["GITHUB_RUN_ID"]);
  if (runId !== null) identity.runId = runId;
  else omitted.push({ field: "runId", reason: "neither --run-id nor GITHUB_RUN_ID was supplied", consumerCode: "NO_ARTIFACT_RUN_ID" });

  // A NUMBER, per the consumer (`asInt`). A non-numeric value is refused rather
  // than coerced — a coerced attempt would be a fabricated one.
  const attemptRaw = nonEmpty(args.attempt) ?? nonEmpty(process.env["GITHUB_RUN_ATTEMPT"]);
  if (attemptRaw === null) {
    omitted.push({ field: "attempt", reason: "neither --attempt nor GITHUB_RUN_ATTEMPT was supplied", consumerCode: "NO_ARTIFACT_ATTEMPT" });
  } else if (!/^\d+$/.test(attemptRaw)) {
    omitted.push({ field: "attempt", reason: `the supplied attempt ${JSON.stringify(attemptRaw)} is not an integer`, consumerCode: "NO_ARTIFACT_ATTEMPT" });
  } else {
    identity.attempt = Number.parseInt(attemptRaw, 10);
  }

  // The closed enum. Deliberately NOT `process.platform`: that yields `win32` /
  // `linux`, which the consumer's enum does not accept, so inferring it would
  // emit a present-but-wrong value instead of an honest omission.
  const platform = nonEmpty(args.platform);
  if (platform === null) {
    omitted.push({
      field: "platform",
      reason: "no --platform was supplied; it is NOT inferred from process.platform (which yields win32/linux, outside the consumer's closed enum)",
      consumerCode: "NO_ARTIFACT_PLATFORM",
    });
  } else if (!PLATFORM_ENUM.includes(platform)) {
    omitted.push({
      field: "platform",
      reason: `--platform ${JSON.stringify(platform)} is not one of ${PLATFORM_ENUM.join("|")}`,
      consumerCode: "NO_ARTIFACT_PLATFORM",
    });
  } else {
    identity.platform = platform;
  }

  return { identity, omitted };
}

function nonEmpty(v) {
  return typeof v === "string" && v.trim() !== "" ? v.trim() : null;
}

/**
 * F3 — the dual-build block, from the REAL arm directories.
 *
 * Both `sourceSha` values must be real 40-hex SHAs and both `buildDigest` values
 * must be real 64-hex sha256 digests of the arm's OWN bytes (via the EXISTING
 * `computeArmBuildDigestV1`). `verifier.ran` is `true` ONLY when this script
 * actually observed arm evidence being re-verified.
 *
 * IF ANY OF THAT CANNOT BE ESTABLISHED, THE WHOLE BLOCK IS OMITTED. A partial or
 * placeholder block is exactly the forgery the F3 verifier must refuse, so it is
 * never emitted in a degraded form.
 */
async function collectDualBuild(armDirs, verifierFacts) {
  const reasons = [];
  if (armDirs === null || armDirs === undefined) {
    return { dualBuild: null, reasons: ["no arm directories were materialised in this run"] };
  }
  const evalMod = await import(pathToFileURL(EVAL_ENTRY).href);

  const readArm = (label, dir, runId) => {
    if (typeof dir !== "string" || dir === "") {
      reasons.push(`${label}: no arm directory`);
      return null;
    }
    let sourceSha = null;
    try {
      sourceSha = nonEmpty(git(["-C", dir, "rev-parse", "HEAD"]));
    } catch {
      reasons.push(`${label}: git rev-parse HEAD failed at ${dir}`);
      return null;
    }
    if (sourceSha === null || !/^[0-9a-f]{40}$/.test(sourceSha)) {
      reasons.push(`${label}: ${dir} is not at a 40-hex SHA`);
      return null;
    }
    let buildDigest = null;
    try {
      buildDigest = evalMod.computeArmBuildDigestV1(dir);
    } catch (err) {
      reasons.push(`${label}: computeArmBuildDigestV1 failed at ${dir} (${err instanceof Error ? err.message : String(err)})`);
      return null;
    }
    if (typeof buildDigest !== "string" || !/^[0-9a-f]{64}$/.test(buildDigest)) {
      reasons.push(`${label}: buildDigest at ${dir} is not a 64-hex sha256`);
      return null;
    }
    return { sourceSha, buildDigest, dir, runId };
  };

  const baselineArm = readArm("baselineArm", armDirs.baselineDir, armDirs.baselineRunId);
  const candidateArm = readArm("candidateArm", armDirs.candidateDir, armDirs.candidateRunId);
  if (baselineArm === null || candidateArm === null) {
    return { dualBuild: null, reasons };
  }

  // The verifier facts come from the REAL verification pass in POS-EXEC. When it
  // did not run, this block is omitted rather than reported with `ran:false`
  // plus invented counts.
  if (verifierFacts === null || verifierFacts === undefined) {
    reasons.push("the verifier pass did not run, so verifier{ran,casesTotal,casesVerified} is not established");
    return { dualBuild: null, reasons };
  }
  return {
    dualBuild: {
      baselineArm: { sourceSha: baselineArm.sourceSha, buildDigest: baselineArm.buildDigest, dir: baselineArm.dir },
      candidateArm: { sourceSha: candidateArm.sourceSha, buildDigest: candidateArm.buildDigest, dir: candidateArm.dir },
      verifier: {
        ran: verifierFacts.ran === true,
        casesTotal: verifierFacts.casesTotal,
        casesVerified: verifierFacts.casesVerified,
      },
    },
    reasons,
  };
}

function sha256Hex(text) {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function git(args) {
  return execFileSync("git", ["-C", REPO_ROOT, ...args], { encoding: "utf8" }).trim();
}

/**
 * S6b/Phase H — a real checkout's HEAD, or `null`.
 *
 * A `git -C <dir> rev-parse HEAD` on a directory that is NOT a git checkout does
 * NOT fail: git walks UP to the enclosing repository and returns THAT commit. The
 * two synthetic arm checkouts are plain directories inside the repo, so a naive
 * call returns the SAME sha for both and the bundle declares a comparable pair
 * where none exists (the verifier correctly flags `ARMS_IDENTICAL`). That is a
 * FABRICATED identity, so this refuses it: the directory must be its own
 * repository ROOT, otherwise there is no per-arm source identity to report.
 */
function gitShaOf(dir) {
  if (typeof dir !== "string" || dir === "") return null;
  try {
    const top = execFileSync("git", ["-C", dir, "rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
    // The arm dir must BE the repo root (or a path equal to it after
    // normalisation). Anything else means git answered for an ANCESTOR repo.
    if (resolve(top) !== resolve(dir)) return null;
    const sha = execFileSync("git", ["-C", dir, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    return /^[0-9a-f]{40}$/.test(sha) ? sha : null;
  } catch {
    return null;
  }
}

function paidEnvironmentPresent() {
  const key = process.env.OPENAI_API_KEY;
  const paid = process.env.RUN_PAID_BENCHMARKS;
  const hasKey = typeof key === "string" && key.trim() !== "";
  const hasPaidSwitch = typeof paid === "string" && paid.trim() !== "" && paid.trim() !== "0" && paid.trim().toLowerCase() !== "false";
  return { hasKey, hasPaidSwitch };
}

/** A CLEAN tracked tree, as the `require-clean` observer would see it. */
function treeClean() {
  try {
    return git(["status", "--porcelain"]) === "";
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// The local COUNTING HTTP stub — the only network surface, and it is loopback.
// ---------------------------------------------------------------------------

/**
 * Start a loopback HTTP server that COUNTS every request it receives and answers
 * an OpenAI-compatible SSE completion. It exists so "0 external requests" is a
 * MEASUREMENT: if any code path under test reached the network, `requests` would
 * be non-zero and the gate would fail.
 */
function startCountingStub() {
  let requests = 0;
  const seen = [];
  const server = createServer((req, res) => {
    requests += 1;
    seen.push(`${req.method ?? "?"} ${req.url ?? "?"}`);
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => {
      void body;
      const payload = {
        id: "chatcmpl-stub",
        object: "chat.completion.chunk",
        created: 0,
        model: "stub",
        choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      };
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      res.write(`data: ${JSON.stringify(payload)}\n\n`);
      res.write("data: [DONE]\n\n");
      res.end();
    });
  });
  return new Promise((resolvePromise) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address !== null ? address.port : 0;
      resolvePromise({
        baseUrl: `http://127.0.0.1:${port}/v1`,
        count: () => requests,
        seen: () => [...seen],
        close: () => new Promise((done) => server.close(() => done())),
      });
    });
  });
}

// ---------------------------------------------------------------------------
// Running the SHIPPED CLI as a real subprocess
// ---------------------------------------------------------------------------

/** Run `node apps/cli/dist/main.js <args>` with a hermetic env. */
function runCli(args, env) {
  const res = spawnSync(process.execPath, [CLI_ENTRY, ...args], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    timeout: 900_000,
    maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, ...env },
  });
  return { code: res.status ?? 1, out: `${res.stdout ?? ""}\n${res.stderr ?? ""}` };
}

/**
 * The ASYNC twin of `runCli`, for the one phase that must NOT block this
 * process: POS-FWD.
 *
 * WHY IT MUST BE ASYNC — the loopback COUNTING stub lives in THIS process. A
 * `spawnSync` blocks this event loop for the whole child lifetime, so the stub's
 * server callback never runs: the child's HTTP request is accepted by the kernel
 * but never answered, its client timeout fires, the model client emits a `retry`,
 * and B2 then reserves cost for that second physical attempt against a frozen
 * budget that has no retry headroom — the run refuses with BUDGET_EXHAUSTED and
 * the stub counter stays at 0. That is an artefact of the harness deadlocking
 * itself, not a property of the release CLI, so it must not be mistaken for one.
 * Running the child asynchronously keeps the event loop free to serve the stub,
 * which is what makes "physical requests === ledger.committed" a real
 * MEASUREMENT instead of a number that can only ever be 0.
 */
function runCliAsync(args, env) {
  return new Promise((resolvePromise) => {
    const child = spawn(process.execPath, [CLI_ENTRY, ...args], {
      cwd: REPO_ROOT,
      windowsHide: true,
      env: { ...process.env, ...env },
    });
    let out = "";
    child.stdout.on("data", (c) => {
      out += c;
    });
    child.stderr.on("data", (c) => {
      out += c;
    });
    const timer = setTimeout(() => child.kill(), 900_000);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolvePromise({ code: code ?? 1, out });
    });
  });
}

// ---------------------------------------------------------------------------
// The NEGATIVE matrix — every preflight counterexample, on the release entry.
// ---------------------------------------------------------------------------

/**
 * Each row is a command the release CLI must REFUSE, with the reason code that
 * makes the refusal auditable rather than "it exited non-zero". The HTTP stub's
 * counter is checked around the whole matrix.
 */
async function runNegativeMatrix(stub, dir) {
  const cfgInlineCatalog = join(dir, "neg-inline-catalog.json");
  writeFileSync(
    cfgInlineCatalog,
    `${JSON.stringify({ candidateId: "tool_call_efficiency_v1", catalog: [], selection: { caseIds: [] } }, null, 2)}\n`,
    "utf8",
  );
  const cfgOk = join(dir, "neg-config.json");
  writeFileSync(cfgOk, `${JSON.stringify({ candidateId: "tool_call_efficiency_v1", selectionEvidence: { root: REPO_ROOT } }, null, 2)}\n`, "utf8");

  const cases = [
    {
      id: "f6-unknown-flag",
      args: ["prereg", "build", cfgOk, "--out", join(dir, "a.json"), "--model", "gpt-4"],
      expectCode: "CLI_USAGE",
    },
    {
      id: "f6-duplicate-out",
      args: ["prereg", "build", cfgOk, "--out", join(dir, "a.json"), "--out", join(dir, "b.json")],
      expectCode: "CLI_USAGE",
    },
    {
      id: "f6-extra-positional",
      args: ["prereg", "build", cfgOk, join(dir, "b.json"), "--out", join(dir, "a.json")],
      expectCode: "CLI_USAGE",
    },
    {
      id: "a3-run-mode-omitted",
      args: ["prereg", "run", join(dir, "p.json"), "--authorization", join(dir, "a.json"), "--budget-dir", join(dir, "bud"), "--out", join(dir, "o")],
      expectCode: "CLI_USAGE",
    },
    {
      id: "a3-run-mode-invalid",
      args: ["prereg", "run", join(dir, "p.json"), "--authorization", join(dir, "a.json"), "--budget-dir", join(dir, "bud"), "--out", join(dir, "o"), "--mode", "auto"],
      expectCode: "CLI_USAGE",
    },
    {
      id: "a3-run-budget-out-overlap",
      args: ["prereg", "run", join(dir, "p.json"), "--authorization", join(dir, "a.json"), "--budget-dir", join(dir, "o"), "--out", join(dir, "o"), "--mode", "first-run"],
      expectCode: "CLI_USAGE",
    },
    {
      id: "a1-build-inline-catalog",
      args: ["prereg", "build", cfgInlineCatalog, "--out", join(dir, "c.json")],
      expectCode: "SELECTION_PROVENANCE_UNPROVEN",
    },
    {
      id: "f7-validate-missing-artifact",
      args: ["prereg", "validate", join(dir, "does-not-exist.json")],
      expectCode: "cannot read",
    },
    {
      id: "a4-run-unreadable-prereg",
      args: ["prereg", "run", join(dir, "p.json"), "--authorization", join(dir, "no-auth.json"), "--budget-dir", join(dir, "bud"), "--out", join(dir, "o"), "--mode", "first-run"],
      expectCode: "cannot read",
    },
  ];

  const results = [];
  for (const c of cases) {
    const before = stub.count();
    const res = runCli(c.args, {});
    const after = stub.count();
    const lines = res.out.trim().split(/\r?\n/);
    const matched = res.out.includes(c.expectCode);
    results.push({
      id: c.id,
      command: `agent ${c.args.join(" ")}`,
      exitCode: res.code,
      expectedCode: c.expectCode,
      codeObserved: matched,
      refused: res.code !== 0,
      httpRequestsDuring: after - before,
      firstLine: lines.find((l) => l.trim() !== "") ?? "",
      ok: res.code !== 0 && matched && after - before === 0,
    });
  }
  return results;
}

// ---------------------------------------------------------------------------
// The POSITIVE certification — build + validate on the release entry (0 provider)
// ---------------------------------------------------------------------------

async function runPositiveCertification(stub, dir, env) {
  const selection = await selectionEvidence(dir, env);
  const cfgPath = join(dir, "pos-config.json");
  writeFileSync(cfgPath, `${JSON.stringify(selection.config, null, 2)}\n`, "utf8");
  const preregPath = join(dir, "pos-prereg.json");
  const validatePath = join(dir, "pos-validate.json");

  const before = stub.count();
  const build = runCli(["prereg", "build", cfgPath, "--out", preregPath], env);
  const validate = build.code === 0 ? runCli(["prereg", "validate", preregPath, "--json"], env) : { code: 1, out: "(skipped: build failed)" };
  const after = stub.count();

  return {
    selectionProvenance: selection.provenance,
    build: { exitCode: build.code, lines: build.out.trim().split(/\r?\n/).slice(0, 8) },
    validate: { exitCode: validate.code, lines: validate.out.trim().split(/\r?\n/).slice(0, 8) },
    httpRequestsDuring: after - before,
    ok: build.code === 0 && validate.code === 0 && after - before === 0,
  };
}

/**
 * Build the config the release `prereg build` consumes: the REAL frozen selection
 * (no inline catalog), plus the subject identity this script can establish
 * independently (git HEAD, the two frozen arm build digests). The provider
 * identity, runtime digest and request profile are derived by `prereg build`
 * itself from the same env, so they cannot drift.
 */
async function selectionEvidence(dir, env) {
  const mod = await import(pathToFileURL(EVAL_ENTRY).href);
  const resolved = mod.selectionFromFrozenEvidence({ root: REPO_ROOT });
  const baseDir = env.R97_ARM_BASELINE_DIR;
  const candDir = env.R97_ARM_CANDIDATE_DIR;
  const baselineArmDigest = mod.computeArmBuildDigestV1(baseDir);
  const candidateArmDigest = mod.computeArmBuildDigestV1(candDir);
  const candidateSourceSha = git(["rev-parse", "HEAD"]);
  const config = {
    candidateId: "tool_call_efficiency_v1",
    selectionEvidence: { root: REPO_ROOT },
    subject: {
      candidateSourceSha,
      baselineArmDigest,
      candidateArmDigest,
      cleanTreePolicy: "require-clean",
      runtimeConfigDigest: "(derived by prereg build)",
    },
    evaluation: {
      judgeId: "judge-formal",
      judgeDigest: sha256Hex("judge-formal"),
      verifierDigest: sha256Hex("verifier-formal"),
      scorerDigest: sha256Hex("scorer-formal"),
      decisionPolicy: mod.DEFAULT_DECISION_POLICY_V3,
    },
    schedule: { repetitions: 2, orderSeed: 7 },
    budget: {
      maxModelCallsPerRun: 30,
      maxToolCalls: 100,
      // Phase F — the SAME constant the clock guard uses. The gate freezes the
      // campaign deadline as `clock() + caps.maxDurationMs`, so if these two ever
      // diverged the guard would validate a deadline nobody creates.
      maxDurationMs: DECLARED_MAX_DURATION_MS,
      maxInputTokens: 320_000,
      maxOutputTokens: 64_000,
      maxTotalTokens: 384_000,
      // B5 — NULL, deliberately. The only reachable endpoint in this offline gate
      // is the loopback counting stub: a `127.0.0.1` proxy whose billing terms
      // this snapshot cannot claim, so `resolveUsdMicrosPerCall` returns `null`
      // (unknown). A money-bounded artifact would then (correctly) refuse with
      // `PRICING_UNKNOWN`. An offline run spends nothing, so the honest choice is
      // to NOT declare a USD bound rather than fabricate one; USD enforcement
      // itself is proven by the B2 unit tests, not by this gate.
      maxUsdMicros: null,
      pricingUnknownPolicy: "refuse",
    },
    isolation: {
      driverSchema: "r97-driver-v1",
      workerSchema: "r97-worker-v1",
      isolationBackendId: "process-exec",
      isolationStrength: "process",
      resumeStateSchema: "r97-execution-state-v1",
    },
  };
  void dir;
  return {
    config,
    provenance: {
      cases: resolved.frozen.cases.length,
      selectionProvenanceDigest: resolved.selection.selectionProvenanceDigest,
      candidateSourceSha,
      baselineArmDigest,
      candidateArmDigest,
    },
  };
}

// ---------------------------------------------------------------------------
// POS-EXEC — the full paired schedule through the SHIPPED adapter, in-process
// ---------------------------------------------------------------------------

/**
 * A counting fake provider that terminates the agent loop in one physical call
 * per arm-run: it yields usage then a `completed` event. `entered()` is the
 * MEASURED physical call count (the report's `physicalProviderCalls`).
 */
function countingFakeProvider() {
  let entered = 0;
  const provider = {
    id: "prereg-e2e-fake",
    async listModels() {
      return [];
    },
    createClient() {
      return {
        async *generate() {
          entered += 1;
          yield { type: "usage", usage: { inputTokens: 7, outputTokens: 3 }, timestamp: 0 };
          yield { type: "completed", result: { finishReason: "stop" }, timestamp: 0 };
        },
      };
    },
  };
  return { provider, entered: () => entered };
}

/**
 * B3/B5 — a REAL, loadable arm build. After B3 the executor spawns the arm's
 * OWN build as an isolated worker which imports `apps/cli/dist/benchmark-command.js`
 * FROM ITS CHECKOUT, so an inert placeholder module can no longer represent an
 * arm: B3 forbids synthesizing a checkout from empty module stubs, and every
 * entry here is a genuine loadable module. This entry
 * exports the versioned mechanism probe and a real `runOneCase` whose one model
 * call is resolved through the stdio proxy provider the worker hands it (which
 * the driver services with the ONE budget channel → the loopback stub). A
 * per-build `marker` and `activate` flag make the two arms genuinely distinct —
 * different entry bytes ⇒ different build-closure digest AND a different
 * observable probe.
 */
/**
 * R0/S1 — the ABI list the fixture arm declares. RETURNED from the driver's own
 * constant space (the same `R97_ARM_ABI` the executor consumes), never re-typed,
 * so the fixture cannot claim a capability the real ABI does not contain.
 */
async function fixtureArmAbi() {
  const mod = await import(pathToFileURL(CLI_BENCHMARK_ENTRY).href);
  const abi = mod.R97_ARM_ABI;
  const toolBudget = mod.R97_ARM_ABI_TOOL_BUDGET;
  if (!Array.isArray(abi) || abi.length === 0 || typeof toolBudget !== "string") {
    throw new Error(
      "fixtureArmAbi: the built CLI exports no R97_ARM_ABI capability list — refusing to write a fixture arm that would claim an ABI it cannot import",
    );
  }
  return [...abi];
}

/**
 * R0/S1/F1 + Phase G — the synthetic fixture arm.
 *
 * WHAT CHANGED AND WHY
 * --------------------
 * A7a previously REFUSED this fixture with `ARM_WORKER_ABI_UNSUPPORTED`: the arm
 * exported only `R97_ARM_PROBE` + `runOneCase`, so the worker reported `abi: []`
 * and the S1 pre-check correctly refused it BEFORE the first model request. The
 * fixture therefore represented an arm built BEFORE S1 and could not exercise
 * the formal path at all.
 *
 * The arm now declares `R97_ARM_ABI` AND GENUINELY HONOURS IT. Declaring
 * `tool-budget-rpc-v1` while never calling the budget RPC would be a fabricated
 * capability — the exact forgery this round exists to prevent — so `runOneCase`
 * constructs a REAL `ToolOrchestrator` bound to the worker's forwarded
 * `opts.toolBudget` and executes a REAL `write_file` through it. Each dispatch is
 * routed through `budget.reserve()`/`settle()` over the driver's stdio channel,
 * so the campaign's durable tool cap is genuinely enforced on this arm.
 */
function armEntrySource(marker, activate, abi) {
  return [
    `export const ${ARM_PROBE_EXPORT} = ${JSON.stringify(`probe:${marker}`)};`,
    // R0/S1 — the versioned capability list, taken from the built CLI so it
    // cannot drift from what `prereg-arm-executor` requires.
    `export const R97_ARM_ABI = ${JSON.stringify(abi)};`,
    `import { ToolOrchestrator, ToolRegistry, writeFileTool } from ${JSON.stringify(TOOLS_DIST)};`,
    "import { mkdtempSync } from 'node:fs';",
    "import { join } from 'node:path';",
    "import { tmpdir } from 'node:os';",
    "export async function runOneCase(caseDef, opts, _suite) {",
    "  const client = opts.provider.createClient({ id: 'arm-fixture' }, {});",
    "  let input = 0;",
    "  let output = 0;",
    "  for await (const ev of client.generate({ messages: [] }, new AbortController().signal)) {",
    "    if (ev.type === 'usage') { input += ev.usage.inputTokens; output += ev.usage.outputTokens; }",
    "    if (ev.type === 'completed' || ev.type === 'error') break;",
    "  }",
    // THE REAL BUDGETED TOOL DISPATCH. `opts.toolBudget` is the worker's proxy
    // budget; binding it into the orchestrator is what makes the declared
    // `tool-budget-rpc-v1` capability TRUE rather than claimed.
    "  const workspace = mkdtempSync(join(tmpdir(), 'e2e-arm-ws-'));",
    "  const registry = new ToolRegistry();",
    "  registry.register(writeFileTool);",
    "  const orchestrator = new ToolOrchestrator({",
    "    registry,",
    "    workspaceRoot: workspace,",
    "    events: { async emit() {} },",
    "    ...(opts.toolBudget !== undefined ? { toolBudget: opts.toolBudget } : {}),",
    "  });",
    "  const sessionId = 'e2e-arm-session';",
    "  const permissions = { rules: [",
    "    { action: 'read', resource: 'file', effect: 'allow' },",
    "    { action: 'edit', resource: 'file', effect: 'allow' },",
    "  ] };",
    "  const sandboxPolicy = {",
    "    filesystem: { mode: 'workspace-write', allowedPaths: [workspace] },",
    "    network: { mode: 'deny' },",
    "    process: { timeoutMs: 5000, maxOutputBytes: 65536 },",
    "  };",
    "  let toolCallCount = 0;",
    "  let dispatchStatus = null;",
    "  try {",
    "    const callId = 'e2e-arm-call-1';",
    "    const r = await orchestrator.execute(",
    "      { id: callId, sessionId, turnId: 't1', agentId: 'a1', call: { id: callId, name: 'write_file', args: { path: join(workspace, 'arm-proof.txt'), content: 'written-by-' + caseDef.id } } },",
    "      { sessionId, turnId: 't1', agentId: 'a1', cwd: workspace, signal: new AbortController().signal, permissions, sandboxPolicy },",
    "    );",
    "    dispatchStatus = r.status;",
    "    toolCallCount = 1;",
    "  } catch (err) {",
    // A REFUSED dispatch is a REAL outcome of the budget path (the campaign cap
    // or the deadline refused it), not a driver failure — record it, never
    // swallow it, and never let it masquerade as a successful write.
    "    dispatchStatus = 'refused:' + String(err && err.message ? err.message : err);",
    "  }",
    "  const outcome = {",
    "    caseId: caseDef.id,",
    "    status: 'failed',",
    "    actualStatus: 'completed',",
    "    events: [],",
    "    metrics: { turn_count: 1, tool_call_count: toolCallCount, tokens_input: input, tokens_output: output, context_tokens: 0, compaction_count: 0, duration_ms: 0, retry_count: 0, verification_failures: 0, human_interventions: 0, estimated_cost: 0, usage_unknown: 0, cache_tokens_read: 0, cache_tokens_created: 0, model_call_count: 1 },",
    "    violations: [],",
    `    reason: ${JSON.stringify(`arm-probe:${marker}`)} + '/dispatch:' + String(dispatchStatus),`,
    "    suite: caseDef.suite || 'regression',",
    "    judgeVersion: '1.0.0',",
    "    terminationReason: 'verified_incomplete',",
    "  };",
    ...(activate ? [`  outcome.activationEvidenceV2 = { events: [{ eventId: ${JSON.stringify(`probe:${marker}`)} }] };`] : []),
    "  return outcome;",
    "}",
    "",
  ].join("\n");
}

/**
 * Two REAL, loadable frozen arm checkouts. The declared entry
 * (`apps/cli/dist/benchmark-command.js`) is a genuine module exporting
 * `R97_ARM_PROBE` + `runOneCase`; the other declared closure entries are real
 * modules too (distinct per arm), so the shared closure walker resolves a
 * build-closure digest from the arm's OWN bytes.
 */
async function writeArmCheckout(dir, marker, activate, entries, abi) {
  for (const rel of entries) {
    const abs = join(dir, rel);
    mkdirSync(dirname(abs), { recursive: true });
    const source = rel === ARM_ENTRY_REL
      ? armEntrySource(marker, activate, abi)
      : `export const R97_ARM_SIBLING_STUB = ${JSON.stringify(`sibling:${marker}`)};\n`;
    writeFileSync(abs, source, "utf8");
  }
  // R1/F2 — this tree was produced by the harness's OWN fixture writer, so it
  // carries the synthetic-fixture marker. That marker is a PROVENANCE BREADCRUMB,
  // NOT a trust source: the caller that wrote the tree must also PIN it with
  // `createFixtureCheckoutTrust` (POS-EXEC does; the release-CLI subprocess cannot,
  // which is why POS-FWD now asserts its pre-request refusal). The marker travels
  // with the artifact and is required to be a regular file, but on its own it
  // grants nothing — writing, copying, hard-linking or symlinking it upgrades
  // nothing. This does NOT make the fixture a network sandbox, and a real checkout
  // is refused before it starts.
  const executorMod = await import(pathToFileURL(EXECUTOR_ENTRY).href);
  const markerName = executorMod.FIXTURE_CHECKOUT_MARKER_FILENAME;
  if (typeof markerName !== "string" || markerName === "") {
    throw new Error(
      "writeArmCheckout: the executor exports no FIXTURE_CHECKOUT_MARKER_FILENAME — refusing to write a fixture tree whose marker would not match the executor's refusal rule",
    );
  }
  writeFileSync(join(dir, markerName), `${JSON.stringify({ writer: "scripts/e4/prereg-production-e2e.mjs", schema: "r97-synthetic-fixture-checkout-v1", marker })}\n`, "utf8");
}

/**
 * N6/N7 — the DURABLE COST LEDGER read from the budget directory the run actually
 * used (`cost-budget.json`), as TWO independent facts: the read-only charged TOTAL
 * and the RAW per-request journal entries. `exists:false` means no ledger at all —
 * explicitly UNKNOWN, never `0`. `entries:null` on an existing file means a LEGACY
 * total-only ledger whose total is readable but whose arm attribution does NOT
 * exist (and must not be invented from the total — the F3 defect).
 */
function journalFromFile(budgetDir) {
  let file;
  try {
    file = JSON.parse(readFileSync(join(budgetDir, "cost-budget.json"), "utf8"));
  } catch {
    return { exists: false, chargedTotalTokens: null, journalSchemaVersion: null, entries: null };
  }
  const charged = file.charged;
  const total = charged !== undefined && charged !== null ? charged.totalTokens : undefined;
  const chargedTotalTokens = Number.isSafeInteger(total) ? total : null;
  const journal = file.journal;
  if (journal === undefined || journal === null || !Array.isArray(journal.entries)) {
    return { exists: true, chargedTotalTokens, journalSchemaVersion: null, entries: null };
  }
  return {
    exists: true,
    chargedTotalTokens,
    journalSchemaVersion: typeof journal.schemaVersion === "string" ? journal.schemaVersion : null,
    entries: journal.entries,
  };
}

/**
 * N7/F3 — recompute total/baseline/candidate/delta INDEPENDENTLY from the raw
 * journal entries. This script deliberately does NOT reuse the aggregate's own
 * arithmetic: the release evidence must be able to disagree with it.
 *
 * A MEASURED entry contributes real tokens to its arm; a RESERVED_UPPER_BOUND
 * entry makes its arm's measured total NOT_OBSERVED (`null`) — a conservative
 * reservation is a bound, never consumption, so it can never be summed as one.
 */
function independentArmTokens(journal) {
  if (journal === null || journal.exists !== true) {
    return { total: null, attributedTotal: null, baseline: null, candidate: null, delta: null, basis: "NO_JOURNAL", requests: { baseline: 0, candidate: 0 } };
  }
  if (journal.entries === null) {
    return { total: journal.chargedTotalTokens, attributedTotal: null, baseline: null, candidate: null, delta: null, basis: "LEGACY_TOTAL_ONLY", requests: { baseline: 0, candidate: 0 } };
  }
  const measured = { baseline: 0, candidate: 0 };
  const unknown = { baseline: 0, candidate: 0 };
  const requests = { baseline: 0, candidate: 0 };
  let attributedTotal = 0;
  let reserved = 0;
  for (const e of journal.entries) {
    if (e === null || typeof e !== "object") continue;
    attributedTotal += Number.isSafeInteger(e.chargedTotalTokens) ? e.chargedTotalTokens : 0;
    if (e.arm !== "baseline" && e.arm !== "candidate") continue;
    requests[e.arm] += 1;
    if (e.basis === "MEASURED") {
      measured[e.arm] += (e.inputTokens ?? 0) + (e.outputTokens ?? 0);
    } else {
      unknown[e.arm] += 1;
      reserved += (e.reservedInputTokens ?? 0) + (e.reservedOutputTokens ?? 0);
    }
  }
  const known = unknown.baseline === 0 && unknown.candidate === 0;
  return {
    total: journal.chargedTotalTokens,
    attributedTotal,
    baseline: known ? measured.baseline : null,
    candidate: known ? measured.candidate : null,
    delta: known ? measured.candidate - measured.baseline : null,
    basis: unknown.baseline + unknown.candidate > 0 ? "UNKNOWN_RESERVATION" : "JOURNAL_PER_ARM",
    reservedUpperBound: reserved,
    requests,
  };
}

/** Exact, null-aware token equality: NOT_OBSERVED (`null`) equals only NOT_OBSERVED. */
function sameTokens(a, b) {
  if (a === undefined || a === null) return b === undefined || b === null;
  return a === b;
}

/**
 * N7/F3 — the aggregate's own cost block must match this script's INDEPENDENT
 * recomputation from the raw journal bytes. This replaces the old
 * `aggregateTokensDelta === (journalChargedTokens ?? 0)` assertion, which treated
 * the campaign TOTAL as if it were the candidate-vs-baseline DIFFERENCE.
 */
function costMatchesIndependent(aggregateCost, independent) {
  if (aggregateCost === undefined || aggregateCost === null) return false;
  return (
    sameTokens(aggregateCost.totalTokens, independent.total)
    && sameTokens(aggregateCost.baselineTokens, independent.baseline)
    && sameTokens(aggregateCost.candidateTokens, independent.candidate)
    && sameTokens(aggregateCost.deltaTokens, independent.delta)
  );
}

/** The durable R97 ledger view, re-derived from the file the subprocess wrote. */
function ledgerViewFromFile(budgetDir) {  const file = JSON.parse(readFileSync(join(budgetDir, R97_LEDGER_FILE), "utf8"));
  let committed = 0;
  let outstanding = 0;
  let unknown = 0;
  let transportRetries = 0;
  for (const e of file.entries) {
    if (e.status === "committed") {
      committed += e.consumed ?? e.reserved;
      transportRetries += e.transportRetries ?? 0;
    } else if (e.status === "reserved") outstanding += e.reserved;
    else if (e.status === "unknown") unknown += e.reserved;
  }
  return {
    granted: file.campaignModelCalls,
    committed,
    outstanding,
    unknown,
    transportRetries,
    remaining: file.campaignModelCalls - committed - outstanding - unknown,
  };
}

async function runPositiveExecution(dir, env, runIdentity) {
  const evalMod = await import(pathToFileURL(EVAL_ENTRY).href);
  const runnerMod = await import(pathToFileURL(RUNNER_ENTRY).href);
  const identityMod = await import(pathToFileURL(IDENTITY_ENTRY).href);

  // S6b/Phase H — the identity the bundle root must carry. Both arm SHAs are
  // READ from the real arm checkouts this phase was handed, never invented; the
  // driver SHA is this repo's own HEAD.
  const armSourceSha = { baseline: gitShaOf(env.R97_ARM_BASELINE_DIR), candidate: gitShaOf(env.R97_ARM_CANDIDATE_DIR) };
  const driverSha = (() => {
    const sha = git(["rev-parse", "HEAD"]);
    return typeof sha === "string" && /^[0-9a-f]{40}$/.test(sha) ? sha : null;
  })();

  // 1. the artifact, built IN-PROCESS from the same frozen selection + env.
  const { config } = await selectionEvidence(dir, env);
  const profile = identityMod.formalExecutionProfile(env);
  const resolved = evalMod.selectionFromFrozenEvidence({ root: REPO_ROOT });
  const artifact = evalMod.buildToolCallEfficiencyPreregistrationV2({
    ...config,
    catalog: resolved.catalog,
    selection: resolved.selection,
    suiteId: resolved.suiteId,
    suiteVersion: resolved.suiteVersion,
    subject: { ...config.subject, runtimeConfigDigest: profile.runtimeConfigDigest },
    provider: {
      providerId: profile.provider.providerId,
      modelId: profile.provider.modelId,
      endpointBaseUrl: profile.provider.endpointBaseUrl,
      requestProfile: profile.requestProfile,
    },
  });
  const preregistrationJson = evalMod.serializePreregistrationV2(artifact);

  // 2. the SHIPPED adapter: the real observer and the real arm executor.
  // R1/F2 — this TEST PARENT wrote the two arm checkouts, so it is the only party
  // that can and does PIN them. The marker file alone is no longer a trust source:
  // a self-written/copied/symlinked marker, or a swapped entry, upgrades nothing
  // (see `apps/cli/src/prereg-fixture-checkout-trust.test.ts`).
  const executorMod = await import(pathToFileURL(EXECUTOR_ENTRY).href);
  const trustedFixtureCheckouts = executorMod.createFixtureCheckoutTrust(
    env.R97_ARM_BASELINE_DIR,
    env.R97_ARM_CANDIDATE_DIR,
  );
  const runner = runnerMod.createProductionPreregRunner({ rootDir: REPO_ROOT, env, trustedFixtureCheckouts });
  const observation = await runner.observe(artifact);

  const authorizationJson = `${JSON.stringify(
    {
      schemaVersion: "tool-call-efficiency-authorization-v2",
      preregistrationDigest: artifact.preregistrationDigest,
      candidateSourceSha: artifact.subject.candidateSourceSha,
      baselineArmDigest: artifact.subject.baselineArmDigest,
      candidateArmDigest: artifact.subject.candidateArmDigest,
      providerId: artifact.provider.providerId,
      modelId: artifact.provider.modelId,
      endpointDigest: artifact.provider.endpointDigest,
      caps: {
        maxModelCalls: artifact.budget.campaignWorstCaseModelCalls,
        maxToolCalls: artifact.budget.maxToolCalls,
        maxDurationMs: artifact.budget.maxDurationMs,
        maxInputTokens: artifact.budget.maxInputTokens,
        maxOutputTokens: artifact.budget.maxOutputTokens,
        maxTotalTokens: artifact.budget.maxTotalTokens,
        maxUsdMicros: artifact.budget.maxUsdMicros,
      },
      issuedAtMs: 1_000,
      expiresAtMs: 9_000_000_000_000,
      approvalId: "e2e-offline-TEST_ONLY-approval",
      allowResume: false,
      // N3 — this is the SEPARATELY-IDENTIFIED SYNTHETIC-FIXTURE class, NOT a
      // paid approval. It carries `paid:false` + `fixtureMode`, and the parser
      // refuses those two together, so it can never be confused with (or widened
      // into) a paid authorization. The gate admits it only after the OBSERVED
      // transport proves itself non-billable: here the artifact's provider
      // identity is the unbilled stub (`usdMicrosPerCall = 0`). This script still
      // refuses to run at all if a real key or the paid switch is selectable, and
      // the class is recorded in `authorizationFixture` so "the gate admitted a
      // fixture" is never read as "a paid experiment ran".
      paid: false,
      fixtureMode: "synthetic-offline-v1",
    },
    null,
    2,
  )}\n`;

  const budgetDir = join(dir, "pos-exec-budget");
  const resultsDir = join(dir, "pos-exec-runs");
  const fake = countingFakeProvider();

  // R1/F1 — the fixture class is admitted ONLY through a test-host-injected,
  // endpoint- and model-bound NON-BILLABLE transport. `makeProvider` is the
  // operator's credential-bearing factory; it must never be entered on this path,
  // and `operatorFactoryEntered` is a MEASURED count of that.
  let operatorFactoryEntered = 0;
  const admission = await evalMod.openPreregisteredCampaignGate({
    preregistrationJson,
    authorizationJson,
    observation,
    budgetDir,
    mode: "first-run",
    now: () => NOW,
    makeProvider: () => {
      operatorFactoryEntered += 1;
      return fake.provider;
    },
    nonBillableTransport: evalMod.createNonBillableFixtureTransport({
      endpointBaseUrl: profile.provider.endpointBaseUrl ?? null,
      providerId: observation.providerId,
      modelId: observation.modelId,
      provider: fake.provider,
    }),
  });
  if (admission.status !== "ADMITTED") {
    return {
      ok: false,
      stage: "gate",
      code: admission.code,
      reason: admission.reason,
      providerFactoryCalls: admission.providerFactoryCalls,
      providerCalls: admission.providerCalls,
    };
  }

  const run = await evalMod.runPreregisteredCampaign({
    admission,
    prereg: artifact,
    resultsDir,
    runArm: runner.runArm,
    resume: false,
    now: () => NOW,
  });

  // 3. re-verify EVERY arm's evidence from the bytes it wrote (A6, from outside).
  const evidenceRoot = join(resultsDir, evalMod.PREREG_RUN_EVIDENCE_DIRNAME);
  let verified = 0;
  let unverified = 0;
  const verifyProblems = [];
  for (const record of run.records) {
    if (record.outcome.status === "error" || record.outcome.evidence === undefined) continue;
    const v = evalMod.verifyArmEvidenceFromArtifacts(
      join(evidenceRoot, record.armRunId),
      {
        preregistrationDigest: record.preregistrationDigest,
        planDigest: record.planDigest,
        armRunId: record.armRunId,
        armId: record.armId,
        caseId: record.caseId,
        repetition: record.repetition,
        orderIndex: record.orderIndex,
      },
      record.outcome.evidence,
    );
    if (v.verified) verified += 1;
    else {
      unverified += 1;
      verifyProblems.push(...v.problems);
    }
  }

  // B5 — the aggregate is fed the DURABLE ledger view the gate opened, never an
  // injected fake counter or the artifact's initial worst case ("不向 aggregate
  // 注入 fake.entered() 或初始 campaignWorstCaseModelCalls 当真实账本数").
  const ledgerView = await admission.ledger.view();
  // N7/F3 — the token metrics are bound to the DURABLE COST JOURNAL read as two
  // independent facts (charged TOTAL + raw per-request attribution), not to the
  // arms' self-reported `tokensUsed`, and never as `total == delta`.
  const journal = await evalMod.readCostJournal(budgetDir);
  const aggregate = evalMod.aggregatePreregisteredCampaign(run, artifact, {
    providerCalls: ledgerView.committed,
    budgetRemaining: ledgerView.remaining,
    journalChargedTokens: journal.chargedTotalTokens,
    journal,
  });
  // The aggregate's per-arm cost must equal an INDEPENDENT recomputation from the
  // raw journal bytes this script reads itself.
  const independent = independentArmTokens(journal);
  const journalChargedTokens = journal.chargedTotalTokens;

  // S6b/Phase H — the bundle ROOT files the readiness verifier reads. Written
  // here because every input is in scope: the run records (schedule + the arm
  // manifests), the durable aggregate, and the cost journal read back from disk.
  const bundleRecords = run.records.map((r) => ({
    armRunId: r.armRunId,
    armId: r.armId,
    caseId: r.caseId,
    repetition: r.repetition,
    orderIndex: r.orderIndex,
    preregistrationDigest: r.preregistrationDigest,
    planDigest: r.planDigest,
    declaredEvidence: r.outcome.evidence,
    manifestPath: join(evidenceRoot, r.armRunId, "manifest.json"),
    sourceSha: armSourceSha[r.armId] ?? null,
  }));
  const bundle = writeEvidenceBundleRoot(evidenceRoot, {
    schemaVersion: READINESS_EVIDENCE_SCHEMA,
    driverSha,
    runId: runIdentity.identity.runId ?? null,
    attempt: runIdentity.identity.attempt ?? null,
    platform: runIdentity.identity.platform ?? null,
    records: bundleRecords,
    aggregate,
    journal,
  });

  const statuses = run.records.reduce((acc, r) => {
    acc[r.outcome.status] = (acc[r.outcome.status] ?? 0) + 1;
    return acc;
  }, {});

  const out = {
    transport: "in-process-adapter",
    executionBackend: "in-process",
    preregistrationDigest: artifact.preregistrationDigest,
    planDigest: artifact.schedule.planDigest,
    logicalRuns: artifact.schedule.logicalRuns,
    scheduledArmRuns: run.records.length,
    armStatuses: statuses,
    physicalProviderCalls: fake.entered(),    ledgerCommitted: ledgerView.committed,
    ledgerRemaining: ledgerView.remaining,
    journalChargedTokens,
    // N7/F3 — total consumption and the candidate-vs-baseline CHANGE, each
    // reported separately and each independently recomputable from the raw journal.
    tokensTotal: aggregate.cost.totalTokens,
    tokensBaseline: aggregate.cost.baselineTokens,
    tokensCandidate: aggregate.cost.candidateTokens,
    tokensDelta: aggregate.cost.deltaTokens,
    tokensBasis: aggregate.cost.basis,
    tokensReservedUpperBound: aggregate.cost.reservedUpperBound,
    tokensProblems: aggregate.cost.problems,
    independentTokens: independent,
    providerFactoryCalls: admission.providerFactoryCalls,
    // R1/F1 — MEASURED: the operator's credential-bearing factory entries on a
    // fixture admission. Must be 0; the injected non-billable provider is used.
    operatorFactoryEntered,
    evidenceVerified: verified,
    evidenceUnverified: unverified,
    verifyProblems: verifyProblems.slice(0, 5),
    decision: aggregate.decision.decision,
    decisionReason: aggregate.decision.reason ?? null,
    // N6 — `ok` no longer excludes `error` records from the comparison. The old
    // predicate (`records.filter(r => r.outcome.status !== "error" && ...)`) let a
    // campaign whose arms ALL died satisfy the count trivially, because the
    // right-hand side collapsed to 0. Every EXPECTED arm run must now be present,
    // non-error, carry evidence, and be verified.
    // N7/F3 — and the aggregate's per-arm cost must equal this script's OWN
    // recomputation from the raw journal: a total is never accepted as a delta.
    ok:
      run.records.length === artifact.schedule.logicalRuns
      && fake.entered() > 0
      && operatorFactoryEntered === 0
      && run.records.every((r) => r.outcome.status !== "error" && r.outcome.evidence !== undefined)
      && verified === run.records.length
      && unverified === 0
      && costMatchesIndependent(aggregate.cost, independent),
  };
  return out;
}

/**
 * S6b/Phase H — WRITE THE EVIDENCE-BUNDLE ROOT FILES.
 *
 * WHY THIS EXISTS
 * ---------------
 * `scripts/e4/readiness-evidence-verify.mjs` declares the bundle contract
 * (`EVIDENCE_BUNDLE_FILES`, L53-60): it reads `identity.json`, `schedule.json`,
 * `aggregate.json` and `cost-journal.json` from the evidence ROOT, and the
 * per-arm artifacts from `<root>/evidence/<armRunId>/`. This producer used to
 * write ONLY the per-arm layer, so `--evidence-root` re-verification failed with
 * `MISSING_RAW_EVIDENCE: identity.json …; schedule.json …` — a structurally
 * incomplete bundle, not a path bug.
 *
 * NOTHING HERE IS INVENTED. Every value is either
 *   - measured by this run (SHAs, digests, the aggregate, the ledger view), or
 *   - READ BACK from the bytes the campaign/budget already wrote (the per-arm
 *     manifests and the durable cost journal's own `entries` array).
 * A field this run did not measure is OMITTED, never defaulted — the consumer
 * reports a named problem for a missing field, which is the honest outcome.
 *
 * WHAT IS DELIBERATELY STILL ABSENT: there is no TOOL-DISPATCH journal
 * (`dispatch-journal.json`). Nothing in this build produces one, so
 * `budgetEvidenceReady` stays NOT_PROVEN with `DISPATCH_JOURNAL_MISSING`. That is
 * expected; fabricating one to force a PASS is the F3 defect.
 */
function writeEvidenceBundleRoot(evidenceRoot, ctx) {
  const write = (name, value) => {
    writeFileSync(join(evidenceRoot, name), `${JSON.stringify(value, null, 2)}\n`, "utf8");
  };
  const problems = [];

  // --- the per-arm layer, in the layout the verifier expects ---------------
  // `readiness-evidence-verify.mjs` reads the per-arm artifacts from
  // `<evidenceRoot>/evidence/<armRunId>/` (EVIDENCE_BUNDLE_FILES.armEvidenceDir),
  // while the campaign writes them FLAT at `<resultsDir>/evidence/<armRunId>/`.
  // This bundle root IS that `evidence` directory, so the arms must be nested one
  // level deeper under it. Without this the verifier reports every arm as
  // `ARM_EVIDENCE_UNVERIFIED: artifact manifest.json is missing or unreadable`.
  // The copies are REAL BYTES (not rewritten), so each arm's manifest still
  // hashes to what the campaign wrote.
  const armEvidenceDir = join(evidenceRoot, "evidence");
  mkdirSync(armEvidenceDir, { recursive: true });
  for (const r of ctx.records) {
    const from = join(evidenceRoot, r.armRunId);
    const to = join(armEvidenceDir, r.armRunId);
    if (!existsSync(from)) continue;
    mkdirSync(to, { recursive: true });
    for (const f of ["manifest.json", "verifier.json", "security.json", "activation.json"]) {
      const src = join(from, f);
      if (existsSync(src)) copyFileSync(src, join(to, f));
    }
  }

  // --- identity.json ------------------------------------------------------
  // `arms.<id>.{sourceSha,buildDigest,entrySha256,clean}` are read from the ARM
  // MANIFESTS the campaign wrote (a real sha256 of the arm's own entry bytes),
  // not re-derived here. `clean` is TRUE because `require-clean` is a
  // precondition of this whole phase (the observer refuses a dirty tree), and
  // the arm checkouts are freshly materialised inside the disposable workspace.
  const armIdentity = (armId) => {
    const record = ctx.records.find((r) => r.armId === armId && r.manifestPath !== null);
    if (record === undefined) {
      problems.push(`identity: no manifest was written for the ${armId} arm`);
      return null;
    }
    let man;
    try {
      man = JSON.parse(readFileSync(record.manifestPath, "utf8"));
    } catch (err) {
      problems.push(`identity: the ${armId} manifest is unreadable (${err instanceof Error ? err.message : String(err)})`);
      return null;
    }
    const entry = {
      buildDigest: man.armBuildDigest,
      entrySha256: man.armEntrySha256,
      clean: true,
      probe: man.armProbe,
    };
    const sha = record.sourceSha;
    if (typeof sha === "string" && /^[0-9a-f]{40}$/.test(sha)) entry.sourceSha = sha;
    else problems.push(`identity: the ${armId} arm has no 40-hex sourceSha`);
    return entry;
  };
  const baseline = armIdentity("baseline");
  const candidate = armIdentity("candidate");

  const identity = {
    schemaVersion: ctx.schemaVersion,
    driverSha: ctx.driverSha,
    runId: ctx.runId,
    attempt: ctx.attempt,
    platform: ctx.platform,
    executionBackend: "in-process",
    // The two arm builds are distinguishable ONLY if their closure digests
    // differ; that is a MEASURED comparison, not an assertion.
    closuresDistinguishable:
      baseline !== null &&
      candidate !== null &&
      typeof baseline.buildDigest === "string" &&
      typeof candidate.buildDigest === "string" &&
      baseline.buildDigest !== candidate.buildDigest,
    arms: {
      ...(baseline !== null ? { baseline } : {}),
      ...(candidate !== null ? { candidate } : {}),
    },
  };
  if (ctx.driverSha === null) problems.push("identity: the run has no 40-hex driver SHA");
  write("identity.json", identity);

  // --- schedule.json ------------------------------------------------------
  // The schedule the campaign ACTUALLY executed, taken from the run records.
  const schedule = {
    schemaVersion: ctx.schemaVersion,
    arms: ctx.records.map((r) => ({
      armRunId: r.armRunId,
      armId: r.armId,
      caseId: r.caseId,
      repetition: r.repetition,
      orderIndex: r.orderIndex,
      preregistrationDigest: r.preregistrationDigest,
      planDigest: r.planDigest,
      evidence: r.declaredEvidence,
    })),
  };
  write("schedule.json", schedule);

  // --- aggregate.json -----------------------------------------------------
  const cost = ctx.aggregate.cost;
  write("aggregate.json", {
    schemaVersion: ctx.schemaVersion,
    decision: ctx.aggregate.decision.decision,
    decisionReason: ctx.aggregate.decision.reason ?? null,
    arms: ctx.aggregate.arms ?? null,
    cost: {
      totalTokens: cost.totalTokens,
      baselineTokens: cost.baselineTokens,
      candidateTokens: cost.candidateTokens,
      deltaTokens: cost.deltaTokens,
      basis: cost.basis,
      reservedUpperBound: cost.reservedUpperBound,
    },
  });

  // --- cost-journal.json --------------------------------------------------
  // The durable journal's OWN `entries`, copied verbatim from the file the
  // budget wrote. `trustedCounterfactual` is carried so the consumer can see the
  // strategy's direction without this script reinterpreting a single entry.
  write("cost-journal.json", {
    schemaVersion: ctx.schemaVersion,
    journalSchemaVersion: ctx.journal.schemaVersion ?? null,
    chargedTotalTokens: ctx.journal.chargedTotalTokens,
    entries: ctx.journal.entries ?? [],
  });

  return { problems, armCount: schedule.arms.length };
}

// ---------------------------------------------------------------------------
// POS-FWD — B5: the SHIPPED release CLI walks the FULL forward schedule
// ---------------------------------------------------------------------------

/** A POS-FWD refusal keeps the SAME shape as a success so a reader cannot tell a
 *  refused phase from a corrupt report: `ok:false` + the stage that stopped. */
function forwardRefusal(stage, res, httpDuring) {
  return {
    transport: "release-cli-subprocess",
    executionBackend: "release-cli-subprocess",
    ok: false,
    stage,
    exitCode: res.code,
    httpRequestsDuring: httpDuring,
    lines: res.out.trim().split(/\r?\n/).slice(0, 10),
  };
}

/**
 * R16 — the SEPARATELY-IDENTIFIED synthetic-fixture authorization, bound exactly
 * to `artifact`. Factored out (it was inline) because the declared-posture probes
 * must write a SECOND approval bound to a DIFFERENT (trusted-build) artifact and
 * show that the first one no longer authorizes it.
 *
 * N3/R1 — this is never a paid approval: `paid` must be false and the parser
 * refuses `paid:true` together with `fixtureMode`.
 */
function fixtureAuthorizationFor(artifact, approvalId) {
  return {
    schemaVersion: "tool-call-efficiency-authorization-v2",
    preregistrationDigest: artifact.preregistrationDigest,
    candidateSourceSha: artifact.subject.candidateSourceSha,
    baselineArmDigest: artifact.subject.baselineArmDigest,
    candidateArmDigest: artifact.subject.candidateArmDigest,
    providerId: artifact.provider.providerId,
    modelId: artifact.provider.modelId,
    endpointDigest: artifact.provider.endpointDigest,
    caps: {
      maxModelCalls: artifact.budget.campaignWorstCaseModelCalls,
      maxToolCalls: artifact.budget.maxToolCalls,
      maxDurationMs: artifact.budget.maxDurationMs,
      maxInputTokens: artifact.budget.maxInputTokens,
      maxOutputTokens: artifact.budget.maxOutputTokens,
      maxTotalTokens: artifact.budget.maxTotalTokens,
      maxUsdMicros: artifact.budget.maxUsdMicros,
    },
    issuedAtMs: 1_000,
    expiresAtMs: 9_000_000_000_000,
    approvalId,
    allowResume: false,
    paid: false,
    fixtureMode: "synthetic-offline-v1",
  };
}

/**
 * B5/R1 — the SHIPPED release entry point as a real SUBPROCESS
 * (`node apps/cli/dist/main.js`) over the same two synthesized fixture checkouts.
 *
 * R1/F1+F2 — WHAT THIS PHASE NOW PROVES. It used to run the full frozen schedule
 * here. After R1 the fixture admission requires an in-process, branded capability
 * (a non-billable transport bound to the observed endpoint/model) and the arm
 * executor requires another (the pinned fixture checkouts). A subprocess can be
 * handed neither, and the release CLI deliberately accepts NO fixture-bypass
 * configuration. So `prereg build` and `prereg validate` still run (0 provider,
 * 0 HTTP), and `prereg run` must be REFUSED before any request: non-zero exit,
 * 0 requests at the loopback counting stub, no per-arm record. That is a
 * SECURITY result — fail-closed ahead of the network — and it is reported as
 * `CLOSED_BY_R1`, never as a forward-execution PASS.
 */
async function runPositiveForward(stub, dir, env) {
  const evalMod = await import(pathToFileURL(EVAL_ENTRY).href);
  const selection = await selectionEvidence(dir, env);
  const cfgPath = join(dir, "pos-fwd-config.json");
  writeFileSync(cfgPath, `${JSON.stringify(selection.config, null, 2)}\n`, "utf8");
  const preregPath = join(dir, "pos-fwd-prereg.json");
  const authPath = join(dir, "pos-fwd-auth.json");
  const budgetDir = join(dir, "pos-fwd-budget");
  const outDir = join(dir, "pos-fwd-out");

  // 1. build + validate on the release entry (0 provider, 0 HTTP).
  const httpBeforeBuild = stub.count();
  const build = await runCliAsync(["prereg", "build", cfgPath, "--out", preregPath], env);
  const afterBuild = stub.count();
  if (build.code !== 0) return forwardRefusal("build", build, afterBuild - httpBeforeBuild);
  const validate = await runCliAsync(["prereg", "validate", preregPath, "--json"], env);
  const afterCertify = stub.count();
  if (validate.code !== 0) return forwardRefusal("validate", validate, afterCertify - afterBuild);

  // 2. the independent authorization BINDS the artifact the release CLI wrote.
  const artifact = JSON.parse(readFileSync(preregPath, "utf8"));
  const authorization = fixtureAuthorizationFor(artifact, "e2e-offline-TEST_ONLY-forward-approval");
  writeFileSync(authPath, `${JSON.stringify(authorization, null, 2)}\n`, "utf8");

  // 3. the FULL forward schedule through the shipped release CLI subprocess.
  //
  // R1/F1+F2 — this phase is a SECURITY POSITIVE, not a forward run. A subprocess
  // cannot receive the in-process test-host capabilities (`nonBillableTransport`,
  // `trustedFixtureCheckouts`), and the release CLI accepts NO fixture-bypass
  // configuration — so the SHIPPED entry point must REFUSE this fixture campaign
  // BEFORE any request: non-zero exit, 0 HTTP against the loopback stub, no per-arm
  // record written.
  //
  // R16 — THE DECLARED-MODE REQUIREMENT, AND WHY IT STILL DOES NOT ADMIT THIS RUN.
  // R5 built the right primitive: a DECLARED `trusted-build`/`no-os-network-sandbox`
  // posture carried in the digest-bound pre-registration and honored by the shipped
  // arm executor. R16 asks whether that posture can restore a genuine RELEASE-CLI
  // FORWARD RUN of this campaign. It cannot, and `declaredPostureProbes` below
  // MEASURES the three independent reasons rather than asserting them:
  //
  //   (b) DIGEST   — declaring the posture changes `preregistrationDigest`, so the
  //                  approval written for the `process-exec` artifact is refused
  //                  `AUTHORIZATION_DIGEST_MISMATCH` at 0 HTTP: the declared
  //                  posture IS bound by the approval (through its digest), so
  //                  changing it invalidates the approval.
  //   (c) NO BYPASS— with a FRESH approval bound to the trusted-build artifact the
  //                  campaign is STILL refused `FIXTURE_TRANSPORT_NOT_NON_BILLABLE`
  //                  at 0 HTTP with no per-arm record. The binding blocker is the
  //                  TRANSPORT admission class, which lives in the formal gate and
  //                  never reads `isolation` at all; a posture whose own name says
  //                  "no-os-network-sandbox" cannot stand in for a proof that a
  //                  transport cannot bill. Admitting it there would re-open R1's
  //                  F1 defect and would run this artifact UNCAPPED (`maxUsdMicros`
  //                  is null by design in this offline gate).
  //   (a) FLAG     — `--fixture-mode` is not on the `prereg run` whitelist, so a
  //                  flag-driven bypass attempt is `CLI_USAGE` at 0 HTTP.
  //
  // See `docs/evidence/e4-r16-fixture-forward-path.md` for the full finding.
  const before = stub.count();
  const run = await runCliAsync(
    ["prereg", "run", preregPath, "--authorization", authPath, "--budget-dir", budgetDir, "--out", outDir, "--mode", "first-run"],
    env,
  );
  const after = stub.count();
  const httpDuringRun = after - before;
  const runsDir = join(outDir, "runs");
  const recordFiles = existsSync(runsDir) ? readdirSync(runsDir).filter((f) => f.endsWith(".json")) : [];
  const refusalCode =
    ["EGRESS_ISOLATION_UNAVAILABLE", "FIXTURE_TRANSPORT_NOT_NON_BILLABLE"].find((c) => run.out.includes(c)) ?? null;
  // The refusal must have happened BEFORE the budget was touched: if the durable
  // ledger file exists at all, it must record nothing committed/reserved/unknown.
  const ledgerFile = join(budgetDir, R97_LEDGER_FILE);
  const ledger = existsSync(ledgerFile) ? ledgerViewFromFile(budgetDir) : null;
  const noLedgerCommitment = ledger === null || (ledger.committed === 0 && ledger.outstanding === 0 && ledger.unknown === 0);
  const refusedByDesign =
    run.code !== 0 && httpDuringRun === 0 && recordFiles.length === 0 && refusalCode !== null && noLedgerCommitment;
  const expectArmRuns = artifact.schedule.logicalRuns;
  // R16 — the DECLARED-posture probes: a declared `trusted-build` posture is bound
  // by the approval's digest, but cannot license a fixture TRANSPORT.
  const declared = await declaredPostureProbes(stub, dir, env, selection, artifact, preregPath, authPath);
  // LEAD MERGE RESOLUTION (R1 x R2 conflict on this file).
  //
  // R1 turned this phase into a SECURITY POSITIVE: the shipped release CLI has no
  // fixture-bypass configuration and therefore REFUSES this marker-only fixture
  // campaign before any request, so no per-arm record and no forward aggregate are
  // produced. R2 (branched before that change) still expected a completed forward
  // RUN here, and its lines referenced `records`/`physical`/`verified`/`aggregate`,
  // which R1's rewrite removed from this function — keeping them would have been a
  // ReferenceError, not evidence.
  //
  // Taking R1's semantics does NOT lose R2's F3 fix: the F3 defect
  // (`tokensDelta` = campaign TOTAL rather than candidate-vs-baseline) is fixed and
  // cross-checked in the IN-PROCESS phase (`runPositiveExecution`), which does write
  // a real journal and a real aggregate. Because POS-FWD is now a refusal, the
  // forward cost fields are intentionally ABSENT here; `ci-readiness.mjs` reads them
  // through `?? null`, so downstream reports NOT_OBSERVED rather than a fabricated 0.
  return {
    transport: "release-cli-subprocess",
    executionBackend: "release-cli-subprocess",
    preregistrationDigest: artifact.preregistrationDigest,
    planDigest: artifact.schedule.planDigest,
    expectArmRuns,
    scheduledArmRuns: recordFiles.length,
    // MEASURED, and legitimately 0: the refusal happened BEFORE any request left,
    // which is exactly what the loopback stub's own counter proves.
    physicalStubRequests: httpDuringRun,
    httpRequestsDuringBuildAndValidate: afterCertify - httpBeforeBuild,
    refusedByDesign,
    refusalCode,
    exitCode: run.code,
    // `null` = NOT_OBSERVED (no ledger was opened); a number is the durable
    // ledger's own count, never an inferred one.
    ledgerFilePresent: ledger !== null,
    ledgerCommitted: ledger === null ? null : ledger.committed,
    ledgerUnknown: ledger === null ? null : ledger.unknown,
    // R16 — the declared-posture measurement. Every `false` here is a REFUSAL the
    // shipped CLI failed to make; every `null` is NOT_OBSERVED.
    declaredPosture: declared,
    // R16 — the honest statement of what the release CLI would have to be given to
    // run this campaign, and why neither route is available without weakening R1.
    declaredModeRequirement:
      "REQUIRED FOR A RELEASE-CLI FIXTURE FORWARD RUN (NOT SATISFIED, BY DESIGN): the fixture admission class needs the test host's IN-PROCESS, Symbol-branded non-billable transport (createNonBillableFixtureTransport); no env var, JSON field, marker, port or flag produces it, and `preregCommandDeps()` passes no options, so a subprocess cannot have one. The other admission class is PAID and additionally requires paid:true, a non-null maxUsdMicros and a KNOWN per-call price — a different class, not licensed by any isolation posture. Declaring `trusted-build`/`no-os-network-sandbox` therefore changes what the ARM EXECUTOR trusts (R5) and NOTHING about the transport gate. A declaration standing in for the billing proof is exactly R1's F1 defect and would run this artifact UNCAPPED (maxUsdMicros is null here).",
    ok: refusedByDesign && declared.allRefusedBeforeAnyRequest,
    lines: run.out.trim().split(/\r?\n/).slice(0, 10),
  };
}

/**
 * R16 — WHAT A DECLARED POSTURE CAN AND CANNOT GRANT.
 *
 * Runs THREE probes against the SHIPPED release CLI, each with the loopback
 * stub's own request counter read around it. Nothing here is inferred from a
 * return code alone: a refusal counts only when the counter did not move, no
 * per-arm record was written and the named refusal code is present in the output.
 *
 *   (a) FLAG   — `--fixture-mode` is not on the `prereg run` argument whitelist,
 *                so a flag-driven bypass attempt is `CLI_USAGE` at 0 HTTP. A flag
 *                grants nothing because there is no flag that grants anything.
 *   (b) DIGEST — the SAME campaign is re-built DECLARING
 *                `isolationBackendId: "trusted-build"` /
 *                `isolationStrength: "no-os-network-sandbox"`. `isolation` is part
 *                of the canonical source body, so the root digest MOVES. The
 *                approval written for the `process-exec` artifact is then REFUSED
 *                `AUTHORIZATION_DIGEST_MISMATCH` at 0 HTTP: the declared posture is
 *                bound BY THE APPROVAL (through the digest it authorizes), so
 *                changing the posture invalidates the approval.
 *   (c) NO BYPASS — with a FRESH approval bound to the trusted-build artifact, the
 *                campaign is STILL refused `FIXTURE_TRANSPORT_NOT_NON_BILLABLE` at
 *                0 HTTP with no per-arm record. This is the binding blocker, and it
 *                is independent of the posture: the transport admission lives in
 *                the formal gate, which never reads `isolation` at all.
 *
 * A NOTE ON WHAT THIS IS NOT: (c) is NOT "the declared mode failed". R5's posture
 * is honored by the arm executor (proven in
 * `apps/cli/src/prereg-declared-posture-forward-path.test.ts`); it is simply not a
 * TRANSPORT claim, and this phase never gets as far as the executor.
 */
async function declaredPostureProbes(stub, dir, env, selection, processExecArtifact, preregPath, authPath) {
  // --- (a) a flag-driven bypass attempt ------------------------------------
  const flagBudget = join(dir, "pos-fwd-flag-budget");
  const flagOut = join(dir, "pos-fwd-flag-out");
  const beforeFlag = stub.count();
  const flagAttempt = await runCliAsync(
    [
      "prereg", "run", preregPath,
      "--authorization", authPath,
      "--budget-dir", flagBudget,
      "--out", flagOut,
      "--mode", "first-run",
      // NOT a real flag: the point is that inventing one cannot upgrade the run.
      "--fixture-mode", "synthetic-offline-v1",
    ],
    env,
  );
  const flagHttp = stub.count() - beforeFlag;
  const flagDrivenBypassRefused = flagAttempt.code !== 0 && flagHttp === 0 && flagAttempt.out.includes("CLI_USAGE");

  // --- (b) declare the R5 posture; the digest must move --------------------
  const declaredCfg = join(dir, "pos-fwd-declared-config.json");
  writeFileSync(
    declaredCfg,
    `${JSON.stringify(
      {
        ...selection.config,
        isolation: {
          ...selection.config.isolation,
          isolationBackendId: "trusted-build",
          isolationStrength: "no-os-network-sandbox",
        },
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  const declaredPrereg = join(dir, "pos-fwd-declared-prereg.json");
  const beforeDeclaredBuild = stub.count();
  const declaredBuild = await runCliAsync(["prereg", "build", declaredCfg, "--out", declaredPrereg], env);
  const declaredValidate =
    declaredBuild.code === 0
      ? await runCliAsync(["prereg", "validate", declaredPrereg, "--json"], env)
      : { code: 1, out: "(skipped: build failed)" };
  const declaredBuildHttp = stub.count() - beforeDeclaredBuild;
  let declaredArtifact = null;
  try {
    declaredArtifact = declaredBuild.code === 0 ? JSON.parse(readFileSync(declaredPrereg, "utf8")) : null;
  } catch {
    declaredArtifact = null;
  }
  const postureIsDigestBound =
    declaredArtifact !== null &&
    declaredArtifact.isolation?.isolationBackendId === "trusted-build" &&
    declaredArtifact.isolation?.isolationStrength === "no-os-network-sandbox" &&
    declaredArtifact.preregistrationDigest !== processExecArtifact.preregistrationDigest;

  // (b1) the STALE approval (bound to the process-exec artifact) no longer authorizes.
  const staleBudget = join(dir, "pos-fwd-stale-budget");
  const staleOut = join(dir, "pos-fwd-stale-out");
  const beforeStale = stub.count();
  const staleRun = await runCliAsync(
    ["prereg", "run", declaredPrereg, "--authorization", authPath, "--budget-dir", staleBudget, "--out", staleOut, "--mode", "first-run"],
    env,
  );
  const staleHttp = stub.count() - beforeStale;
  const staleApprovalRefused =
    declaredArtifact !== null && staleRun.code !== 0 && staleHttp === 0 && staleRun.out.includes("AUTHORIZATION_DIGEST_MISMATCH");

  // (c) a FRESH approval bound to the declared artifact: STILL no fixture bypass.
  const declaredAuthPath = join(dir, "pos-fwd-declared-auth.json");
  let declaredRun = { code: 1, out: "(skipped: declared build failed)" };
  let declaredRunHttp = 0;
  let declaredRecords = [];
  let declaredLedgerCommitted = null;
  let declaredRefusalCode = null;
  if (declaredArtifact !== null) {
    writeFileSync(
      declaredAuthPath,
      `${JSON.stringify(fixtureAuthorizationFor(declaredArtifact, "e2e-offline-TEST_ONLY-declared-posture-approval"), null, 2)}\n`,
      "utf8",
    );
    const declaredBudget = join(dir, "pos-fwd-declared-budget");
    const declaredOut = join(dir, "pos-fwd-declared-out");
    const beforeDeclaredRun = stub.count();
    declaredRun = await runCliAsync(
      ["prereg", "run", declaredPrereg, "--authorization", declaredAuthPath, "--budget-dir", declaredBudget, "--out", declaredOut, "--mode", "first-run"],
      env,
    );
    declaredRunHttp = stub.count() - beforeDeclaredRun;
    const declaredRunsDir = join(declaredOut, "runs");
    declaredRecords = existsSync(declaredRunsDir) ? readdirSync(declaredRunsDir).filter((f) => f.endsWith(".json")) : [];
    const declaredLedgerFile = join(declaredBudget, R97_LEDGER_FILE);
    if (existsSync(declaredLedgerFile)) {
      declaredLedgerCommitted = ledgerViewFromFile(declaredBudget).committed;
    }
    declaredRefusalCode =
      ["FIXTURE_TRANSPORT_NOT_NON_BILLABLE", "EGRESS_ISOLATION_UNAVAILABLE", "PAID_WITHOUT_USD_CAP", "PRICING_UNKNOWN"].find((c) =>
        declaredRun.out.includes(c),
      ) ?? null;
  }
  const declaredPostureGrantsNoBypass =
    declaredArtifact !== null &&
    declaredRun.code !== 0 &&
    declaredRunHttp === 0 &&
    declaredRecords.length === 0 &&
    declaredRefusalCode === "FIXTURE_TRANSPORT_NOT_NON_BILLABLE";

  return {
    // (a) a marker/flag grants nothing
    flagDrivenBypassAttempt: "agent prereg run … --fixture-mode synthetic-offline-v1",
    flagDrivenBypassRefused,
    flagDrivenBypassExitCode: flagAttempt.code,
    flagDrivenBypassHttp: flagHttp,
    // (b) the declared posture is BOUND: changing it invalidates the approval
    declaredIsolationBackendId: declaredArtifact?.isolation?.isolationBackendId ?? null,
    declaredIsolationStrength: declaredArtifact?.isolation?.isolationStrength ?? null,
    declaredPreregistrationDigest: declaredArtifact?.preregistrationDigest ?? null,
    processExecPreregistrationDigest: processExecArtifact.preregistrationDigest,
    postureIsDigestBound,
    declaredBuildExitCode: declaredBuild.code,
    declaredValidateExitCode: declaredValidate.code,
    declaredBuildAndValidateHttp: declaredBuildHttp,
    staleApprovalRefused,
    staleApprovalRefusalCode: staleRun.out.includes("AUTHORIZATION_DIGEST_MISMATCH") ? "AUTHORIZATION_DIGEST_MISMATCH" : null,
    staleApprovalHttp: staleHttp,
    // (c) the declared posture does NOT license a fixture transport
    freshApprovalRefusalCode: declaredRefusalCode,
    freshApprovalExitCode: declaredRun.code,
    freshApprovalHttp: declaredRunHttp,
    freshApprovalArmRecords: declaredRecords.length,
    freshApprovalLedgerCommitted: declaredLedgerCommitted,
    declaredPostureGrantsNoBypass,
    allRefusedBeforeAnyRequest:
      flagDrivenBypassRefused && postureIsDigestBound && staleApprovalRefused && declaredPostureGrantsNoBypass,
    forwardRunPossibleWithoutWeakeningR1: false,
  };
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

async function main() {
  const parsed = parseArgs(process.argv.slice(2));
  const outPath = parsed.out !== undefined ? resolve(parsed.out) : join(WORKSPACE, "evidence.json");

  const paid = paidEnvironmentPresent();
  if (paid.hasKey || paid.hasPaidSwitch) {
    process.stdout.write(`[FAIL] a paid provider is selectable (key=${paid.hasKey}, switch=${paid.hasPaidSwitch}) — refusing to produce A7 evidence\n`);
    return 1;
  }
  for (const entry of [CLI_ENTRY, EVAL_ENTRY, RUNNER_ENTRY, IDENTITY_ENTRY]) {
    try {
      readFileSync(entry);
    } catch {
      process.stdout.write(`[FAIL] built artifact missing: ${entry} — run \`pnpm build\` first\n`);
      return 1;
    }
  }

  // S3/F4 (Phase F) — refuse to run at all if this script's own injected clock
  // would make the campaign deadline already-expired. Checked BEFORE any phase,
  // so a regression is a named failure here rather than an opaque
  // ARM_DEADLINE_EXCEEDED from the arm executor — and it fires locally on a
  // dirty tree too, where the positive phases would otherwise short-circuit and
  // hide it until CI.
  try {
    assertCampaignClockIsOpen();
  } catch (err) {
    process.stdout.write(`[FAIL] ${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }

  rmSync(WORKSPACE, { recursive: true, force: true });
  mkdirSync(WORKSPACE, { recursive: true });

  const clean = treeClean();
  const stub = await startCountingStub();
  const httpBaseUrl = stub.baseUrl;

  let negative = [];
  let positiveCert = null;
  let positiveExec = null;
  let positiveForward = null;
  let blocked = null;
  // F3/E-R16 — the REAL arm directories this run materialised, or `null` when the
  // positive phases never ran (dirty tree / blocked). `dualBuild` is derived from
  // these and is OMITTED entirely when they do not exist.
  let armDirs = null;
  // S6b/Phase H — the run identity, collected ONCE and used both for the bundle
  // root's `identity.json` and (below) for the report's own top-level fields, so
  // the two can never disagree.
  const runIdentityForBundle = collectRunIdentity(parsed);

  try {
    negative = await runNegativeMatrix(stub, WORKSPACE);

    // POS/POS-EXEC/POS-FWD require the `require-clean` precondition the observer enforces.
    if (!clean) {
      blocked = "CLEAN_TREE_REQUIRED: the formal observer refuses a dirty checkout, so the positive phases cannot be certified here";
    } else {
      const armRoot = join(WORKSPACE, "arms");
      const baselineDir = join(armRoot, "baseline");
      const candidateDir = join(armRoot, "candidate");
      armDirs = { baselineDir, candidateDir };
      const evalMod = await import(pathToFileURL(EVAL_ENTRY).href);
      // R0/S1 Phase G — the fixture arms declare the SAME versioned ABI the real
      // executor requires, imported from the built CLI rather than re-typed.
      const abi = await fixtureArmAbi();
      await writeArmCheckout(baselineDir, "baseline", false, evalMod.R97_ARM_BUILD_ENTRIES, abi);
      await writeArmCheckout(candidateDir, "candidate", true, evalMod.R97_ARM_BUILD_ENTRIES, abi);
      const claimsDir = join(WORKSPACE, "claims");
      mkdirSync(claimsDir, { recursive: true });
      // The in-process POS-EXEC gate resolves its claim anchor from
      // `process.env` (not from the child-only `env` object below), so it must
      // point INSIDE this run's disposable WORKSPACE as well. Otherwise the
      // global tmpdir anchor remembers a budget dir that this script deletes on
      // every run, and the NEXT run refuses with CAMPAIGN_STATE_LOST (a deleted
      // root is a loss, not a fresh allowance). Scoping it here keeps the run
      // idempotent without weakening that runtime rule.
      process.env.R97_CAMPAIGN_CLAIMS_DIR = claimsDir;
      const env = {
        R97_ARM_BASELINE_DIR: baselineDir,
        R97_ARM_CANDIDATE_DIR: candidateDir,
        R97_CAMPAIGN_CLAIMS_DIR: claimsDir,
      };
      positiveCert = await runPositiveCertification(stub, WORKSPACE, env);
      positiveExec = await runPositiveExecution(WORKSPACE, env, runIdentityForBundle);
      // B5 — the SAME two frozen arm builds, but the schedule is now driven by
      // the SHIPPED release CLI as a real subprocess. Its ONLY endpoint is the
      // loopback counting stub, reached through the `TEST_ONLY` sentinel key.
      const forwardEnv = {
        ...env,
        OPENAI_API_KEY: TEST_ONLY_API_KEY,
        OPENAI_BASE_URL: stub.baseUrl,
      };
      positiveForward = await runPositiveForward(stub, WORKSPACE, forwardEnv);
    }
  } finally {
    await stub.close();
  }

  const ready =
    negative.length > 0 &&
    negative.every((c) => c.ok) &&
    positiveCert !== null &&
    positiveCert.ok &&
    positiveExec !== null &&
    positiveExec.ok &&
    positiveForward !== null &&
    positiveForward.ok;
  // F3/E-R16 — the run identity and the dual-build block, each established from
  // REAL sources or omitted. `runIdentity.identity` is spread FIRST so a
  // fabricated `runId`/`attempt`/`platform` cannot shadow it later in the literal.
  const runIdentity = runIdentityForBundle;
  const verifierFacts =
    positiveExec !== null && typeof positiveExec.evidenceVerified === "number"
      ? {
          ran: positiveExec.evidenceVerified > 0,
          casesTotal: positiveExec.scheduledArmRuns ?? 0,
          casesVerified: positiveExec.evidenceVerified,
        }
      : null;
  const dualBuildResult = await collectDualBuild(armDirs, verifierFacts);
  const omittedEvidenceFields = [
    ...runIdentity.omitted,
    ...(dualBuildResult.dualBuild === null
      ? [{ field: "dualBuild", reason: dualBuildResult.reasons.join("; ") || "not established", consumerCode: "NO_DUAL_BUILD_EVIDENCE" }]
      : []),
    ...(typeof parsed.evidenceRoot === "string" && parsed.evidenceRoot.trim() !== ""
      ? []
      : [{ field: "evidenceRoot", reason: "no --evidence-root was supplied for this artifact", consumerCode: "NO_RAW_EVIDENCE" }]),
  ];

  const report = {
    schema: SCHEMA,
    ...runIdentity.identity,
    ...(dualBuildResult.dualBuild !== null ? { dualBuild: dualBuildResult.dualBuild } : {}),
    ...(typeof parsed.evidenceRoot === "string" && parsed.evidenceRoot.trim() !== ""
      ? { evidenceRoot: parsed.evidenceRoot.trim() }
      : {}),
    // NOT_PROVEN is a POSITION, not a failure: each omitted field names the
    // consumer reason code it will surface as. See the block comment above
    // `collectRunIdentity` for the governing principle.
    omittedEvidenceFields,
    head: (() => {
      try {
        return git(["rev-parse", "HEAD"]);
      } catch {
        return "(unknown)";
      }
    })(),
    // The RAW runtime platform, kept under its own key. It must NEVER be aliased
    // to the readiness `platform` field: `ci-readiness.mjs` compares that field
    // against the closed enum "windows"|"ubuntu", so a `win32`/`linux` value
    // there is a present-but-WRONG identity — worse than an honest omission.
    rawProcessPlatform: process.platform,
    node: process.version,
    treeClean: clean,
    blocked,
    authorizationFixture:
      "FIXTURE_PASS (synthetic class, NOT a paid approval): the POS-EXEC authorization carries paid:false + " +
      "fixtureMode=\"synthetic-offline-v1\" with approvalId 'e2e-offline-TEST_ONLY-approval'. N3/R1 make this a separately-identified " +
      "admission class: the parser refuses fixtureMode together with paid:true, so it cannot be confused with (or widened into) a paid " +
      "authorization, and the gate admits it ONLY through the test host's INJECTED, endpoint- and model-bound non-billable transport " +
      "(POS-EXEC), never because an address is loopback and never through the operator's credential-bearing factory (MEASURED 0 entries). " +
      "POS-FWD's authorization is written but REFUSED by the shipped CLI before any request. This script refuses to run if a real key or " +
      "RUN_PAID_BENCHMARKS is selectable. paidExperimentRun remains NOT_RUN.",
    negative: {
      cases: negative.length,
      refusalsOk: negative.filter((c) => c.ok).length,
      ok: negative.length > 0 && negative.every((c) => c.ok),
      rows: negative,
    },
    positiveCertification: positiveCert,
    positiveExecution: positiveExec,
    positiveForward: positiveForward,
    counts: {
      httpRequestsAgainstTheLoopbackStub: "MEASURED: the stub's own request counter (0 for every refusal and the 0-provider certification)",
      physicalProviderCalls: positiveExec === null ? "NOT_OBSERVED" : `MEASURED: the fake provider's generate() entry counter = ${positiveExec.physicalProviderCalls}`,
      providerFactoryCalls: positiveExec === null ? "NOT_OBSERVED" : `MEASURED: the gate's providerFactoryCalls = ${positiveExec.providerFactoryCalls}`,
      operatorFactoryEnteredByTheFixtureAdmission:
        positiveExec === null
          ? "NOT_OBSERVED"
          : `MEASURED: the operator's credential-bearing provider factory entries on the fixture admission = ${positiveExec.operatorFactoryEntered} (must be 0; the injected non-billable transport is used)`,
      forwardPhysicalStubRequests:
        positiveForward === null
          ? "NOT_OBSERVED"
          : `MEASURED: the loopback stub's request counter across the POS-FWD subprocess = ${positiveForward.physicalStubRequests} (the R1 refusal is PRE-request)`,
      forwardRefusalCode: positiveForward === null ? "NOT_OBSERVED" : positiveForward.refusalCode,
      // R16 — the declared-posture measurement, kept as its own field so a reader
      // can never read it as "the declared mode failed" or as a forward PASS.
      declaredPostureForwardRun:
        positiveForward === null
          ? "NOT_OBSERVED"
          : "NOT_OBSERVED: no release-CLI fixture forward run exists. The DECLARED trusted-build posture is bound by the approval's digest (MEASURED), yet the transport admission still refuses the campaign before any request; making the declaration substitute for the billing proof is R1's F1 defect and was NOT done",
      externalProviderCalls: "NOT_OBSERVED: no externally-billed provider exists in this environment (a key/switch is refused above)",
      costUsdMicros: "NOT_OBSERVED: no provider was billed; a paid run is BLOCKED",
      loopbackStubBaseUrlDigest: sha256Hex(httpBaseUrl),
    },
    // The plan's FOUR readiness levels are reported SEPARATELY, and
    // `productionOfflineReady` is SPLIT into the three distinct claims the plan
    // §B6 requires — an offline pass must never be readable as a paid run, a
    // promotion, or as the release CLI having proven more than it measured.
    readiness: {
      offlineFixtureReady:
        "PASS (reported by scripts/e4/n5-prereg-closed-loop.mjs, not this script): the injected-adapter fixture chain runs offline",
      productionOfflineReady: ready
        ? "PASS (offline, SYNTHETIC fixtures): (1) the SHIPPED entry point (real subprocess CLI) refuses every preflight counterexample with 0 HTTP; (2) it certifies a frozen identity with 0 provider; (3) the in-process shipped adapter executes the full paired schedule against a counting fake transport that is INJECTED as the test host's non-billable transport, and its two fixture checkouts are PINNED by an injected trust capability; (4) R1: the SHIPPED release CLI subprocess, given the SAME two synthesized fixture arm build entries, now REFUSES the campaign before any request (no in-process capability is reachable from a subprocess, and the release CLI accepts NO fixture-bypass configuration) — measured as non-zero exit, 0 requests at the loopback counting stub and no per-arm record. N3/R1 ADMISSION CLASS: (3) is admitted as the separately-identified SYNTHETIC-FIXTURE class (paid:false + fixtureMode) ONLY through the injected, endpoint- and model-bound non-billable transport, so its address cannot make it free and the operator's credential-bearing factory is never entered (MEASURED 0). NOT_PROVEN here: a REAL dual frozen build (two real pinned checkouts built from two distinct source SHAs) and the real verifier over them; that is N1's scope and this script does not claim it. Also NOT_PROVEN (R16 — RESOLVED AS A DOCUMENTED, MEASURED REFUSAL): a legitimate release-CLI fixture FORWARD RUN. R5's DECLARED `trusted-build`/`no-os-network-sandbox` posture is honored by the arm executor and is bound by the approval through the artifact digest, but it is NOT a transport claim: the formal gate admits a fixture campaign only through an in-process Symbol-branded non-billable transport, which a subprocess cannot be given without an env/flag/file bypass (forbidden), and the only other admission class is PAID (paid:true + a known per-call price + a money cap). Letting the declaration stand in for the billing proof would re-open R1's F1 defect and run this UNCAPPED artifact (maxUsdMicros is null here), so it was NOT done. See docs/evidence/e4-r16-fixture-forward-path.md. None of this is a paid run or a promotion."
        : blocked !== null
          ? `NOT_READY: ${blocked}`
          : "NOT_READY: at least one phase did not pass",
      productionOfflineReadiness: {
        releaseCliNegativeAndCertification:
          negative.length > 0 && negative.every((c) => c.ok) && positiveCert !== null && positiveCert.ok ? "PASS" : "FAIL",
        inProcessAdapterForward: positiveExec !== null && positiveExec.ok ? "PASS" : "FAIL",
        // R1/F2 — the release CLI's fixture path is CLOSED, not proven: a
        // subprocess cannot carry the test-host trust capability, so the shipped
        // entry point refuses those checkouts before any request. "CLOSED" is a
        // security result; it is NOT a forward-execution PASS.
        releaseCliSubprocessForward:
          positiveForward !== null && positiveForward.refusedByDesign === true
            ? "CLOSED_BY_R1 (fixture campaign refused pre-request; 0 HTTP)"
            : positiveForward !== null && positiveForward.ok
              ? "PASS"
              : "NOT_READY",
        // N3/R1 — which admission CLASS the positive phase got through. It is the
        // separately-identified synthetic-fixture class (paid:false + fixtureMode),
        // admitted ONLY via the injected non-billable transport; a PAID admission
        // additionally requires a non-null maxUsdMicros AND a verifiable per-call
        // price, and is NOT exercised here.
        positivePhasesAdmissionClass:
          positiveExec !== null && positiveExec.ok
            ? "FIXTURE_PASS (N3 synthetic-fixture class: paid:false + fixtureMode=\"synthetic-offline-v1\", admitted through an INJECTED endpoint/model-bound non-billable transport; the operator's provider factory was never entered. A PAID admission requires a non-null maxUsdMicros and a verifiable per-call price and is NOT exercised here — paidExperimentRun=NOT_RUN)"
            : "NOT_OBSERVED",
        // N0 — the split the plan requires. `inProcessAdapterForward=PASS` proves
        // the IPC + protocol + durable-ledger closed loop over SYNTHESIZED arm
        // builds; it must never be read as a real dual frozen build or as the real
        // verifier having run over one. Those are separately labelled here so an
        // offline PASS cannot be quoted as production proof.
        releaseCliSubprocessForwardBasis:
          positiveForward !== null && positiveForward.refusedByDesign === true
            ? "CLOSED_BY_R1: the SHIPPED release CLI refuses a marker-only SYNTHETIC fixture checkout/preregistration before any request (0 HTTP); the positive in-process closed loop uses the test host's injected non-billable transport and pinned fixture checkouts. R16 RE-SPECIFICATION: the DECLARED `trusted-build`/`no-os-network-sandbox` posture (R5) is present in the digest-bound artifact and is bound BY THE APPROVAL through that digest (declaring it MOVES the root digest and the old approval is refused AUTHORIZATION_DIGEST_MISMATCH — MEASURED), but it does not and cannot license this run: the binding blocker is the TRANSPORT admission class, which the posture never reaches. A release-CLI fixture forward run therefore remains NOT_OBSERVED, and is not claimed"
            : positiveForward !== null && positiveForward.ok
              ? "SYNTHETIC_FIXTURE_BUILD (writeArmCheckout entries, not two real pinned checkouts)"
              : "NOT_OBSERVED",
        realDualFrozenBuildAndRealVerifier:
          "NOT_PROVEN: this offline script builds no two real pinned checkouts from distinct source SHAs, so a real dual build and the real verifier over it are unproven by it (N1 scope)",
        overall: ready ? "PASS" : blocked !== null ? "BLOCKED" : "PARTIAL",
      },
      paidExperimentRun: "NOT_RUN: no paid authorization exists; this script refuses a selectable paid key/switch and every transport is local (in-process fake or a loopback counting stub)",
      championPromotion: "NOT_RUN: promotion is a separate, later approval and is never inferred from this evidence",
    },
    ok: ready,
  };

  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");

  process.stdout.write(
    `prereg-production-e2e: ${report.ok ? "PASS" : blocked !== null ? "BLOCKED" : "FAIL"}\n` +
      `  negative: ${report.negative.refusalsOk}/${report.negative.cases} refusals on the release CLI (0 HTTP)\n` +
      `  positive certification: ${positiveCert === null ? blocked : `${positiveCert.ok ? "ok" : "FAIL"} (build ${positiveCert.build.exitCode}, validate ${positiveCert.validate.exitCode}, ${positiveCert.httpRequestsDuring} HTTP)`}\n` +
      `  positive execution (in-process): ${positiveExec === null ? blocked : `decision=${positiveExec.decision ?? positiveExec.code} arms=${positiveExec.scheduledArmRuns ?? "?"} physicalCalls=${positiveExec.physicalProviderCalls ?? "?"} verified=${positiveExec.evidenceVerified ?? "?"}`}\n` +
      `  positive forward (release CLI subprocess): ${positiveForward === null ? blocked : `refusedByDesign=${positiveForward.refusedByDesign ?? "?"} refusalCode=${positiveForward.refusalCode ?? "?"} exit=${positiveForward.exitCode ?? "?"} httpRequests=${positiveForward.physicalStubRequests ?? "?"} armRecords=${positiveForward.scheduledArmRuns ?? "?"}`}\n` +
      `  productionOfflineReadiness: negative+cert=${report.readiness.productionOfflineReadiness.releaseCliNegativeAndCertification} in-process=${report.readiness.productionOfflineReadiness.inProcessAdapterForward} release-subprocess=${report.readiness.productionOfflineReadiness.releaseCliSubprocessForward} overall=${report.readiness.productionOfflineReadiness.overall}\n` +
      `  forward basis: ${report.readiness.productionOfflineReadiness.releaseCliSubprocessForwardBasis}\n` +
      `  R16 declared posture: ${positiveForward === null ? "NOT_OBSERVED" : `declared=${positiveForward.declaredPosture?.declaredIsolationBackendId ?? "?"}/${positiveForward.declaredPosture?.declaredIsolationStrength ?? "?"} digestMoved=${positiveForward.declaredPosture?.postureIsDigestBound ?? "?"} staleApprovalRefused=${positiveForward.declaredPosture?.staleApprovalRefused ?? "?"} (${positiveForward.declaredPosture?.staleApprovalRefusalCode ?? "?"}) freshApprovalRefusal=${positiveForward.declaredPosture?.freshApprovalRefusalCode ?? "?"} freshHttp=${positiveForward.declaredPosture?.freshApprovalHttp ?? "?"} flagRefused=${positiveForward.declaredPosture?.flagDrivenBypassRefused ?? "?"} forwardRunPossibleWithoutWeakeningR1=${positiveForward.declaredPosture?.forwardRunPossibleWithoutWeakeningR1 ?? "?"}`}\n` +
      `  real dual build + real verifier: ${report.readiness.productionOfflineReadiness.realDualFrozenBuildAndRealVerifier}\n` +
      `  paidExperimentRun=${report.readiness.paidExperimentRun.split(":")[0]} championPromotion=${report.readiness.championPromotion.split(":")[0]}\n` +
      `  evidence: ${outPath}\n`,
  );
  return report.ok ? 0 : 1;
}

process.exitCode = await main();