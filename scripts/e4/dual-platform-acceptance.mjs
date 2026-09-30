#!/usr/bin/env node
/**
 * S7b — SAME-SHA DUAL-PLATFORM ACCEPTANCE SUMMARY (plan(20260929-015956).md §10/S7).
 *
 * WHY THIS EXISTS
 * ---------------
 * The `e4` CI job is a matrix, so it produces ONE `ci-readiness.json` per
 * platform. Each leg is bound to `github.run_id` / `github.run_attempt` /
 * `github.sha` / its own `--platform`, and each is uploaded with its raw evidence
 * bundle. Nothing joined them. A reviewer had to eyeball two artifacts to answer
 * the plan's question:
 *
 *     "did BOTH platforms, at the SAME commit and the SAME run, independently
 *      reach the same readiness levels?"
 *
 * That is exactly the shape a gate gets wrong: a single-platform green reads as
 * dual-platform acceptance, and a re-run leg from a different SHA/attempt gets
 * spliced with an original leg into one "complete" verdict. This script refuses
 * to do either. It is a JOIN, not an OR.
 *
 * REFUSALS (exit 2, named reason, NO verdict written):
 *   SAME_RUN_MISMATCH      the legs are not from the same `ciRunId`
 *   SAME_SHA_MISMATCH      the legs do not certify the same commit
 *   ATTEMPT_MISMATCH       different `attempt` values (a re-run mixed with an original)
 *   ATTEMPT_MISSING        neither leg records an attempt
 *   PLATFORM_MISMATCH      a leg's RECORDED platform is not the flag it was passed under
 *   PLATFORM_DUPLICATE     both legs are the same platform
 *   PLATFORM_MISSING       one of windows/ubuntu is absent
 *   MALFORMED_ARTIFACT     a schema field is missing or the wrong TYPE (parse, never coerce)
 *   NO_RAW_EVIDENCE        a leg claims a raw-evidence-dependent level but its bundle is absent
 *   RAW_EVIDENCE_MISMATCH  the bundle exists but does not re-verify against its own claims
 *   EVIDENCE_ROOT_AMBIGUOUS  two artifact-relative roots exist for one leg (never scanned)
 *   EVIDENCE_ROOT_ESCAPE   the recorded root resolves outside the leg artifact's tree
 *   EVIDENCE_ROOT_OVERRIDE_UNUSABLE  an explicit --*-evidence-root cannot be read
 *   EVIDENCE_ROOT_UNUSABLE the located root exists but is not a directory
 *
 * F30-7 (evidence-root resolution): the joining job's CWD is NOT an automatic
 * candidate. See `resolveEvidenceRoot` for the rule, why scan order was the bug,
 * and how a stale `<cwd>/.ci/...` bundle can no longer be read by accident.
 *
 * EXIT CODES (three genuinely different facts, never collapsed):
 *   0  report mode: the verdict was written
 *   1  `--strict`: a required level is not BOTH_PASS
 *   2  refused: the two legs are not one acceptance unit (no verdict written)
 *
 * `--require` SEMANTICS (chosen deliberately, see §5 of the task):
 *   COMMA-SEPARATED ONLY. A REPEATED `--require x --require y` is REFUSED LOUDLY.
 *   `ci-readiness.mjs` uses `arg()`, which returns the FIRST match, so a repeated
 *   flag silently requires only the first value — a gate that looks configured and
 *   is not. This script refuses that input instead of reproducing the trap.
 *
 * HONESTY: `realBuildOfflineReady` is NOT_PROVEN today and that is CORRECT — no
 * producer writes `dualBuild` yet (task-5/S3). A NOT_PROVEN level is a FINDING and
 * is reported as such; this script never synthesizes a PASS to make the table look
 * complete. `paidExperimentRun` / `championPromotion` stay NOT_RUN.
 *
 * READ-ONLY / OFFLINE: reads local JSON and local bundle files. It executes nothing
 * inside an artifact, starts no provider and no tool, and makes no network request.
 * The raw bundle is re-verified through the EXISTING
 * `scripts/e4/readiness-evidence-verify.mjs` (`verifyEvidenceBundle`) — imported,
 * never reimplemented.
 *
 * usage: node scripts/e4/dual-platform-acceptance.mjs
 *          (--windows <ci-readiness.json> --ubuntu <ci-readiness.json> | --in <dir>)
 *          --out <verdict.json> [--strict] [--require=a,b] [--expect-sha=<40hex>]
 *          [--run-id=<id>] [--attempt=<n>]
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isNonEmptyString, isSha40, resolveInsideRoot, verifyEvidenceBundle } from "./readiness-evidence-verify.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(here, "..", "..");

const SCHEMA_VERSION = "prereg-dual-platform-acceptance-v1";
const READINESS_SCHEMA = "prereg-ci-readiness-v2";

/** The five separated levels, in the order the readiness artifact reports them. */
const LEVELS = [
  "fixtureProtocolReady",
  "realBuildOfflineReady",
  "budgetEvidenceReady",
  "paidExperimentRun",
  "championPromotion",
];

/** A level whose PASS is only meaningful when raw bytes back it. */
const RAW_DEPENDENT_LEVELS = new Set(["realBuildOfflineReady", "budgetEvidenceReady"]);

const DEFAULT_REQUIRED = ["fixtureProtocolReady", "realBuildOfflineReady", "budgetEvidenceReady"];

const PLATFORMS = ["windows", "ubuntu"];

