/**
 * S7b — same-SHA dual-platform acceptance summary (plan(20260929-015956).md §10/S7).
 *
 * WHAT THIS TESTS: `scripts/e4/dual-platform-acceptance.mjs` joins the two
 * per-platform readiness artifacts into ONE verdict, and REFUSES to join legs
 * that are not the same acceptance unit. Every refusal below is a REAL
 * counter-example driven as a subprocess: a nonzero exit AND a named reason.
 *
 * THE HONEST BASELINE: `realBuildOfflineReady` is NOT_PROVEN today and that is
 * CORRECT — no producer writes `dualBuild` yet (task-5/S3). The consistent-pair
 * test therefore asserts NOT_PROVEN is reported as a FINDING, not papered over.
 * No test synthesizes a PASS to make the two-leg table look complete; where a
 * test does forge a PASS (the NO_RAW_EVIDENCE / RAW_EVIDENCE_MISMATCH cases) it is
 * explicitly to prove the refusal fires.
 *
 * OFFLINE: local files and local child processes only. No provider, no tool, no
 * network, no cost. The script executes nothing inside an artifact.
 */

import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

const REPO_ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const SCRIPT = join(REPO_ROOT, "scripts", "e4", "dual-platform-acceptance.mjs");
const HEAD = execFileSync("git", ["rev-parse", "HEAD"], { cwd: REPO_ROOT, encoding: "utf8" }).trim();

const CREATED: string[] = [];
afterAll(() => {
  for (const dir of CREATED) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* temp cleanup only */
    }
  }
});

interface Verdict {
  schemaVersion: string;
  acceptanceUnit: { ciRunId: string; expectedSha: string; ciRunSha: string; attempt: number | null; platforms: string[] };
  legs: Record<string, { path: string; platform: string; recordedPlatform: string; attempt: number | null; evidenceRoot: string | null; evidenceRootRecorded: string | null; evidenceRootResolvedFrom: string | null; evidenceRootRule: string | null; evidenceRootCandidates: { from: string; path: string; exists: boolean; note: string }[] | null; bundleReVerified: { ok: boolean; problems: string[]; derivedVerifierCoverage: { verified: number; total: number } | null; journalBinding: string | null; requestDispatchBinding: string | null; verifierLevels: Record<string, { status: string; reason: string | null }> | null; levelAuthority: string | null; blocksAllLevels: string[]; realBuildOnly: { blockedLevel: string; required: boolean; problems: string[] } } | null }>;
  levels: Record<string, { windows: string; ubuntu: string; verdict: string }>;
  overall: string;
  findings: { level: string; verdict: string; windows: string; ubuntu: string }[];
  requiredLevels: string[];
  unmetRequiredLevels: string[];
  strict: boolean;
  strictGatePassed: boolean;
  exitCode: number;
}

interface RunResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  verdictPath: string;
  verdict: Verdict | null;
}

/**
 * One readiness artifact with the shape `scripts/e4/ci-readiness.mjs` writes.
 * The defaults are the CURRENT, HONEST state: the fixture protocol passes, the
 * real-build and budget levels are NOT_PROVEN (no `dualBuild` producer yet), and
 * paid/promotion are NOT_RUN.
 */
function readinessArtifact(platform: "windows" | "ubuntu", overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const base: Record<string, unknown> = {
    schemaVersion: "prereg-ci-readiness-v2",
    generatedBy: "scripts/e4/ci-readiness.mjs",
    ciRunSha: HEAD,
    expectedSha: HEAD,
    ciRunId: "36540000000",
    inputs: {
      e2ePath: "/ci/prereg-production-e2e.json",
      e2eSha256: "e".repeat(64),
      otherPlatformArtifactPath: null,
      otherPlatformArtifactSha256: null,
      evidenceRoot: null,
      attempt: 2,
      platform,
      strict: true,
      requiredLevels: ["fixtureProtocolReady", "realBuildOfflineReady", "budgetEvidenceReady"],
    },
    os: { label: `${platform}-latest`, platform: platform === "windows" ? "win32" : "linux", arch: "x64", node: "v24.18.1" },
    platforms: {
      thisProcess: { platform, rawPlatform: platform === "windows" ? "win32" : "linux", status: "MEASURED" },
      windows: { status: platform === "windows" ? "MEASURED" : "NOT_OBSERVED", detail: "" },
      ubuntu: { status: platform === "ubuntu" ? "MEASURED" : "NOT_OBSERVED", detail: "" },
      crossPlatform: { status: "NOT_OBSERVED", sameSha: null, selfMeasured: false, detail: "" },
    },
    commandExits: { typecheck: 0, test: 0, build: 0 },
    counts: {},
    executionKind: "SYNTHETIC_FIXTURE_BUILD",
    forwardBasis: "SYNTHETIC_FIXTURE_BUILD",
    forwardBasisSource: "readiness.productionOfflineReadiness.releaseCliSubprocessForwardBasis (leading enum token)",
    levels: {
      fixtureProtocolReady: { status: "PASS", basis: "the offline closed loop over SYNTHETIC fixture arm builds" },
      realBuildOfflineReady: {
        status: "NOT_PROVEN",
        basis: "the structured execution kind is SYNTHETIC_FIXTURE_BUILD, so no real dual pinned build is available",
        blocker: "NO_REAL_ARM_PAIR: real dual frozen arm builds + the real verifier over them are NOT_PROVEN",
      },
      budgetEvidenceReady: { status: "NOT_PROVEN", basis: "the raw arm evidence has not been verified" },
      paidExperimentRun: { status: "NOT_RUN", basis: "no paid authorization exists; this script never creates one" },
      championPromotion: { status: "NOT_RUN", basis: "no promotion is performed or authorized by this script" },
    },
  };
  return deepMerge(base, overrides) as Record<string, unknown>;
}

function deepMerge(base: unknown, over: unknown): unknown {
  if (over === undefined) return base;
  if (Array.isArray(over) || typeof over !== "object" || over === null) return over;
  if (typeof base !== "object" || base === null || Array.isArray(base)) return over;
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [k, v] of Object.entries(over as Record<string, unknown>)) {
    // `undefined` in an override means "REMOVE this key", so a counter-example can
    // model a genuinely missing field rather than a silently-ignored one.
    if (v === undefined) {
      delete out[k];
      continue;
    }
    out[k] = k in out ? deepMerge(out[k], v) : v;
  }
  return out;
}

