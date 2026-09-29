/**
 * R0/R7 — F6 acceptance and mutation suite for `scripts/e4/ci-readiness.mjs`.
 *
 * HISTORY: R0 wrote this file as the DELIBERATELY-RED reproducer for F6
 * (plan(20260928-105425).md §R0 line 62): the forward basis was inferred from
 * PROSE —
 *
 *     readinessText.includes("SYNTHETIC") ? "SYNTHETIC_FIXTURE_BUILD"
 *                                         : "REAL_DUAL_PINNED_BUILD"
 *
 * — so lowercase `synthetic`, an empty string and unrelated prose all rendered
 * `realBuildOfflineReady = PASS`, and `platforms.ubuntu.status` was a hardcoded
 * `NOT_PROVEN` literal. R0's RED run measured `4 failed | 2 passed (6)`.
 *
 * R7 (task-10) replaced that classifier with a structured enum plus verified
 * evidence and made this file GREEN. It now ALSO carries the §R7.3 mutation
 * table: every one of these must fail to upgrade —
 *   empty string, case changes, unrelated text, a forged REAL enum with no
 *   artifact, a wrong SHA, a replayed/stale artifact with no run identity, a null
 *   exit code, a verifier that did not run over every case, and a journal that
 *   does not agree with itself.
 * The final test drives the COMPLETE REAL evidence and requires PASS, so the REAL
 * path is proven reachable rather than dead code.
 *
 * HOW THIS TESTS BEHAVIOUR (never by string-matching the source): the real script
 * is executed with mutated `--e2e` inputs and its real JSON output artifact is
 * asserted. Two things make that fast and deterministic:
 *   - the three nested gate subprocesses (`pnpm test:n0-gaps`,
 *     `pnpm test:red-next-gaps`, docs smoke) are neutralised by a `pnpm` shim
 *     first on PATH; this suite targets the CLASSIFICATION, not the gates (the
 *     gates are run for real by `pnpm test:n0-gaps` / `pnpm test:red-next-gaps`
 *     and by the unshimmed readiness run recorded in the evidence docs).
 *   - the Ubuntu case overrides `process.platform` to `linux` through a
 *     `--import` preload, so the Linux branch really executes. This is a
 *     SIMULATION, not a real Ubuntu runner: Ubuntu-Actions itself was NOT run.
 *
 * OFFLINE: local files + local child processes only. No provider, no key, no
 * network, no paid request.
 */

import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

const REPO_ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const SCRIPT = join(REPO_ROOT, "scripts", "e4", "ci-readiness.mjs");
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

interface ReadinessArtifact {
  schemaVersion: string;
  ciRunSha: string;
  expectedSha: string;
  ciRunId: string | null;
  os: { label: string; platform: string; arch: string; node: string };
  platforms: {
    thisProcess: { platform: string; status: string };
    windows: { status: string; detail: string };
    ubuntu: { status: string; detail: string };
    crossPlatform: { status: string; sameSha: boolean | null; selfMeasured: boolean; detail: string };
  };
  commandExits: Record<string, number | null>;
  counts: Record<string, number | null>;
  executionKind: string | null;
  forwardBasis: string | null;
  forwardBasisSource: string;
  levels: Record<
    string,
    { status: string; basis: string; blocker?: string | null; evidence?: { realDeclaration: boolean; failures: string[] } }
  >;
}

interface RunOptions {
  linuxSimulation?: boolean;
  osLabel?: string;
  extraArgs?: string[];
}

interface RunResult {
  exitCode: number | null;
  artifact: ReadinessArtifact;
  stderr: string;
}