/**
 * Problems that are ONLY evidence of "there is no real arm pair in this bundle".
 *
 * `realBuildOfflineReady` is the one level that asserts a real, comparable pair of
 * frozen arm builds. A run that never claimed one legitimately has no
 * `identity.arms.<id>.sourceSha` and different build digests, so these codes say
 * nothing about any other level.
 *
 * The DIGEST/ENTRY/CLEAN codes are deliberately NOT in this set even though they
 * are emitted next to the SHA ones: `readiness-evidence-verify.mjs` computes
 * `levels.realBuildOfflineReady.reason` as `problems.join("; ")`, i.e. the WHOLE
 * problem list, so that reason cannot be used to attribute a problem to a level.
 * Only codes that are unambiguously about the ARM PAIR are listed; everything
 * else — including any code this repo has not emitted yet — blocks every level.
 *
 * Every member is verified present in `scripts/e4/readiness-evidence-verify.mjs`.
 */
const REAL_ARM_PAIR_ONLY_CODES = new Set([
  "ARMS_IDENTICAL",
  "BASELINE_SOURCE_SHA_INVALID",
  "BUILD_IDENTITY_MISSING",
  "BUILD_IDENTITY_UNVERIFIABLE",
  "CANDIDATE_SOURCE_SHA_INVALID",
  "CLOSURES_NOT_DISTINGUISHABLE",
  "IDENTITY_ARMS_MISSING",
]);

/** The code of a verifier problem, which is always the text before the first `:`. */
const codeOfProblem = (problem) => {
  const idx = problem.indexOf(":");
  return idx === -1 ? problem.trim() : problem.slice(0, idx).trim();
};

/**
 * Partition re-verification problems by which level they can honestly block.
 *
 * Fail-closed in four ways:
 *   1. a problem is downgraded only when its code is on the closed arm-pair list;
 *   2. ...and only when `realBuildOfflineReady` is NOT one of the required levels;
 *   3. ...and only when the verifier itself reports that level NOT_PROVEN, so a
 *      verifier that disagreed could never be overruled;
 *   4. every other problem, known or unknown, blocks ALL levels.
 * The downgraded problems are still RETURNED verbatim, so the report records them
 * instead of hiding them.
 */
function classifyBundleProblems(bundle, requiredLevels) {
  const blocksAll = [];
  const realBuildOnly = [];
  const bundleProblems = Array.isArray(bundle?.problems) ? bundle.problems : [];
  const requiresRealBuild = requiredLevels.includes("realBuildOfflineReady");
  const levels = typeof bundle?.levels === "object" && bundle.levels !== null ? bundle.levels : null;
  const realBuildNotProven = levels === null || levels.realBuildOfflineReady?.status !== "PASS";
  for (const problem of bundleProblems) {
    if (
      REAL_ARM_PAIR_ONLY_CODES.has(codeOfProblem(problem)) &&
      !requiresRealBuild &&
      realBuildNotProven
    ) {
      realBuildOnly.push(problem);
    } else {
      blocksAll.push(problem);
    }
  }
  return {
    blocksAll,
    realBuildOnly,
    levelAuthority: levels === null ? null : "verifyEvidenceBundle.levels + REAL_ARM_PAIR_ONLY_CODES",
    levels,
  };
}

/** Statuses that mean "not decided", as opposed to a decided FAIL. */
const UNPROVEN_STATUSES = new Set(["NOT_PROVEN", "NOT_RUN", "NOT_OBSERVED", "BLOCKED"]);

// ---------------------------------------------------------------------------
// CLI — an explicit parser, because `arg()`'s first-match behaviour is exactly
// the trap this script must not reproduce.
// ---------------------------------------------------------------------------

const FLAGS_WITH_VALUE = new Set([
  "windows",
  "ubuntu",
  "in",
  "out",
  "expect-sha",
  "run-id",
  "attempt",
  "require",
  "windows-evidence-root",
  "ubuntu-evidence-root",
]);
const BOOLEAN_FLAGS = new Set(["strict", "help"]);

function parseCli(argv) {
  const problems = [];
  const values = new Map();
  const flags = new Set();
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith("--")) {
      problems.push(`unexpected positional argument: ${token}`);
      continue;
    }
    const eq = token.indexOf("=");
    const name = eq === -1 ? token.slice(2) : token.slice(2, eq);
    if (BOOLEAN_FLAGS.has(name)) {
      if (eq !== -1) problems.push(`--${name} does not take a value`);
      flags.add(name);
      continue;
    }
    if (!FLAGS_WITH_VALUE.has(name)) {
      problems.push(`unknown argument: ${token}`);
      continue;
    }
    let value;
    if (eq !== -1) {
      value = token.slice(eq + 1);
    } else {
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) {
        problems.push(`--${name} requires a value`);
        continue;
      }
      value = next;
      i += 1;
    }
    if (!values.has(name)) values.set(name, []);
    values.get(name).push(value);
  }
  for (const [name, list] of values) {
    if (list.length <= 1) continue;
    problems.push(
      name === "require"
        ? `--require was given ${list.length} times. A repeated --require is a FIRST-MATCH trap: ci-readiness.mjs's arg() returns only the first match, so ${JSON.stringify(list[0])} alone would apply and the gate would look configured while it was not. Use ONE comma-separated list instead: --require ${list.join(",")}`
        : `--${name} was given ${list.length} times; a repeated flag is ambiguous and is refused`,
    );
  }
  return { problems, values, flags };
}