/** A scratch directory with a `write` helper and an acceptance runner. */
function scratch(): {
  dir: string;
  write: (name: string, value: unknown) => string;
  run: (args: string[], options?: { cwd?: string }) => RunResult;
} {
  const dir = mkdtempSync(join(tmpdir(), "dp-accept-"));
  CREATED.push(dir);
  const write = (name: string, value: unknown): string => {
    const p = join(dir, name);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, typeof value === "string" ? value : JSON.stringify(value), "utf8");
    return p;
  };
  const run = (args: string[], options?: { cwd?: string }): RunResult => {
    const verdictPath = join(dir, `verdict-${Math.random().toString(36).slice(2)}.json`);
    const result = spawnSync(process.execPath, [SCRIPT, ...args, "--out", verdictPath], {
      // The join runs from the repository root in CI. A test that models a STALE
      // bundle at the join's own cwd points this at its own directory (DP-W),
      // which is what makes the F30-7 condition hermetic instead of dependent on
      // whatever happens to be left in this checkout.
      cwd: options?.cwd ?? REPO_ROOT,
      encoding: "utf8",
      timeout: 60_000,
    });
    if (result.error) throw new Error(`dual-platform-acceptance child did not complete: ${result.error.message}`);
    let verdict: Verdict | null = null;
    try {
      verdict = JSON.parse(readFileSync(verdictPath, "utf8")) as Verdict;
    } catch {
      verdict = null; // a refusal writes NO verdict — that is the contract
    }
    return { exitCode: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "", verdictPath, verdict };
  };
  return { dir, write, run };
}

/** The consistent pair: same run, same SHA, same attempt, different platforms. */
function consistentPair(dir: string): { windows: string; ubuntu: string } {
  return {
    windows: writeArtifact(dir, "ci-readiness-windows.json", readinessArtifact("windows")),
    ubuntu: writeArtifact(dir, "ci-readiness-ubuntu.json", readinessArtifact("ubuntu")),
  };
}

function writeArtifact(dir: string, name: string, value: unknown): string {
  const p = join(dir, name);
  writeFileSync(p, JSON.stringify(value), "utf8");
  return p;
}

// ---------------------------------------------------------------------------
// A minimal but GENUINELY VALID raw bundle, so requirement 6 (re-verify each
// leg's bundle through the EXISTING verifyEvidenceBundle) is proven end to end
// rather than merely imported.
// ---------------------------------------------------------------------------

const BUNDLE_SCHEMA = "prereg-readiness-evidence-v1";

function writeValidBundle(dir: string, platform: "windows" | "ubuntu"): string {
  const root = join(dir, `bundle-${platform}`);
  const runId = "36540000000";
  const arms = [
    { armRunId: "run-baseline-0", armId: "baseline", orderIndex: 0, sourceSha: "1".repeat(40), buildDigest: "a".repeat(64), entrySha256: "c".repeat(64) },
    { armRunId: "run-candidate-0", armId: "candidate", orderIndex: 1, sourceSha: "2".repeat(40), buildDigest: "b".repeat(64), entrySha256: "d".repeat(64) },
  ];
  const identity = {
    schemaVersion: BUNDLE_SCHEMA,
    driverSha: HEAD,
    runId,
    attempt: 2,
    platform,
    closuresDistinguishable: true,
    arms: {
      baseline: { sourceSha: arms[0]!.sourceSha, buildDigest: arms[0]!.buildDigest, entrySha256: arms[0]!.entrySha256, clean: true },
      candidate: { sourceSha: arms[1]!.sourceSha, buildDigest: arms[1]!.buildDigest, entrySha256: arms[1]!.entrySha256, clean: true },
    },
  };
  const scheduleArms = arms.map((a) => {
    const manifestText = `${JSON.stringify({
      schemaVersion: "prereg-run-manifest-v1",
      executorId: "prereg-arm-executor-v1",
      preregistrationDigest: "e".repeat(64),
      planDigest: "f".repeat(64),
      armRunId: a.armRunId,
      armId: a.armId,
      caseId: "reg-12-csv-parse",
      repetition: 1,
      orderIndex: a.orderIndex,
      armBuildDigest: a.buildDigest,
      armEntrySha256: a.entrySha256,
      armProbe: "r97-arm-probe-v1",
    })}\n`;
    return {
      armRunId: a.armRunId,
      armId: a.armId,
      caseId: "reg-12-csv-parse",
      repetition: 1,
      orderIndex: a.orderIndex,
      preregistrationDigest: "e".repeat(64),
      planDigest: "f".repeat(64),
      evidence: {
        executorId: "prereg-arm-executor-v1",
        traceDigest: createHash("sha256").update(manifestText, "utf8").digest("hex"),
        verifiedCompletion: true,
        securityViolations: 0,
        activationEvidenceDigest: null,
      },
    };
  });
  const files: Record<string, string> = {
    "identity.json": `${JSON.stringify(identity)}\n`,
    "schedule.json": `${JSON.stringify({ schemaVersion: BUNDLE_SCHEMA, arms: scheduleArms })}\n`,
  };
  for (const a of arms) {
    files[`evidence/${a.armRunId}/manifest.json`] = `${JSON.stringify({
      schemaVersion: "prereg-run-manifest-v1",
      executorId: "prereg-arm-executor-v1",
      preregistrationDigest: "e".repeat(64),
      planDigest: "f".repeat(64),
      armRunId: a.armRunId,
      armId: a.armId,
      caseId: "reg-12-csv-parse",
      repetition: 1,
      orderIndex: a.orderIndex,
      armBuildDigest: a.buildDigest,
      armEntrySha256: a.entrySha256,
      armProbe: "r97-arm-probe-v1",
    })}\n`;
    files[`evidence/${a.armRunId}/verifier.json`] = `${JSON.stringify({ schemaVersion: "prereg-run-verifier-v1", verifiedCompletion: true, status: "passed", grade: "strong", violations: [] })}\n`;
    files[`evidence/${a.armRunId}/security.json`] = `${JSON.stringify({ schemaVersion: "prereg-run-security-v1", violations: 0 })}\n`;
  }
  for (const [rel, text] of Object.entries(files)) {
    const p = join(root, rel);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, text, "utf8");
  }
  return root;
}

/**
 * `writeValidBundle` with the REAL ARM PAIR removed — the honest shape Phase H
 * writes for a `SYNTHETIC_FIXTURE_BUILD` run: every other byte is valid, and
 * `identity.arms.<id>.sourceSha` is OMITTED (not null), which is what makes the
 * verifier emit `BASELINE_/CANDIDATE_SOURCE_SHA_INVALID`.
 *
 * The digest/entry/clean fields stay real, so the ONLY problems are the two
 * sourceSha codes: a test using this fixture proves the level attribution, not
 * the fixture's own brokenness.
 */
function writeValidBundleWithoutArmPair(dir: string, platform: "windows" | "ubuntu"): string {
  const root = writeValidBundle(dir, platform);
  const identityPath = join(root, "identity.json");
  const identity = JSON.parse(readFileSync(identityPath, "utf8")) as {
    arms: Record<string, Record<string, unknown>>;
    closuresDistinguishable?: unknown;
  };
  for (const armId of ["baseline", "candidate"]) {
    delete identity.arms[armId]!.sourceSha;
  }
  // `closuresDistinguishable` is recomputed by the verifier from the two build
  // digests, which still differ, so it stays true and is NOT one of the problems.
  writeFileSync(identityPath, `${JSON.stringify(identity)}\n`, "utf8");
  return root;
}

/**
 * A bundle that is valid in every way EXCEPT that it carries NO platform on
 * `identity.json` — the exact CI wiring defect (`ci.yml` never passed
 * `--platform`) that the dual-platform join must still refuse.
 */
