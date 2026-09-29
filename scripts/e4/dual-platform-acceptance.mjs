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
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isNonEmptyString, isSha40, verifyEvidenceBundle } from "./readiness-evidence-verify.mjs";

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
                      them; without an override the joiner tries the recorded
                      path, then CWD, then beside the leg artifact itself.
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
 * WHERE IS THE RAW BUNDLE?
 *
 * `ci-readiness.mjs` records `inputs.evidenceRoot` as the RAW `--evidence-root`
 * argument it was given. In CI that argument is a path RELATIVE to the PRODUCING
 * job's workspace (`.ci/r97-r98/readiness-evidence`), and the artifact is
 * uploaded with the bundle beside it. The JOINING job downloads that artifact
 * into a different directory entirely (`.ci/dual/windows/`), so the recorded
 * string does not resolve against this process's CWD.
 *
 * Resolving only against the CWD would therefore refuse EVERY real leg for a
 * reason that is about job layout, not about the evidence — a gate that is red
 * for the wrong reason is a gate nobody trusts. So we try the documented
 * candidates IN ORDER, record which one matched, and still refuse (naming every
 * candidate) when none matches. Nothing here weakens verification: whichever
 * directory is found must still pass the FULL `verifyEvidenceBundle`.
 *
 * A caller can also pin the location explicitly with `--windows-evidence-root` /
 * `--ubuntu-evidence-root`, which is tried FIRST and is never silently ignored.
 */
function resolveEvidenceRoot(recorded, legPath, isOverride) {
  if (!isNonEmptyString(recorded)) return { resolved: null, from: null, tried: [] };
  const tried = [];
  const legDir = dirname(resolve(legPath));
  // The leg ARTIFACT's own directory (`.ci/dual/<platform>`), which is where
  // `actions/download-artifact` places a bundle the producing job uploaded
  // alongside its JSON. The uploader lists repo-root-relative paths, so the
  // artifact preserves them and the download NESTS one level deeper than the
  // JSON: with the JSON at `.ci/dual/<os>/r97-r98/ci-readiness.json`, the bundle
  // lands at `.ci/dual/<os>/prereg-production-e2e/pos-exec-runs/evidence`.
  //
  // MEASURED on run 36536713230: none of the candidates below matched that real
  // location, so the join refused NO_RAW_EVIDENCE even though the bundle had
  // downloaded correctly. The candidate is derived from the leg artifact path's
  // GRANDPARENT (strip `r97-r98/<file>`), not hardcoded, so a different artifact
  // layout does not silently break it.
  const legRoot = dirname(legDir);
  // The uploader's `path:` entries are repo-root-relative (`.ci/prereg-production-e2e/...`),
  // and `actions/upload-artifact` stores them, so the download reproduces the FULL
  // path including the `.ci/` segment: `<legRoot>/.ci/prereg-production-e2e/pos-exec-runs/evidence`.
  // The `leg-root/recorded` candidate below therefore finds it AS RECORDED, and
  // `leg-root/dot-ci-stripped` covers the other plausible packaging (an uploader
  // that rooted its paths at `.ci/` instead of the repo root). Both are tried, so
  // neither layout can silently break the join.
  const withoutDotCi = recorded.replace(/^\.ci[/\\]/, "");
  const candidates = [];
  if (isAbsolute(recorded)) {
    candidates.push([isOverride ? "override(absolute)" : "recorded(absolute)", recorded]);
  } else {
    candidates.push([isOverride ? "override(cwd)" : "cwd", resolve(recorded)]);
    candidates.push(["leg-dir/basename", join(legDir, basename(recorded))]);
    candidates.push(["leg-dir/recorded", join(legDir, recorded)]);
    candidates.push(["leg-root/recorded", join(legRoot, recorded)]);
    if (withoutDotCi !== recorded) {
      candidates.push(["leg-root/without-dot-ci", join(legRoot, withoutDotCi)]);
    }
    candidates.push(["leg-root/basename", join(legRoot, basename(recorded))]);
  }
  for (const [from, candidate] of candidates) {
    tried.push(`${from}=${candidate}`);
    if (existsSync(candidate)) return { resolved: candidate, from, tried };
  }
  return { resolved: null, from: null, tried };
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
function loadLeg(flagPlatform, path, evidenceRootOverride) {
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
  if (claimsRawPass.length > 0 && evidenceRoot === null) {
    problems.push(`NO_RAW_EVIDENCE: the leg claims ${claimsRawPass.join(", ")} = PASS but records no evidenceRoot, so no raw bundle can be read`);
  }
  if (recordedEvidenceRoot !== null || isNonEmptyString(evidenceRootOverride)) {
    if (evidenceRoot === null) {
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
      bundleReVerified = {
        ok: bundle.problems.length === 0,
        problems: bundle.problems,
        derivedVerifierCoverage: bundle.facts?.derivedVerifierCoverage ?? null,
        journalBinding: bundle.facts?.journalBinding?.status ?? null,
        requestDispatchBinding: bundle.facts?.requestDispatchBinding?.status ?? null,
      };
      if (bundle.problems.length > 0) {
        problems.push(`RAW_EVIDENCE_MISMATCH: re-verifying ${flagPlatform}'s bundle reported: ${bundle.problems.join("; ")}`);
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
  const w = loadLeg("windows", windowsPath, one("windows-evidence-root"));
  const u = loadLeg("ubuntu", ubuntuPath, one("ubuntu-evidence-root"));
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