const USAGE = `usage: node scripts/e4/dual-platform-acceptance.mjs
         (--windows <ci-readiness.json> --ubuntu <ci-readiness.json> | --in <dir>)
         --out <verdict.json> [--strict] [--require=a,b] [--expect-sha=<40hex>]
         [--run-id=<id>] [--attempt=<n>]

  --windows/--ubuntu  the two per-platform readiness artifacts (explicit mode)
  --in <dir>          discover ci-readiness*.json under a directory (content-classified)
  --out <verdict.json> where the verdict JSON is written (required)
  --strict            GATE mode: exit 1 when a required level is not BOTH_PASS
  --require=a,b       COMMA-SEPARATED required levels (a repeated flag is refused)
  --expect-sha        additionally pin both legs to this 40-hex commit
  --run-id            additionally pin both legs to this CI run id
  --attempt           additionally pin both legs to this attempt number
  --windows-evidence-root / --ubuntu-evidence-root
                      override where that leg's raw bundle is read from. Needed
                      because a leg records the path RELATIVE to the job that
                      PRODUCED it, which need not resolve in the job that JOINS
                      them. The override is used VERBATIM and is never silently
                      ignored: an override that cannot be read is a refusal, not
                      a fall back. Without an override only the leg artifact's
                      OWN tree is searched — the joining process's cwd is
                      deliberately NOT a candidate (F30-7).
`;

const parsed = parseCli(process.argv.slice(2));
if (parsed.flags.has("help")) {
  process.stdout.write(USAGE);
  process.exit(0);
}
if (parsed.problems.length > 0) {
  console.error(`dual-platform-acceptance: refusing to run on an invalid command line:\n  ${parsed.problems.join("\n  ")}`);
  process.exit(2);
}

const one = (name) => {
  const list = parsed.values.get(name);
  return list === undefined ? null : list[0];
};

const outPath = one("out");
if (outPath === null) {
  console.error("dual-platform-acceptance: --out <verdict.json> is required");
  process.exit(2);
}

