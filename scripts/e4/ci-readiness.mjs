#!/usr/bin/env node
/**
 * N7/R7 — one machine-readable readiness artifact per CI run.
 * plan(20260926-175819).md §N7 (line 117); plan(20260928-105425).md §R7 lines 199-219.
 *
 * WHY ONE ARTIFACT: the acceptance criterion is that "a reviewer can recompute the
 * core counts and identity from a SINGLE artifact". This writes exactly that:
 * ciRunSha + OS + per-command exit codes + the measured counts + the SEPARATED
 * readiness levels.
 *
 * THE FIVE LEVELS ARE NEVER COLLAPSED INTO ONE `ok`. A fixture protocol that works
 * does not make a real dual build exist, and neither authorizes a paid run. Each
 * level carries its own status, its own basis, and — when it is not green — the
 * concrete reason it is not.
 *
 * R7/F6 — READINESS IS CLASSIFIED FROM STRUCTURE, NEVER FROM PROSE.
 * The previous revision decided `realBuildOfflineReady` with
 *
 *     readinessText.includes("SYNTHETIC") ? SYNTHETIC_FIXTURE_BUILD
 *                                         : REAL_DUAL_PINNED_BUILD
 *
 * so ANY other string — lowercase `synthetic`, an empty string, an unrelated
 * sentence — was read as a REAL dual pinned build and could render
 * `realBuildOfflineReady = PASS`. A documentation edit could therefore move a
 * gate. That classifier is DELETED. `readiness.productionOfflineReady` (the
 * human-readable prose) is now read by nothing in this file.
 *
 * Instead:
 *   1. the EXECUTION KIND is a structured field, matched against a closed enum
 *      (`KNOWN_EXECUTION_KINDS`); anything unrecognised or missing is `NOT_OBSERVED`
 *      and can never raise a level;
 *   2. `REAL_DUAL_PINNED_BUILD` alone is not enough: a REAL declaration must also
 *      carry VERIFIED EVIDENCE (artifact SHA against `--expect-sha`, run id, the two
 *      distinct arm source SHAs + build digests, a verifier that ran over every
 *      case, command exit codes all 0, and a journal that is internally consistent).
 *      A forged REAL enum with no evidence is NOT_PROVEN, never PASS.
 *
 * HONESTY RULES ENFORCED HERE:
 *   - `realBuildOfflineReady` is BLOCKED when the structured kind is a declared
 *     synthetic/closed basis, and NOT_PROVEN when it is unreadable or its REAL
 *     evidence does not verify (plan line 125 forbids inferring a real build from a
 *     green fixture loop).
 *   - `paidExperimentRun` / `championPromotion` are NEVER set by this script.
 *   - an absent measurement is `null`/UNKNOWN — never `0`.
 *   - no log/text is ever scanned for the word "PASS".
 *
 * R7/F6 — PLATFORM MEASUREMENT. This process records its OWN platform as MEASURED
 * (`platforms.thisProcess` + the `windows`/`ubuntu` slot it ran on). The other
 * platform is NOT hardcoded NOT_PROVEN: it is `NOT_OBSERVED` until
 * `--other-platform-artifact <ci-readiness.json>` is supplied, and is accepted only
 * when that artifact's `ciRunSha` equals THIS run's expected SHA
 * (`MEASURED_SAME_SHA`); a mismatched SHA is `NOT_PROVEN`.
 *
 * SAFETY: reads local files and runs the offline test gates. Zero network, zero
 * provider, zero cost, no key.
 *
 * usage: node scripts/e4/ci-readiness.mjs --e2e <e2e.json> --out <readiness.json>
 *        [--exit-pnpm-test=N] [--exit-typecheck=N] [--exit-build=N] [--os-label=...]
 *        [--expect-sha=<40hex>] [--run-id=<id>] [--other-platform-artifact=<json>]
 *        [--evidence-root=<dir>] [--attempt=<n>] [--platform=windows|ubuntu]
 *        [--strict] [--require=<level>[,<level>...]]
 *
 * S6/F3 — READINESS IS COMPUTED FROM RAW EVIDENCE. A REAL declaration is now
 * corroborated by reading the actual arm / verifier / journal bytes under
 * `--evidence-root` (scripts/e4/readiness-evidence-verify.mjs). The artifact's
 * OWN run identity (runId + attempt + platform) is required, a build digest must
 * be a LEGAL 64-hex sha256 rather than merely non-empty, and every path is
 * confined to the evidence root. Nothing inside the bundle is ever executed.
 *
 * `--strict` turns the report into a GATE: it exits non-zero when a required
 * level is not PASS (default: fixtureProtocolReady, realBuildOfflineReady,
 * budgetEvidenceReady). Without `--strict` the script keeps its report-mode
 * exit 0, because a readiness artifact is most useful when a phase FAILED.
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isSha256Hex, verifyEvidenceBundle } from "./readiness-evidence-verify.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(here, "..", "..");

const SCHEMA_VERSION = "prereg-ci-readiness-v2";

function arg(name, dflt = null) {
  const eq = process.argv.find((a) => a.startsWith(`--${name}=`));
  if (eq !== undefined) return eq.slice(name.length + 3);
  const i = process.argv.indexOf(`--${name}`);
  if (i !== -1 && i + 1 < process.argv.length && !process.argv[i + 1].startsWith("--")) return process.argv[i + 1];
  return dflt;
}

// --- S6/F3: the CLI schema is VALIDATED, not guessed -------------------------
// A silently-ignored typo (`--evidnce-root`) used to be indistinguishable from
// "no evidence root supplied", which is exactly how a misconfigured gate reads
// as a weaker gate. Unknown flags, missing values and stray positionals are
// refused before any file is read.
const FLAGS_WITH_VALUE = new Set([
  "e2e",
  "out",
  "exit-pnpm-test",
  "exit-typecheck",
  "exit-build",
  "os-label",
  "expect-sha",
  "run-id",
  "other-platform-artifact",
  "evidence-root",
  "attempt",
  "platform",
  "require",
]);
const BOOLEAN_FLAGS = new Set(["strict"]);

function cliSchemaProblems(argv) {
  const problems = [];
  const consumed = new Set();
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith("--")) continue;
    const eq = token.indexOf("=");
    const name = eq === -1 ? token.slice(2) : token.slice(2, eq);
    if (BOOLEAN_FLAGS.has(name)) {
      if (eq !== -1) problems.push(`--${name} does not take a value`);
      continue;
    }
    if (!FLAGS_WITH_VALUE.has(name)) {
      problems.push(`unknown argument: ${token}`);
      continue;
    }
    if (eq !== -1) continue;
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) {
      problems.push(`--${name} requires a value`);
      continue;
    }
    consumed.add(i + 1);
    i += 1;
  }
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i].startsWith("--") || consumed.has(i)) continue;
    problems.push(`unexpected positional argument: ${argv[i]}`);
  }
  return problems;
}

const cliProblems = cliSchemaProblems(process.argv.slice(2));
if (cliProblems.length > 0) {
  console.error(`ci-readiness: refusing to run on an invalid command line:\n  ${cliProblems.join("\n  ")}`);
  process.exit(2);
}

const e2ePath = arg("e2e");
const outPath = arg("out");
if (e2ePath === null || outPath === null) {
  console.error("ci-readiness: --e2e <json> and --out <json> are required");
  process.exit(2);
}

/** Run a gate and record its exit code. Never throws: a non-zero exit is DATA. */
function runGate(cmd, args) {
  try {
    execFileSync(cmd, args, {
      cwd: REPO_ROOT,
      stdio: "ignore",
      // Windows ships `pnpm` as a .cmd shim, which execFileSync cannot launch
      // without a shell. The arguments here are fixed literals, never user input.
      shell: process.platform === "win32",
      env: { ...process.env, OPENAI_API_KEY: "" },
    });
    return { exitCode: 0 };
  } catch (err) {
    const code = typeof err?.status === "number" ? err.status : null;
    return { exitCode: code };
  }
}

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

