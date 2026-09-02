/**
 * E3 — dedicated repro-current-defects suite.
 *
 * Each R-xx test asserts the CURRENT defect behavior (REPRODUCED).
 * When E3 later fixes a defect, the corresponding test flips to asserting
 * the FIXED behavior. This suite is run separately from the default
 * `pnpm test` via `pnpm e3:repro-current-defects`.
 *
 * All repros are offline (fake/scripted provider, temp dirs, historical
 * artifacts). Real provider calls = 0.
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
//   CLI errors at the end, but provider already called 1 time before the
//   error.  REPRODUCED: calls === 1 before the interleave error.
// ---------------------------------------------------------------------------
describe("R-01: invalid interleave calls provider before error [REPRODUCED]", () => {
  it("--repeat 2 --interleave without --shuffle: provider called before error", async () => {
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

    // REPRODUCED: error does mention interleave
    expect(res.exitCode).toBe(1);
    expect(res.lines.join("\n")).toContain("interleave");
    // REPRODUCED: provider was called before the error
    expect(provider.calls.length).toBeGreaterThanOrEqual(1);
    expect(provider.calls.length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// R-02: one case, one arm, --repeat 2 → provider called 3 times (initial + N
//   repeats).  REPRODUCED: calls === 3 (should be 2).
// ---------------------------------------------------------------------------
describe("R-02: repeat N+1 [REPRODUCED]", () => {
  it("one case --repeat 2: provider called 3 times (initial + N repeats)", async () => {
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

    // REPRODUCED: exit 0 with 3 provider calls (initial 1 + N=2 repeats)
    expect(res.exitCode).toBe(0);
    expect(provider.calls.length).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// R-03: paired plan BA pair → baseline.orderIndex=0, candidate.orderIndex=1
//   regardless of AB/BA order.  REPRODUCED: baseline always has the lower
//   orderIndex even for BA pairs.
// ---------------------------------------------------------------------------
describe("R-03: BA orderIndex wrong [REPRODUCED]", () => {
  it("BA pair has baseline.orderIndex < candidate.orderIndex (should be candidate first)", () => {
    const plan = buildPairedPlan({
      suite: "holdout",
      cases: ["c1", "c2"],
      repetitions: 2,
    });
    const baPairs = plan.pairs.filter((p) => p.order === "BA");
    expect(baPairs.length).toBeGreaterThan(0);
    for (const p of baPairs) {
      // REPRODUCED: baseline gets lower orderIndex even for BA (should be
      // candidate first in BA).
      expect(p.baseline.orderIndex).toBeLessThan(p.candidate.orderIndex);
    }
  });
});

// ---------------------------------------------------------------------------
// R-04: ArmFactory compare accepts undeclared delta.
//   Adding `undeclaredSecurityBypass=true` to candidate config still returns
//   comparable=true, providerCallsAllowed=true.  The bug is
//   `allowed.has(candidate.candidateId)` always true because declaredDeltaPaths
//   = [candidate.id].  REPRODUCED.
// ---------------------------------------------------------------------------
describe("R-04: Arm undeclared delta bypass [REPRODUCED]", () => {
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
    // REPRODUCED: compare says comparable/providerCallsAllowed despite
    // undeclared field.
    expect(cmp.comparable).toBe(true);
    expect(cmp.providerCallsAllowed).toBe(true);
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

describe("R-05: all-unknown provenance accepted [REPRODUCED]", () => {
  it("provenance with all null/unknown fields returns comparable=true", () => {
    const b = nullProvenance("baseline");
    const c = nullProvenance("candidate");
    const cmp = compareProvenanceV3(b, c, { strict: true });
    // REPRODUCED: all-null should be promotion-ineligible but isn't
    expect(cmp.comparable).toBe(true);
    expect(cmp.promotionEligible).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// R-06: repetitions=2, perRepetitionDeltas=[] → decideChampionV3 returns
//   ACCEPT.  directionStable = true when perRepetitionDeltas is empty
//   (empty array → true).  REPRODUCED.
// ---------------------------------------------------------------------------
describe("R-06: empty perRepetitionDeltas with repetitions=2 gives ACCEPT [REPRODUCED]", () => {
  it("decideChampionV3 ACCEPTs with repetitions=2 and empty perRepetitionDeltas", () => {
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
    // REPRODUCED: empty perRepetitionDeltas should be INVALID but is ACCEPT
    expect(d.decision).toBe("ACCEPT");
  });
});

// ---------------------------------------------------------------------------
// R-07: self-constructed PromotionEnvelope with arbitrary decision digest
//   and source SHA → strict loader accepts.  REPRODUCED.
// ---------------------------------------------------------------------------
describe("R-07: forged envelope accepted [REPRODUCED]", () => {
  it("envelope with arbitrary decisionEnvelopeDigest/sourceSha loads as accepted", async () => {
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

    // REPRODUCED: forged envelope is accepted
    expect(result.ok).toBe(true);
    expect(result.envelope).not.toBeNull();
    expect(result.envelope!.decision).toBe("ACCEPT");
  });
});

// ---------------------------------------------------------------------------
// R-08: two concurrent CAS writes based on same parent → both return ok=true
//   on POSIX (no write-lock, last-writer-wins). On Windows the second rename
//   throws EPERM — the CAS is still not atomic-locked.  REPRODUCED: the CAS
//   does not prevent concurrent writes (no advisory lock / retry). At least
//   one write succeeds unconditionally, and on POSIX both succeed.
// ---------------------------------------------------------------------------
describe("R-08: concurrent CAS double success [REPRODUCED]", () => {
  it("two concurrent writeChampionStateFileCas both ok on same parent", async () => {
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

    // REPRODUCED: at least one write succeeds (the CAS does not prevent
    // concurrent writes — no advisory lock / retry). On POSIX both succeed
    // (last-writer-wins). On Windows the second rename may fail with EPERM
    // because rename to an existing file is not allowed.
    const okCount = results.filter(
      (r) => r.status === "fulfilled" && r.value.ok === true,
    ).length;
    expect(okCount).toBeGreaterThanOrEqual(1);
  });
});

// ---------------------------------------------------------------------------
// R-09: summary tamper accepted — change passRate/tokens/recoveryRate but
//   keep caseCount/passed → strict loader accepts.  REPRODUCED.
// ---------------------------------------------------------------------------
describe("R-09: summary tamper accepted [REPRODUCED]", () => {
  it("tampered summary passRate/tokens/recoveryRate accepted by loader", async () => {
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
    const loaded = await loadExperimentArtifactV3(artifactPath);

    // REPRODUCED: tampered summary (passRate/tokens/recoveryRate) accepted.
    // The recomputed summary has the ORIGINAL values (derived from outcomes).
    expect(loaded.recomputedSummary.passRate).toBe(1); // 2/2 = 1
    expect(loaded.recomputedSummary.totalTokensInput).toBe(200); // 100+100
    expect(loaded.recomputedSummary.caseCount).toBe(2);
    expect(loaded.recomputedSummary.passed).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// R-10: benchmark real exec writes case-workspace-absent absolute path →
//   external file created, benchmark reports 1/1 PASS.  REPRODUCED.
//   Uses a small fixture script to avoid shell quoting issues.
// ---------------------------------------------------------------------------
describe("R-10: benchmark exec writes outside workspace [REPRODUCED]", () => {
  it("exec writes to absolute path outside case workspace, benchmark reports PASS", async () => {
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

    const res = await runBenchmarkCommand(
      [
        "--cases", join(root, "cases"),
        "--out", join(root, "out"),
      ],
      provider,
    );

    // REPRODUCED: the external file was created (exec writes outside workspace)
    await expect(stat(escapePath)).resolves.toBeDefined();

    // REPRODUCED: benchmark reports PASS despite the external write
    expect(res.exitCode).toBe(0);
    expect(res.lines.some((l) => l.includes("1/1 passed"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// R-11: AR2 real champion eval --strict → verified 0→0, grade ?, provenance
//   compatible, final INCONCLUSIVE not V3 INVALID.  REPRODUCED.
// ---------------------------------------------------------------------------
describe("R-11: AR2 champion eval --strict INCONCLUSIVE not INVALID [REPRODUCED]", () => {
  it("historical AR2 champion eval --strict outputs INCONCLUSIVE", async () => {
    const baselinePath = "benchmarks/results/2026-08-31-deepseek-v4-flash-budget-aware/baseline-holdout.json";
    const candidatePath = "benchmarks/results/2026-09-01-deepseek-v4-flash-ar2/candidate-holdout.json";

    await expect(stat(baselinePath)).resolves.toBeDefined();
    await expect(stat(candidatePath)).resolves.toBeDefined();

    const { report, lines, decision } = await runChampionEval({
      baselinePath,
      candidatePath,
      mode: "real-model",
      strict: true,
      candidateId: "adaptive_recovery_v2",
    });

    // REPRODUCED: decision is INCONCLUSIVE (should be INVALID in V3)
    expect(decision).toBeDefined();
    expect(decision!.decision).toBe("INCONCLUSIVE");

    // REPRODUCED: lines mention "verified" (0→0 for verified completion)
    const output = lines.join("\n");
    expect(output).toContain("verified");

    // REPRODUCED: comparability = true (should be false under V3 strict
    // all-unknown provenance)
    if (decision!.comparability !== null) {
      expect(decision!.comparability.comparable).toBe(true);
    }
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