const strictMode = parsed.flags.has("strict");
const requireList = (one("require") ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter((s) => s !== "");
const REQUIRED_LEVELS = requireList.length > 0 ? requireList : DEFAULT_REQUIRED;

const pinSha = one("expect-sha");
const pinRunId = one("run-id");
const pinAttemptRaw = one("attempt");
const pinAttempt = pinAttemptRaw === null ? null : Number(pinAttemptRaw);
if (pinAttemptRaw !== null && !Number.isInteger(pinAttempt)) {
  console.error(`dual-platform-acceptance: --attempt must be an integer (got ${JSON.stringify(pinAttemptRaw)})`);
  process.exit(2);
}

const explicitWindows = one("windows");
const explicitUbuntu = one("ubuntu");
const inDir = one("in");
if (inDir !== null && (explicitWindows !== null || explicitUbuntu !== null)) {
  console.error("dual-platform-acceptance: --in is mutually exclusive with --windows/--ubuntu");
  process.exit(2);
}

const refusal = [];

// ---------------------------------------------------------------------------
// The A6 per-arm verifier is loaded LAZILY and INJECTED into the task-7 bundle
// verifier, exactly as `ci-readiness.mjs` does. Without it, a leg that claims a
// raw-dependent PASS can never be re-verified and the summary would have to
// either pass it (wrong) or refuse every leg (also wrong). It is only imported
// when at least one leg actually records an evidenceRoot.
// ---------------------------------------------------------------------------

let armEvidenceVerifier = null;
let armEvidenceVerifierError = null;

async function loadArmEvidenceVerifier() {
  if (armEvidenceVerifier !== null || armEvidenceVerifierError !== null) return;
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
}

/** Cheap pre-scan so the evaluation package is imported only when it is needed. */
function recordsEvidenceRoot(path) {
  try {
    const art = JSON.parse(readFileSync(path, "utf8"));
    return isNonEmptyString(art?.inputs?.evidenceRoot);
  } catch {
    return false;
  }
}

/**
 * WHERE IS THE RAW BUNDLE?  (F30-7: deterministic, artifact-relative, never CWD)
 *
 * `ci-readiness.mjs` records `inputs.evidenceRoot` as the RAW `--evidence-root`
 * argument it was given. In CI that argument is a path RELATIVE to the PRODUCING
 * job's workspace (`.ci/prereg-production-e2e/pos-exec-runs/evidence`), and the
 * artifact is uploaded with the bundle beside it. The JOINING job downloads that
 * artifact into a different directory entirely (`.ci/dual/<os>/`), so the
 * recorded string does not resolve against this process's CWD.
 *
 * THE RULE, written down here rather than left to scan order:
 *
 *   1. AN EXPLICIT OVERRIDE WINS. `--windows-evidence-root` /
 *      `--ubuntu-evidence-root` replaces auto-resolution completely: it is used
 *      VERBATIM (absolute) or against the CWD (relative), and a value that cannot
 *      be read is a LOUD refusal — never a silent fall back to an auto root.
 *   2. OTHERWISE ONLY THE LEG ARTIFACT'S OWN TREE IS RANKED, in the documented
 *      order below. The joining process's CWD is NOT a candidate. That is the
 *      F30-7 fix: a stale `<cwd>/.ci/.../evidence` left by an earlier local run
 *      used to be scanned FIRST and win silently, so the join re-verified the
 *      wrong bytes and refused. An unrelated directory is no longer reachable by
 *      auto-resolution at all.
 *   3. TWO DISTINCT EXISTING ROOTS REFUSE. Silently taking the first match is
 *      what made (2) invisible; when more than one artifact-relative root exists
 *      the join refuses EVIDENCE_ROOT_AMBIGUOUS and lists all of them.
 *   4. OWNERSHIP IS ENFORCED. Every auto candidate must resolve INSIDE the leg
 *      artifact's own tree: a `..` escape, or a symlink that leaves the tree, is
 *      refused (EVIDENCE_ROOT_ESCAPE) even when the escaped directory exists.
 *   5. "NOTHING FOUND" STILL NAMES EVERY CANDIDATE — "the bundle is somewhere
 *      else" and "there is no bundle" must not read the same.
 *
 * The chosen candidate, the rule, and EVERY ranked candidate (with whether it
 * existed) are recorded in the verdict, so the decision is auditable instead of
 * implicit. Nothing here weakens verification: whichever directory is found must
 * still pass the FULL `verifyEvidenceBundle`.
 */

/** The rule text recorded in every verdict leg; see `resolveEvidenceRoot`. */
const EVIDENCE_ROOT_RULE = [
  "artifact-relative-only: an explicit --windows-evidence-root/--ubuntu-evidence-root override is used verbatim;",
  "otherwise only the leg artifact's own tree is ranked (leg-dir/basename, leg-dir/recorded, leg-root/recorded, leg-root/without-dot-ci, leg-root/basename);",
  "the joining process's cwd is NEVER an automatic candidate (F30-7);",
  "two or more distinct existing artifact-relative roots refuse as ambiguous instead of being scanned;",
  "every auto candidate must resolve inside the leg artifact's own tree.",
].join(" ");

/**
 * A usable evidence root must EXIST and BE A DIRECTORY. `existsSync` alone also
 * accepts a FILE, which then reads as an empty bundle rather than as a wrong
 * path — two different facts that must not be reported the same way.
 */
function usableDirectory(path) {
  try {
    return statSync(path).isDirectory()
      ? { ok: true, note: "exists and is a directory" }
      : { ok: false, note: "exists but is not a directory" };
  } catch {
    return { ok: false, note: "does not exist" };
  }
}

function resolveEvidenceRoot(recorded, legPath, isOverride) {
  const tried = [];
  const candidates = [];
  const problems = [];
  const outcome = (resolved, from) => ({ resolved, from, tried, candidates, rule: EVIDENCE_ROOT_RULE, problems });
  if (!isNonEmptyString(recorded)) return outcome(null, null);

  // --- 1. an explicit override is authoritative and is never replaced ---------
  if (isOverride) {
    const from = isAbsolute(recorded) ? "override(absolute)" : "override(cwd)";
    const target = resolve(recorded);
    tried.push(`${from}=${target}`);
    const usable = usableDirectory(target);
    candidates.push({ from, path: target, exists: usable.ok, note: usable.note });
    if (!usable.ok) {
      problems.push(
        `EVIDENCE_ROOT_OVERRIDE_UNUSABLE: the explicit evidence-root override ${JSON.stringify(recorded)} resolved to ${target}, which ${usable.note}; refusing rather than silently falling back to an auto-resolved root, because an ignored override is how the join reads bytes nobody chose`,
      );
      return outcome(null, null);
    }
    return outcome(target, from);
  }

  // --- 2. an ABSOLUTE recorded path is taken as the producer recorded it ------
  if (isAbsolute(recorded)) {
    const from = "recorded(absolute)";
    const target = resolve(recorded);
    tried.push(`${from}=${target}`);
    const usable = usableDirectory(target);
    candidates.push({ from, path: target, exists: usable.ok, note: usable.note });
    if (!usable.ok) {
      // "a file sits there" is a different fact from "nothing is there".
      if (usable.note !== "does not exist") {
        problems.push(`EVIDENCE_ROOT_UNUSABLE: the recorded evidenceRoot ${JSON.stringify(recorded)} exists at ${target} but ${usable.note}`);
      }
      return outcome(null, null);
    }
    return outcome(target, from);
  }

  // --- 3. relative: rank the leg artifact's OWN tree, never the CWD -----------
  const legDir = dirname(resolve(legPath));
  const legRoot = dirname(legDir);
  // The uploader's `path:` entries are repo-root-relative
  // (`.ci/prereg-production-e2e/...`), and `actions/upload-artifact` stores them
  // with the shared `.ci/` prefix stripped, so the download reproduces the path
  // WITHOUT it: `<legRoot>/prereg-production-e2e/pos-exec-runs/evidence`. The
  // `leg-root/recorded` candidate covers the other plausible packaging (an
  // uploader that kept the `.ci/` segment as a real directory), and
  // `leg-root/without-dot-ci` the measured one. Both are ranked, so neither
  // layout can silently break the join.
  //
  // MEASURED on run 36536713230: no candidate matched the real location, so the
  // join refused NO_RAW_EVIDENCE even though the bundle had downloaded correctly.
  // The candidates are derived from the leg artifact path itself (its directory
  // and its grandparent), never hardcoded.
  const withoutDotCi = recorded.replace(/^\.ci[/\\]/, "");
  const specs = [
    // A downloading job also places a bundle BESIDE the leg JSON (DP-O's flat
    // shape), which is the most specific location, so it is ranked first.
    ["leg-dir/basename", join(legDir, basename(recorded))],
    ["leg-dir/recorded", join(legDir, recorded)],
    ["leg-root/recorded", join(legRoot, recorded)],
  ];
  if (withoutDotCi !== recorded) {
    specs.push(["leg-root/without-dot-ci", join(legRoot, withoutDotCi)]);
  }
  specs.push(["leg-root/basename", join(legRoot, basename(recorded))]);

  const seen = new Set();
  const escaped = [];
  for (const [from, absolute] of specs) {
    // OWNERSHIP: the repository's single implementation of "stays inside the
    // root" is REUSED, not reimplemented — it refuses both a lexical `..` escape
    // and a path whose REAL location leaves the root through a link.
    const rel = relative(legRoot, absolute);
    const inside = resolveInsideRoot(legRoot, rel === "" ? "." : rel);
    if (!inside.ok) {
      tried.push(`${from}=REJECTED(${inside.problem})`);
      candidates.push({ from, path: resolve(absolute), exists: false, note: `rejected: ${inside.problem}` });
      // An escape that DOES exist is reported even though it is never read: "the
      // bundle is outside the tree" must not read as "there is no bundle".
      if (usableDirectory(resolve(absolute)).ok) {
        escaped.push(`${from}=${resolve(absolute)} (${inside.problem})`);
      }
      continue;
    }
    const target = inside.path;
    // The SAME directory under two names is not a second candidate: a recorded
    // path with no directory component makes `leg-dir/basename` and
    // `leg-dir/recorded` identical, and counting that as ambiguity would refuse
    // a leg that has exactly one root.
    if (seen.has(target)) continue;
    seen.add(target);
    tried.push(`${from}=${target}`);
    const usable = usableDirectory(target);
    candidates.push({ from, path: target, exists: usable.ok, note: usable.note });
  }

  if (escaped.length > 0) {
    problems.push(
      `EVIDENCE_ROOT_ESCAPE: the recorded evidenceRoot ${JSON.stringify(recorded)} resolves OUTSIDE the leg artifact's tree ${legRoot}, so it is refused even though it exists: ${escaped.join(", ")}`,
    );
    return outcome(null, null);
  }

  const existing = candidates.filter((c) => c.exists);
  if (existing.length > 1) {
    problems.push(
      `EVIDENCE_ROOT_AMBIGUOUS: ${existing.length} distinct artifact-relative evidence roots exist for this leg (${existing.map((c) => `${c.from}=${c.path}`).join(", ")}); the join does not take the first match by scan order — name the intended root with --windows-evidence-root/--ubuntu-evidence-root`,
    );
    return outcome(null, null);
  }
  if (existing.length === 1) return outcome(existing[0].path, existing[0].from);
  return outcome(null, null);
}

// ---------------------------------------------------------------------------
// Loading one leg
// ---------------------------------------------------------------------------

const sha256Text = (text) => createHash("sha256").update(text, "utf8").digest("hex");

/**
 * Parse and validate ONE readiness artifact. Returns `{leg}` or `{problems}`.
 * Validation is a PARSE, never a coercion: a stringified attempt number is
 * MALFORMED_ARTIFACT rather than silently `Number()`d into a passing value.
 */
function loadLeg(flagPlatform, path, evidenceRootOverride, requiredLevels) {
  const problems = [];
  const bad = (msg) => problems.push(`MALFORMED_ARTIFACT: ${flagPlatform}: ${msg}`);

  let text;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return { problems: [`MISSING_ARTIFACT: ${flagPlatform}: the readiness artifact ${path} is missing or unreadable`] };
  }
  let art;
  try {
    art = JSON.parse(text);
  } catch {
    return { problems: [`MALFORMED_ARTIFACT: ${flagPlatform}: ${path} is not valid JSON`] };
  }
  if (typeof art !== "object" || art === null || Array.isArray(art)) {
    return { problems: [`MALFORMED_ARTIFACT: ${flagPlatform}: the artifact is not a JSON object`] };
  }

  if (art.schemaVersion !== READINESS_SCHEMA) {
    bad(`schemaVersion is ${JSON.stringify(art.schemaVersion)}, expected ${READINESS_SCHEMA}`);
  }
  if (!isSha40(art.ciRunSha)) bad(`ciRunSha is not a 40-hex SHA (got ${JSON.stringify(art.ciRunSha)})`);
  if (!isSha40(art.expectedSha)) bad(`expectedSha is not a 40-hex SHA (got ${JSON.stringify(art.expectedSha)})`);
  if (!isNonEmptyString(art.ciRunId)) bad(`ciRunId is not a non-empty string (got ${JSON.stringify(art.ciRunId)})`);

  let attempt = null;
  let declaredPlatform = null;
  if (typeof art.inputs !== "object" || art.inputs === null) {
    bad("inputs is missing");
  } else {
    const a = art.inputs.attempt;
    if (a === null || a === undefined) attempt = null;
    else if (Number.isInteger(a)) attempt = a;
    else bad(`inputs.attempt is neither null nor an integer (got ${JSON.stringify(a)})`);
    const p = art.inputs.platform;
    if (p === null || p === undefined) declaredPlatform = null;
    else if (typeof p === "string") declaredPlatform = p;
    else bad(`inputs.platform is neither null nor a string (got ${JSON.stringify(p)})`);
  }

  const recorded = art.platforms?.thisProcess?.platform;
  if (typeof recorded !== "string" || recorded === "") {
    bad("platforms.thisProcess.platform is missing");
  } else if (!PLATFORMS.includes(recorded)) {
    bad(`platforms.thisProcess.platform is ${JSON.stringify(recorded)}, expected one of ${PLATFORMS.join("|")}`);
  }

  const levels = {};
  if (typeof art.levels !== "object" || art.levels === null) {
    bad("levels is missing");
  } else {
    for (const name of LEVELS) {
      const lv = art.levels[name];
      if (typeof lv !== "object" || lv === null) {
        bad(`levels.${name} is missing`);
        continue;
      }
      if (typeof lv.status !== "string" || lv.status === "") {
        bad(`levels.${name}.status is not a non-empty string`);
        continue;
      }
      levels[name] = { status: lv.status, blocker: typeof lv.blocker === "string" ? lv.blocker : null };
    }
  }

  if (problems.length > 0) return { problems };

  // --- platform labelling: the flag must agree with what the leg RECORDS -----
  if (recorded !== flagPlatform) {
    problems.push(`PLATFORM_MISMATCH: the leg passed under --${flagPlatform} records platforms.thisProcess.platform = ${recorded}`);
  }
  if (declaredPlatform !== null && declaredPlatform !== flagPlatform) {
    problems.push(`PLATFORM_MISMATCH: the leg passed under --${flagPlatform} was produced with --platform ${declaredPlatform}`);
  }

  // --- raw evidence ---------------------------------------------------------
  const recordedEvidenceRoot = isNonEmptyString(art.inputs?.evidenceRoot) ? art.inputs.evidenceRoot : null;
  const resolution = resolveEvidenceRoot(evidenceRootOverride ?? recordedEvidenceRoot, path, isNonEmptyString(evidenceRootOverride));
  const evidenceRoot = resolution.resolved;
  const claimsRawPass = LEVELS.filter((n) => RAW_DEPENDENT_LEVELS.has(n) && levels[n]?.status === "PASS");
  let bundleReVerified = null;
  if (claimsRawPass.length > 0 && evidenceRoot === null && resolution.problems.length === 0) {
    problems.push(`NO_RAW_EVIDENCE: the leg claims ${claimsRawPass.join(", ")} = PASS but records no evidenceRoot, so no raw bundle can be read`);
  }
  if (recordedEvidenceRoot !== null || isNonEmptyString(evidenceRootOverride)) {
    if (resolution.problems.length > 0) {
      // F30-7: an ambiguous, escaping or unusable root is a NAMED refusal. It is
      // never replaced by a fallback candidate, which is exactly how a stale
      // unrelated bundle used to be read without anyone choosing it.
      for (const p of resolution.problems) problems.push(p);
    } else if (evidenceRoot === null) {
      // Name EVERY candidate tried: "the bundle is somewhere else" and "there is
      // no bundle" are different facts and must not read the same.
      problems.push(
        `NO_RAW_EVIDENCE: the recorded evidenceRoot ${JSON.stringify(recordedEvidenceRoot)} could not be located` +
          (isNonEmptyString(evidenceRootOverride) ? ` (nor the override ${JSON.stringify(evidenceRootOverride)})` : "") +
          `; tried ${resolution.tried.join(", ")}`,
      );
    } else {
      // Re-verify through the EXISTING task-7 verifier (imported, not reimplemented).
      const bundle = verifyEvidenceBundle({
        evidenceRoot,
        expectSha: art.expectedSha,
        runId: art.ciRunId,
        attempt,
        platform: flagPlatform,
        // Injected so the per-arm manifest/verifier/security bytes are really read.
        armEvidenceVerifier,
      });
      const classified = classifyBundleProblems(bundle, requiredLevels);
      bundleReVerified = {
        ok: bundle.problems.length === 0,
        problems: bundle.problems,
        derivedVerifierCoverage: bundle.facts?.derivedVerifierCoverage ?? null,
        journalBinding: bundle.facts?.journalBinding?.status ?? null,
        requestDispatchBinding: bundle.facts?.requestDispatchBinding?.status ?? null,
        // The verifier's OWN per-level verdicts, carried through so a reviewer sees
        // which level really failed rather than a flattened problem list.
        verifierLevels: classified.levels,
        levelAuthority: classified.levelAuthority,
        // Recorded, not hidden: a problem that cannot block the levels this run
        // actually requires is still reported verbatim, with the level it speaks to.
        blocksAllLevels: classified.blocksAll,
        realBuildOnly: {
          blockedLevel: "realBuildOfflineReady",
          required: requiredLevels.includes("realBuildOfflineReady"),
          problems: classified.realBuildOnly,
        },
      };
      if (classified.blocksAll.length > 0) {
        problems.push(`RAW_EVIDENCE_MISMATCH: re-verifying ${flagPlatform}'s bundle reported: ${classified.blocksAll.join("; ")}`);
      }
    }
  }

  if (problems.length > 0) return { problems };

  return {
    leg: {
      path: resolve(path),
      artifactSha256: sha256Text(text),
      platform: flagPlatform,
      recordedPlatform: recorded,
      ciRunId: art.ciRunId,
      ciRunSha: art.ciRunSha,
      expectedSha: art.expectedSha,
      attempt,
      // Both are recorded so a reviewer can see WHAT the leg claimed and WHERE the
      // bytes were actually found — a bare resolved path would hide a wrong claim.
      evidenceRootRecorded: recordedEvidenceRoot,
      evidenceRoot,
      evidenceRootResolvedFrom: resolution.from,
      // F30-7: the RULE and EVERY ranked candidate are recorded, so a reviewer
      // can see the resolution was rule-driven — and that the joining process's
      // cwd was never a candidate — rather than trusting an unexplained path.
      evidenceRootRule: resolution.rule,
      evidenceRootCandidates: resolution.candidates,
      levels,
      bundleReVerified,
      bundleDerivedVerifierCoverage: bundleReVerified?.derivedVerifierCoverage ?? null,
    },
  };
}

