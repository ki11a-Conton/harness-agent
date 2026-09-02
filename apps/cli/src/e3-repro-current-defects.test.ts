/**
 * E3 — dedicated repro-current-defects suite.
 *
 * Each R-xx test asserts the CURRENT defect behavior (REPRODUCED).
 * When E3 later fixes a defect, the corresponding test flips to asserting
 * the FIXED behavior. This suite is run separately from the default
 * `pnpm test` via `pnpm e3:repro-current-defects`.
 *
 * E3-01: R-01 fixed — interleave without shuffle now fails in preflight
 * (0 provider calls, error before any provider resolution).
 * All other repros unchanged.
 */

import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, rm, writeFile, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { createHash } from "node:crypto";
import { ScriptedModelProvider } from "@ar/model";
import {
  buildPairedPlan,
  compareProvenanceV3,
  decideChampionV3,
  buildPromotionEnvelope,
  loadPromotionEnvelope,
  buildExperimentArtifactV3,
  loadExperimentArtifactV3,
  deriveSummaryV3,
  createInitialChampionState,
  stableStringify,
} from "@ar/evaluation";
import type { ExperimentProvenanceV3, CaseOutcomeV3 } from "@ar/evaluation";
import { runBenchmarkCommand } from "./benchmark-command.js";
import { runChampionEval } from "./champion-eval.js";
import {
  writeChampionStateFileCas,
  championStateDigest,
} from "./champion-state-file.js";

let tempDirs: string[] = [];

afterEach(async () => {
  for (const d of tempDirs.splice(0)) {
    await rm(d, { recursive: true, force: true }).catch(() => {});
  }
});

async function makeTemp(): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), "e3-repro-"));
  tempDirs.push(d);
  return d;
}

async function makeCaseDir(
  files: Record<string, string>,
): Promise<string> {
  const dir = await makeTemp();
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(dir, ...rel.split("/"));
    if (rel.includes("/")) {
      await mkdir(dirname(abs), { recursive: true });
    }
    await writeFile(abs, content, "utf8");
  }
  return dir;
}

const sha = (s: string): string =>
  createHash("sha256").update(s, "utf8").digest("hex");

