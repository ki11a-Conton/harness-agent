import { describe, expect, it } from "vitest";
import { mkdtemp, mkdir, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildExperimentArtifactV3,
  deriveSummaryV3,
  writeExperimentArtifactV3,
  loadExperimentArtifactV3,
  loadLegacyArtifact,
  discoverArtifactFiles,
  validateArtifactDir,
  classifyArtifact,
  parseExperimentArtifactV3,
  ArtifactSchemaError,
  computeContentDigestV3,
  type CaseOutcomeV3,
  type ExperimentArtifactV3Input,
} from "./index.js";

function makeOutcome(overrides: Partial<CaseOutcomeV3> = {}): CaseOutcomeV3 {
  return {
    caseId: "ho-01",
    suite: "holdout",
    armId: "baseline",
    attempt: 1,
    repetition: 1,
    order: 1,
    passed: true,
    grade: "good",
    verificationPassed: true,
    terminationReason: "verified_complete",
    failureCategory: null,
    inputTokens: 1000,
    outputTokens: 500,
    costUsd: 0.01,
    latencyMs: 100,
    toolCalls: 5,
    recoveryDecisions: [],
    activationRef: null,
    securityOutcomeRef: null,
    outputDigest: "abc",
    workspaceDigest: "def",
    judgeVersion: "1.0.0",
    evaluationContextHash: "ctx1",
    candidateConfigHash: null,
    ...overrides,
  };
}

function makeInput(overrides: Partial<ExperimentArtifactV3Input> = {}): ExperimentArtifactV3Input {
  return {
    arm: { armId: "baseline", candidateId: null, candidateConfigHash: null },
    manifest: { suiteVersion: "2.1.0", judgeVersion: "1.0.0", gitSha: "abc123", dirty: false },
    outcomes: [
      makeOutcome({ caseId: "ho-01", order: 1 }),
      makeOutcome({ caseId: "ho-02", order: 2, passed: false, terminationReason: "agent_limit", failureCategory: "model", grade: null, verificationPassed: false }),
    ],
    provenance: { sourceManifestPath: null, gitSha: "abc123", dirty: false, model: "deepseek-v4-flash", provider: "openai", runtimeConfigHash: "cfg" },
    ...overrides,
  };
}

async function makeTempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "e2-v3-"));
}

describe("E2-01 artifact-v3 schema", () => {
  it("classifies V3 vs legacy vs unknown (no loose cast)", () => {
    const v3 = buildExperimentArtifactV3(makeInput());
    const raw = JSON.parse(JSON.stringify(v3)) as unknown;
    expect(classifyArtifact(raw).kind).toBe("v3");
    expect(classifyArtifact(raw).promotionEligible).toBe(true);

    expect(classifyArtifact({ results: [] }).kind).toBe("legacy-report-object");
    expect(classifyArtifact({ results: [] }).promotionEligible).toBe(false);
    expect(classifyArtifact([]).kind).toBe("unknown");
    expect(classifyArtifact({ schemaVersion: "2.0.0", results: [] }).kind).toBe("unknown");
    expect(classifyArtifact(null).kind).toBe("unknown");
  });
});