// ---------------------------------------------------------------------------
// Discovery mode
// ---------------------------------------------------------------------------

function peekPlatform(path) {
  try {
    const art = JSON.parse(readFileSync(path, "utf8"));
    const p = art?.platforms?.thisProcess?.platform;
    if (PLATFORMS.includes(p)) return p;
    const q = art?.inputs?.platform;
    if (PLATFORMS.includes(q)) return q;
    return null;
  } catch {
    return null;
  }
}

function discoverReadinessArtifacts(dir) {
  const found = [];
  const walk = (d, depth) => {
    if (depth > 4) return;
    let entries;
    try {
      entries = readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const p = join(d, entry.name);
      if (entry.isDirectory()) walk(p, depth + 1);
      else if (entry.isFile() && /^ci-readiness.*\.json$/i.test(entry.name)) found.push(p);
    }
  };
  walk(dir, 0);
  return found.sort();
}

let windowsPath = explicitWindows;
let ubuntuPath = explicitUbuntu;

if (inDir !== null) {
  const root = resolve(inDir);
  if (!existsSync(root)) {
    console.error(`dual-platform-acceptance: --in ${inDir} does not exist`);
    process.exit(2);
  }
  const byPlatform = new Map(PLATFORMS.map((p) => [p, []]));
  const unclassified = [];
  for (const p of discoverReadinessArtifacts(root)) {
    const platform = peekPlatform(p);
    if (platform === null) unclassified.push(p);
    else byPlatform.get(platform).push(p);
  }
  for (const p of unclassified) {
    refusal.push(`MALFORMED_ARTIFACT: discovered artifact ${p} does not record a windows|ubuntu platform, so it cannot be assigned to a leg`);
  }
  for (const platform of PLATFORMS) {
    const list = byPlatform.get(platform);
    if (list.length === 0) refusal.push(`PLATFORM_MISSING: no ${platform} readiness artifact was discovered under ${inDir}`);
    else if (list.length > 1) refusal.push(`PLATFORM_DUPLICATE: ${list.length} ${platform} readiness artifacts were discovered under ${inDir} (${list.join(", ")}); the acceptance unit is ambiguous`);
    else if (platform === "windows") windowsPath = list[0];
    else ubuntuPath = list[0];
  }
} else {
  if (windowsPath === null) refusal.push("PLATFORM_MISSING: --windows <ci-readiness.json> was not supplied");
  if (ubuntuPath === null) refusal.push("PLATFORM_MISSING: --ubuntu <ci-readiness.json> was not supplied");
}