// ---------------------------------------------------------------------------
// R-01: invalid --repeat 2 --interleave without --shuffle
//   E3-01 FIXED: CLI errors in preflight, 0 provider calls before the error.
// ---------------------------------------------------------------------------
describe("R-01: invalid interleave fails before provider call [FIXED]", () => {
  it("--repeat 2 --interleave without --shuffle: 0 provider calls before error", async () => {
    const root = await makeCaseDir({
      "cases/t1/request.md": "write a test file",
      "cases/t1/expected.md": "file written",
      "cases/t1/case.json": JSON.stringify({
        verification: [{ kind: "command", command: "echo ok" }],
      }),
    });

    const provider = new ScriptedModelProvider([
      ScriptedModelProvider.text("done"),
    ]);

    const res = await runBenchmarkCommand(
      [
        "--cases", join(root, "cases"),
        "--repeat", "2",
        "--interleave",
        "--out", join(root, "out"),
      ],
      provider,
    );

    // FIXED: error mentions interleave
    expect(res.exitCode).toBe(1);
    expect(res.lines.join("\n")).toContain("interleave");
    // FIXED: provider was NEVER called (preflight rejects before resolution)
    expect(provider.calls.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// R-02: one case, one arm, --repeat 2 → the historical bug ran 1 initial +
//   N repeats = 3 provider calls.  E3-02 FIXED: repeat=N means EXACTLY N
//   repetitions per case per arm → provider called exactly 2 times.
// ---------------------------------------------------------------------------
describe("R-02: repeat N+1 [FIXED]", () => {
  it("one case --repeat 2: provider called exactly 2 times (N repeats, no initial + N)", async () => {
    const root = await makeCaseDir({
      "cases/t1/request.md": "write a test file",
      "cases/t1/expected.md": "file written",
      "cases/t1/case.json": JSON.stringify({
        verification: [{ kind: "command", command: "echo ok" }],
      }),
    });

    const provider = new ScriptedModelProvider([
      ScriptedModelProvider.text("done"),
      ScriptedModelProvider.text("done"),
    ]);

    const res = await runBenchmarkCommand(
      [
        "--cases", join(root, "cases"),
        "--repeat", "2",
        "--out", join(root, "out"),
      ],
      provider,
    );

    // FIXED: exit 0 with exactly 2 provider calls (N=2 — no initial run + N).
    expect(res.exitCode).toBe(0);
    expect(provider.calls.length).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// R-03: paired plan BA pair → baseline.orderIndex=0, candidate.orderIndex=1
//   regardless of AB/BA order.  E3-02 FIXED: the orderIndex reflects the TRUE
//   pair order — BA pairs put the CANDIDATE first (lower orderIndex).
// ---------------------------------------------------------------------------
describe("R-03: BA orderIndex wrong [FIXED]", () => {
  it("BA pair has candidate.orderIndex < baseline.orderIndex (candidate executes first)", () => {
    const plan = buildPairedPlan({
      suite: "holdout",
      cases: ["c1", "c2"],
      repetitions: 2,
    });
    const baPairs = plan.pairs.filter((p) => p.order === "BA");
    expect(baPairs.length).toBeGreaterThan(0);
    for (const p of baPairs) {
      // FIXED: in a BA pair the candidate executes before the baseline, so
      // the candidate carries the lower orderIndex.
      expect(p.candidate.orderIndex).toBeLessThan(p.baseline.orderIndex);
    }
    // AB pairs keep the baseline first.
    for (const p of plan.pairs.filter((p) => p.order === "AB")) {
      expect(p.baseline.orderIndex).toBeLessThan(p.candidate.orderIndex);
    }
  });
});

// ---------------------------------------------------------------------------
// R-04: ArmFactory compare accepted undeclared delta.
//   Adding `undeclaredSecurityBypass=true` to candidate config previously
//   returned comparable=true, providerCallsAllowed=true because
//   declaredDeltaPaths defaulted to [candidate.id].  FIXED in E3-03: compare
//   now diff-snaps the ACTUAL harnessConfig and rejects any undeclared field
//   as UNDECLARED_ARM_DELTA (comparable=false, providerCallsAllowed=false).
// ---------------------------------------------------------------------------
describe("R-04: Arm undeclared delta bypass [FIXED in E3-03]", () => {
  it("candidate with undeclaredSecurityBypass=true still comparable", async () => {
    const { getArmFactory } = await import("@ar/evaluation");
    const factory = getArmFactory();
    const baseline = factory.resolveBaseline();
    const candidate = factory.resolveCandidate("adaptive_recovery_v2");

    // Inject undeclared field into the candidate's harnessConfig.
    const tampered = {
      ...candidate,
      harnessConfig: {
        ...candidate.harnessConfig,
        undeclaredSecurityBypass: true,
      },
    };
    const cmp = factory.compare(baseline, tampered);
    // FIXED (E3-03): undeclared config delta is UNDECLARED_ARM_DELTA —
    // comparable=false, providerCallsAllowed=false.
    expect(cmp.comparable).toBe(false);
    expect(cmp.providerCallsAllowed).toBe(false);
    expect(cmp.reasonCode).toBe("UNDECLARED_ARM_DELTA");
  });
});

// ---------------------------------------------------------------------------
// R-05: all-unknown provenance accepted as comparable and promotion-eligible.
//   compareProvenanceV3(baseline, candidate) — both have all-null/unknown
//   fields.  `same()` uses `String(b ?? "") === String(c ?? "")` → all
//   nulls match → no mismatches → comparable=true.  hasUnknownIdentity()
//   is NOT called inside compareProvenanceV3.  REPRODUCED.
// ---------------------------------------------------------------------------
function nullProvenance(armId: string): ExperimentProvenanceV3 {
  return {
    schemaVersion: "3.0.0",
    armId,
    candidateId: null,
    build: {
      gitSha: null, clean: null, sourceBundleDigest: null,
      lockfileDigest: null, buildOutputDigest: null,
      nodeVersion: null, pnpmVersion: null, os: null, arch: null,
      artifactSchemaVersion: "3.0.0", runnerVersion: null,
    },
    environment: {
      platform: null, nodeVersion: null, processArch: null,
      environmentContractHash: null,
    },
    provider: {
      providerType: null, modelId: null, endpointIdentity: null,
      temperature: null, topP: null, modelSeed: null,
      // Set modelSeedSupport to "supported" so the comparer doesn't add
      // MODEL_SEED_UNSUPPORTED — the defect is that all-null fields are
      // never detected as "unknown" (hasUnknownIdentity is NOT called).
      modelSeedSupport: "supported", maxTokens: null, timeoutMs: null,
      retryPolicyIdentity: null,
    },
    cases: [],
    protocol: {
      caseSetDigest: null, orderSeed: null, armOrder: null,
      repetitionCount: null, interleaveStrategy: null,
      retryIdentityRule: null, resumePlan: null, pairingKey: null,
      expectedCallCap: null,
    },
    finalSourceClean: null,
  };
}

describe("R-05: all-unknown provenance rejected [FIXED in E3-04]", () => {
  it("provenance with all null/unknown fields is NOT comparable / not promotion-eligible", () => {
    const b = nullProvenance("baseline");
    const c = nullProvenance("candidate");
    const cmp = compareProvenanceV3(b, c, { strict: true });
    // FIXED (E3-04): hasUnknownIdentity() is now called inside
    // compareProvenanceV3 — all-null identity is never promotion-eligible.
    expect(cmp.comparable).toBe(false);
    expect(cmp.promotionEligible).toBe(false);
    expect(cmp.reasonCodes).toContain("UNKNOWN_IDENTITY");
  });
});

// ---------------------------------------------------------------------------
// R-06: repetitions=2, perRepetitionDeltas=[] → decideChampionV3 returns
//   INVALID (E3-06: perRepetitionComplete gate).  FIXED.
// ---------------------------------------------------------------------------
describe("R-06: empty perRepetitionDeltas with repetitions=2 gives INVALID [FIXED in E3-06]", () => {
  it("decideChampionV3 rejects repetitions=2 and empty perRepetitionDeltas as INVALID", () => {
    const d = decideChampionV3({
      digestValid: true,
      pairComplete: true,
      comparable: true,
      incomparabilityReasons: [],
      activationCoverage: 1,
      activationEligibleCases: 6,
      minActivationEligibleCases: 3,
      minActivationCoverage: 0.5,
      securityBreachesCandidate: 0,
      securityBreachesBaseline: 0,
      baselineVerifiedRate: 0.8,
      candidateVerifiedRate: 0.9,
      maxVerifiedDrop: 0.05,
      infraFailuresBaseline: 0,
      infraFailuresCandidate: 0,
      cases: 6,
      netPassedDelta: 3,
      repetitions: 2,
      perRepetitionDeltas: [],
      minConclusiveNetDelta: 2,
      tokensDelta: 10000,
      maxTokensDelta: 100000,
      recommendsRepetition: false,
    });
    // FIXED (E3-06): perRepetitionComplete gate catches empty deltas.
    expect(d.decision).toBe("INVALID");
    expect(d.reasonCodes).toContain("PER_REPETITION_INCOMPLETE");
  });
});

// ---------------------------------------------------------------------------
// R-07: self-constructed PromotionEnvelope with arbitrary decision digest
//   and source SHA → strict loader accepts.  FIXED in E3-07: the envelope
//   must reference a REAL DecisionArtifactV3 (path + digest); a bare digest
//   string or forged artifact is rejected.
// ---------------------------------------------------------------------------
describe("R-07: forged envelope rejected [FIXED in E3-07]", () => {
  it("envelope with arbitrary decisionEnvelopeDigest/sourceSha and NO real decision artifact is rejected", async () => {
    const dir = await makeTemp();
    const artifactPath = join(dir, "artifact.json");

    const artifactContent = JSON.stringify({ key: "value" }, null, 2);
    await writeFile(artifactPath, artifactContent, "utf8");
    const artifactDigest = sha(artifactContent);

    const envelope = buildPromotionEnvelope({
      generatedBy: "attacker",
      decisionEnvelopeDigest: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      candidateId: "adaptive_recovery_v2",
      parentLevel: "C0",
      parentStateDigest: sha("C0"),
      // E3-07: references a decision artifact that does NOT exist.
      decisionArtifactPath: join(dir, "no-decision-artifact.json"),
      decisionArtifactDigest: "BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB",
      artifactRefs: [
        { role: "candidate", path: artifactPath, digest: artifactDigest },
      ],
      sourceSha: "1111111111111111111111111111111111111111",
      generatedAtIso: "2026-01-01T00:00:00.000Z",
    });

    const envelopePath = join(dir, "envelope.json");
    await writeFile(envelopePath, JSON.stringify(envelope, null, 2), "utf8");

    const result = await loadPromotionEnvelope(envelopePath, {
      parentStateDigest: sha("C0"),
      candidateId: "adaptive_recovery_v2",
    });

    // FIXED (E3-07): forged envelope rejected — missing decision artifact.
    expect(result.ok).toBe(false);
    expect(result.issues.some((i) => i.code === "DECISION_ARTIFACT_MISSING")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// R-08: two concurrent CAS writes based on same parent → exactly one wins.
//   FIXED in E3-07: compare + write happens INSIDE a cross-process lock, so
//   the second writer re-reads the advanced state and rejects with stale.
// ---------------------------------------------------------------------------
describe("R-08: concurrent CAS exactly one winner [FIXED in E3-07]", () => {
  it("two concurrent writeChampionStateFileCas on same parent -> exactly one ok", async () => {
    const dir = await makeTemp();
    const statePath = join(dir, "champion-state.json");

    const c0 = createInitialChampionState();
    await writeFile(statePath, JSON.stringify(c0, null, 2), "utf8");
    const c0Digest = championStateDigest(c0);

    // Two concurrent writes based on the same parent (C0).
    const results = await Promise.allSettled([
      writeChampionStateFileCas(
        { ...c0, level: "C1" as const, candidateId: "candidate-1", evidenceRef: "e1" } as any,
        c0Digest,
        statePath,
      ),
      writeChampionStateFileCas(
        { ...c0, level: "C1" as const, candidateId: "candidate-2", evidenceRef: "e2" } as any,
        c0Digest,
        statePath,
      ),
    ]);

    // FIXED (E3-07): the cross-process lock + in-lock re-read means exactly
    // one writer succeeds; the other sees the advanced state and returns stale.
    const okCount = results.filter(
      (r) => r.status === "fulfilled" && r.value.ok === true,
    ).length;
    const staleCount = results.filter(
      (r) => r.status === "fulfilled" && r.value.ok === false && r.value.stale === true,
    ).length;
    expect(okCount).toBe(1);
    expect(okCount + staleCount).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// R-09: summary tamper accepted — change passRate/tokens/recoveryRate but
//   keep caseCount/passed → strict loader accepts.  REPRODUCED.
// ---------------------------------------------------------------------------
describe("R-09: summary tamper rejected [FIXED in E3-04]", () => {
  it("tampered summary passRate/tokens/recoveryRate rejected by strict loader", async () => {
    const dir = await makeTemp();

    const outcome = (caseId: string, passed: boolean): CaseOutcomeV3 => ({
      caseId,
      suite: "regression",
      armId: "baseline",
      attempt: 1,
      repetition: 1,
      order: 1,
      passed,
      grade: passed ? "verified_complete" : "failed",
      verificationPassed: passed,
      terminationReason: "completed",
      failureCategory: null,
      inputTokens: 100,
      outputTokens: 50,
      costUsd: 0.001,
      latencyMs: 100,
      toolCalls: 2,
      recoveryDecisions: [],
      activationRef: null,
      securityOutcomeRef: null,
      outputDigest: null,
      workspaceDigest: null,
      judgeVersion: "1.0.0",
      evaluationContextHash: null,
      candidateConfigHash: null,
    });

    const artifact = buildExperimentArtifactV3({
      arm: {
        armId: "baseline",
        candidateId: null,
        candidateConfigHash: null,
      },
      manifest: { benchmarkVersion: "1.0.0" },
      outcomes: [outcome("c1", true), outcome("c2", true)],
      activationEvidence: [],
      securityOutcomes: [],
      provenance: {
        sourceManifestPath: null,
        gitSha: "abc",
        dirty: false,
        model: "scripted",
        provider: "scripted",
        runtimeConfigHash: sha("runtime"),
      },
    });

    const artifactPath = join(dir, "artifact.json");
    await writeFile(artifactPath, JSON.stringify(artifact, null, 2), "utf8");

    // Tamper: read, modify summary fields, write back.
    const raw = JSON.parse(await readFile(artifactPath, "utf8"));
    raw.summary.passRate = 0.99;
    raw.summary.totalTokensInput = 999999;
    raw.summary.totalTokensOutput = 9999999;
    raw.summary.recoveryRate = 0.99;
    // Keep caseCount and passed unchanged.
    raw.summary.caseCount = 2;
    raw.summary.passed = 2;
    // NOTE: summary is excluded from content digest (NON_DIGEST_KEYS).
    await writeFile(artifactPath, JSON.stringify(raw, null, 2), "utf8");

    // Load with strict loader.
    // FIXED (E3-04): the strict loader now validates ALL summary fields and
    // throws SUMMARY_MISMATCH on the tampered values.
    await expect(loadExperimentArtifactV3(artifactPath)).rejects.toThrow(/SUMMARY_MISMATCH/);
  });
});

// ---------------------------------------------------------------------------
// R-10: benchmark real exec writes case-workspace-absent absolute path.
//   FIXED in E3-09: a PROMOTION-grade benchmark (--candidate) requires a
//   strong OS isolation backend at preflight. On platforms without one
//   (Windows), the benchmark is REFUSED before any provider call — the
//   escape script never runs and no external file is created (fail-closed,
//   never a fake PASS). With a strong backend, exec is OS-confined so the
//   write cannot reach outside the workspace either way.
// ---------------------------------------------------------------------------
describe("R-10: benchmark exec writes outside workspace [FIXED in E3-09]", () => {
  it("promotion benchmark on a platform without strong isolation is REFUSED (no external file, 0 provider calls)", async () => {
    const outsideDir = await makeTemp();
    const escapePath = join(outsideDir, "escaped.txt");
    // Escape the path for a JS string literal in the script.
    const escapedScriptPath = escapePath.replace(/\\/g, "\\\\");

    // Create a case fixture that includes a small JS script in the fixture/ dir.
    const root = await makeCaseDir({
      "cases/t10/request.md": "Run a command to create a test file outside the workspace.",
      "cases/t10/expected.md": "File created.",
      "cases/t10/case.json": JSON.stringify({
        verification: [{ kind: "command", command: "echo ok" }],
      }),
      // Fixture files go in fixture/ subdirectory (loadBenchmarkCase reads
      // fixture/ from the case dir).
      "cases/t10/fixture/escape.js": `require('fs').writeFileSync('${escapedScriptPath}', 'pwned');`,
    });

    const provider = new ScriptedModelProvider([
      // Run the script from the workspace root (cwd is confined to workspace).
      ScriptedModelProvider.toolCall("exec", {
        command: "node escape.js",
      }),
      ScriptedModelProvider.text("done"),
    ]);

    // Promotion-grade run: --candidate triggers the E3-09 confinement
    // preflight. On a platform with no strong backend, the run is refused
    // before ANY provider call.
    const res = await runBenchmarkCommand(
      [
        "--cases", join(root, "cases"),
        "--candidate", "adaptive_recovery_v2",
        "--out", join(root, "out"),
      ],
      provider,
    );

    // FIXED: either the platform has a strong backend (exec OS-confined →
    // no external file) OR the promotion run is refused at preflight. In
    // BOTH cases the escape effect must not occur, and no provider call.
    // The escape file MUST NOT exist.
    await expect(stat(escapePath)).rejects.toBeDefined();

    // On a no-strong-backend platform (Windows/macOS without tooling) the
    // run is refused with a clear isolation reason and 0 provider calls.
    const output = res.lines.join("\n");
    if (output.includes("strong isolation backend")) {
      expect(res.exitCode).toBe(1);
      expect(provider.calls.length).toBe(0);
    } else {
      // Strong backend present: the run proceeds but the confined exec must
      // not have created the external file (prevention, not detection).
      expect(res.exitCode).toBe(0);
    }
  });
});

// ---------------------------------------------------------------------------
// R-11: AR2 real champion eval --strict → verified 0→0, grade ?, provenance
//   compatible, final INCONCLUSIVE not V3 INVALID.  FIXED in E3-06: strict
//   eval routes through the V3 bridge and legacy AR2 artifacts now fail
//   closed as INVALID / LEGACY_NOT_PROMOTION_ELIGIBLE.
// ---------------------------------------------------------------------------
describe("R-11: AR2 champion eval --strict now INVALID (E3-06 fix) [FIXED]", () => {
  it("historical AR2 champion eval --strict fails closed as INVALID / LEGACY_NOT_PROMOTION_ELIGIBLE", async () => {
    const baselinePath = "benchmarks/results/2026-08-31-deepseek-v4-flash-budget-aware/baseline-holdout.json";
    const candidatePath = "benchmarks/results/2026-09-01-deepseek-v4-flash-ar2/candidate-holdout.json";

    await expect(stat(baselinePath)).resolves.toBeDefined();
    await expect(stat(candidatePath)).resolves.toBeDefined();

    const { lines, decision } = await runChampionEval({
      baselinePath,
      candidatePath,
      mode: "real-model",
      strict: true,
      candidateId: "adaptive_recovery_v2",
    });

    // FIXED (E3-06): strict eval of legacy AR2 artifacts is INVALID —
    // legacy evidence can never be promoted.
    expect(decision).toBeDefined();
    expect(decision!.decision).toBe("INVALID");
    expect(decision!.reasonCode).toBe("LEGACY_NOT_PROMOTION_ELIGIBLE");

    // The output clearly states legacy artifacts cannot be promoted.
    const output = lines.join("\n");
    expect(output).toContain("LEGACY_NOT_PROMOTION_ELIGIBLE");
  });

  it("historical AR2 champion eval --historical stays descriptive-only (no promotion authority)", async () => {
    const baselinePath = "benchmarks/results/2026-08-31-deepseek-v4-flash-budget-aware/baseline-holdout.json";
    const candidatePath = "benchmarks/results/2026-09-01-deepseek-v4-flash-ar2/candidate-holdout.json";

    const { report, decision } = await runChampionEval({
      baselinePath,
      candidatePath,
      mode: "real-model",
      strict: false,
      historical: true,
      candidateId: "adaptive_recovery_v2",
    });

    // Historical path keeps the legacy paired report (descriptive only).
    expect(report.aggregated.cases).toBeGreaterThan(0);
    expect(decision).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// R-12: benchmark validate on historical AR2 → finds 32 cases, correctly
//   marks legacy / not-promotion-eligible.  FIXED (this improvement already
//   works in E2).
// ---------------------------------------------------------------------------
describe("R-12: benchmark validate on historical AR2 finds 32 cases [FIXED]", () => {
  it("benchmark validate on AR2 candidate dir finds 32 cases and marks legacy", async () => {
    const { runValidateBenchmarkArtifacts } = await import("./benchmark-command.js");
    const resultDir = "benchmarks/results/2026-09-01-deepseek-v4-flash-ar2";

    await expect(stat(resultDir)).resolves.toBeDefined();

    const res = await runValidateBenchmarkArtifacts([resultDir]);
    // FIXED: exit code 1 (INVALID — legacy artifact not promotion-eligible),
    // but the 32 cases are correctly detected and marked as legacy.
    expect(res.exitCode).toBe(1);
    const output = res.lines.join("\n");
    expect(output).toContain("32");
    expect(output).toContain("cases");
    expect(output).toContain("LEGACY_NOT_PROMOTION_ELIGIBLE");
  });
});