/** Executes the real readiness script over `e2e` and returns its written artifact. */
function runScript(e2e: Record<string, unknown> | null, opts: RunOptions = {}): RunResult {
  const dir = mkdtempSync(join(tmpdir(), "r0-f6-"));
  CREATED.push(dir);

  const e2ePath = join(dir, "e2e.json");
  writeFileSync(e2ePath, JSON.stringify(e2e === null ? {} : e2e), "utf8");
  const outPath = join(dir, "readiness.json");

  // Neutralise the three nested gate subprocesses: this suite's subject is the
  // classification, never the gates.
  const shimDir = join(dir, "bin");
  mkdirSync(shimDir);
  writeFileSync(join(shimDir, "pnpm.cmd"), "@echo off\r\nexit /b 0\r\n", "utf8");
  writeFileSync(join(shimDir, "pnpm"), "#!/bin/sh\nexit 0\n", "utf8");

  const args = [SCRIPT, "--e2e", e2ePath, "--out", outPath, "--os-label", opts.osLabel ?? "windows-local", ...(opts.extraArgs ?? [])];
  let nodeArgs = args;
  if (opts.linuxSimulation === true) {
    // A minimal preload that makes the Linux/Ubuntu branch actually execute.
    const preload = join(dir, "platform-linux.mjs");
    writeFileSync(preload, 'Object.defineProperty(process, "platform", { value: "linux", configurable: true });\n', "utf8");
    nodeArgs = ["--import", pathToFileURL(preload).href, ...args];
  }

  const result = spawnSync(process.execPath, nodeArgs, {
    cwd: REPO_ROOT,
    encoding: "utf8",
    env: { ...process.env, PATH: `${shimDir};${process.env["PATH"] ?? ""}` },
  });
  const artifact = JSON.parse(readFileSync(outPath, "utf8")) as ReadinessArtifact;
  return { exitCode: result.status, artifact, stderr: result.stderr ?? "" };
}

/**
 * Runs a REAL-declaration artifact with the run identity the evidence requires.
 * `runId: null` exercises the "no run identity" mutation explicitly.
 */
function runReal(e2e: Record<string, unknown>, opts: RunOptions & { runId?: string | null } = {}): RunResult {
  const runId = opts.runId === undefined ? "36540000000" : opts.runId;
  const extraArgs = runId === null ? ["--run-id=", ...(opts.extraArgs ?? [])] : ["--run-id", runId, ...(opts.extraArgs ?? [])];
  return runScript(e2e, { ...opts, extraArgs });
}

/** The shared, shape-complete baseline E2E body used by every mutation below. */
function baseE2e(): Record<string, unknown> {
  return {
    ok: true,
    positiveExecution: {
      providerFactoryCalls: 0,
      physicalProviderCalls: 124,
      ledgerCommitted: 124,
      journalChargedTokens: 248,
      evidenceVerified: 124,
      evidenceUnverified: 0,
      decision: "INCONCLUSIVE",
    },
    positiveForward: {
      physicalStubRequests: 124,
      ledgerCommitted: 124,
      journalChargedTokens: 248,
      aggregateTokensTotal: 248,
      aggregateTokensDelta: -60,
      aggregateTokensBaseline: 100,
      aggregateTokensCandidate: 40,
      independentTokens: { delta: -60 },
      costMatchesJournal: true,
    },
  };
}

/** The legacy shape R0 tested: only the human-readable prose field is present. */
function proseE2e(prose: string): Record<string, unknown> {
  return { ...baseE2e(), readiness: { productionOfflineReady: prose } };
}

/** A structured execution kind, with no evidence at all. */
function kindE2e(kind: string): Record<string, unknown> {
  return { ...baseE2e(), readiness: { productionOfflineReadiness: { executionKind: kind } } };
}

/** A COMPLETE, verifiable REAL dual-pinned-build declaration (the positive case). */
function realE2e(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ...baseE2e(),
    ciRunSha: HEAD,
    runId: "36540000000",
    os: "windows-latest",
    commandExits: { typecheck: 0, test: 0, build: 0 },
    dualBuild: {
      baselineArm: { sourceSha: "1".repeat(40), buildDigest: "a".repeat(64) },
      candidateArm: { sourceSha: "2".repeat(40), buildDigest: "b".repeat(64) },
      verifier: { ran: true, casesVerified: 16, casesTotal: 16 },
    },
    readiness: {
      productionOfflineReadiness: {
        executionKind: "REAL_DUAL_PINNED_BUILD",
        realDualFrozenBuildAndRealVerifier: "PROVEN: two real pinned checkouts built from distinct source SHAs",
      },
    },
    ...overrides,
  };
}

