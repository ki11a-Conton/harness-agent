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
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
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

interface LevelEvidence {
  realDeclaration?: boolean;
  failures?: string[];
  evidenceRoot?: string | null;
  bundle?: {
    derivedVerifierCoverage?: { verified: number; total: number } | null;
    identity?: Record<string, unknown> | null;
  } | null;
  journalBinding?: string;
  journalBindingReason?: string | null;
  requestDispatchBinding?: string;
  requestDispatchBindingReason?: string | null;
  budget?: Record<string, number> | null;
}

interface ReadinessArtifact {
  schemaVersion: string;
  ciRunSha: string;
  expectedSha: string;
  ciRunId: string | null;
  inputs: {
    e2ePath: string;
    evidenceRoot: string | null;
    attempt: number | null;
    platform: string | null;
    strict: boolean;
    requiredLevels: string[] | null;
  };
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
  levels: Record<string, { status: string; basis: string; blocker?: string | null; evidence?: LevelEvidence }>;
}

interface RunOptions {
  linuxSimulation?: boolean;
  osLabel?: string;
  extraArgs?: string[];
}

interface RunResult {
  exitCode: number | null;
  artifact: ReadinessArtifact;
  /** The artifact exactly as written, so a test can record the raw output verbatim. */
  rawArtifact: string;
  /** The temp directory the run used (input, output and any raw evidence files). */
  dir: string;
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
    // WATCHDOG: the readiness script shells out to three nested gates. A wedged
    // child must be killed instead of hanging CI, so this suite always terminates.
    timeout: 120_000,
    env: { ...process.env, PATH: `${shimDir};${process.env["PATH"] ?? ""}` },
  });
  if (result.error) {
    throw new Error(`ci-readiness child did not complete (watchdog 120000ms): ${result.error.message}\nstderr: ${result.stderr ?? ""}`);
  }
  let rawArtifact: string;
  try {
    rawArtifact = readFileSync(outPath, "utf8");
  } catch {
    // A refused command line exits before writing anything. Surface WHY instead
    // of a bare ENOENT, so a refusal is diagnosable rather than a test mystery.
    throw new Error(
      `ci-readiness wrote no artifact (exit ${String(result.status)})\n--- stdout ---\n${result.stdout ?? ""}\n--- stderr ---\n${result.stderr ?? ""}`,
    );
  }
  const artifact = JSON.parse(rawArtifact) as ReadinessArtifact;
  return { exitCode: result.status, artifact, rawArtifact, dir, stderr: result.stderr ?? "" };
}

/**
 * Runs the real script and returns the RAW process result WITHOUT reading an
 * artifact. Used for the CLI-schema refusals, which exit before writing one.
 */