function writeValidBundleWithoutPlatform(dir: string, platform: "windows" | "ubuntu"): string {
  const root = writeValidBundle(dir, platform);
  const identityPath = join(root, "identity.json");
  const identity = JSON.parse(readFileSync(identityPath, "utf8")) as Record<string, unknown>;
  delete identity.platform;
  writeFileSync(identityPath, `${JSON.stringify(identity)}\n`, "utf8");
  return root;
}

/**
 * The RECORDED `inputs.evidenceRoot` the e4 producer writes — verbatim from
 * `ci.yml`'s `--evidence-root` argument, i.e. a path RELATIVE to the PRODUCING
 * job's workspace. This is the value whose resolution F30-7 is about.
 */
const CI_RECORDED_EVIDENCE_ROOT = ".ci/prereg-production-e2e/pos-exec-runs/evidence";

/** Copy a bundle's CONTENTS into `dest` — `dest` itself IS the evidence root. */
function copyBundleInto(root: string, dest: string): void {
  mkdirSync(dest, { recursive: true });
  for (const entry of readdirSync(root)) {
    cpSync(join(root, entry), join(dest, entry), { recursive: true });
  }
}

/**
 * The MEASURED CI download layout (ci.yml's own note: `.ci/dual/<leg>/r97-r98/
 * ci-readiness.json` beside `.ci/dual/<leg>/prereg-production-e2e/pos-exec-runs/
 * evidence`): the leg JSON nested under the leg ROOT, and its bundle at
 * `<legRoot>/<recorded with the .ci/ segment stripped>` — the shape
 * `actions/upload-artifact` produces when the uploader's `path:` entries are
 * repo-root-relative. Returns the paths the test needs to assert against.
 */
function nestedLeg(
  dir: string,
  leg: "windows" | "ubuntu",
  options: { recorded?: string } = {},
): { artifact: string; bundle: string; legRoot: string } {
  const recorded = options.recorded ?? CI_RECORDED_EVIDENCE_ROOT;
  const legRoot = join(dir, leg);
  mkdirSync(join(legRoot, "r97-r98"), { recursive: true });
  const artifact = writeArtifact(
    dir,
    `${leg}/r97-r98/ci-readiness.json`,
    readinessArtifact(leg, { inputs: { evidenceRoot: recorded } }),
  );
  const bundle = join(legRoot, recorded.replace(/^\.ci[/\\]/, ""));
  copyBundleInto(writeValidBundle(dir, leg), bundle);
  return { artifact, bundle, legRoot };
}