describe("E2-01 writer -> strict loader round-trip", () => {
  it("production writer builds V3; strict loader reads all fields intact", async () => {
    const dir = await makeTempDir();
    try {
      const path = join(dir, "baseline-holdout.json");
      const artifact = buildExperimentArtifactV3(makeInput());
      await writeExperimentArtifactV3(artifact, path);

      const loaded = await loadExperimentArtifactV3(path);
      expect(loaded.artifact.schemaVersion).toBe("3.0.0");
      expect(loaded.artifact.outcomes).toHaveLength(2);
      expect(loaded.artifact.outcomes[0]).toEqual(artifact.outcomes[0]);
      expect(loaded.artifact.outcomes[1]!.grade).toBeNull();
      expect(loaded.artifact.outcomes[1]!.terminationReason).toBe("agent_limit");
      expect(loaded.artifact.summary.caseCount).toBe(2);
      expect(loaded.artifact.summary.passed).toBe(1);
      expect(loaded.recomputedSummary).toEqual(artifact.summary);
      // Round-trip equality of the full canonical payload.
      expect(loaded.artifact).toEqual(artifact);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("unknown schemaVersion fails closed (strict load)", async () => {
    const dir = await makeTempDir();
    try {
      const path = join(dir, "x.json");
      const artifact = buildExperimentArtifactV3(makeInput());
      const tampered = { ...artifact, schemaVersion: "4.0.0" };
      await writeFile(path, JSON.stringify(tampered), "utf8");
      await expect(loadExperimentArtifactV3(path)).rejects.toThrow(/UNSUPPORTED_SCHEMA_VERSION/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("schema version mismatch on the whole artifact is caught by parse", () => {
    const artifact = buildExperimentArtifactV3(makeInput());
    const tampered = { ...artifact, schemaVersion: "2.0.0" };
    expect(() => parseExperimentArtifactV3(tampered)).toThrow(ArtifactSchemaError);
  });
});

describe("E2-01 strict loader fail-closed scenarios", () => {
  it("content digest tampering -> CONTENT_DIGEST_MISMATCH", async () => {
    const dir = await makeTempDir();
    try {
      const path = join(dir, "candidate-holdout.json");
      const artifact = buildExperimentArtifactV3(makeInput());
      await writeExperimentArtifactV3(artifact, path);
      // Tamper: change one outcome field after writing, keep the digest.
      const raw = JSON.parse(await readFile(path, "utf8")) as ExperimentArtifactV3Input & { outcomes: CaseOutcomeV3[] };
      raw.outcomes[0]!.inputTokens = 9999;
      await writeFile(path, JSON.stringify(raw), "utf8");
      await expect(loadExperimentArtifactV3(path)).rejects.toThrow(/CONTENT_DIGEST_MISMATCH/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("persisted summary tampering -> SUMMARY_MISMATCH (strict load rejects)", async () => {
    const dir = await makeTempDir();
    try {
      const path = join(dir, "baseline-holdout.json");
      const artifact = buildExperimentArtifactV3(makeInput());
      await writeExperimentArtifactV3(artifact, path);
      // Tamper the persisted summary (digest does not cover the summary, so
      // this is a pure SUMMARY_MISMATCH, distinct from outcome tampering).
      const raw = JSON.parse(await readFile(path, "utf8")) as { summary: { passed: number } };
      raw.summary.passed = 2;
      await writeFile(path, JSON.stringify(raw), "utf8");

      await expect(loadExperimentArtifactV3(path)).rejects.toThrow(/SUMMARY_MISMATCH/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("validator reports SUMMARY_MISMATCH on tampered summary", async () => {
    const dir = await makeTempDir();
    try {
      const path = join(dir, "baseline-holdout.json");
      const artifact = buildExperimentArtifactV3(makeInput());
      await writeExperimentArtifactV3(artifact, path);
      const raw = JSON.parse(await readFile(path, "utf8")) as { summary: { passed: number } };
      raw.summary.passed = 2;
      await writeFile(path, JSON.stringify(raw), "utf8");

      const result = await validateArtifactDir(dir);
      expect(result.ok).toBe(false);
      expect(result.errors.some((e) => e.code === "SUMMARY_MISMATCH")).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("duplicate case/arm/repetition key -> DUPLICATE_OUTCOME", async () => {
    const dir = await makeTempDir();
    try {
      const input = makeInput();
      // Force a duplicate key: same caseId/armId/attempt/repetition.
      const outcomes = [
        makeOutcome({ caseId: "ho-01", armId: "candidate", attempt: 1, repetition: 1, order: 1 }),
        makeOutcome({ caseId: "ho-01", armId: "candidate", attempt: 1, repetition: 1, order: 2 }),
      ];
      const artifact = buildExperimentArtifactV3({ ...input, outcomes, arm: { armId: "candidate", candidateId: "x", candidateConfigHash: "c" } });
      const path = join(dir, "candidate-holdout.json");
      await writeExperimentArtifactV3(artifact, path);
      // buildExperimentArtifactV3 does not dedupe; the schema parser rejects.
      const raw = JSON.parse(await readFile(path, "utf8")) as unknown;
      expect(() => parseExperimentArtifactV3(raw)).toThrow(/DUPLICATE_OUTCOME/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("outcome grade/termination removed -> strict load fails (not castable)", async () => {
    const dir = await makeTempDir();
    try {
      const path = join(dir, "x.json");
      const artifact = buildExperimentArtifactV3(makeInput());
      const raw = JSON.parse(JSON.stringify(artifact)) as { outcomes: Array<Record<string, unknown>> };
      delete raw.outcomes[0]!.grade;
      await writeFile(path, JSON.stringify(raw), "utf8");
      // The schema parser throws SCHEMA_VALIDATION_FAILED (missing required field).
      await expect(loadExperimentArtifactV3(path)).rejects.toThrow(/expected string, got undefined/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("E2-01 directory validator (F-04: no more '0 suites / 0 cases / VALID')", () => {
  it("empty directory -> NO_EXPERIMENT_ARTIFACTS, non-zero", async () => {
    const dir = await makeTempDir();
    try {
      const result = await validateArtifactDir(dir);
      expect(result.ok).toBe(false);
      expect(result.errors.some((e) => e.code === "NO_EXPERIMENT_ARTIFACTS")).toBe(true);
      expect(result.summary.cases).toBe(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("only README/markdown files -> NO_EXPERIMENT_ARTIFACTS", async () => {
    const dir = await makeTempDir();
    try {
      await writeFile(join(dir, "README.md"), "# readme", "utf8");
      await writeFile(join(dir, "summary.md"), "no json", "utf8");
      const result = await validateArtifactDir(dir);
      expect(result.ok).toBe(false);
      expect(result.errors.some((e) => e.code === "NO_EXPERIMENT_ARTIFACTS")).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("real legacy artifact dir is DISCOVERED (cases != 0) and marked legacy/not promotion-eligible", async () => {
    const dir = await makeTempDir();
    try {
      // Write a legacy report-object shape (like the real AR2 candidate-holdout.json).
      const legacy = {
        manifest: { gitSha: "3cf62ab", dirty: true, model: "deepseek-v4-flash" },
        results: [
          { task_id: "ho-01", suite: "holdout", success: true, termination_reason: "verified_complete", verified: true },
          { task_id: "ho-02", suite: "holdout", success: false, termination_reason: "agent_limit", verified: false },
        ],
        summary: { total: 2, passed: 1 },
      };
      await writeFile(join(dir, "candidate-holdout.json"), JSON.stringify(legacy), "utf8");

      const discovered = await discoverArtifactFiles(dir);
      expect(discovered).toHaveLength(1);

      const result = await validateArtifactDir(dir);
      // Discovered: cases != 0.
      expect(result.summary.cases).toBe(2);
      // Marked legacy, promotion NOT eligible, and directory is INVALID.
      expect(result.errors.some((e) => e.code === "LEGACY_NOT_PROMOTION_ELIGIBLE")).toBe(true);
      expect(result.ok).toBe(false);

      const legacyLoaded = await loadLegacyArtifact(discovered[0]!);
      expect(legacyLoaded.promotionEligible).toBe(false);
      expect(legacyLoaded.caseCount).toBe(2);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("V3 real artifact directory validates OK (writer-generated)", async () => {
    const dir = await makeTempDir();
    try {
      const path = join(dir, "baseline-holdout.json");
      await writeExperimentArtifactV3(buildExperimentArtifactV3(makeInput()), path);
      const result = await validateArtifactDir(dir);
      expect(result.ok).toBe(true);
      expect(result.summary.cases).toBe(2);
      expect(result.summary.suites).toBe(1);
      expect(result.errors).toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("E2-01 summary derivation + content digest determinism", () => {
  it("deriveSummaryV3 is a pure function of outcomes", () => {
    const a = deriveSummaryV3(makeInput().outcomes);
    const b = deriveSummaryV3(makeInput().outcomes);
    expect(a).toEqual(b);
    expect(a.caseCount).toBe(2);
    expect(a.passed).toBe(1);
    expect(a.failed).toBe(1);
    expect(a.suiteCount).toBe(1);
    expect(a.terminationReasons["verified_complete"]).toBe(1);
    expect(a.terminationReasons["agent_limit"]).toBe(1);
  });

  it("content digest is deterministic and self-excluding (no wall-clock)", () => {
    const a = buildExperimentArtifactV3(makeInput());
    const b = buildExperimentArtifactV3(makeInput());
    expect(a.contentDigest).toBe(b.contentDigest);
    // Digest differs when content differs.
    const c = buildExperimentArtifactV3(makeInput({ outcomes: [makeOutcome({ caseId: "ho-99" })] }));
    expect(c.contentDigest).not.toBe(a.contentDigest);
    // Recomputing from the full artifact (with digest field) yields the same
    // value because the canonical input strips the digest field.
    const { contentDigest, ...rest } = a;
    expect(computeContentDigestV3(rest)).toBe(contentDigest);
  });

  it("content digest excludes timestamps (non-deterministic fields)", () => {
    const withTs = buildExperimentArtifactV3(makeInput({ manifest: { timestamp: "2026-01-01T00:00:00Z", suiteVersion: "2.1.0" } }));
    const withTs2 = buildExperimentArtifactV3(makeInput({ manifest: { timestamp: "2026-02-02T00:00:00Z", suiteVersion: "2.1.0" } }));
    // Timestamp differs but digest is identical (timestamp excluded).
    expect(withTs.contentDigest).toBe(withTs2.contentDigest);
  });
});

describe("E2-01 field preservation table (deliverable)", () => {
  it("grade/verification/termination/manifest/activation/security all round-trip", async () => {
    const dir = await makeTempDir();
    try {
      const path = join(dir, "candidate-holdout.json");
      const outcome = makeOutcome({
        caseId: "ho-42",
        armId: "candidate",
        attempt: 2,
        repetition: 3,
        order: 7,
        passed: false,
        grade: "poor",
        verificationPassed: false,
        terminationReason: "verification_failed",
        failureCategory: "harness",
        inputTokens: 2222,
        outputTokens: 111,
        costUsd: 0.333,
        latencyMs: 4444,
        toolCalls: 9,
        recoveryDecisions: [
          { id: "recovery.decided", action: "retry_safe", budgetExhausted: false },
          { id: "recovery.decided", action: "change_strategy", budgetExhausted: true },
        ],
        activationRef: "ae-1",
        securityOutcomeRef: "sec-1",
        outputDigest: "out-digest-1",
        workspaceDigest: "ws-digest-1",
        judgeVersion: "9.9.9",
        evaluationContextHash: "eval-ctx-hash",
        candidateConfigHash: "cand-cfg-hash",
      });
      const artifact = buildExperimentArtifactV3({
        arm: { armId: "candidate", candidateId: "adaptive_recovery_v2", candidateConfigHash: "cand-cfg-hash" },
        manifest: { suiteVersion: "2.1.0", judgeVersion: "1.0.0", gitSha: "deadbeef", dirty: true, model: "deepseek-v4-flash", provider: "openai", runtimeConfigHash: "rt-hash" },
        outcomes: [outcome],
        activationEvidence: [{ id: "ae-1", reasonCodes: ["recovery_decision"], note: "recovery fired" }],
        securityOutcomes: [{ caseId: "ho-42", kind: "blocked", detail: "sandbox blocked write" }],
        provenance: { sourceManifestPath: "manifest.json", gitSha: "deadbeef", dirty: true, model: "deepseek-v4-flash", provider: "openai", runtimeConfigHash: "rt-hash" },
      });
      await writeExperimentArtifactV3(artifact, path);

      const loaded = await loadExperimentArtifactV3(path);
      const o = loaded.artifact.outcomes[0]!;
      // Decision-critical fields survive byte-for-byte.
      expect(o.grade).toBe("poor");
      expect(o.verificationPassed).toBe(false);
      expect(o.terminationReason).toBe("verification_failed");
      expect(o.failureCategory).toBe("harness");
      expect(o.attempt).toBe(2);
      expect(o.repetition).toBe(3);
      expect(o.order).toBe(7);
      expect(o.recoveryDecisions).toHaveLength(2);
      expect(o.recoveryDecisions[1]!.action).toBe("change_strategy");
      expect(o.recoveryDecisions[1]!.budgetExhausted).toBe(true);
      expect(o.activationRef).toBe("ae-1");
      expect(o.securityOutcomeRef).toBe("sec-1");
      expect(o.outputDigest).toBe("out-digest-1");
      expect(o.workspaceDigest).toBe("ws-digest-1");
      expect(o.judgeVersion).toBe("9.9.9");
      expect(o.evaluationContextHash).toBe("eval-ctx-hash");
      expect(o.candidateConfigHash).toBe("cand-cfg-hash");
      // Activation + security payloads round-trip.
      expect(loaded.artifact.activationEvidence[0]).toEqual(artifact.activationEvidence[0]);
      expect(loaded.artifact.securityOutcomes[0]).toEqual(artifact.securityOutcomes[0]);
      // Manifest + provenance + arm identity round-trip.
      expect(loaded.artifact.manifest).toEqual(artifact.manifest);
      expect(loaded.artifact.provenance).toEqual(artifact.provenance);
      expect(loaded.artifact.arm).toEqual(artifact.arm);
      // Full canonical equality.
      expect(loaded.artifact).toEqual(artifact);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});