function runScriptRaw(e2e: Record<string, unknown>, opts: RunOptions = {}): { exitCode: number | null; stdout: string; stderr: string } {
  const dir = mkdtempSync(join(tmpdir(), "r0-f6-raw-"));
  CREATED.push(dir);
  const e2ePath = join(dir, "e2e.json");
  writeFileSync(e2ePath, JSON.stringify(e2e), "utf8");
  const shimDir = join(dir, "bin");
  mkdirSync(shimDir);
  writeFileSync(join(shimDir, "pnpm.cmd"), "@echo off\r\nexit /b 0\r\n", "utf8");
  writeFileSync(join(shimDir, "pnpm"), "#!/bin/sh\nexit 0\n", "utf8");
  const result = spawnSync(
    process.execPath,
    [SCRIPT, "--e2e", e2ePath, "--out", join(dir, "readiness.json"), "--os-label", opts.osLabel ?? "windows-local", ...(opts.extraArgs ?? [])],
    { cwd: REPO_ROOT, encoding: "utf8", timeout: 120_000, env: { ...process.env, PATH: `${shimDir};${process.env["PATH"] ?? ""}` } },
  );
  return { exitCode: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
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

/**
 * S0b / F3 — the FROZEN forged input of plan(20260929-015956).md §4 item 5 and
 * Appendix B. Every field the classifier reads is present and self-reportedly
 * good, so nothing can bail early on an unrelated missing field. The ONLY things
 * absent are the three that must be real:
 *   - a legal build digest (`buildDigest` is the literal "x" for BOTH arms);
 *   - the artifact's own `runId` (the reviewer omitted it; the caller still
 *     passes `--run-id`, which is what the current script accepts instead);
 *   - any raw arm / verifier / journal evidence (no evidence root is named).
 *
 * FROZEN means: task-7 must replay THIS object unchanged, so the before/after
 * pair is comparable. Do not "fix" the input to make the gate pass.
 */
function forgedF3E2e(): Record<string, unknown> {
  return {
    ...baseE2e(),
    ciRunSha: HEAD,
    os: "windows-latest",
    commandExits: { typecheck: 0, test: 0, build: 0 },
    dualBuild: {
      baselineArm: { sourceSha: "a".repeat(40), buildDigest: "x" },
      candidateArm: { sourceSha: "b".repeat(40), buildDigest: "x" },
      verifier: { ran: true, casesVerified: 1, casesTotal: 1 },
    },
    readiness: { productionOfflineReadiness: { executionKind: "REAL_DUAL_PINNED_BUILD" } },
  };
}

// ---------------------------------------------------------------------------
// S6/F3 — a COMPLETE, self-consistent raw evidence bundle.
//
// This is the bundle S4 is contracted to keep (plan §10.2): the bundle's OWN run
// identity, both arm build identities, a schedule, and the per-arm A6 artifacts
// (`manifest.json` / `verifier.json` / `security.json`) whose bytes are what the
// verifier re-reads. `tamper` mutates files AFTER the digests were computed, so a
// tampered artifact is genuinely detectable rather than merely self-inconsistent.
// ---------------------------------------------------------------------------

const BUNDLE_SCHEMA = "prereg-readiness-evidence-v1";
const BUNDLE_EXECUTOR_ID = "prereg-arm-executor-v1";
const BUNDLE_CASE_ID = "reg-12-csv-parse";

interface BundleSpec {
  runId: string;
  attempt: number;
  platform: string;
  driverSha: string;
  armRunIds?: [string, string];
  sourceShas?: [string, string];
  buildDigests?: [string, string];
  withBudget?: boolean;
  /** Applied to the on-disk files AFTER all digests were computed. */
  tamper?: (paths: Record<string, string>) => void;
  /** Rewrites `identity.json` after it was written. */
  tamperIdentity?: (identity: Record<string, unknown>) => Record<string, unknown>;
}

interface Bundle {
  root: string;
  runId: string;
  attempt: number;
  platform: string;
  driverSha: string;
}

const sha256 = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex");

function writeEvidenceBundle(parentDir: string, spec: BundleSpec): Bundle {
  const root = join(parentDir, "evidence-root");
  const armRunIds = spec.armRunIds ?? ["run-baseline-0", "run-candidate-0"];
  const sourceShas = spec.sourceShas ?? ["1".repeat(40), "2".repeat(40)];
  const buildDigests = spec.buildDigests ?? ["a".repeat(64), "b".repeat(64)];
  const entryShas: [string, string] = ["c".repeat(64), "d".repeat(64)];
  const armIds = ["baseline", "candidate"] as const;
  const preregDigest = "e".repeat(64);
  const planDigest = "f".repeat(64);
  const files: Record<string, string> = {};

  const identity: Record<string, unknown> = {
    schemaVersion: BUNDLE_SCHEMA,
    driverSha: spec.driverSha,
    runId: spec.runId,
    attempt: spec.attempt,
    platform: spec.platform,
    closuresDistinguishable: true,
    arms: {
      baseline: { sourceSha: sourceShas[0], buildDigest: buildDigests[0], entrySha256: entryShas[0], clean: true },
      candidate: { sourceSha: sourceShas[1], buildDigest: buildDigests[1], entrySha256: entryShas[1], clean: true },
    },
  };
  files["identity.json"] = `${JSON.stringify(spec.tamperIdentity ? spec.tamperIdentity(identity) : identity)}\n`;

  const scheduleArms = armIds.map((armId, i) => {
    const armRunId = armRunIds[i]!;
    const manifestText = `${JSON.stringify({
      schemaVersion: "prereg-run-manifest-v1",
      executorId: BUNDLE_EXECUTOR_ID,
      preregistrationDigest: preregDigest,
      planDigest,
      armRunId,
      armId,
      caseId: BUNDLE_CASE_ID,
      repetition: 1,
      orderIndex: i,
      armBuildDigest: buildDigests[i],
      armEntrySha256: entryShas[i],
      armProbe: "r97-arm-probe-v1",
    })}\n`;
    const verifierText = `${JSON.stringify({ schemaVersion: "prereg-run-verifier-v1", verifiedCompletion: true, status: "passed", grade: "strong", violations: [] })}\n`;
    const securityText = `${JSON.stringify({ schemaVersion: "prereg-run-security-v1", violations: 0 })}\n`;
    files[`evidence/${armRunId}/manifest.json`] = manifestText;
    files[`evidence/${armRunId}/verifier.json`] = verifierText;
    files[`evidence/${armRunId}/security.json`] = securityText;
    return {
      armRunId,
      armId,
      caseId: BUNDLE_CASE_ID,
      repetition: 1,
      orderIndex: i,
      preregistrationDigest: preregDigest,
      planDigest,
      evidence: {
        executorId: BUNDLE_EXECUTOR_ID,
        traceDigest: sha256(manifestText),
        verifiedCompletion: true,
        securityViolations: 0,
        activationEvidenceDigest: null,
      },
    };
  });
  files["schedule.json"] = `${JSON.stringify({ schemaVersion: BUNDLE_SCHEMA, arms: scheduleArms })}\n`;

  if (spec.withBudget === true) {
    const entries = [
      { armRunId: armRunIds[0], arm: "baseline", caseId: BUNDLE_CASE_ID, repetition: 1, requestId: "rq-b", attemptId: 0, reservationId: "rs-b", basis: "MEASURED", inputTokens: 100, outputTokens: 20, reservedInputTokens: null, reservedOutputTokens: null, chargedTotalTokens: 120, outcomeUnknown: false },
      { armRunId: armRunIds[1], arm: "candidate", caseId: BUNDLE_CASE_ID, repetition: 1, requestId: "rq-c", attemptId: 0, reservationId: "rs-c", basis: "MEASURED", inputTokens: 40, outputTokens: 20, reservedInputTokens: null, reservedOutputTokens: null, chargedTotalTokens: 60, outcomeUnknown: false },
    ];
    files["cost-journal.json"] = `${JSON.stringify({ schemaVersion: "tool-call-efficiency-cost-journal-v2", entries })}\n`;
    files["aggregate.json"] = `${JSON.stringify({ schemaVersion: "prereg-aggregate-v1", cost: { totalTokens: 180, deltaTokens: -60 } })}\n`;
  }

  const paths: Record<string, string> = {};
  for (const [rel, text] of Object.entries(files)) {
    const abs = join(root, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, text, "utf8");
    paths[rel] = abs;
  }
  spec.tamper?.(paths);
  return { root, runId: spec.runId, attempt: spec.attempt, platform: spec.platform, driverSha: spec.driverSha };
}

/** The E2E artifact that points at a REAL bundle (the positive case). */
function realBundleE2e(bundle: Bundle): Record<string, unknown> {
  return {
    ...realE2e(),
    ciRunSha: bundle.driverSha,
    runId: bundle.runId,
    attempt: bundle.attempt,
    platform: bundle.platform,
    evidenceRoot: bundle.root,
  };
}

/** Runs the real script over a bundle-backed artifact with the matching CLI inputs. */
function runRealBundle(
  e2e: Record<string, unknown>,
  bundle: Bundle,
  extra: string[] = [],
): RunResult {
  return runScript(e2e, {
    extraArgs: [
      "--run-id",
      bundle.runId,
      "--attempt",
      String(bundle.attempt),
      "--platform",
      bundle.platform,
      "--evidence-root",
      bundle.root,
      ...extra,
    ],
  });
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
    expect((artifact.levels["realBuildOfflineReady"]?.evidence?.failures ?? []).length).toBeGreaterThan(0);
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
    const dir = mkdtempSync(join(tmpdir(), "r0-f6-real-"));
    CREATED.push(dir);
    // S6/F3 — "complete" now means a COMPLETE RAW EVIDENCE BUNDLE, not a complete
    // set of self-reported fields. This is the positive case that proves the REAL
    // path is reachable rather than dead code.
    const bundle = writeEvidenceBundle(dir, { runId: "36540000000", attempt: 1, platform: "windows", driverSha: HEAD, withBudget: true });
    const { artifact } = runRealBundle(realBundleE2e(bundle), bundle);
    expect(artifact.executionKind).toBe("REAL_DUAL_PINNED_BUILD");
    expect(artifact.ciRunId).toBe("36540000000");
    expect(artifact.expectedSha).toBe(HEAD);
    expect(artifact.platforms.thisProcess.status).toBe("MEASURED");
    expect(artifact.levels["realBuildOfflineReady"]?.status).toBe("PASS");
    expect(artifact.levels["realBuildOfflineReady"]?.blocker).toBeNull();
    expect(artifact.levels["realBuildOfflineReady"]?.evidence?.failures).toEqual([]);
    // The verifier coverage is DERIVED from the per-arm records, not self-reported.
    expect(artifact.levels["realBuildOfflineReady"]?.evidence?.bundle?.derivedVerifierCoverage).toEqual({ verified: 2, total: 2 });
    // S6 — budgetEvidenceReady is COMPUTED. The raw journal reconciles, but the
    // request/dispatch cross-binding is S4's contract and does not exist yet, so
    // this level stays NOT_PROVEN with that dimension named. It must NOT be
    // promoted to PASS because the code was written.
    expect(artifact.levels["budgetEvidenceReady"]?.status).toBe("NOT_PROVEN");
    expect(artifact.levels["budgetEvidenceReady"]?.evidence?.journalBinding).toBe("MEASURED");
    expect(artifact.levels["budgetEvidenceReady"]?.evidence?.requestDispatchBinding).toBe("NOT_PROVEN");
    expect(artifact.levels["budgetEvidenceReady"]?.blocker).toContain("REQUEST_DISPATCH_JOURNAL_NOT_BOUND");
    // A REAL basis still does not authorize money or promotion.
    expect(artifact.levels["paidExperimentRun"]?.status).toBe("NOT_RUN");
    expect(artifact.levels["championPromotion"]?.status).toBe("NOT_RUN");
  });
});