if (refusal.length === 0) {
  if (recordsEvidenceRoot(windowsPath) || recordsEvidenceRoot(ubuntuPath)) {
    await loadArmEvidenceVerifier();
    if (armEvidenceVerifier === null) {
      console.error(`dual-platform-acceptance: the A6 per-arm evidence verifier is unavailable (${armEvidenceVerifierError}); raw arm artifacts cannot be verified`);
    }
  }
  const w = loadLeg("windows", windowsPath, one("windows-evidence-root"), REQUIRED_LEVELS);
  const u = loadLeg("ubuntu", ubuntuPath, one("ubuntu-evidence-root"), REQUIRED_LEVELS);
  for (const r of [...(w.problems ?? []), ...(u.problems ?? [])]) refusal.push(r);

  if (refusal.length === 0) {
    const legW = w.leg;
    const legU = u.leg;

    // --- the two legs must be ONE acceptance unit --------------------------
    if (legW.recordedPlatform === legU.recordedPlatform) {
      refusal.push(`PLATFORM_DUPLICATE: both legs record platform ${legW.recordedPlatform}; there is no second platform`);
    }
    if (legW.ciRunId !== legU.ciRunId) {
      refusal.push(`SAME_RUN_MISMATCH: windows ciRunId ${legW.ciRunId} != ubuntu ciRunId ${legU.ciRunId}`);
    }
    if (legW.expectedSha !== legU.expectedSha) {
      refusal.push(`SAME_SHA_MISMATCH: windows expectedSha ${legW.expectedSha} != ubuntu expectedSha ${legU.expectedSha}`);
    }
    if (legW.ciRunSha !== legU.ciRunSha) {
      refusal.push(`SAME_SHA_MISMATCH: windows ciRunSha ${legW.ciRunSha} != ubuntu ciRunSha ${legU.ciRunSha}`);
    }
    if (legW.attempt === null && legU.attempt === null) {
      refusal.push("ATTEMPT_MISSING: neither leg records an attempt number, so the two legs cannot be proven to be the same attempt");
    } else if (legW.attempt !== legU.attempt) {
      refusal.push(`ATTEMPT_MISMATCH: windows attempt ${String(legW.attempt)} != ubuntu attempt ${String(legU.attempt)}`);
    }
    if (pinSha !== null) {
      if (!isSha40(pinSha)) refusal.push(`MALFORMED_ARTIFACT: --expect-sha is not a 40-hex SHA (got ${JSON.stringify(pinSha)})`);
      else if (legW.expectedSha !== pinSha) refusal.push(`SAME_SHA_MISMATCH: windows expectedSha ${legW.expectedSha} != --expect-sha ${pinSha}`);
    }
    if (pinRunId !== null && legW.ciRunId !== pinRunId) {
      refusal.push(`SAME_RUN_MISMATCH: windows ciRunId ${legW.ciRunId} != --run-id ${pinRunId}`);
    }
    if (pinAttempt !== null && legW.attempt !== pinAttempt) {
      refusal.push(`ATTEMPT_MISMATCH: windows attempt ${String(legW.attempt)} != --attempt ${String(pinAttempt)}`);
    }

    if (refusal.length === 0) {
      // --- per-level comparison -------------------------------------------
      const levelVerdict = (a, b) => {
        if (a === "PASS" && b === "PASS") return "BOTH_PASS";
        if (a === "PASS" || b === "PASS") return "SPLIT";
        if (a === "FAIL" && b === "FAIL") return "BOTH_FAIL";
        if (UNPROVEN_STATUSES.has(a) && UNPROVEN_STATUSES.has(b)) return "NOT_PROVEN";
        // Any other combination is a disagreement and is NEVER averaged or OR-ed.
        return "SPLIT";
      };

      const perLevel = {};
      for (const name of LEVELS) {
        const a = legW.levels[name].status;
        const b = legU.levels[name].status;
        perLevel[name] = {
          windows: a,
          ubuntu: b,
          verdict: levelVerdict(a, b),
          windowsBlocker: legW.levels[name].blocker,
          ubuntuBlocker: legU.levels[name].blocker,
        };
      }

      const verdicts = LEVELS.map((n) => perLevel[n].verdict);
      let overall;
      if (verdicts.includes("SPLIT")) overall = "SPLIT";
      else if (verdicts.includes("BOTH_FAIL")) overall = "FAIL";
      else if (verdicts.includes("NOT_PROVEN")) overall = "NOT_PROVEN";
      else overall = "PASS";

      const unmet = REQUIRED_LEVELS.filter((n) => perLevel[n]?.verdict !== "BOTH_PASS");
      const unknownRequired = REQUIRED_LEVELS.filter((n) => perLevel[n] === undefined);

      const verdict = {
        schemaVersion: SCHEMA_VERSION,
        generatedBy: "scripts/e4/dual-platform-acceptance.mjs",
        acceptanceUnit: {
          ciRunId: legW.ciRunId,
          expectedSha: legW.expectedSha,
          ciRunSha: legW.ciRunSha,
          attempt: legW.attempt,
          platforms: PLATFORMS,
        },
        legs: { windows: legW, ubuntu: legU },
        levels: perLevel,
        overall,
        // A NOT_PROVEN level is a FINDING, not a failure to hide.
        findings: LEVELS.filter((n) => perLevel[n].verdict !== "BOTH_PASS").map((n) => ({
          level: n,
          verdict: perLevel[n].verdict,
          windows: perLevel[n].windows,
          ubuntu: perLevel[n].ubuntu,
        })),
        requiredLevels: REQUIRED_LEVELS,
        unmetRequiredLevels: unmet,
        unknownRequiredLevels: unknownRequired,
        strict: strictMode,
        strictGatePassed: unmet.length === 0 && unknownRequired.length === 0,
        exitCode: strictMode && (unmet.length > 0 || unknownRequired.length > 0) ? 1 : 0,
      };

      const outAbs = resolve(outPath);
      mkdirSync(dirname(outAbs), { recursive: true });
      writeFileSync(outAbs, `${JSON.stringify(verdict, null, 2)}\n`, "utf8");

      // --- human-readable summary table -----------------------------------
      const pad = (s, n) => String(s).padEnd(n);
      const lines = [];
      lines.push("dual-platform acceptance (SEPARATED levels — a single-platform green is NOT acceptance)");
      lines.push(`  run: ${legW.ciRunId}  sha: ${legW.expectedSha}  attempt: ${String(legW.attempt)}`);
      lines.push(`  windows: ${legW.path}`);
      lines.push(`  ubuntu:  ${legU.path}`);
      lines.push(`  ${pad("level", 24)} ${pad("windows", 14)} ${pad("ubuntu", 14)} verdict`);
      for (const name of LEVELS) {
        const l = perLevel[name];
        lines.push(`  ${pad(name, 24)} ${pad(l.windows, 14)} ${pad(l.ubuntu, 14)} ${l.verdict}`);
      }
      lines.push(`  overall: ${overall}`);
      lines.push(`  required: ${REQUIRED_LEVELS.join(", ")}`);
      if (unknownRequired.length > 0) lines.push(`  UNKNOWN required level(s): ${unknownRequired.join(", ")}`);
      if (strictMode) {
        lines.push(
          verdict.strictGatePassed
            ? "  strict gate: PASS"
            : `  strict gate: FAILED (${[...unmet, ...unknownRequired].join(", ")})`,
        );
      } else {
        lines.push("  strict gate: NOT RUN (report mode)");
      }
      lines.push(`  verdict: ${outAbs}`);
      process.stdout.write(`${lines.join("\n")}\n`);

      if (strictMode && !verdict.strictGatePassed) {
        console.error(`dual-platform-acceptance STRICT GATE FAILED: ${[...unmet, ...unknownRequired].length} required level(s) are not BOTH_PASS`);
        for (const n of [...unmet, ...unknownRequired]) {
          console.error(`  ${n}: ${perLevel[n] === undefined ? "UNKNOWN (not a known level)" : `${perLevel[n].windows} / ${perLevel[n].ubuntu} -> ${perLevel[n].verdict}`}`);
        }
        process.exit(1);
      }
      process.exit(0);
    }
  }
}

// Refused: name every reason and write NO verdict.
console.error("dual-platform-acceptance REFUSED: the two legs are not one acceptance unit");
for (const reason of refusal) console.error(`  ${reason}`);
console.error("  (no verdict was written: a refusal is not a result)");
process.exit(2);