describe("S7b — dual-platform acceptance joins two legs, or refuses", () => {
  it("DP-0: a consistent same-run/same-SHA/same-attempt pair yields a verdict, and reports the CURRENT honest state", () => {
    const s = scratch();
    const pair = consistentPair(s.dir);
    const r = s.run(["--windows", pair.windows, "--ubuntu", pair.ubuntu]);

    expect(r.exitCode).toBe(0);
    expect(r.verdict).not.toBeNull();
    const v = r.verdict!;
    expect(v.schemaVersion).toBe("prereg-dual-platform-acceptance-v1");
    expect(v.acceptanceUnit.ciRunId).toBe("36540000000");
    expect(v.acceptanceUnit.expectedSha).toBe(HEAD);
    expect(v.acceptanceUnit.attempt).toBe(2);

    // The fixture loop genuinely agrees on both legs.
    expect(v.levels["fixtureProtocolReady"]?.verdict).toBe("BOTH_PASS");
    // THE HONEST BASELINE: no dualBuild producer exists yet, so this level is
    // NOT_PROVEN on BOTH legs. It is reported as a FINDING, never papered over.
    expect(v.levels["realBuildOfflineReady"]?.windows).toBe("NOT_PROVEN");
    expect(v.levels["realBuildOfflineReady"]?.ubuntu).toBe("NOT_PROVEN");
    expect(v.levels["realBuildOfflineReady"]?.verdict).toBe("NOT_PROVEN");
    expect(v.levels["budgetEvidenceReady"]?.verdict).toBe("NOT_PROVEN");
    expect(v.levels["paidExperimentRun"]?.verdict).toBe("NOT_PROVEN");
    expect(v.levels["championPromotion"]?.verdict).toBe("NOT_PROVEN");
    // A single-platform green is NOT acceptance: the overall verdict is NOT_PROVEN.
    expect(v.overall).toBe("NOT_PROVEN");
    expect(v.overall).not.toBe("PASS");
    expect(v.findings.map((f) => f.level)).toContain("realBuildOfflineReady");
    // Report mode is not a gate.
    expect(v.strict).toBe(false);
    expect(v.strictGatePassed).toBe(false);
    // The table is human-readable too.
    expect(r.stdout).toContain("realBuildOfflineReady");
    expect(r.stdout).toContain("overall: NOT_PROVEN");
  });

  it("DP-A: legs from DIFFERENT runs refuse with SAME_RUN_MISMATCH and write no verdict", () => {
    const s = scratch();
    const pair = consistentPair(s.dir);
    const other = writeArtifact(s.dir, "ci-readiness-ubuntu-other-run.json", readinessArtifact("ubuntu", { ciRunId: "36540000001" }));
    const r = s.run(["--windows", pair.windows, "--ubuntu", other]);
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain("SAME_RUN_MISMATCH");
    expect(r.verdict).toBeNull();
  });

  it("DP-B: legs from DIFFERENT commits refuse with SAME_SHA_MISMATCH", () => {
    const s = scratch();
    const pair = consistentPair(s.dir);
    const otherSha = "9".repeat(40);
    const other = writeArtifact(s.dir, "ci-readiness-ubuntu-other-sha.json", readinessArtifact("ubuntu", { expectedSha: otherSha, ciRunSha: otherSha }));
    const r = s.run(["--windows", pair.windows, "--ubuntu", other]);
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain("SAME_SHA_MISMATCH");
    expect(r.verdict).toBeNull();
  });

  it("DP-C: a re-run leg must not be mixed with an original leg — ATTEMPT_MISMATCH", () => {
    const s = scratch();
    const pair = consistentPair(s.dir);
    const rerun = writeArtifact(s.dir, "ci-readiness-ubuntu-attempt3.json", readinessArtifact("ubuntu", { inputs: { attempt: 3 } }));
    const r = s.run(["--windows", pair.windows, "--ubuntu", rerun]);
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain("ATTEMPT_MISMATCH");
    expect(r.verdict).toBeNull();
  });

  it("DP-D: a MISLABELLED leg refuses with PLATFORM_MISMATCH", () => {
    const s = scratch();
    const pair = consistentPair(s.dir);
    // A WINDOWS artifact passed under --ubuntu.
    const mislabelled = writeArtifact(s.dir, "ci-readiness-mislabelled.json", readinessArtifact("windows"));
    const r = s.run(["--windows", pair.windows, "--ubuntu", mislabelled]);
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain("PLATFORM_MISMATCH");
    expect(r.verdict).toBeNull();
  });

  it("DP-E: a missing leg refuses with PLATFORM_MISSING", () => {
    const s = scratch();
    const pair = consistentPair(s.dir);
    const r = s.run(["--windows", pair.windows]);
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain("PLATFORM_MISSING");
    expect(r.verdict).toBeNull();
  });

  it("DP-F: MALFORMED_ARTIFACT — a missing field or a WRONG TYPE is refused, never coerced", () => {
    const s = scratch();
    const pair = consistentPair(s.dir);

    // (a) a stringified attempt number must NOT be coerced into a passing int.
    const stringAttempt = writeArtifact(s.dir, "ci-readiness-ubuntu-string-attempt.json", readinessArtifact("ubuntu", { inputs: { attempt: "2" } }));
    const a = s.run(["--windows", pair.windows, "--ubuntu", stringAttempt]);
    expect(a.exitCode).toBe(2);
    expect(a.stderr).toContain("MALFORMED_ARTIFACT");
    expect(a.stderr).toContain("inputs.attempt");
    expect(a.verdict).toBeNull();

    // (b) a missing required level.
    const missingLevel = writeArtifact(s.dir, "ci-readiness-ubuntu-missing-level.json", readinessArtifact("ubuntu", { levels: { budgetEvidenceReady: undefined } }));
    const b = s.run(["--windows", pair.windows, "--ubuntu", missingLevel]);
    expect(b.exitCode).toBe(2);
    expect(b.stderr).toContain("MALFORMED_ARTIFACT");
    expect(b.verdict).toBeNull();

    // (c) a missing run id.
    const noRunId = writeArtifact(s.dir, "ci-readiness-ubuntu-no-runid.json", readinessArtifact("ubuntu", { ciRunId: null }));
    const c = s.run(["--windows", pair.windows, "--ubuntu", noRunId]);
    expect(c.exitCode).toBe(2);
    expect(c.stderr).toContain("MALFORMED_ARTIFACT");
    expect(c.verdict).toBeNull();

    // (d) not JSON at all.
    const garbage = s.write("ci-readiness-ubuntu-garbage.json", "{not json");
    const d = s.run(["--windows", pair.windows, "--ubuntu", garbage]);
    expect(d.exitCode).toBe(2);
    expect(d.stderr).toContain("MALFORMED_ARTIFACT");
    expect(d.verdict).toBeNull();
  });

  it("DP-G: a leg claiming a raw-dependent PASS with NO bundle refuses with NO_RAW_EVIDENCE", () => {
    const s = scratch();
    const pair = consistentPair(s.dir);
    // A FORGED claim: realBuildOfflineReady = PASS with no evidenceRoot. This is
    // exactly the S6/F3 forgery shape, one level up.
    const forged = writeArtifact(
      s.dir,
      "ci-readiness-ubuntu-forged-pass.json",
      readinessArtifact("ubuntu", {
        levels: { realBuildOfflineReady: { status: "PASS", blocker: null, basis: "forged" } },
        inputs: { evidenceRoot: null },
      }),
    );
    const r = s.run(["--windows", pair.windows, "--ubuntu", forged]);
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain("NO_RAW_EVIDENCE");
    expect(r.verdict).toBeNull();
  });

  it("DP-H: a claimed PASS whose bundle does NOT re-verify refuses with RAW_EVIDENCE_MISMATCH", () => {
    const s = scratch();
    const pair = consistentPair(s.dir);
    // An evidenceRoot that exists but carries none of the required raw files.
    const emptyRoot = join(s.dir, "empty-bundle");
    mkdirSync(emptyRoot, { recursive: true });
    const forged = writeArtifact(
      s.dir,
      "ci-readiness-ubuntu-bad-bundle.json",
      readinessArtifact("ubuntu", {
        levels: { realBuildOfflineReady: { status: "PASS", blocker: null, basis: "forged" } },
        inputs: { evidenceRoot: emptyRoot },
      }),
    );
    const r = s.run(["--windows", pair.windows, "--ubuntu", forged]);
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain("RAW_EVIDENCE_MISMATCH");
    expect(r.verdict).toBeNull();
  });

  it("DP-I: SPLIT is an explicit non-PASS outcome and is never averaged or OR-ed", () => {
    const s = scratch();
    const pair = consistentPair(s.dir);
    // One leg reports the fixture protocol as FAIL, the other as PASS.
    const split = writeArtifact(s.dir, "ci-readiness-ubuntu-split.json", readinessArtifact("ubuntu", { levels: { fixtureProtocolReady: { status: "FAIL", basis: "the fixture loop failed" } } }));
    const r = s.run(["--windows", pair.windows, "--ubuntu", split]);
    expect(r.exitCode).toBe(0); // report mode still reports
    const v = r.verdict!;
    expect(v.levels["fixtureProtocolReady"]?.windows).toBe("PASS");
    expect(v.levels["fixtureProtocolReady"]?.ubuntu).toBe("FAIL");
    expect(v.levels["fixtureProtocolReady"]?.verdict).toBe("SPLIT");
    expect(v.overall).toBe("SPLIT");
    expect(v.overall).not.toBe("PASS");
  });

  it("DP-J: BOTH_FAIL is reported as FAIL (a decided failure, not an unproven one)", () => {
    const s = scratch();
    const pair = consistentPair(s.dir);
    const w = writeArtifact(s.dir, "ci-readiness-windows-bothfail.json", readinessArtifact("windows", { levels: { fixtureProtocolReady: { status: "FAIL" } } }));
    const u = writeArtifact(s.dir, "ci-readiness-ubuntu-bothfail.json", readinessArtifact("ubuntu", { levels: { fixtureProtocolReady: { status: "FAIL" } } }));
    const r = s.run(["--windows", w, "--ubuntu", u]);
    expect(r.exitCode).toBe(0);
    expect(r.verdict!.levels["fixtureProtocolReady"]?.verdict).toBe("BOTH_FAIL");
    expect(r.verdict!.overall).toBe("FAIL");
    expect(pair.windows.length).toBeGreaterThan(0);
  });

  it("DP-K: report mode exits 0 while --strict exits 1 on an unmet required level, and --require narrows it", () => {
    const s = scratch();
    const pair = consistentPair(s.dir);

    const report = s.run(["--windows", pair.windows, "--ubuntu", pair.ubuntu]);
    expect(report.exitCode).toBe(0);
    expect(report.verdict!.strict).toBe(false);

    // Default required levels include realBuildOfflineReady + budgetEvidenceReady,
    // which are NOT_PROVEN today, so a strict gate MUST fail.
    const strict = s.run(["--windows", pair.windows, "--ubuntu", pair.ubuntu, "--strict"]);
    expect(strict.exitCode).toBe(1);
    expect(strict.verdict!.strict).toBe(true);
    expect(strict.verdict!.requiredLevels).toEqual(["fixtureProtocolReady", "realBuildOfflineReady", "budgetEvidenceReady"]);
    expect(strict.verdict!.unmetRequiredLevels).toContain("realBuildOfflineReady");
    expect(strict.verdict!.strictGatePassed).toBe(false);

    // Narrowed to the level that really is BOTH_PASS: the gate passes.
    const narrow = s.run(["--windows", pair.windows, "--ubuntu", pair.ubuntu, "--strict", "--require=fixtureProtocolReady"]);
    expect(narrow.exitCode).toBe(0);
    expect(narrow.verdict!.strictGatePassed).toBe(true);
  });

  it("DP-L: a REPEATED --require is refused loudly (the arg() first-match trap)", () => {
    const s = scratch();
    const pair = consistentPair(s.dir);
    const r = s.run(["--windows", pair.windows, "--ubuntu", pair.ubuntu, "--require", "fixtureProtocolReady", "--require", "budgetEvidenceReady"]);
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain("FIRST-MATCH trap");
    expect(r.stderr).toContain("comma-separated");
    expect(r.verdict).toBeNull();

    // The comma-separated form is accepted.
    const ok = s.run(["--windows", pair.windows, "--ubuntu", pair.ubuntu, "--require=fixtureProtocolReady,budgetEvidenceReady"]);
    expect(ok.exitCode).toBe(0);
    expect(ok.verdict!.requiredLevels).toEqual(["fixtureProtocolReady", "budgetEvidenceReady"]);
  });

  it("DP-M: --in discovery finds both legs by CONTENT and refuses an ambiguous pair", () => {
    const s = scratch();
    consistentPair(s.dir);

    const ok = s.run(["--in", s.dir]);
    expect(ok.exitCode).toBe(0);
    expect(ok.verdict!.legs["windows"]?.recordedPlatform).toBe("windows");
    expect(ok.verdict!.legs["ubuntu"]?.recordedPlatform).toBe("ubuntu");

    // A SECOND windows artifact makes the acceptance unit ambiguous.
    writeArtifact(s.dir, "ci-readiness-windows-duplicate.json", readinessArtifact("windows"));
    const dup = s.run(["--in", s.dir]);
    expect(dup.exitCode).toBe(2);
    expect(dup.stderr).toContain("PLATFORM_DUPLICATE");
    expect(dup.verdict).toBeNull();
  });

  it("DP-N: each leg's RAW BUNDLE is re-verified through the existing verifyEvidenceBundle", () => {
    const s = scratch();
    const windowsRoot = writeValidBundle(s.dir, "windows");
    const ubuntuRoot = writeValidBundle(s.dir, "ubuntu");
    const windows = writeArtifact(s.dir, "ci-readiness-windows-bundle.json", readinessArtifact("windows", { inputs: { evidenceRoot: windowsRoot } }));
    const ubuntu = writeArtifact(s.dir, "ci-readiness-ubuntu-bundle.json", readinessArtifact("ubuntu", { inputs: { evidenceRoot: ubuntuRoot } }));

    const r = s.run(["--windows", windows, "--ubuntu", ubuntu]);
    expect(r.exitCode, r.stderr).toBe(0);
    const v = r.verdict!;
    // The import really ran and really verified the per-arm bytes.
    expect(v.legs["windows"]?.bundleReVerified?.ok).toBe(true);
    expect(v.legs["ubuntu"]?.bundleReVerified?.ok).toBe(true);
    expect(v.legs["windows"]?.bundleReVerified?.derivedVerifierCoverage).toEqual({ verified: 2, total: 2 });
    // ...and the deferred dimension stays visibly NOT_PROVEN rather than passing.
    expect(v.legs["windows"]?.bundleReVerified?.requestDispatchBinding).toBe("NOT_PROVEN");
  });

  it("DP-O: a leg that records a RELATIVE evidenceRoot (the real CI layout) still resolves and re-verifies", () => {
    const s = scratch();
    // Mirror the REAL CI shape: `ci-readiness.mjs` records the RAW `--evidence-root`
    // argument, which in the e4 job is a path relative to THAT job's workspace
    // (`.ci/r97-r98/readiness-evidence`). The joining job downloads the artifact
    // somewhere else, with the bundle BESIDE the leg's ci-readiness.json.
    const copyBundle = (from: string, to: string): void => {
      execFileSync(process.execPath, ["-e", "require('fs').cpSync(process.argv[1], process.argv[2], {recursive:true})", from, to], { cwd: REPO_ROOT });
    };

    const windowsLegDir = join(s.dir, "windows");
    mkdirSync(windowsLegDir, { recursive: true });
    copyBundle(writeValidBundle(s.dir, "windows"), join(windowsLegDir, "readiness-evidence"));

    const ubuntuLegDir = join(s.dir, "ubuntu");
    mkdirSync(ubuntuLegDir, { recursive: true });
    copyBundle(writeValidBundle(s.dir, "ubuntu"), join(ubuntuLegDir, "readiness-evidence"));

    const windows = writeArtifact(
      s.dir,
      "windows/ci-readiness.json",
      readinessArtifact("windows", { inputs: { evidenceRoot: ".ci/r97-r98/readiness-evidence" } }),
    );
    const ubuntu = writeArtifact(
      s.dir,
      "ubuntu/ci-readiness.json",
      readinessArtifact("ubuntu", { inputs: { evidenceRoot: ".ci/r97-r98/readiness-evidence" } }),
    );

    // The recorded relative path does NOT exist from this CWD — which is exactly
    // why resolving only against the CWD would refuse every real leg.
    expect(existsSync(".ci/r97-r98/readiness-evidence")).toBe(false);

    const r = s.run(["--windows", windows, "--ubuntu", ubuntu]);
    expect(r.exitCode, r.stderr).toBe(0);
    const v = r.verdict!;
    expect(v.legs["windows"]?.evidenceRootResolvedFrom).toBe("leg-dir/basename");
    expect(v.legs["windows"]?.bundleReVerified?.ok).toBe(true);
    expect(v.legs["ubuntu"]?.bundleReVerified?.ok).toBe(true);
  });

  it("DP-R: the REAL nested CI artifact layout resolves — the bundle one level ABOVE the leg JSON's directory", () => {
    // Reproduces run 36536713230 exactly. `actions/upload-artifact` was given
    // repo-root-relative paths, so `actions/download-artifact` PRESERVES them and
    // each leg arrives NESTED one level deeper than DP-O's flat shape:
    //   .ci/dual/<os>/r97-r98/ci-readiness.json          <- the leg JSON
    //   .ci/dual/<os>/prereg-production-e2e/pos-exec-runs/evidence/  <- the bundle
    // DP-O's `leg-dir/basename` candidate cannot find that (the bundle is NOT
    // beside the JSON), so this case is what proves `leg-root/recorded` works.
    const s = scratch();
    const copyBundle = (from: string, to: string): void => {
      execFileSync(process.execPath, ["-e", "require('fs').cpSync(process.argv[1], process.argv[2], {recursive:true})", from, to], { cwd: REPO_ROOT });
    };

    // The e2e producer's real recorded value — the path RELATIVE TO THE e4 JOB.
    const RECORDED = ".ci/prereg-production-e2e/pos-exec-runs/evidence";

    // `writeArtifact` writes into its own subdirectory (mirroring the download's
    // nesting), so the parent must exist first.
    mkdirSync(join(s.dir, "windows", "r97-r98"), { recursive: true });
    mkdirSync(join(s.dir, "ubuntu", "r97-r98"), { recursive: true });

    const windows = writeArtifact(
      s.dir,
      "windows/r97-r98/ci-readiness.json",
      readinessArtifact("windows", { inputs: { evidenceRoot: RECORDED } }),
    );
    const ubuntu = writeArtifact(
      s.dir,
      "ubuntu/r97-r98/ci-readiness.json",
      readinessArtifact("ubuntu", { inputs: { evidenceRoot: RECORDED } }),
    );

    // Mirror the download EXACTLY as MEASURED on run 36540340331 (from the CI
    // diagnostic step's `find`), NOT as assumed:
    //   .ci/dual/<os>/r97-r98/ci-readiness.json                        <- leg JSON
    //   .ci/dual/<os>/prereg-production-e2e/pos-exec-runs/evidence/…   <- bundle
    // The `.ci/` segment is STRIPPED by the uploader's `path:` entry, so the bundle
    // sits under the leg ROOT with the `.ci/` prefix removed — which is why the
    // `leg-root/without-dot-ci` candidate exists. My first version of this test
    // put the bundle at `<leg>/.ci/...` (with the segment kept) and so encoded an
    // assumption the real artifact does not satisfy; the measured layout is what
    // is asserted here.
    const withoutDotCi = RECORDED.replace(/^\.ci\//, "");
    for (const leg of ["windows", "ubuntu"] as const) {
      const dest = join(s.dir, leg, withoutDotCi);
      mkdirSync(dest, { recursive: true });
      // `dest` IS the evidence root, so the bundle's CONTENTS belong directly inside
      // it. Copying the bundle DIR into `dest` nests it one level too deep
      // (`<dest>/bundle-<leg>/…`), after which the verifier reads an EMPTY evidence
      // root and refuses MISSING_RAW_EVIDENCE. That is precisely what happened on
      // first fixing this test: the old `ok: true` assertion had been passing only
      // because the pre-fix join refused on `bundleReVerified.ok` instead of on the
      // missing files it had genuinely found.
      const src = writeValidBundle(s.dir, leg);
      for (const entry of readdirSync(src)) {
        cpSync(join(src, entry), join(dest, entry), { recursive: true });
      }
    }

    const r = s.run(["--windows", windows, "--ubuntu", ubuntu]);
    expect(r.exitCode, r.stderr).toBe(0);
    const v = r.verdict!;
    // Resolved via the LEG ROOT (the bundle is NOT beside the leg JSON), which is
    // the case DP-O's flat layout cannot cover.
    expect(v.legs["windows"]?.evidenceRootResolvedFrom).toBe("leg-root/without-dot-ci");
    expect(v.legs["ubuntu"]?.evidenceRootResolvedFrom).toBe("leg-root/without-dot-ci");
    // And the bundle really WAS re-verified from that location, cleanly. This is
    // the assertion that makes DP-R meaningful: it proves the `leg-root/without-dot-ci`
    // candidate found the COMPLETE bundle, not merely some directory that exists.
    // The earlier version asserted `bundleReVerified.ok === true` and passed only by
    // accident — with the bundle nested one level too deep the verifier read an
    // EMPTY root, but the pre-fix join refused on `ok` rather than on the missing
    // files, so the test was green for the wrong reason. `writeValidBundle` does
    // carry a real arm pair (two distinct 40-hex `sourceSha`s), so a correct
    // resolution of a correctly-copied bundle must verify with NO problems at all.
    const w = v.legs["windows"]!;
    expect(w.bundleReVerified?.problems).toEqual([]);
    expect(w.bundleReVerified?.ok).toBe(true);
    expect(v.legs["ubuntu"]?.bundleReVerified?.ok).toBe(true);
  });

  it("DP-P: an UNLOCATABLE evidenceRoot refuses, naming every candidate tried", () => {
    const s = scratch();
    const pair = consistentPair(s.dir);
    const nowhere = writeArtifact(
      s.dir,
      "ci-readiness-ubuntu-nowhere.json",
      readinessArtifact("ubuntu", { inputs: { evidenceRoot: "no/such/bundle/anywhere" } }),
    );
    const r = s.run(["--windows", pair.windows, "--ubuntu", nowhere]);
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain("NO_RAW_EVIDENCE");
    // "the bundle is somewhere else" must not read like "there is no bundle".
    expect(r.stderr).toContain("tried ");
    expect(r.stderr).toContain("leg-dir/basename=");
    expect(r.verdict).toBeNull();
  });

  it("DP-Q: an explicit --windows-evidence-root override is honoured and recorded", () => {
    const s = scratch();
    const windowsBundle = writeValidBundle(s.dir, "windows");
    const ubuntuBundle = writeValidBundle(s.dir, "ubuntu");
    const windows = writeArtifact(s.dir, "ci-readiness-windows.json", readinessArtifact("windows", { inputs: { evidenceRoot: "stale/producing-job/path" } }));
    const ubuntu = writeArtifact(s.dir, "ci-readiness-ubuntu.json", readinessArtifact("ubuntu", { inputs: { evidenceRoot: ubuntuBundle } }));

    const r = s.run(["--windows", windows, "--ubuntu", ubuntu, "--windows-evidence-root", windowsBundle]);
    expect(r.exitCode, r.stderr).toBe(0);
    const v = r.verdict!;
    // The override wins, and the leg's own (wrong) claim is still visible.
    expect(v.legs["windows"]?.evidenceRootResolvedFrom).toBe("override(absolute)");
    expect(v.legs["windows"]?.evidenceRootRecorded).toBe("stale/producing-job/path");
    expect(v.legs["windows"]?.bundleReVerified?.ok).toBe(true);
  });

  // -------------------------------------------------------------------------
  // DP-W..DP-Z2 — F30-7: the evidence-root RESOLUTION RULE, made explicit.
  //
  // DP-R proves the real nested layout resolves, but only while this checkout
  // happens to contain (or not contain) a stale `<cwd>/.ci/...` bundle. Before
  // the fix the resolver ranked the joining process's CWD FIRST, so such a stale
  // bundle silently WON and the join re-verified the wrong bytes. DP-W makes
  // that condition HERMETIC: the join is run with its cwd set to a directory
  // holding a decoy at exactly the recorded relative path. The remaining tests
  // pin the rest of the rule — ownership (DP-X), the override (DP-Y), and the
  // no-silent-first-exists ambiguity refusal (DP-Z / DP-Z2).
  // -------------------------------------------------------------------------

  it("DP-W: a STALE bundle at the join's cwd NEVER wins — the artifact-relative root does", () => {
    const s = scratch();
    const w = nestedLeg(s.dir, "windows");
    const u = nestedLeg(s.dir, "ubuntu");

    // The F30-7 decoy, reproduced hermetically: a leftover bundle sitting at
    // exactly the RECORDED relative path, resolved against the directory the
    // join actually RUNS IN.
    const staleCwd = join(s.dir, "stale-cwd");
    const decoy = join(staleCwd, CI_RECORDED_EVIDENCE_ROOT);
    mkdirSync(decoy, { recursive: true });
    expect(existsSync(decoy)).toBe(true);

    // CONTROL — the decoy is genuinely LETHAL: naming it explicitly makes the
    // join refuse. That is what makes the next assertion behavioural rather than
    // a recorded string that a cwd-first resolver would also have printed.
    const control = s.run(["--windows", w.artifact, "--ubuntu", u.artifact, "--windows-evidence-root", decoy]);
    expect(control.exitCode).toBe(2);
    expect(control.stderr).toContain("RAW_EVIDENCE_MISMATCH");
    expect(control.verdict).toBeNull();

    // THE FIX: the stale directory is present in the join's cwd and does NOT win.
    const r = s.run(["--windows", w.artifact, "--ubuntu", u.artifact], { cwd: staleCwd });
    expect(r.exitCode, r.stderr).toBe(0);
    const leg = r.verdict!.legs["windows"]!;
    expect(leg.evidenceRootResolvedFrom).toBe("leg-root/without-dot-ci");
    expect(leg.evidenceRoot).toBe(w.bundle);
    expect(leg.evidenceRoot).not.toBe(decoy);
    // The cwd is not merely "tried and lost" — it is not a candidate at all, so
    // no future scan-order change can reach it. `length > 0` first, so the list
    // assertions below cannot pass vacuously against a missing field.
    const ranked = leg.evidenceRootCandidates ?? [];
    expect(ranked.length).toBeGreaterThan(0);
    // The RULE is pinned here, not just described in a comment: this is the
    // candidate set and its ORDER, with no cwd-derived entry in it.
    expect(ranked.map((c) => c.from)).toEqual([
      "leg-dir/basename",
      "leg-dir/recorded",
      "leg-root/recorded",
      "leg-root/without-dot-ci",
      "leg-root/basename",
    ]);
    expect(ranked.map((c) => c.path)).not.toContain(decoy);
    expect(ranked.some((c) => c.from.startsWith("cwd"))).toBe(false);
    expect(leg.evidenceRootRule).toContain("NEVER an automatic candidate");
    expect(leg.bundleReVerified?.ok).toBe(true);
  });

  it("DP-X: a recorded root that ESCAPES the leg artifact's tree is refused, not silently read", () => {
    const s = scratch();
    const ubuntu = consistentPair(s.dir).ubuntu;

    // A COMPLETE, VALID bundle — but OUTSIDE the leg artifact's tree.
    const escapedBundle = join(s.dir, "escape-bundle");
    copyBundleInto(writeValidBundle(s.dir, "windows"), escapedBundle);
    mkdirSync(join(s.dir, "legs", "windows", "r97-r98"), { recursive: true });
    const artifact = writeArtifact(
      s.dir,
      "legs/windows/r97-r98/ci-readiness.json",
      readinessArtifact("windows", { inputs: { evidenceRoot: `../../escape-bundle` } }),
    );

    // CONTROL — the escaped bundle is GOOD: naming it explicitly verifies
    // cleanly. So the refusal below is about OWNERSHIP, not brokenness.
    const control = s.run(["--windows", artifact, "--ubuntu", ubuntu, "--windows-evidence-root", escapedBundle]);
    expect(control.exitCode, control.stderr).toBe(0);
    expect(control.verdict!.legs["windows"]?.bundleReVerified?.ok).toBe(true);

    const r = s.run(["--windows", artifact, "--ubuntu", ubuntu]);
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain("EVIDENCE_ROOT_ESCAPE");
    expect(r.stderr).toContain(escapedBundle);
    expect(r.verdict).toBeNull();
  });

  it("DP-Y: an UNREADABLE override refuses instead of silently falling back to an auto root", () => {
    const s = scratch();
    const w = nestedLeg(s.dir, "windows");
    const u = nestedLeg(s.dir, "ubuntu");

    // CONTROL — the artifact-relative resolution is GREEN on its own, which is
    // exactly the fallback that must not be taken quietly.
    const ok = s.run(["--windows", w.artifact, "--ubuntu", u.artifact]);
    expect(ok.exitCode, ok.stderr).toBe(0);

    const bogus = join(s.dir, "no-such-override-root");
    const r = s.run(["--windows", w.artifact, "--ubuntu", u.artifact, "--windows-evidence-root", bogus]);
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain("EVIDENCE_ROOT_OVERRIDE_UNUSABLE");
    expect(r.stderr).toContain(bogus);
    expect(r.verdict).toBeNull();
  });

  it("DP-Z: two DISTINCT artifact-relative roots refuse as AMBIGUOUS — no silent first-exists", () => {
    const s = scratch();
    const ubuntu = writeArtifact(s.dir, "ci-readiness-ubuntu.json", readinessArtifact("ubuntu"));
    const RECORDED = ".ci/r97-r98/readiness-evidence";

    const legRoot = join(s.dir, "windows");
    mkdirSync(legRoot, { recursive: true });
    const artifact = writeArtifact(
      s.dir,
      "windows/ci-readiness.json",
      readinessArtifact("windows", { inputs: { evidenceRoot: RECORDED } }),
    );
    // Two legitimate roots at once: DP-O's flat shape (beside the leg JSON,
    // `leg-dir/basename`) AND DP-R's nested shape (`leg-root/without-dot-ci`).
    // Both are COMPLETE bundles, so the only reason to refuse is the ambiguity.
    const beside = join(legRoot, "readiness-evidence");
    const nested = join(s.dir, "r97-r98", "readiness-evidence");
    copyBundleInto(writeValidBundle(s.dir, "windows"), beside);
    copyBundleInto(writeValidBundle(s.dir, "windows"), nested);

    const r = s.run(["--windows", artifact, "--ubuntu", ubuntu]);
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain("EVIDENCE_ROOT_AMBIGUOUS");
    // BOTH candidates are named, so a human can choose deliberately (the override
    // is the way out) instead of the join choosing by scan order.
    expect(r.stderr).toContain(beside);
    expect(r.stderr).toContain(nested);
    expect(r.verdict).toBeNull();
  });

  it("DP-Z2: the SAME root reached by two candidate names is NOT ambiguity (one dimension from DP-Z)", () => {
    const s = scratch();
    const ubuntu = writeArtifact(s.dir, "ci-readiness-ubuntu.json", readinessArtifact("ubuntu"));

    // `recorded` has no directory component, so `leg-dir/basename` and
    // `leg-dir/recorded` name the SAME directory — and so do `leg-root/basename`
    // and `leg-root/recorded`. Counting NAMES instead of distinct roots would
    // refuse a leg that has exactly one root, which is why the resolver dedupes
    // before it decides.
    const legRoot = join(s.dir, "windows");
    mkdirSync(legRoot, { recursive: true });
    const artifact = writeArtifact(
      s.dir,
      "windows/ci-readiness.json",
      readinessArtifact("windows", { inputs: { evidenceRoot: "readiness-evidence" } }),
    );
    copyBundleInto(writeValidBundle(s.dir, "windows"), join(legRoot, "readiness-evidence"));

    const r = s.run(["--windows", artifact, "--ubuntu", ubuntu]);
    expect(r.exitCode, r.stderr).toBe(0);
    expect(r.verdict!.legs["windows"]?.evidenceRootResolvedFrom).toBe("leg-dir/basename");
    expect(r.verdict!.legs["windows"]?.bundleReVerified?.ok).toBe(true);
  });

  // -------------------------------------------------------------------------
  // DP-S..DP-V — the bundle re-verification is LEVEL-SCOPED, not blanket.
  //
  // MEASURED CI DEFECT (run 36656606680, job `dual-platform acceptance`): the
  // e4 job requires ONLY `fixtureProtocolReady` (ci.yml N7), yet the join refused
  // because the bundle honestly carries no REAL ARM PAIR. Those codes speak to
  // `realBuildOfflineReady` alone, so refusing a fixture-only run on them made the
  // join unsatisfiable in CI. The fix must be fail-closed: only a closed set of
  // ARM-PAIR codes may be attributed to that level, and everything else must
  // still refuse.
  // -------------------------------------------------------------------------

  it("DP-S: an honest NO-REAL-ARM-PAIR bundle does NOT fail a fixture-only run, and the problems are still RECORDED", () => {
    const s = scratch();
    const windowsBundle = writeValidBundleWithoutArmPair(s.dir, "windows");
    const ubuntuBundle = writeValidBundleWithoutArmPair(s.dir, "ubuntu");
    const windows = writeArtifact(s.dir, "ci-readiness-windows.json", readinessArtifact("windows", { inputs: { evidenceRoot: windowsBundle } }));
    const ubuntu = writeArtifact(s.dir, "ci-readiness-ubuntu.json", readinessArtifact("ubuntu", { inputs: { evidenceRoot: ubuntuBundle } }));

    const r = s.run(["--windows", windows, "--ubuntu", ubuntu, "--require", "fixtureProtocolReady", "--strict"]);
    expect(r.exitCode, r.stderr).toBe(0);

    const leg = r.verdict!.legs["windows"]!;
    // The bundle did NOT verify — that fact is never hidden.
    expect(leg.bundleReVerified?.ok).toBe(false);
    expect(leg.bundleReVerified?.problems).toContainEqual(expect.stringContaining("BASELINE_SOURCE_SHA_INVALID"));
    expect(leg.bundleReVerified?.problems).toContainEqual(expect.stringContaining("CANDIDATE_SOURCE_SHA_INVALID"));
    // ...but those problems are RECORDED as belonging to the real-build level...
    expect(leg.bundleReVerified?.realBuildOnly?.blockedLevel).toBe("realBuildOfflineReady");
    expect(leg.bundleReVerified?.realBuildOnly?.required).toBe(false);
    expect(leg.bundleReVerified?.realBuildOnly?.problems).toContainEqual(expect.stringContaining("BASELINE_SOURCE_SHA_INVALID"));
    // ...and NOTHING blocks the levels this run actually required.
    expect(leg.bundleReVerified?.blocksAllLevels).toEqual([]);
    // The run still refuses to claim success: the overall verdict is NOT_PROVEN.
    expect(r.verdict!.overall).toBe("NOT_PROVEN");
    expect(r.verdict!.overall).not.toBe("PASS");
  });

  it("DP-T: the SAME no-pair bundle DOES refuse once realBuildOfflineReady is required (the scoping is a gate, not a waiver)", () => {
    const s = scratch();
    const windowsBundle = writeValidBundleWithoutArmPair(s.dir, "windows");
    const ubuntuBundle = writeValidBundleWithoutArmPair(s.dir, "ubuntu");
    const windows = writeArtifact(s.dir, "ci-readiness-windows.json", readinessArtifact("windows", { inputs: { evidenceRoot: windowsBundle } }));
    const ubuntu = writeArtifact(s.dir, "ci-readiness-ubuntu.json", readinessArtifact("ubuntu", { inputs: { evidenceRoot: ubuntuBundle } }));

    const r = s.run(["--windows", windows, "--ubuntu", ubuntu, "--require", "fixtureProtocolReady,realBuildOfflineReady"]);
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain("RAW_EVIDENCE_MISMATCH");
    expect(r.stderr).toContain("BASELINE_SOURCE_SHA_INVALID");
    expect(r.verdict).toBeNull();
  });

  it("DP-U: NON-VACUITY — a bundle-IDENTITY defect (no platform) is NOT an arm-pair code and still refuses a fixture-only run", () => {
    const s = scratch();
    // This is the real CI defect verbatim: the missing `--platform` made every
    // bundle carry no platform. It is a defect OF THE BUNDLE'S RUN IDENTITY, so
    // scoping the arm-pair codes must not let it through.
    const windowsBundle = writeValidBundleWithoutPlatform(s.dir, "windows");
    const ubuntuBundle = writeValidBundleWithoutPlatform(s.dir, "ubuntu");
    const windows = writeArtifact(s.dir, "ci-readiness-windows.json", readinessArtifact("windows", { inputs: { evidenceRoot: windowsBundle } }));
    const ubuntu = writeArtifact(s.dir, "ci-readiness-ubuntu.json", readinessArtifact("ubuntu", { inputs: { evidenceRoot: ubuntuBundle } }));

    const r = s.run(["--windows", windows, "--ubuntu", ubuntu, "--require", "fixtureProtocolReady", "--strict"]);
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain("IDENTITY_PLATFORM_MISSING");
    expect(r.verdict).toBeNull();
  });

  it("DP-V: a bundle that fully verifies still yields an honest NOT_PROVEN overall, and reports the verifier's own levels", () => {
    const s = scratch();
    const windowsBundle = writeValidBundle(s.dir, "windows");
    const ubuntuBundle = writeValidBundle(s.dir, "ubuntu");
    const windows = writeArtifact(s.dir, "ci-readiness-windows.json", readinessArtifact("windows", { inputs: { evidenceRoot: windowsBundle } }));
    const ubuntu = writeArtifact(s.dir, "ci-readiness-ubuntu.json", readinessArtifact("ubuntu", { inputs: { evidenceRoot: ubuntuBundle } }));

    const r = s.run(["--windows", windows, "--ubuntu", ubuntu, "--require", "fixtureProtocolReady", "--strict"]);
    expect(r.exitCode, r.stderr).toBe(0);
    const leg = r.verdict!.legs["windows"]!;
    expect(leg.bundleReVerified?.ok).toBe(true);
    expect(leg.bundleReVerified?.realBuildOnly?.problems).toEqual([]);
    // The verifier's OWN per-level verdicts are carried through, so a reviewer can
    // see WHICH level failed without re-deriving it from the problem text.
    expect(leg.bundleReVerified?.verifierLevels?.realBuildOfflineReady?.status).toBe("PASS");
    expect(leg.bundleReVerified?.verifierLevels?.budgetEvidenceReady?.status).toBe("NOT_PROVEN");
    expect(leg.bundleReVerified?.levelAuthority).toBe("verifyEvidenceBundle.levels + REAL_ARM_PAIR_ONLY_CODES");
    // A fully-valid bundle does NOT make the join claim acceptance.
    expect(r.verdict!.overall).toBe("NOT_PROVEN");
  });
});