/**
 * S6 — plan(20260929-015956).md §10. The raw-evidence verifier's refusal matrix.
 *
 * Every test below is a NEGATIVE that must refuse for its OWN reason, so the
 * classifier cannot be satisfied by a well-formed JSON shape. The positive case
 * above (`R7-F6-P`) proves the same machinery renders PASS when the evidence is
 * actually complete.
 */
describe("S6/F3 — readiness is computed from raw evidence, and each missing dimension refuses independently", () => {
  /** A fresh complete bundle, so each test mutates exactly one dimension. */
  function freshBundle(spec: Partial<BundleSpec> = {}): { dir: string; bundle: Bundle } {
    const dir = mkdtempSync(join(tmpdir(), "r0-f6-bundle-"));
    CREATED.push(dir);
    const bundle = writeEvidenceBundle(dir, { runId: "36540000000", attempt: 1, platform: "windows", driverSha: HEAD, ...spec });
    return { dir, bundle };
  }

  it("S6-A: the ARTIFACT must carry its own runId, attempt and platform", () => {
    const { bundle } = freshBundle();
    const base = realBundleE2e(bundle);

    const noRunId = runRealBundle({ ...base, runId: undefined }, bundle);
    expect(noRunId.artifact.levels["realBuildOfflineReady"]?.status).toBe("NOT_PROVEN");
    expect(noRunId.artifact.levels["realBuildOfflineReady"]?.blocker).toContain("NO_ARTIFACT_RUN_ID");

    const noAttempt = runRealBundle({ ...base, attempt: undefined }, bundle);
    expect(noAttempt.artifact.levels["realBuildOfflineReady"]?.blocker).toContain("NO_ARTIFACT_ATTEMPT");

    const noPlatform = runRealBundle({ ...base, platform: undefined }, bundle);
    expect(noPlatform.artifact.levels["realBuildOfflineReady"]?.blocker).toContain("NO_ARTIFACT_PLATFORM");
  });

  it("S6-B: a wrong attempt or platform must refuse even when everything else is complete", () => {
    const { bundle } = freshBundle();
    const base = realBundleE2e(bundle);

    const wrongAttempt = runRealBundle({ ...base, attempt: 2 }, bundle);
    expect(wrongAttempt.artifact.levels["realBuildOfflineReady"]?.status).toBe("NOT_PROVEN");
    expect(wrongAttempt.artifact.levels["realBuildOfflineReady"]?.blocker).toContain("ATTEMPT_MISMATCH");

    const wrongPlatform = runRealBundle({ ...base, platform: "ubuntu" }, bundle);
    expect(wrongPlatform.artifact.levels["realBuildOfflineReady"]?.blocker).toContain("PLATFORM_MISMATCH");
  });

  it("S6-C: a bundle for a DIFFERENT driver SHA must refuse", () => {
    const { bundle } = freshBundle({ driverSha: "9".repeat(40) });
    const { artifact } = runRealBundle({ ...realBundleE2e(bundle), ciRunSha: HEAD }, bundle);
    expect(artifact.levels["realBuildOfflineReady"]?.status).toBe("NOT_PROVEN");
    const reasons = `${artifact.levels["realBuildOfflineReady"]?.blocker ?? ""}`;
    expect(reasons).toContain("IDENTITY_SHA_MISMATCH");
  });

  it("S6-D: a MALFORMED or mismatched build digest must refuse", () => {
    // (a) self-reported digest is not a legal sha256
    const malformed = freshBundle({ buildDigests: ["x", "b".repeat(64)] });
    const a = runRealBundle(realBundleE2e(malformed.bundle), malformed.bundle);
    expect(a.artifact.levels["realBuildOfflineReady"]?.blocker).toContain("BASELINE_BUILD_DIGEST_MALFORMED");

    // (b) the artifact's digest does not match the raw identity file
    const mismatch = freshBundle();
    const e2e = realBundleE2e(mismatch.bundle);
    const dualBuild = e2e["dualBuild"] as Record<string, Record<string, string>>;
    dualBuild["baselineArm"]!["buildDigest"] = "9".repeat(64);
    const b = runRealBundle(e2e, mismatch.bundle);
    expect(b.artifact.levels["realBuildOfflineReady"]?.blocker).toContain("BASELINE_BUILD_DIGEST_MISMATCH");
  });

  it("S6-E: a DELETED per-arm verifier must refuse (a parsed schedule is not evidence)", () => {
    const { bundle } = freshBundle({
      tamper: (paths) => {
        rmSync(paths["evidence/run-baseline-0/verifier.json"]!, { force: true });
      },
    });
    const { artifact } = runRealBundle(realBundleE2e(bundle), bundle);
    expect(artifact.levels["realBuildOfflineReady"]?.status).toBe("NOT_PROVEN");
    expect(artifact.levels["realBuildOfflineReady"]?.blocker).toContain("ARM_EVIDENCE_UNVERIFIED");
    expect(artifact.levels["realBuildOfflineReady"]?.blocker).toContain("verifier.json");
  });

  it("S6-F: a TAMPERED manifest must refuse even though its declared digest is unchanged", () => {
    const { bundle } = freshBundle({
      tamper: (paths) => {
        const p = paths["evidence/run-candidate-0/manifest.json"]!;
        writeFileSync(p, `${readFileSync(p, "utf8").replace('"armId":"candidate"', '"armId":"baseline"')}`, "utf8");
      },
    });
    const { artifact } = runRealBundle(realBundleE2e(bundle), bundle);
    expect(artifact.levels["realBuildOfflineReady"]?.status).toBe("NOT_PROVEN");
    expect(artifact.levels["realBuildOfflineReady"]?.blocker).toContain("ARM_EVIDENCE_UNVERIFIED");
  });

  it("S6-G: identical arm closures / identical source SHAs must refuse", () => {
    const { bundle } = freshBundle({ sourceShas: ["1".repeat(40), "1".repeat(40)] });
    const { artifact } = runRealBundle(realBundleE2e(bundle), bundle);
    expect(artifact.levels["realBuildOfflineReady"]?.status).toBe("NOT_PROVEN");
    expect(artifact.levels["realBuildOfflineReady"]?.blocker).toContain("ARMS_IDENTICAL");
  });

  it("S6-H: a path that escapes the evidence root must refuse", () => {
    const { dir, bundle } = freshBundle();
    // A schedule naming an arm run OUTSIDE the root.
    const schedulePath = join(bundle.root, "schedule.json");
    const schedule = JSON.parse(readFileSync(schedulePath, "utf8")) as { arms: { armRunId: string }[] };
    schedule.arms[0]!.armRunId = "../../outside-the-root";
    writeFileSync(schedulePath, `${JSON.stringify(schedule)}\n`, "utf8");
    const { artifact } = runRealBundle(realBundleE2e(bundle), bundle);
    const reasons = `${artifact.levels["realBuildOfflineReady"]?.blocker ?? ""}`;
    expect(artifact.levels["realBuildOfflineReady"]?.status).toBe("NOT_PROVEN");
    expect(reasons).toMatch(/PATH_REJECTED|PATH_ESCAPE/);
    expect(dir.length).toBeGreaterThan(0);
  });

  it("S6-I: an unknown CLI argument is REFUSED, never silently ignored", () => {
    const { bundle } = freshBundle();
    // A typo'd flag must be an ERROR, not a silently-absent input: otherwise a
    // misconfigured gate reads exactly like a weaker gate.
    const typo = runScriptRaw(realBundleE2e(bundle), { extraArgs: ["--run-id", bundle.runId, "--evidnce-root", bundle.root] });
    expect(typo.exitCode).toBe(2);
    expect(typo.stderr).toContain("unknown argument: --evidnce-root");

    // A known flag with no value is refused too.
    const valueless = runScriptRaw(realBundleE2e(bundle), { extraArgs: ["--run-id", bundle.runId, "--evidence-root"] });
    expect(valueless.exitCode).toBe(2);
    expect(valueless.stderr).toContain("--evidence-root requires a value");

    // A bare positional is refused.
    const positional = runScriptRaw(realBundleE2e(bundle), { extraArgs: ["--run-id", bundle.runId, "stray"] });
    expect(positional.exitCode).toBe(2);
    expect(positional.stderr).toContain("unexpected positional argument: stray");
  });

  it("S6-J: report mode exits 0 while `--strict` exits non-zero when a required level is unmet", () => {
    const { bundle } = freshBundle();
    const e2e = realBundleE2e(bundle);

    // REPORT MODE: the artifact was written, so exit 0 — the levels are the verdict.
    const report = runScript(e2e, {
      extraArgs: ["--run-id", bundle.runId, "--attempt", "1", "--platform", "windows", "--evidence-root", bundle.root],
    });
    expect(report.exitCode).toBe(0);
    expect(report.artifact.inputs["strict"]).toBe(false);

    // GATE MODE: budgetEvidenceReady is NOT_PROVEN (the request/dispatch binding
    // is unbound), so a strict gate on it MUST fail.
    const strict = runScript(e2e, {
      extraArgs: ["--run-id", bundle.runId, "--attempt", "1", "--platform", "windows", "--evidence-root", bundle.root, "--strict"],
    });
    expect(strict.exitCode).toBe(1);
    expect(strict.artifact.inputs["strict"]).toBe(true);
    expect(strict.artifact.inputs["requiredLevels"]).toEqual(["fixtureProtocolReady", "realBuildOfflineReady", "budgetEvidenceReady"]);

    // A strict gate over ONLY the levels that really passed must exit 0.
    const narrow = runScript(e2e, {
      extraArgs: ["--run-id", bundle.runId, "--attempt", "1", "--platform", "windows", "--evidence-root", bundle.root, "--strict", "--require", "fixtureProtocolReady,realBuildOfflineReady"],
    });
    expect(narrow.exitCode, JSON.stringify(narrow.artifact.levels["realBuildOfflineReady"])).toBe(0);
  });

  it("S6-K: an UNBOUND budget dimension is NOT_PROVEN with its reason, never flattened to zero", () => {
    // No aggregate / cost-journal: the journal binding is explicitly missing.
    const { bundle } = freshBundle();
    const { artifact } = runRealBundle(realBundleE2e(bundle), bundle);
    const level = artifact.levels["budgetEvidenceReady"];
    expect(level?.status).toBe("NOT_PROVEN");
    expect(level?.evidence?.journalBinding).toBe("NOT_PROVEN");
    expect(level?.evidence?.journalBindingReason).toContain("JOURNAL_BINDING_NOT_PROVEN");
    expect(level?.evidence?.requestDispatchBinding).toBe("NOT_PROVEN");
    expect(level?.evidence?.budget).toBeNull();
  });

  it("S6-L: an unknown-usage journal entry keeps its conservative upper bound and is not reported as measured", () => {
    const { bundle } = freshBundle({
      withBudget: true,
      tamper: (paths) => {
        const p = paths["cost-journal.json"]!;
        const journal = JSON.parse(readFileSync(p, "utf8")) as { entries: Record<string, unknown>[] };
        journal.entries[1] = {
          ...journal.entries[1],
          basis: "RESERVED_UPPER_BOUND",
          inputTokens: null,
          outputTokens: null,
          reservedInputTokens: 40,
          reservedOutputTokens: 20,
          chargedTotalTokens: 60,
          outcomeUnknown: true,
        };
        writeFileSync(p, `${JSON.stringify(journal)}\n`, "utf8");
      },
    });
    const { artifact } = runRealBundle(realBundleE2e(bundle), bundle);
    const level = artifact.levels["budgetEvidenceReady"];
    expect(level?.status).toBe("NOT_PROVEN");
    expect(level?.evidence?.journalBinding).toBe("NOT_PROVEN");
    expect(level?.evidence?.journalBindingReason).toContain("JOURNAL_UNKNOWN_USAGE");
    const budget = level?.evidence?.budget as Record<string, number> | null;
    expect(budget?.["reservedUpperBound"]).toBe(60);
    expect(budget?.["unknownEntries"]).toBe(1);
    expect(budget?.["measuredTotal"]).toBe(120);
  });

  it("S6-M: a DUPLICATE journal attempt and an unknown arm are both refused, on the BUDGET level only", () => {
    const { bundle } = freshBundle({
      withBudget: true,
      tamper: (paths) => {
        const p = paths["cost-journal.json"]!;
        const journal = JSON.parse(readFileSync(p, "utf8")) as { entries: Record<string, unknown>[] };
        journal.entries.push({ ...journal.entries[0] });
        journal.entries.push({ ...journal.entries[0], armRunId: "run-not-in-schedule" });
        writeFileSync(p, `${JSON.stringify(journal)}\n`, "utf8");
      },
    });
    const { artifact } = runRealBundle(realBundleE2e(bundle), bundle);
    // A journal defect is a BUDGET fact: it must be reported on the budget level
    // and must NOT make the REAL-BUILD level unproven (the levels stay independent).
    expect(artifact.levels["realBuildOfflineReady"]?.status).toBe("PASS");
    const budget = artifact.levels["budgetEvidenceReady"];
    const reasons = `${budget?.blocker ?? ""} ${budget?.evidence?.journalBindingReason ?? ""}`;
    expect(budget?.status).toBe("NOT_PROVEN");
    expect(reasons).toContain("JOURNAL_DUPLICATE_ATTEMPT");
    expect(reasons).toContain("JOURNAL_UNKNOWN_ARM");
  });
});