function sha256File(path) {
  try {
    return createHash("sha256").update(readFileSync(path)).digest("hex");
  } catch {
    return null;
  }
}

const SHA40 = /^[0-9a-f]{40}$/;
const isSha40 = (v) => typeof v === "string" && SHA40.test(v);
const isNonEmptyString = (v) => typeof v === "string" && v.trim() !== "";
const asInt = (v) => (v === null || v === undefined || v === "" ? null : Number.isInteger(Number(v)) ? Number(v) : null);

const gitSha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: REPO_ROOT, encoding: "utf8" }).trim();

// --- the fast, platform-neutral gates this script runs itself -----------------
const n0Gate = runGate("pnpm", ["test:n0-gaps"]);
const legacyGate = runGate("pnpm", ["test:red-next-gaps"]);
const docsSmoke = runGate("pnpm", ["exec", "vitest", "run", "apps/cli/src/prereg-docs-smoke.test.ts"]);

// --- identity inputs ----------------------------------------------------------
// `--expect-sha` is the SHA this readiness is being certified FOR. It defaults to
// this checkout's HEAD; a CI job may pass it explicitly so a stale artifact cannot
// be replayed under a newer SHA.
const expectSha = arg("expect-sha", gitSha);
const runId = arg("run-id", process.env["GITHUB_RUN_ID"] ?? null);
const otherPlatformPath = arg("other-platform-artifact");
// S6/F3 — the raw evidence root and the run identity it must agree with.
const evidenceRoot = arg("evidence-root");
const attemptArg = asInt(arg("attempt"));
const platformArg = arg("platform");
// S6/F3 — report mode (default, exit 0) vs GATE mode (`--strict`, exit non-zero
// when a required level is not PASS). Plan §10.9: "脚本成功写出报告" and
// "必要 gate 通过" are two different facts and must not share one exit code.
const strictMode = process.argv.some((a) => a === "--strict");
const requireList = (arg("require") ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter((s) => s !== "");
const REQUIRED_LEVELS = requireList.length > 0 ? requireList : ["fixtureProtocolReady", "realBuildOfflineReady", "budgetEvidenceReady"];

const declaredExits = {
  typecheck: arg("exit-typecheck"),
  test: arg("exit-pnpm-test"),
  build: arg("exit-build"),
};

// --- measured counts, all from the E2E artifact -------------------------------
const e2e = readJson(e2ePath);
const exec = e2e?.positiveExecution ?? null;
const fwd = e2e?.positiveForward ?? null;

// --- F6/R7: the EXECUTION KIND is a structured enum, never prose ---------------
/**
 * The closed set of execution kinds this script understands. Only
 * `REAL_DUAL_PINNED_BUILD` can ever carry `real: true`, and even that needs the
 * evidence checks below.
 */
const KNOWN_EXECUTION_KINDS = Object.freeze({
  REAL_DUAL_PINNED_BUILD: { real: true, blocker: null },
  SYNTHETIC_FIXTURE_BUILD: { real: false, blocker: "NO_REAL_ARM_PAIR" },
  CLOSED_BY_R1: { real: false, blocker: "NO_REAL_ARM_PAIR" },
  NOT_OBSERVED: { real: false, blocker: null },
});

/**
 * Extract a structured kind from a field that may be a bare enum
 * (`"SYNTHETIC_FIXTURE_BUILD"`) or an enum followed by a separator and a prose
 * explanation (`"SYNTHETIC_FIXTURE_BUILD (writeArmCheckout entries…)"`).
 *
 * The token must be the FIRST thing in the string and exactly `[A-Z][A-Z0-9_]*`.
 * This is a schema parse, not a substring search: `"my synthetic fixture"`,
 * `""`, `"synthetic"` (lowercase), `"REAL: but actually synthetic"` and every other
 * free-text value do NOT produce a known kind.
 */
function executionKindToken(value) {
  if (typeof value !== "string") return null;
  const match = /^([A-Z][A-Z0-9_]*)(?=$|[\s:(])/.exec(value.trim());
  return match === null ? null : match[1];
}

const offlineReadiness = e2e?.readiness?.productionOfflineReadiness ?? null;
const executionKind = executionKindToken(offlineReadiness?.["executionKind"]) ?? executionKindToken(offlineReadiness?.["releaseCliSubprocessForwardBasis"]);
const executionKindKnown = executionKind !== null && Object.hasOwn(KNOWN_EXECUTION_KINDS, executionKind);
const kindSpec = executionKindKnown ? KNOWN_EXECUTION_KINDS[executionKind] : null;

/** TRUE only when the structured kind says REAL *and* the evidence verifies. */
const realDeclaration = kindSpec?.real === true;

/**
 * R7/F3 — the evidence a REAL declaration must actually carry. Every entry is a
 * check that returns a reason string when it fails, so a forged enum with no
 * artifact produces a list of concrete failures instead of a PASS.
 *
 * S6 — the artifact's OWN identity and the RAW evidence root are now mandatory:
 *   - the artifact must CARRY `runId`, `attempt` and `platform` (a caller-supplied
 *     `--run-id` is not a substitute for the artifact's own identity, plan §10.5);
 *   - a `buildDigest` must be a LEGAL 64-hex sha256, not merely non-empty;
 *   - `--evidence-root` must be supplied and every claim re-derived from the raw
 *     arm / verifier / journal bytes (readiness-evidence-verify.mjs).
 */
let bundleFacts = null;

function verifyRealEvidence() {
  const failures = [];
  const dualBuild = e2e?.dualBuild ?? null;
  const baselineArm = dualBuild?.baselineArm ?? null;
  const candidateArm = dualBuild?.candidateArm ?? null;
  const verifier = dualBuild?.verifier ?? null;

  if (e2e === null) failures.push("NO_INPUT_ARTIFACT: the --e2e artifact is unreadable, so no REAL basis can be verified");
  if (!isNonEmptyString(e2e?.["ciRunSha"])) failures.push("NO_ARTIFACT_SHA: the artifact carries no ciRunSha");
  else if (isSha40(expectSha) && e2e["ciRunSha"] !== expectSha) {
    failures.push(`SHA_MISMATCH: artifact ciRunSha ${e2e["ciRunSha"]} != expected ${expectSha}`);
  }

  // --- run identity: the ARTIFACT must carry it (S6/F3) ---------------------
  const artifactRunId = e2e?.["runId"];
  if (!isNonEmptyString(artifactRunId)) {
    failures.push("NO_ARTIFACT_RUN_ID: the artifact carries no runId, so the run identity of its evidence cannot be established (a caller-supplied --run-id is not a substitute)");
  } else if (isNonEmptyString(runId) && artifactRunId !== runId) {
    failures.push(`RUN_ID_MISMATCH: the artifact was produced by run ${artifactRunId}, this readiness run is ${runId}`);
  }
  if (!isNonEmptyString(runId)) failures.push("NO_RUN_ID: neither --run-id nor GITHUB_RUN_ID was supplied");

  // --- attempt + platform: the same run/attempt requirement per schema ------
  const artifactAttempt = asInt(e2e?.["attempt"]);
  if (artifactAttempt === null) failures.push("NO_ARTIFACT_ATTEMPT: the artifact carries no attempt number");
  else if (attemptArg === null) failures.push("NO_ATTEMPT_INPUT: --attempt was not supplied, so the artifact's attempt cannot be corroborated");
  else if (artifactAttempt !== attemptArg) failures.push(`ATTEMPT_MISMATCH: the artifact is attempt ${artifactAttempt}, this verification is attempt ${attemptArg}`);

  const artifactPlatform = e2e?.["platform"];
  if (!isNonEmptyString(artifactPlatform)) failures.push("NO_ARTIFACT_PLATFORM: the artifact carries no platform");
  else if (!isNonEmptyString(platformArg)) failures.push("NO_PLATFORM_INPUT: --platform was not supplied, so the artifact's platform cannot be corroborated");
  else if (artifactPlatform !== platformArg) failures.push(`PLATFORM_MISMATCH: the artifact is platform ${artifactPlatform}, this verification is ${platformArg}`);

  if (!isNonEmptyString(e2e?.["os"])) failures.push("NO_OS: the artifact does not record the OS it was produced on");
  if (dualBuild === null || typeof dualBuild !== "object") {
    failures.push("NO_DUAL_BUILD_EVIDENCE: the artifact carries no dualBuild evidence block");
  } else {
    if (!isSha40(baselineArm?.sourceSha)) failures.push("BASELINE_ARM_UNIDENTIFIED: dualBuild.baselineArm.sourceSha is not a 40-hex SHA");
    if (!isSha40(candidateArm?.sourceSha)) failures.push("CANDIDATE_ARM_UNIDENTIFIED: dualBuild.candidateArm.sourceSha is not a 40-hex SHA");
    if (isSha40(baselineArm?.sourceSha) && baselineArm.sourceSha === candidateArm?.sourceSha) {
      failures.push("ARMS_IDENTICAL: both arms name the same source SHA, so there is no comparable pair");
    }
    // S6/F3 — a digest must be a LEGAL sha256, not merely a non-empty string.
    // `"x"` used to satisfy this check and carried a forged build to PASS.
    if (!isNonEmptyString(baselineArm?.buildDigest)) failures.push("BASELINE_BUILD_DIGEST_MISSING: dualBuild.baselineArm.buildDigest is empty");
    else if (!isSha256Hex(baselineArm.buildDigest)) {
      failures.push(`BASELINE_BUILD_DIGEST_MALFORMED: dualBuild.baselineArm.buildDigest is not a 64-hex sha256 (got ${JSON.stringify(baselineArm.buildDigest)})`);
    }
    if (!isNonEmptyString(candidateArm?.buildDigest)) failures.push("CANDIDATE_BUILD_DIGEST_MISSING: dualBuild.candidateArm.buildDigest is empty");
    else if (!isSha256Hex(candidateArm.buildDigest)) {
      failures.push(`CANDIDATE_BUILD_DIGEST_MALFORMED: dualBuild.candidateArm.buildDigest is not a 64-hex sha256 (got ${JSON.stringify(candidateArm.buildDigest)})`);
    }
    if (verifier?.ran !== true) failures.push("VERIFIER_NOT_RUN: dualBuild.verifier.ran is not true");
    if (!Number.isInteger(verifier?.casesTotal) || verifier.casesTotal <= 0) failures.push("VERIFIER_CASES_MISSING: dualBuild.verifier.casesTotal is not a positive integer");
    else if (verifier.casesVerified !== verifier.casesTotal) {
      failures.push(`VERIFIER_INCOMPLETE: ${String(verifier.casesVerified)}/${String(verifier.casesTotal)} cases reached a verdict`);
    }
  }
  const exits = e2e?.commandExits ?? null;
  for (const gate of ["typecheck", "test", "build"]) {
    const code = asInt(exits?.[gate]);
    if (code !== 0) failures.push(`COMMAND_EXIT_${gate.toUpperCase()}: ${gate} exit code is ${code === null ? "null" : String(code)}, not 0`);
  }
  if (e2e?.ok !== true) failures.push("E2E_NOT_OK: the E2E artifact does not report ok=true");
  if (fwd !== null && fwd?.["costMatchesJournal"] === false) failures.push("JOURNAL_MISMATCH: positiveForward.costMatchesJournal is false");
  const journalDelta = fwd?.["aggregateTokensDelta"];
  const independentDelta = fwd?.["independentTokens"]?.["delta"];
  if (Number.isFinite(journalDelta) && Number.isFinite(independentDelta) && journalDelta !== independentDelta) {
    failures.push(`JOURNAL_MISMATCH: aggregateTokensDelta ${String(journalDelta)} != independently recomputed delta ${String(independentDelta)}`);
  }
  // --- S6/F3: RAW EVIDENCE — every claim above must be corroborated ---------
  // The artifact's self-reported fields are a CLAIM. Without an evidence root
  // there are no bytes to check, so a REAL declaration is NOT_PROVEN no matter
  // how complete its JSON looks.
  if (!isNonEmptyString(evidenceRoot)) {
    failures.push("NO_RAW_EVIDENCE: no --evidence-root was supplied, so no raw arm/verifier/journal file was read and the self-reported fields above are uncorroborated");
  } else {
    const bundle = verifyEvidenceBundle({
      evidenceRoot,
      expectSha,
      runId: isNonEmptyString(runId) ? runId : null,
      attempt: attemptArg,
      platform: platformArg,
      armEvidenceVerifier,
      // S6/F3 — the artifact's OWN arm build identity must equal the raw identity
      // file's. A well-formed sha256 that matches nothing is still a forgery.
      declaredArms: { baseline: baselineArm, candidate: candidateArm },
    });
    bundleFacts = bundle.facts;
    for (const p of bundle.problems) failures.push(`RAW_EVIDENCE: ${p}`);
  }
  return failures;
}

// The A6 per-arm verifier is loaded LAZILY (only when a REAL declaration with an
// evidence root is actually being verified) so the script still classifies an
// artifact when the evaluation package has not been built.
let armEvidenceVerifier = null;
let armEvidenceVerifierError = null;
if (realDeclaration && isNonEmptyString(evidenceRoot)) {
  try {
    const mod = await import(pathToFileURL(join(REPO_ROOT, "packages", "evaluation", "dist", "index.js")).href);
    if (typeof mod.verifyArmEvidenceFromArtifacts !== "function") {
      armEvidenceVerifierError = "packages/evaluation/dist/index.js does not export verifyArmEvidenceFromArtifacts";
    } else {
      armEvidenceVerifier = mod.verifyArmEvidenceFromArtifacts;
    }
  } catch (err) {
    armEvidenceVerifierError = err instanceof Error ? err.message : String(err);
  }
  if (armEvidenceVerifier === null) {
    console.error(`ci-readiness: the A6 per-arm evidence verifier is unavailable (${armEvidenceVerifierError}); raw arm artifacts cannot be verified`);
  }
}

const realEvidenceFailures = realDeclaration ? verifyRealEvidence() : [];
const realBasis = realDeclaration && realEvidenceFailures.length === 0;
const bundleJournalBinding = bundleFacts?.journalBinding ?? { status: "NOT_PROVEN", reason: "no evidence bundle was verified" };
const bundleRequestDispatch = bundleFacts?.requestDispatchBinding ?? {
  status: "NOT_PROVEN",
  reason: "no evidence bundle was verified",
};
// budgetEvidenceReady may PASS only when the raw journal reconciled AND the
// request/dispatch cross-binding is proven. Until S4's bundle contract lands the
// second dimension is explicitly unbound, so this stays NOT_PROVEN with a named
// reason — never because the code was written.
const budgetBasis = realBasis && bundleJournalBinding.status === "MEASURED" && bundleRequestDispatch.status === "MEASURED";

const basis = executionKindKnown ? executionKind : "NOT_OBSERVED";
const basisSource = typeof offlineReadiness?.["executionKind"] === "string" && executionKindToken(offlineReadiness["executionKind"]) !== null
  ? "readiness.productionOfflineReadiness.executionKind"
  : typeof offlineReadiness?.["releaseCliSubprocessForwardBasis"] === "string"
    ? "readiness.productionOfflineReadiness.releaseCliSubprocessForwardBasis (leading enum token)"
    : "NOT_OBSERVED (no structured execution-kind field in the E2E artifact)";

const counts = {
  // provider factory / physical request / ledger / journal — the numbers a
  // reviewer recomputes rather than trusts.
  providerFactoryCalls: exec?.providerFactoryCalls ?? null,
  inProcessPhysicalProviderCalls: exec?.physicalProviderCalls ?? null,
  inProcessLedgerCommitted: exec?.ledgerCommitted ?? null,
  inProcessJournalChargedTokens: exec?.journalChargedTokens ?? null,
  forwardPhysicalStubRequests: fwd?.physicalStubRequests ?? null,
  forwardLedgerCommitted: fwd?.ledgerCommitted ?? null,
  forwardJournalChargedTokens: fwd?.journalChargedTokens ?? null,
  // F3/R2 — the forward TOTAL and the candidate-vs-baseline DELTA are two
  // independent numbers, and the independently recomputed per-arm values are
  // reported next to them so a reviewer can recompute every one of them.
  forwardAggregateTokensTotal: fwd?.aggregateTokensTotal ?? null,
  forwardAggregateTokensDelta: fwd?.aggregateTokensDelta ?? null,
  forwardAggregateTokensBaseline: fwd?.aggregateTokensBaseline ?? null,
  forwardAggregateTokensCandidate: fwd?.aggregateTokensCandidate ?? null,
  forwardIndependentTokensDelta: fwd?.independentTokens?.delta ?? null,
  forwardCostMatchesJournal: fwd?.costMatchesJournal ?? null,
  evidenceVerified: exec?.evidenceVerified ?? null,
  evidenceUnverified: exec?.evidenceUnverified ?? null,
  decision: exec?.decision ?? null,
  externalProviderCalls: null, // NOT_OBSERVED: nothing is billed
  costUsdMicros: null, // NOT_OBSERVED: nothing is billed
};

const levels = {
  fixtureProtocolReady: {
    status: e2e?.ok === true ? "PASS" : e2e === null ? "NOT_OBSERVED" : "FAIL",
    basis: "the offline closed loop over SYNTHETIC fixture arm builds (writeArmCheckout equals this)",
    counts_ref: ["inProcessPhysicalProviderCalls", "forwardPhysicalStubRequests", "evidenceVerified"],
  },
  realBuildOfflineReady: {
    status: realBasis ? "PASS" : kindSpec?.blocker != null ? "BLOCKED" : "NOT_PROVEN",
    basis: realBasis
      ? "two real pinned checkouts built from distinct source SHAs, with every arm's manifest/verifier/security re-verified from the raw bytes under --evidence-root (S6/F3)"
      : realDeclaration
        ? "execution kind declares REAL_DUAL_PINNED_BUILD but its evidence did not verify against the raw evidence root, so this level is NOT_PROVEN (S6/F3: a forged enum and a self-reported digest are not a real build)"
        : executionKindKnown
          ? `the structured execution kind is ${executionKind}, so no real dual pinned build is available: this level is BLOCKED rather than inferred from the fixture loop (N1)`
          : "the structured execution kind is missing or unrecognised (NOT_OBSERVED), so this level is NOT_PROVEN — prose is never read (R7)",
    blocker: realBasis
      ? null
      : kindSpec?.blocker === "NO_REAL_ARM_PAIR"
        ? "NO_REAL_ARM_PAIR: real dual frozen arm builds + the real verifier over them are NOT_PROVEN"
        : realDeclaration
          ? `REAL_EVIDENCE_UNVERIFIED: ${realEvidenceFailures.join("; ")}`
          : null,
    evidence: {
      executionKind,
      executionKindSource: basisSource,
      realDeclaration,
      evidenceRoot: isNonEmptyString(evidenceRoot) ? evidenceRoot : null,
      failures: realEvidenceFailures,
      bundle: bundleFacts,
    },
  },
  // S6/F3 — COMPUTED, not hard-coded. It may PASS only when the same run's raw
  // evidence verified AND the raw cost-journal entries reconciled against the
  // aggregate. A missing request/dispatch-journal binding is reported as an
  // explicit NOT_PROVEN naming the missing inputs — never as a green PASS.
  budgetEvidenceReady: {
    status: budgetBasis ? "PASS" : "NOT_PROVEN",
    basis: budgetBasis
      ? "per-arm baseline/candidate/total/delta were recomputed from the raw cost-journal entries and reconciled against the aggregate, AND the request/dispatch journal was cross-bound to the schedule and manifest (S6/F3). This proves the OFFLINE execution only; it does not authorize a paid run"
      : realBasis
        ? `the raw arm evidence verified, but the budget is not fully bound: ${bundleRequestDispatch.reason ?? bundleJournalBinding.reason ?? "no journal binding was established"}`
        : `no raw evidence bundle verified, so the budget cannot be attributed: ${realDeclaration ? realEvidenceFailures.slice(0, 3).join("; ") : "the execution kind is not a REAL declaration"}`,
    blocker: budgetBasis ? null : bundleRequestDispatch.reason ?? bundleJournalBinding.reason ?? (realDeclaration ? "BUDGET_NOT_BOUND: the raw evidence did not verify" : "BUDGET_NOT_BOUND: no REAL declaration"),
    evidence: {
      journalBinding: bundleJournalBinding.status,
      journalBindingReason: bundleJournalBinding.reason,
      requestDispatchBinding: bundleRequestDispatch.status,
      requestDispatchBindingReason: bundleRequestDispatch.reason,
      budget: bundleFacts?.budget ?? null,
      derivedVerifierCoverage: bundleFacts?.derivedVerifierCoverage ?? null,
    },
    counts_ref: [
      "forwardJournalChargedTokens",
      "forwardAggregateTokensTotal",
      "forwardAggregateTokensDelta",
      "forwardAggregateTokensBaseline",
      "forwardAggregateTokensCandidate",
      "forwardIndependentTokensDelta",
      "forwardCostMatchesJournal",
    ],
  },
  paidExperimentRun: { status: "NOT_RUN", basis: "no paid authorization exists; this script never creates one" },
  championPromotion: { status: "NOT_RUN", basis: "no promotion is performed or authorized by this script" },
};

// --- R7: this process measures ITS OWN platform; the other one must be read ---
const THIS_PLATFORM = process.platform === "win32" ? "windows" : process.platform === "linux" ? "ubuntu" : "other";
const otherPlatform = otherPlatformPath === null ? null : readJson(otherPlatformPath);
const otherPlatformSha = typeof otherPlatform?.["ciRunSha"] === "string" && otherPlatform.ciRunSha !== "" ? otherPlatform.ciRunSha : null;
const otherPlatformSameSha = otherPlatformSha !== null && otherPlatformSha === expectSha;

/**
 * The other platform's artifact must show that ITS OWN process measured the
 * platform it ran on. This is what makes the old hardcoded `NOT_PROVEN` visible:
 * a real `ubuntu-latest` artifact produced by the pre-R7 script reports
 * `platforms.ubuntu.status = "NOT_PROVEN"`, so it does NOT certify Ubuntu.
 */
const otherPlatformSelfMeasured = (() => {
  if (otherPlatform === null || typeof otherPlatform !== "object") return false;
  if (otherPlatform?.["platforms"]?.["thisProcess"]?.["status"] === "MEASURED") return true;
  const raw = otherPlatform?.["os"]?.["platform"];
  const slot = raw === "win32" ? "windows" : raw === "linux" ? "ubuntu" : null;
  return slot !== null && otherPlatform?.["platforms"]?.[slot]?.["status"] === "MEASURED";
})();

const crossPlatformStatus =
  otherPlatformPath === null
    ? "NOT_OBSERVED"
    : otherPlatformSha === null
      ? "NOT_PROVEN"
      : !otherPlatformSameSha
        ? "NOT_PROVEN"
        : otherPlatformSelfMeasured
          ? "MEASURED_SAME_SHA"
          : "NOT_PROVEN";

function platformSlot(name) {
  if (THIS_PLATFORM === name) return { status: "MEASURED", detail: `this process: ${process.platform}/${process.arch}` };
  if (otherPlatformPath === null) {
    return {
      status: "NOT_OBSERVED",
      detail: "no --other-platform-artifact was supplied, so this platform was not measured by this run (it is NOT assumed unproven, and it is NOT assumed measured)",
    };
  }
  if (otherPlatformSha === null) return { status: "NOT_PROVEN", detail: "the supplied other-platform artifact has no ciRunSha" };
  if (!otherPlatformSameSha) {
    return { status: "NOT_PROVEN", detail: `SHA_MISMATCH: the other-platform artifact is for ${otherPlatformSha}, this run certifies ${expectSha}` };
  }
  if (!otherPlatformSelfMeasured) {
    return {
      status: "NOT_PROVEN",
      detail: `OTHER_PLATFORM_NOT_SELF_MEASURED: ${otherPlatformPath} is for the same SHA but does not report its own platform as MEASURED (the pre-R7 script hardcoded ubuntu NOT_PROVEN even on a real ubuntu-latest run)`,
    };
  }
  return { status: "MEASURED_SAME_SHA", detail: `read from ${otherPlatformPath}, checked against the SAME SHA ${expectSha}, and it reports its own platform as MEASURED` };
}

const artifact = {
  schemaVersion: SCHEMA_VERSION,
  generatedBy: "scripts/e4/ci-readiness.mjs",
  ciRunSha: gitSha,
  expectedSha: expectSha,
  ciRunId: isNonEmptyString(runId) ? runId : null,
  inputs: {
    e2ePath,
    e2eSha256: sha256File(e2ePath),
    otherPlatformArtifactPath: otherPlatformPath,
    otherPlatformArtifactSha256: otherPlatformPath === null ? null : sha256File(otherPlatformPath),
    // S6/F3 — the raw evidence root that corroborates (or refuses) a REAL claim.
    evidenceRoot: isNonEmptyString(evidenceRoot) ? evidenceRoot : null,
    attempt: attemptArg,
    platform: platformArg,
    strict: strictMode,
    requiredLevels: strictMode ? REQUIRED_LEVELS : null,
  },
  os: {
    label: arg("os-label", `${process.platform}-${process.arch}`),
    platform: process.platform,
    arch: process.arch,
    node: process.version,
  },
  // The workflow runs on BOTH platforms; this process only measured one.
  platforms: {
    thisProcess: { platform: THIS_PLATFORM, rawPlatform: process.platform, status: "MEASURED" },
    windows: platformSlot("windows"),
    ubuntu: platformSlot("ubuntu"),
    crossPlatform: {
      status: crossPlatformStatus,
      sameSha: otherPlatformSameSha,
      selfMeasured: otherPlatformSelfMeasured,
      source: otherPlatformPath,
      detail:
        otherPlatformPath === null
          ? "no other-platform artifact was supplied; the other platform stays NOT_OBSERVED rather than being hardcoded NOT_PROVEN"
          : otherPlatformSha === null
            ? "the supplied other-platform artifact has no ciRunSha"
            : !otherPlatformSameSha
              ? `SHA_MISMATCH: ${otherPlatformSha} != ${expectSha}`
              : otherPlatformSelfMeasured
                ? `the other platform's artifact was read, its ciRunSha equals ${expectSha}, and it reports its own platform MEASURED`
                : "OTHER_PLATFORM_NOT_SELF_MEASURED: same SHA, but the artifact does not report its own platform as MEASURED",
    },
  },
  commandExits: {
    typecheck: asInt(declaredExits.typecheck),
    test: asInt(declaredExits.test),
    build: asInt(declaredExits.build),
    n0GapGate: n0Gate.exitCode,
    legacyRedNextGaps: legacyGate.exitCode,
    docsSmoke: docsSmoke.exitCode,
  },
  counts,
  executionKind,
  forwardBasis: basis,
  forwardBasisSource: basisSource,
  levels,
  // Deliberately NO top-level `ok`: the five levels above are the contract, and a
  // single boolean is exactly the conflation the plan forbids.
  notes: [
    "counts.* === null means NOT_OBSERVED (an unmeasured value), never zero.",
    "externalProviderCalls/costUsdMicros are NOT_OBSERVED because nothing is billed offline.",
    "A green fixtureProtocolReady does not imply realBuildOfflineReady and never authorizes a paid run.",
    "R7: the execution kind is read from a structured enum field; readiness.productionOfflineReady prose is not read at all, and no log is scanned for the word PASS.",
    "R7: a platform is MEASURED only by the process that ran on it, or by an other-platform artifact whose ciRunSha equals expectedSha.",
  ],
};

mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, `${JSON.stringify(artifact, null, 2)}\n`, "utf8");

const line = (name, lvl) => `  ${name}: ${lvl.status}`;
console.log("prereg-ci-readiness (SEPARATED levels — no single overall PASS)");
console.log(`  ciRunSha: ${artifact.ciRunSha}`);
console.log(`  expectedSha: ${artifact.expectedSha}`);
console.log(`  runId: ${artifact.ciRunId ?? "NOT_OBSERVED"}`);
console.log(`  os: ${artifact.os.label} (node ${artifact.os.node})`);
for (const [name, lvl] of Object.entries(levels)) console.log(line(name, lvl));
console.log(`  execution kind: ${executionKind ?? "NOT_OBSERVED"} (${basisSource})`);
console.log(`  forward basis: ${basis}`);
console.log(`  platforms: this=${THIS_PLATFORM} windows=${artifact.platforms.windows.status} ubuntu=${artifact.platforms.ubuntu.status} cross=${crossPlatformStatus}`);
if (realDeclaration && realEvidenceFailures.length > 0) {
  console.log(`  real-build evidence failures: ${realEvidenceFailures.length}`);
  for (const f of realEvidenceFailures) console.log(`    - ${f}`);
}
console.log(`  evidence: ${outPath}`);

// REPORT MODE (default): the SCRIPT exits 0 when it successfully wrote an
// artifact. It does not encode a verdict: the levels are the verdict, and a
// readiness artifact is most useful when a phase FAILED.
//
// GATE MODE (`--strict`, plan §10.9): "the script wrote a report" and "the
// required gate passed" are two different facts. In gate mode an unmet required
// level makes CI exit non-zero.
if (strictMode) {
  const unmet = REQUIRED_LEVELS.filter((name) => levels[name]?.status !== "PASS");
  if (unmet.length > 0) {
    console.error(`ci-readiness STRICT GATE FAILED: ${unmet.length} required readiness level(s) are not PASS`);
    for (const name of unmet) console.error(`  ${name}: ${levels[name]?.status ?? "UNKNOWN"}${levels[name] === undefined ? " (not a known level)" : ""}`);
    process.exit(1);
  }
  console.log(`  strict gate: PASS (required: ${REQUIRED_LEVELS.join(", ")})`);
}
process.exit(0);