describe("R7/F6 — readiness comes from a structured kind + verified evidence, never from prose", () => {
  it("R0-F6-0: the script really runs and the fixture counts really reach the artifact", () => {
    const { exitCode, artifact } = runScript(proseE2e("SYNTHETIC fixture arm builds (writeArmCheckout equals this)"));
    expect(artifact.os.label).toBe("windows-local");
    expect(artifact.counts["forwardJournalChargedTokens"]).toBe(248);
    // The script exits 0 when it wrote an artifact, whatever the levels say.
    expect(exitCode).toBe(0);
    // R7: the contract is still five SEPARATED levels — no collapsed `ok`.
    expect(Object.keys(artifact.levels)).toEqual([
      "fixtureProtocolReady",
      "realBuildOfflineReady",
      "budgetEvidenceReady",
      "paidExperimentRun",
      "championPromotion",
    ]);
    expect(artifact.levels["budgetEvidenceReady"]?.status).toBe("NOT_PROVEN");
    expect(artifact.levels["paidExperimentRun"]?.status).toBe("NOT_RUN");
    expect(artifact.levels["championPromotion"]?.status).toBe("NOT_RUN");
  });

  it("R0-F6-A: LOWERCASE 'synthetic' prose must not be classified as a REAL dual pinned build", () => {
    const { artifact } = runScript(proseE2e("synthetic fixture arm builds (writeArmCheckout equals this)"));
    expect(artifact.forwardBasis).not.toBe("REAL_DUAL_PINNED_BUILD");
    expect(artifact.forwardBasis).toBe("NOT_OBSERVED");
    expect(artifact.levels["realBuildOfflineReady"]?.status).not.toBe("PASS");
  });

  it("R0-F6-B: an EMPTY readiness string must not be classified as a REAL dual pinned build", () => {
    const { artifact } = runScript(proseE2e(""));
    expect(artifact.forwardBasis).not.toBe("REAL_DUAL_PINNED_BUILD");
    expect(artifact.levels["realBuildOfflineReady"]?.status).not.toBe("PASS");
  });

  it("R0-F6-C: UNRELATED text must not be classified as a REAL dual pinned build", () => {
    const { artifact } = runScript(proseE2e("forward closed loop completed; evidence verified by the local harness"));
    expect(artifact.forwardBasis).not.toBe("REAL_DUAL_PINNED_BUILD");
    expect(artifact.levels["realBuildOfflineReady"]?.status).not.toBe("PASS");
  });

  it("R0-F6-D2: the prose field is NOT read even when it is spelled exactly like the enum", () => {
    // Anti-overfit: deleting the classifier means deleting it, not renaming it.
    const { artifact } = runScript(proseE2e("REAL_DUAL_PINNED_BUILD"));
    expect(artifact.forwardBasis).toBe("NOT_OBSERVED");
    expect(artifact.levels["realBuildOfflineReady"]?.status).not.toBe("PASS");
  });

  it("R0-F6-D: an ABSENT readiness field is fail-closed (NOT_PROVEN, never PASS)", () => {
    const { artifact } = runScript(baseE2e());
    expect(artifact.forwardBasis).toBe("NOT_OBSERVED");
    expect(artifact.levels["realBuildOfflineReady"]?.status).toBe("NOT_PROVEN");
  });

  it("R7-F6-F: a known non-REAL kind is BLOCKED with its own blocker — not PASS, not NOT_PROVEN", () => {
    const synthetic = runScript(kindE2e("SYNTHETIC_FIXTURE_BUILD"));
    expect(synthetic.artifact.forwardBasis).toBe("SYNTHETIC_FIXTURE_BUILD");
    expect(synthetic.artifact.levels["realBuildOfflineReady"]?.status).toBe("BLOCKED");
    expect(synthetic.artifact.levels["realBuildOfflineReady"]?.blocker).toContain("NO_REAL_ARM_PAIR");

    // The producer's current enum-prefixed field must parse identically.
    const prefixed = runScript({ ...baseE2e(), readiness: { productionOfflineReadiness: { releaseCliSubprocessForwardBasis: "CLOSED_BY_R1: the SHIPPED release CLI refuses a marker-only SYNTHETIC fixture checkout" } } });
    expect(prefixed.artifact.forwardBasis).toBe("CLOSED_BY_R1");
    expect(prefixed.artifact.levels["realBuildOfflineReady"]?.status).toBe("BLOCKED");
  });

  it("R0-F6-E: on a Linux/Ubuntu run this process's OWN platform is MEASURED, not hardcoded NOT_PROVEN", () => {
    const { artifact } = runScript(kindE2e("SYNTHETIC_FIXTURE_BUILD"), { linuxSimulation: true, osLabel: "ubuntu-latest" });
    // Sanity: the preload really moved the process onto the Linux branch.
    expect(artifact.os.platform).toBe("linux");
    expect(artifact.platforms.thisProcess.platform).toBe("ubuntu");
    expect(artifact.platforms.windows.status).toBe("NOT_OBSERVED");
    // TARGET: this platform was measured by this process.
    expect(artifact.platforms.ubuntu.status).toBe("MEASURED");
  });

  it("R7-F6-H: the other platform's artifact is accepted ONLY when its SHA matches AND it measured itself", () => {
    const dir = mkdtempSync(join(tmpdir(), "r0-f6-other-"));
    CREATED.push(dir);
    const sameShaPath = join(dir, "other-same-sha.json");
    const otherShaPath = join(dir, "other-other-sha.json");
    // The pre-R7 shape: same SHA, but its own platform slot is the hardcoded NOT_PROVEN.
    const v1HardcodePath = join(dir, "other-v1-hardcode.json");
    writeFileSync(
      sameShaPath,
      JSON.stringify({ schemaVersion: "prereg-ci-readiness-v2", ciRunSha: HEAD, platforms: { thisProcess: { status: "MEASURED" } } }),
      "utf8",
    );
    writeFileSync(otherShaPath, JSON.stringify({ schemaVersion: "prereg-ci-readiness-v2", ciRunSha: "f".repeat(40) }), "utf8");
    writeFileSync(
      v1HardcodePath,
      JSON.stringify({
        schemaVersion: "prereg-ci-readiness-v1",
        ciRunSha: HEAD,
        os: { platform: "linux" },
        platforms: { ubuntu: { status: "NOT_PROVEN" }, windows: { status: "NOT_OBSERVED" } },
      }),
      "utf8",
    );

    // The peer slot is whichever platform is NOT this process. Naming `ubuntu`
    // unconditionally encoded a Windows-only assumption: on a real ubuntu runner
    // `ubuntu` IS this process, so `platformSlot("ubuntu")` returns the early
    // `MEASURED` and never reaches the other-platform branch — which made this
    // suite red on CI while green on Windows. The product was right in both
    // cases; the assertion was not platform-agnostic. Assert the PEER role, not
    // a hardcoded platform name, and additionally pin that the two slots are
    // role-symmetric.
    const peerSlot = (r: RunResult): "windows" | "ubuntu" => (r.artifact.platforms.thisProcess.platform === "ubuntu" ? "windows" : "ubuntu");

    const matching = runScript(baseE2e(), { extraArgs: ["--other-platform-artifact", sameShaPath] });
    expect(matching.artifact.platforms[peerSlot(matching)].status).toBe("MEASURED_SAME_SHA");
    expect(matching.artifact.platforms.crossPlatform.status).toBe("MEASURED_SAME_SHA");
    expect(matching.artifact.platforms.crossPlatform.sameSha).toBe(true);
    expect(matching.artifact.platforms.crossPlatform.selfMeasured).toBe(true);
    // The slot this process actually ran on is always MEASURED, on either OS.
    expect(matching.artifact.platforms[matching.artifact.platforms.thisProcess.platform as "windows" | "ubuntu"].status).toBe("MEASURED");

    const mismatched = runScript(baseE2e(), { extraArgs: ["--other-platform-artifact", otherShaPath] });
    expect(mismatched.artifact.platforms[peerSlot(mismatched)].status).toBe("NOT_PROVEN");
    expect(mismatched.artifact.platforms.crossPlatform.status).toBe("NOT_PROVEN");
    expect(mismatched.artifact.platforms.crossPlatform.detail).toContain("SHA_MISMATCH");

    // Same SHA, but the other artifact cannot show that IT measured the platform:
    // this is exactly the historical real ubuntu-latest artifact, which hardcoded
    // `platforms.ubuntu.status = "NOT_PROVEN"`.
    const notSelfMeasured = runScript(baseE2e(), { extraArgs: ["--other-platform-artifact", v1HardcodePath] });
    expect(notSelfMeasured.artifact.platforms[peerSlot(notSelfMeasured)].status).toBe("NOT_PROVEN");
    expect(notSelfMeasured.artifact.platforms.crossPlatform.detail).toContain("OTHER_PLATFORM_NOT_SELF_MEASURED");

    // Absent evidence is NOT_OBSERVED — not "unproven", and not "measured".
    const absent = runScript(baseE2e());
    expect(absent.artifact.platforms[peerSlot(absent)].status).toBe("NOT_OBSERVED");
    expect(absent.artifact.platforms.crossPlatform.status).toBe("NOT_OBSERVED");
  });

  it("R7-F6-H2: the cross-platform branch is role-symmetric — a Linux process is exercised, not assumed", () => {
    // Run the SAME scenario with process.platform forced to linux, so the peer
    // slot is `windows` and the Linux branch is really taken. Without this the
    // suite only ever proved the Windows direction and CI was the first place
    // the mirrored direction ran.
    const dir = mkdtempSync(join(tmpdir(), "r0-f6-sym-"));
    CREATED.push(dir);
    const sameShaPath = join(dir, "other-same-sha.json");
    writeFileSync(
      sameShaPath,
      JSON.stringify({ schemaVersion: "prereg-ci-readiness-v2", ciRunSha: HEAD, platforms: { thisProcess: { status: "MEASURED" } } }),
      "utf8",
    );

    const linux = runScript(baseE2e(), { linuxSimulation: true, osLabel: "ubuntu-latest", extraArgs: ["--other-platform-artifact", sameShaPath] });
    expect(linux.artifact.os.platform).toBe("linux");
    expect(linux.artifact.platforms.thisProcess.platform).toBe("ubuntu");
    // This process measured its own platform...
    expect(linux.artifact.platforms.ubuntu.status).toBe("MEASURED");
    // ...and the PEER (windows) is the one accepted at the same SHA.
    expect(linux.artifact.platforms.windows.status).toBe("MEASURED_SAME_SHA");
    expect(linux.artifact.platforms.crossPlatform.status).toBe("MEASURED_SAME_SHA");

    const linuxAbsent = runScript(baseE2e(), { linuxSimulation: true, osLabel: "ubuntu-latest" });
    expect(linuxAbsent.artifact.platforms.windows.status).toBe("NOT_OBSERVED");
    expect(linuxAbsent.artifact.platforms.crossPlatform.status).toBe("NOT_OBSERVED");
  });

  it("R7-F6-M1: a FORGED REAL enum with no artifact evidence must not upgrade", () => {
    const { artifact } = runScript(kindE2e("REAL_DUAL_PINNED_BUILD"));
    expect(artifact.executionKind).toBe("REAL_DUAL_PINNED_BUILD");
    expect(artifact.levels["realBuildOfflineReady"]?.status).toBe("NOT_PROVEN");
    expect(artifact.levels["realBuildOfflineReady"]?.evidence?.failures.length ?? 0).toBeGreaterThan(0);
  });

  it("R7-F6-M2: a REAL declaration for a DIFFERENT SHA must not upgrade", () => {
    const { artifact } = runReal(realE2e({ ciRunSha: "f".repeat(40) }));
    expect(artifact.levels["realBuildOfflineReady"]?.status).toBe("NOT_PROVEN");
    expect(artifact.levels["realBuildOfflineReady"]?.blocker).toContain("SHA_MISMATCH");
  });

  it("R7-F6-M3: a replayed/stale artifact with no run identity must not upgrade", () => {
    const { artifact } = runReal(realE2e(), { runId: null });
    expect(artifact.ciRunId).toBeNull();
    expect(artifact.levels["realBuildOfflineReady"]?.status).toBe("NOT_PROVEN");
    expect(artifact.levels["realBuildOfflineReady"]?.blocker).toContain("NO_RUN_ID");
  });

  it("R7-F6-M4: a null command exit code must not upgrade", () => {
    const { artifact } = runReal(realE2e({ commandExits: { typecheck: null, test: 0, build: 0 } }));
    expect(artifact.levels["realBuildOfflineReady"]?.status).toBe("NOT_PROVEN");
    expect(artifact.levels["realBuildOfflineReady"]?.blocker).toContain("COMMAND_EXIT_TYPECHECK");
  });

  it("R7-F6-M5: one arm without the verifier over every case must not upgrade", () => {
    const { artifact } = runReal(
      realE2e({
        dualBuild: {
          baselineArm: { sourceSha: "1".repeat(40), buildDigest: "a".repeat(64) },
          candidateArm: { sourceSha: "2".repeat(40), buildDigest: "b".repeat(64) },
          verifier: { ran: true, casesVerified: 15, casesTotal: 16 },
        },
      }),
    );
    expect(artifact.levels["realBuildOfflineReady"]?.status).toBe("NOT_PROVEN");
    expect(artifact.levels["realBuildOfflineReady"]?.blocker).toContain("VERIFIER_INCOMPLETE");

    const notRun = runReal(
      realE2e({
        dualBuild: {
          baselineArm: { sourceSha: "1".repeat(40), buildDigest: "a".repeat(64) },
          candidateArm: { sourceSha: "2".repeat(40), buildDigest: "b".repeat(64) },
          verifier: { ran: false, casesVerified: 0, casesTotal: 16 },
        },
      }),
    );
    expect(notRun.artifact.levels["realBuildOfflineReady"]?.status).toBe("NOT_PROVEN");
    expect(notRun.artifact.levels["realBuildOfflineReady"]?.blocker).toContain("VERIFIER_NOT_RUN");

    const identical = runReal(
      realE2e({
        dualBuild: {
          baselineArm: { sourceSha: "1".repeat(40), buildDigest: "a".repeat(64) },
          candidateArm: { sourceSha: "1".repeat(40), buildDigest: "b".repeat(64) },
          verifier: { ran: true, casesVerified: 16, casesTotal: 16 },
        },
      }),
    );
    expect(identical.artifact.levels["realBuildOfflineReady"]?.status).toBe("NOT_PROVEN");
    expect(identical.artifact.levels["realBuildOfflineReady"]?.blocker).toContain("ARMS_IDENTICAL");
  });

  it("R7-F6-M6: a journal that disagrees with the independently recomputed delta must not upgrade", () => {
    const { artifact } = runReal(
      realE2e({
        positiveForward: {
          ...(baseE2e()["positiveForward"] as Record<string, unknown>),
          costMatchesJournal: false,
          aggregateTokensDelta: 248,
          independentTokens: { delta: -60 },
        },
      }),
    );
    expect(artifact.levels["realBuildOfflineReady"]?.status).toBe("NOT_PROVEN");
    expect(artifact.levels["realBuildOfflineReady"]?.blocker).toContain("JOURNAL_MISMATCH");
  });

  it("R7-F6-P: the COMPLETE REAL evidence is required and IS sufficient — PASS (the path is not dead code)", () => {
    const { artifact } = runReal(realE2e());
    expect(artifact.executionKind).toBe("REAL_DUAL_PINNED_BUILD");
    expect(artifact.ciRunId).toBe("36540000000");
    expect(artifact.expectedSha).toBe(HEAD);
    expect(artifact.platforms.thisProcess.status).toBe("MEASURED");
    expect(artifact.levels["realBuildOfflineReady"]?.status).toBe("PASS");
    expect(artifact.levels["realBuildOfflineReady"]?.blocker).toBeNull();
    expect(artifact.levels["realBuildOfflineReady"]?.evidence?.failures).toEqual([]);
    // A REAL basis still does not authorize money or promotion.
    expect(artifact.levels["paidExperimentRun"]?.status).toBe("NOT_RUN");
    expect(artifact.levels["championPromotion"]?.status).toBe("NOT_RUN");
  });
});