/**
 * S0b — plan(20260929-015956).md §4 item 5 / Appendix B. The F3 counter-example.
 *
 * MEASURED DEFECT against the UNMODIFIED script at HEAD f23de8e (real child
 * process, same input as this test):
 *
 *   inputHasRunId: false, inputBuildDigests: ["x","x"]
 *   realBuildOfflineReady: { status: "PASS", blocker: null, evidence: { failures: [] } }
 *
 * `verifyRealEvidence()` (scripts/e4/ci-readiness.mjs L195-240) checks
 * `buildDigest` for NON-EMPTINESS only (L220-221), accepts a caller-supplied
 * `--run-id` in place of the artifact's own run identity (L207-210), and never
 * opens — or even names — an arm / verifier / journal raw file.
 *
 * THIS BLOCK IS DELIBERATELY RED. It asserts the CORRECT behaviour, so it fails
 * until task-7 (S6) derives readiness from raw evidence. It is NOT `test.fails`,
 * NOT `skip`, and NOT an inverted assertion: nothing here makes a known defect
 * look green.
 */
describe("S0b/F3 — a forged REAL declaration with no raw evidence must not PASS (RED counter-example)", () => {
  it("S0b-F3-RED: forged REAL JSON with buildDigest 'x', no raw evidence and no artifact runId must not PASS", () => {
    const forged = forgedF3E2e();
    // The caller DOES pass --run-id, exactly as the reviewer did. The defect is
    // that the ARTIFACT's own runId is never required.
    const { artifact, rawArtifact, exitCode, dir } = runReal(forged);

    // Verbatim before/after record (plan §4 item 5: keep the raw input and the
    // raw output; the SAME input is replayed after the fix).
    console.log(`[S0b-F3] raw forged input JSON: ${JSON.stringify(forged)}`);
    console.log(`[S0b-F3] raw readiness output JSON: ${rawArtifact}`);

    // The input is COMPLETE: nothing bailed early on an unrelated missing field.
    expect(exitCode).toBe(0);
    expect(artifact.executionKind).toBe("REAL_DUAL_PINNED_BUILD");
    expect(artifact.forwardBasis).toBe("REAL_DUAL_PINNED_BUILD");
    // ...and it really is the forged shape: no artifact runId, no evidence root.
    expect(Object.hasOwn(forged, "runId")).toBe(false);
    expect(Object.keys(forged).some((k) => /evidence|bundle|root/i.test(k))).toBe(false);
    // No arm / verifier / journal / manifest / aggregate / schedule raw file was
    // created anywhere for this run.
    expect(readdirSync(dir).filter((entry) => /arm|verifier|journal|manifest|aggregate|schedule/i.test(entry))).toEqual([]);

    const level = artifact.levels["realBuildOfflineReady"];
    const reasons = `${level?.blocker ?? ""} ${(level?.evidence?.failures ?? []).join(" ")}`;

    // TARGET 1 — a forged declaration must never reach PASS.
    expect(level?.status).not.toBe("PASS");
    // TARGET 2 — the missing ARTIFACT run identity must be named.
    expect(reasons).toMatch(/run[ _-]?id/i);
    // TARGET 3 — "x" is not a legal build digest and must be named.
    expect(reasons).toMatch(/digest/i);
    // TARGET 4 — the absent raw evidence must be named.
    expect(reasons).toMatch(/evidence|raw|bundle|manifest/i);
  });
});

