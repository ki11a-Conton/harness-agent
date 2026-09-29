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
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
  legs: Record<string, { path: string; platform: string; recordedPlatform: string; attempt: number | null; evidenceRoot: string | null; bundleReVerified: { ok: boolean; problems: string[]; derivedVerifierCoverage: { verified: number; total: number } | null; journalBinding: string | null; requestDispatchBinding: string | null } | null }>;
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
  run: (args: string[]) => RunResult;
} {
  const dir = mkdtempSync(join(tmpdir(), "dp-accept-"));
  CREATED.push(dir);
  const write = (name: string, value: unknown): string => {
    const p = join(dir, name);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, typeof value === "string" ? value : JSON.stringify(value), "utf8");
    return p;
  };
  const run = (args: string[]): RunResult => {
    const verdictPath = join(dir, `verdict-${Math.random().toString(36).slice(2)}.json`);
    const result = spawnSync(process.execPath, [SCRIPT, ...args, "--out", verdictPath], {
      cwd: REPO_ROOT,
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
});