/**
 * task-10 — the request/dispatch journal CROSS-BINDING.
 *
 * `bindRequestDispatchJournals` is the function that decides whether
 * `budgetEvidenceReady` can reach MEASURED. It is exported from the verifier and
 * takes its inputs explicitly, so it is asserted DIRECTLY here rather than only
 * through the CLI — otherwise a defect inside it would be invisible, because NO
 * producer writes a tool-dispatch journal yet (see the NOT_PROVEN note below).
 *
 * The point of these cases is that the function must have a REACHABLE MEASURED
 * path (a checker that can never pass is not a checker) while refusing every
 * splice, duplicate and unobserved-outcome shape. The umbrella code
 * `REQUEST_DISPATCH_JOURNAL_NOT_BOUND` must stay FIRST in the reason, with the
 * specific cause after it, so the report names EXACTLY which input is missing.
 */
describe("task-10 — request/dispatch journal cross-binding", () => {
  const ARM_B = "arm-run-baseline";
  const ARM_C = "arm-run-candidate";
  const CASE_ID = "reg-01-basic-edit";

  function schedule(): Map<string, { armId: string; caseId: string; repetition: number; orderIndex: number }> {
    return new Map([
      [ARM_B, { armId: "baseline", caseId: CASE_ID, repetition: 0, orderIndex: 0 }],
      [ARM_C, { armId: "candidate", caseId: CASE_ID, repetition: 0, orderIndex: 1 }],
    ]);
  }

  function entry(over: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      armRunId: ARM_B,
      arm: "baseline",
      caseId: CASE_ID,
      repetition: 0,
      requestId: `${ARM_B}:r1`,
      attemptId: 0,
      reservationId: "rs-1",
      campaignDigest: "digest-1",
      outcomeUnknown: false,
      ...over,
    };
  }

  /**
   * N3/F30-4 — ONE tool-dispatch journal event in the versioned contract. Every
   * test below derives from a VALID journal and changes ONE dimension, so the
   * failure it asserts is the dimension it names rather than an earlier gate.
   */
  function event(over: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      type: "reserve_granted",
      armRunId: ARM_B,
      arm: "baseline",
      caseId: CASE_ID,
      repetition: 0,
      orderIndex: 0,
      campaignDigest: "digest-1",
      toolReservationId: `${ARM_B}:tool:1`,
      dispatchId: "cost-res-1",
      toolCallId: "call-1",
      tool: "write_file",
      sessionId: "s1",
      turnId: "t1",
      readOnly: false,
      sideEffectScope: "filesystem",
      parentRequestId: `${ARM_B}:r1`,
      parentAttemptId: 0,
      refusalReason: null,
      settlement: null,
      ...over,
    };
  }

  function coverage(over: Array<Record<string, unknown>> = []): Array<Record<string, unknown>> {
    return [
      { armRunId: ARM_B, arm: "baseline", caseId: CASE_ID, repetition: 0, orderIndex: 0, openedAtMs: 1, closedAtMs: 9, reserveFrames: 1, settleFrames: 1 },
      { armRunId: ARM_C, arm: "candidate", caseId: CASE_ID, repetition: 0, orderIndex: 1, openedAtMs: 2, closedAtMs: 10, reserveFrames: 1, settleFrames: 1 },
      ...over,
    ];
  }

  function journalOf(events: Array<Record<string, unknown>>, over: Record<string, unknown> = {}): Record<string, unknown> {
    const numbered = events.map((e, i) => ({ seq: i + 1, atMs: 1_000 + i, ...e }));
    return {
      schemaVersion: "e4-n3-tool-dispatch-journal-v1",
      campaignDigest: "digest-1",
      eventCount: numbered.length,
      events: numbered,
      coverage: { armRuns: coverage() },
      ...over,
    };
  }

  /** The fully consistent baseline: one dispatched tool per arm. */
  function okEvents(): Array<Record<string, unknown>> {
    return [
      event(),
      event({ type: "settled", settlement: "dispatched" }),
      event({
        armRunId: ARM_C,
        arm: "candidate",
        orderIndex: 1,
        toolReservationId: `${ARM_C}:tool:1`,
        dispatchId: "cost-res-2",
        toolCallId: "call-2",
        parentRequestId: `${ARM_C}:r1`,
      }),
      event({
        type: "settled",
        armRunId: ARM_C,
        arm: "candidate",
        orderIndex: 1,
        toolReservationId: `${ARM_C}:tool:1`,
        dispatchId: "cost-res-2",
        toolCallId: "call-2",
        parentRequestId: `${ARM_C}:r1`,
        settlement: "dispatched",
      }),
    ];
  }

  async function bind(over: {
    // `null` is a MEANINGFUL input here (the journal is absent), so it must not be
    // conflated with "not supplied" — hence the `in` check rather than `??`.
    entries?: unknown;
    dispatchJournal?: unknown;
    dispatchJournalProblem?: string | null;
    scheduleArms?: Map<string, { armId: string; caseId: string }>;
    budgetFacts?: { chargedToolCalls: number | null; reservedToolCalls: number | null } | null;
  }) {
    const mod = await import(pathToFileURL(join(REPO_ROOT, "scripts", "e4", "readiness-evidence-verify.mjs")).href);
    return mod.bindRequestDispatchJournals({
      entries:
        "entries" in over
          ? over.entries
          : [
              entry(),
              entry({ armRunId: ARM_C, arm: "candidate", requestId: `${ARM_C}:r1`, reservationId: "rs-2" }),
            ],
      scheduleArms: over.scheduleArms ?? schedule(),
      dispatchJournal: "dispatchJournal" in over ? over.dispatchJournal : journalOf(okEvents()),
      dispatchJournalFile: "dispatch-journal.json",
      dispatchJournalProblem: over.dispatchJournalProblem ?? null,
      budgetFacts: "budgetFacts" in over ? over.budgetFacts : { chargedToolCalls: 2, reservedToolCalls: 0 },
    });
  }

  it("BIND-1: a fully consistent pair of journals reaches MEASURED with its digest, counts and reasons intact", async () => {
    const result = await bind({});
    expect(result.status).toBe("MEASURED");
    expect(result.reason).toBeNull();
    expect(result.problems).toEqual([]);
    // The facts actually describe the input, so this is not a blind PASS.
    expect(result.facts.requestJournalEntries).toBe(2);
    expect(result.facts.boundAttempts).toBe(2);
    expect(result.facts.boundReservations).toBe(2);
    expect(result.facts.distinctArms).toEqual([ARM_B, ARM_C].sort());
    // N3 — the dispatch facts are RECOMPUTED from the journal, not trusted from
    // it: two grants, two dispatches, zero retained upper bounds.
    expect(result.facts.toolDispatch.reserveGranted).toBe(2);
    expect(result.facts.toolDispatch.reserveRefused).toBe(0);
    expect(result.facts.toolDispatch.settledDispatched).toBe(2);
    expect(result.facts.toolDispatch.settledUnknown).toBe(0);
    expect(result.facts.toolDispatch.unsettledGrants).toBe(0);
    expect(result.facts.toolDispatch.eventCount).toBe(4);
    expect(result.facts.toolDispatch.chargedToolCalls).toBe(2);
  });

  it("BIND-2: a MISSING journal refuses and still names the request/attempt binding", async () => {
    const result = await bind({ entries: null });
    expect(result.status).toBe("NOT_PROVEN");
    expect(result.reason).toMatch(/^REQUEST_DISPATCH_JOURNAL_NOT_BOUND:/);
    expect(result.reason).toMatch(/REQUEST_JOURNAL_MISSING/);
  });

  it("BIND-3: an ABSENT tool-dispatch journal refuses — a granted reservation that never settled cannot be excluded", async () => {
    const result = await bind({ dispatchJournal: null });
    expect(result.status).toBe("NOT_PROVEN");
    expect(result.reason).toMatch(/DISPATCH_JOURNAL_MISSING/);
  });

  it("BIND-4: the SAME attempt settled twice is refused as a duplicate", async () => {
    const result = await bind({ entries: [entry(), entry()] });
    expect(result.status).toBe("NOT_PROVEN");
    expect(result.reason).toMatch(/JOURNAL_DUPLICATE_ATTEMPT/);
  });

  it("BIND-5: one reservation attributed to BOTH arms is refused as a cross-arm splice", async () => {
    const result = await bind({
      entries: [
        entry(),
        entry({ armRunId: ARM_C, arm: "candidate", requestId: `${ARM_C}:r1`, reservationId: "rs-1" }),
      ],
    });
    expect(result.status).toBe("NOT_PROVEN");
    expect(result.reason).toMatch(/CROSS_ARM_RESERVATION/);
  });

  it("BIND-6: entries spliced from two DIFFERENT runs are refused as a cross-run splice", async () => {
    const result = await bind({
      entries: [entry(), entry({ requestId: `${ARM_B}:r2`, reservationId: "rs-3", campaignDigest: "digest-OTHER" })],
    });
    expect(result.status).toBe("NOT_PROVEN");
    expect(result.reason).toMatch(/CROSS_RUN_SPLICE/);
  });

  it("BIND-7: an entry for an UNSCHEDULED arm is refused rather than ignored", async () => {
    const result = await bind({ entries: [entry({ armRunId: "arm-not-scheduled" })] });
    expect(result.status).toBe("NOT_PROVEN");
    expect(result.reason).toMatch(/JOURNAL_UNKNOWN_ARM/);
  });

  it("BIND-8: an UNOBSERVED outcome stays visible as a conservative bound and is never counted as measured", async () => {
    const result = await bind({ entries: [entry({ outcomeUnknown: true })] });
    expect(result.status).toBe("NOT_PROVEN");
    expect(result.reason).toMatch(/DROPPED_RETRY_UNOBSERVED/);
    // It was still BOUND (not silently dropped), and the count records it.
    expect(result.facts.boundAttempts).toBe(1);
    expect(result.facts.droppedRetries).toBe(1);
  });

  it("BIND-9: a granted dispatch with NO settlement event is UNKNOWN with its bound retained, never zero", async () => {
    // ONE dimension changed from the valid journal: the settlement events are
    // removed. The grant stays, its upper bound stays, and the leading code names
    // the UNKNOWN rather than flattening it into the umbrella "not bound".
    const result = await bind({
      dispatchJournal: journalOf([event()], {
        coverage: {
          armRuns: [
            { armRunId: ARM_B, arm: "baseline", caseId: CASE_ID, repetition: 0, orderIndex: 0, openedAtMs: 1, closedAtMs: 9, reserveFrames: 1, settleFrames: 0 },
          ],
        },
      }),
      entries: [entry()],
      budgetFacts: { chargedToolCalls: 0, reservedToolCalls: 1 },
    });
    expect(result.status).toBe("NOT_PROVEN");
    expect(result.reason).toMatch(/^DISPATCH_UNKNOWN_RETAINED:/);
    expect(result.reason).toMatch(/DISPATCH_SETTLE_INCOMPLETE/);
    expect(result.facts.toolDispatch.unsettledGrants).toBe(1);
    // The upper bound is RETAINED in the ledger, not refunded.
    expect(result.facts.toolDispatch.reservedToolCalls).toBe(1);
  });

  it("BIND-10: a dispatch whose PARENT model request does not exist is refused as unbound", async () => {
    const result = await bind({
      dispatchJournal: journalOf([
        event({ parentRequestId: `${ARM_B}:r7` }),
        event({ type: "settled", settlement: "dispatched", parentRequestId: `${ARM_B}:r7` }),
      ]),
      entries: [entry()],
      budgetFacts: { chargedToolCalls: 1, reservedToolCalls: 0 },
    });
    expect(result.status).toBe("NOT_PROVEN");
    expect(result.reason).toMatch(/DISPATCH_PARENT_REQUEST_UNBOUND/);
  });

  it("BIND-11: a PRODUCER now writes the durable dispatch journal — the contract changed, and the change is asserted rather than deleted", async () => {
    // CONTRACT CHANGE (N3/F30-4). This test used to assert the OPPOSITE — "no
    // producer in this repository WRITES a dispatch journal" — which was the
    // honest state while `budgetEvidenceReady` could only ever report
    // `DISPATCH_JOURNAL_MISSING`. N3 added the producer, so the assertion is
    // INVERTED rather than removed: the claim is now that a producer EXISTS, that
    // it actually sinks the journal to disk, and that the production admission
    // path WIRES it — otherwise the file would be dead code and the level would
    // stay NOT_PROVEN.
    //
    // The files are read from disk rather than through `git grep`, because the
    // claim is about the WORKING TREE the tests run against: a `git grep` would
    // not see the producer until it is committed, which would make this assertion
    // depend on the git index instead of on the code.
    const { readFileSync: read } = await import("node:fs");
    const producerPath = join(REPO_ROOT, "packages", "evaluation", "src", "n3-tool-dispatch-journal.ts");    expect(existsSync(producerPath), "the N3 tool-dispatch journal producer does not exist").toBe(true);
    const producer = read(producerPath, "utf8");
    // It must WRITE: a module that only defines a schema produces nothing.
    expect(producer, "the producer never writes the journal file").toMatch(/writeJsonAtomic\(this\.path/);
    // It must write the file name the verifier looks for FIRST.
    expect(producer).toMatch(/N3_DISPATCH_JOURNAL_FILENAME = "dispatch-journal\.json"/);

    const budgetPath = join(REPO_ROOT, "packages", "evaluation", "src", "tool-call-efficiency-formal-run.ts");
    const budget = read(budgetPath, "utf8");
    expect(
      budget,
      "the durable tool budget is never given a journal, so nothing would produce one on the production path",
    ).toMatch(/journal: \{ dir: opts\.budgetDir/);

    // The real CONSUMERS must still exist, so the change above cannot pass by
    // having deleted the checks that read the journal.
    const verifierPath = join(REPO_ROOT, "scripts", "e4", "readiness-evidence-verify.mjs");
    expect(existsSync(verifierPath)).toBe(true);
    expect(read(verifierPath, "utf8")).toMatch(/verifyDispatchJournal\(/);
    const contractPath = join(REPO_ROOT, "scripts", "e4", "n3-dispatch-journal-contract.mjs");
    expect(existsSync(contractPath), "the shared strict contract module does not exist").toBe(true);
    expect(read(contractPath, "utf8")).toMatch(/e4-n3-tool-dispatch-journal-v1/);
  });
});
