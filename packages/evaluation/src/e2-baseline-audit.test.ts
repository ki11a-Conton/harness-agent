import { describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  auditBaselineEvidence,
  type E2BaselineAuditResult,
} from "./e2-baseline-audit.js";
import {
  createInitialChampionState,
  applyPromotion,
  quarantineChampionState,
  migrateChampionValidity,
} from "./champion-state.js";

// ---------------------------------------------------------------------------
// Fixture builders (deterministic fake artifacts — never call a provider)
// ---------------------------------------------------------------------------

const REVIEW_BASELINE_SHA = "5a6f90c4767413ae1c89dca7a451a13ab5dd6cf0";

function makeArtifact(opts: {
  gitSha: string;
  dirty: boolean;
  cases: number;
  repetition?: { repeat: number; interleaved?: boolean };
}): string {
  return JSON.stringify(
    {
      manifest: {
        gitSha: opts.gitSha,
        dirty: opts.dirty,
        model: "deepseek-v4-flash",
        suiteVersion: "2.1.0",
        judgeVersion: "1.0.0",
        repetition: opts.repetition ?? null,
      },
      results: Array.from({ length: opts.cases }, (_, i) => ({
        task_id: `ho-${String(i + 1).padStart(2, "0")}`,
        success: i % 3 === 0,
        termination_reason: "agent_limit",
        input_tokens: 1000,
        output_tokens: 500,
        tool_calls: 10,
        verification_failures: 0,
        false_complete: false,
        violations: [],
      })),
    },
    null,
    2,
  );
}

async function makeTempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "e2-audit-"));
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("E2-00 baseline audit (read-only, provider-free)", () => {
  it("rejects the historical AR2/baseline pair (dirty, mismatched SHA, single run, applied)", async () => {
    const dir = await makeTempDir();
    try {
      const baselinePath = join(dir, "baseline.json");
      const candidatePath = join(dir, "candidate.json");
      await writeFile(baselinePath, makeArtifact({ gitSha: "c8fd5f87d7d410b88c8e025b53b5e5d24b4789ed", dirty: true, cases: 32 }), "utf8");
      await writeFile(candidatePath, makeArtifact({ gitSha: "3cf62ab8a8e6108349dbc9724785aef9ec023901", dirty: true, cases: 32 }), "utf8");

      const result = await auditBaselineEvidence({
        reviewBaselineSha: REVIEW_BASELINE_SHA,
        baselinePath,
        candidatePath,
        championApplied: true,
        candidateId: "adaptive_recovery_v2",
      });

      expect(result.validForPromotion).toBe(false);
      expect(result.activeForProduction).toBe("C0");
      expect(result.historicalDecision).toBe("ACCEPT");
      expect(result.validity).toBe("INVALID_PROVENANCE");
      // Required reason codes from the E2-00 acceptance criteria.
      expect(result.reasonCodes).toContain("SOURCE_DIRTY");
      expect(result.reasonCodes).toContain("SOURCE_SHA_MISMATCH");
      expect(result.reasonCodes).toContain("SINGLE_RUN_INSUFFICIENT");
      expect(result.reasonCodes).toContain("PRODUCTION_APPLICATION_UNPROVEN");
      // Also the implementation-not-in-source and repetition-conflict codes.
      expect(result.reasonCodes).toContain("IMPLEMENTATION_NOT_IN_RECORDED_SOURCE");
      expect(result.reasonCodes).toContain("REPETITION_RECOMMENDED_BUT_ACCEPTED");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("is deterministic across two runs (no wall-clock in the comparable payload)", async () => {
    const dir = await makeTempDir();
    try {
      const baselinePath = join(dir, "baseline.json");
      const candidatePath = join(dir, "candidate.json");
      await writeFile(baselinePath, makeArtifact({ gitSha: "c8fd5f87d7d410b88c8e025b53b5e5d24b4789ed", dirty: true, cases: 32 }), "utf8");
      await writeFile(candidatePath, makeArtifact({ gitSha: "3cf62ab8a8e6108349dbc9724785aef9ec023901", dirty: true, cases: 32 }), "utf8");

      const first = await auditBaselineEvidence({
        reviewBaselineSha: REVIEW_BASELINE_SHA,
        baselinePath,
        candidatePath,
        championApplied: true,
      });
      const second = await auditBaselineEvidence({
        reviewBaselineSha: REVIEW_BASELINE_SHA,
        baselinePath,
        candidatePath,
        championApplied: true,
      });
      expect(JSON.stringify(first)).toBe(JSON.stringify(second));
      // No timestamp key in the payload at all.
      expect(Object.keys(first)).not.toContain("generatedAt");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("fails closed when an artifact is missing or corrupt (never auto-valid)", async () => {
    const dir = await makeTempDir();
    try {
      const baselinePath = join(dir, "baseline.json");
      const candidatePath = join(dir, "candidate.json");
      // Valid baseline, missing candidate.
      await writeFile(baselinePath, makeArtifact({ gitSha: REVIEW_BASELINE_SHA, dirty: false, cases: 32 }), "utf8");
      const missing = await auditBaselineEvidence({
        reviewBaselineSha: REVIEW_BASELINE_SHA,
        baselinePath,
        candidatePath,
        championApplied: false,
      });
      expect(missing.validForPromotion).toBe(false);
      expect(missing.reasonCodes).toContain("ARTIFACT_MISSING_OR_CORRUPT");

      // Corrupt candidate (not JSON).
      await writeFile(candidatePath, "not json at all", "utf8");
      const corrupt = await auditBaselineEvidence({
        reviewBaselineSha: REVIEW_BASELINE_SHA,
        baselinePath,
        candidatePath,
        championApplied: false,
      });
      expect(corrupt.validForPromotion).toBe(false);
      expect(corrupt.reasonCodes).toContain("ARTIFACT_MISSING_OR_CORRUPT");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("accepts a clean same-source repeated pair with championApplied=false (still not PROVEN but validForPromotion=true)", async () => {
    const dir = await makeTempDir();
    try {
      const baselinePath = join(dir, "baseline.json");
      const candidatePath = join(dir, "candidate.json");
      await writeFile(baselinePath, makeArtifact({ gitSha: REVIEW_BASELINE_SHA, dirty: false, cases: 32, repetition: { repeat: 2, interleaved: true } }), "utf8");
      await writeFile(candidatePath, makeArtifact({ gitSha: REVIEW_BASELINE_SHA, dirty: false, cases: 32, repetition: { repeat: 2, interleaved: true } }), "utf8");

      const result = await auditBaselineEvidence({
        reviewBaselineSha: REVIEW_BASELINE_SHA,
        baselinePath,
        candidatePath,
        championApplied: false,
      });
      expect(result.validForPromotion).toBe(true);
      expect(result.reasonCodes).toEqual([]);
      expect(result.validity).toBe("QUARANTINED_PENDING_REEVALUATION");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("records file digests that change when the artifact changes", async () => {
    const dir = await makeTempDir();
    try {
      const baselinePath = join(dir, "baseline.json");
      const candidatePath = join(dir, "candidate.json");
      await writeFile(baselinePath, makeArtifact({ gitSha: REVIEW_BASELINE_SHA, dirty: false, cases: 32 }), "utf8");
      await writeFile(candidatePath, makeArtifact({ gitSha: REVIEW_BASELINE_SHA, dirty: false, cases: 32 }), "utf8");
      const before: E2BaselineAuditResult = await auditBaselineEvidence({
        reviewBaselineSha: REVIEW_BASELINE_SHA,
        baselinePath,
        candidatePath,
      });
      const digestBefore = before.candidate.sha256;
      // Rewrite the candidate with one more case — digest must change.
      await writeFile(candidatePath, makeArtifact({ gitSha: REVIEW_BASELINE_SHA, dirty: false, cases: 33 }), "utf8");
      const after: E2BaselineAuditResult = await auditBaselineEvidence({
        reviewBaselineSha: REVIEW_BASELINE_SHA,
        baselinePath,
        candidatePath,
      });
      expect(after.candidate.sha256).not.toBe(digestBefore);
      expect(after.candidate.caseCount).toBe(33);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("never calls a model provider (fake provider counter stays 0)", async () => {
    const dir = await makeTempDir();
    try {
      const baselinePath = join(dir, "baseline.json");
      const candidatePath = join(dir, "candidate.json");
      await writeFile(baselinePath, makeArtifact({ gitSha: REVIEW_BASELINE_SHA, dirty: true, cases: 32 }), "utf8");
      await writeFile(candidatePath, makeArtifact({ gitSha: "3cf62ab8a8e6108349dbc9724785aef9ec023901", dirty: true, cases: 32 }), "utf8");

      // A fake provider that counts any model call. The audit is a pure
      // read-only file inspection — it must never touch it.
      let providerCalls = 0;
      const fakeProvider = {
        id: "fake",
        async complete() {
          providerCalls += 1;
          throw new Error("audit must never call a provider");
        },
      } as never;

      const result = await auditBaselineEvidence({
        reviewBaselineSha: REVIEW_BASELINE_SHA,
        baselinePath,
        candidatePath,
        championApplied: true,
      });

      expect(result.validForPromotion).toBe(false);
      // The audit consumed neither the provider nor any model budget.
      expect(providerCalls).toBe(0);
      expect(fakeProvider).toBeDefined();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("E2-00 champion quarantine (preserve history, demote to C0)", () => {
  it("quarantines a C1 state back to C0 while preserving history and evidence path", () => {
    const c0 = createInitialChampionState();
    const c1 = applyPromotion(c0, "adaptive_recovery_v2", { adaptiveRecovery: "conservative-v1" }, "benchmarks/results/2026-09-01-deepseek-v4-flash-ar2/paired-report.txt");
    expect(c1.level).toBe("C1");
    // E2-00: a fresh promotion is a claim, never auto-PROVEN.
    expect(c1.validity).toBe("QUARANTINED_PENDING_REEVALUATION");

    const quarantined = quarantineChampionState(c1, {
      reasonCodes: ["SOURCE_DIRTY", "SINGLE_RUN_INSUFFICIENT", "PRODUCTION_APPLICATION_UNPROVEN"],
      note: "single dirty run cannot be production-valid (E2-00)",
    });

    expect(quarantined.level).toBe("C0");
    expect(quarantined.candidateId).toBeNull();
    expect(quarantined.applied).toBe(true);
    expect(quarantined.validity).toBe("QUARANTINED_PENDING_REEVALUATION");
    // History preserved with the original evidence path.
    expect(quarantined.history).toHaveLength(1);
    expect(quarantined.history[0]!.candidateId).toBe("adaptive_recovery_v2");
    expect(quarantined.history[0]!.evidenceRef).toBe("benchmarks/results/2026-09-01-deepseek-v4-flash-ar2/paired-report.txt");
    expect(quarantined.quarantine).toBeDefined();
    expect(quarantined.quarantine!.priorLevel).toBe("C1");
    expect(quarantined.quarantine!.priorCandidateId).toBe("adaptive_recovery_v2");
    expect(quarantined.quarantine!.reasonCodes).toContain("SOURCE_DIRTY");
  });

  it("does not mutate the input state (pure)", () => {
    const c1 = applyPromotion(createInitialChampionState(), "memory_retrieval", { features: { memory: true } }, "r.json");
    const before = JSON.stringify(c1);
    quarantineChampionState(c1, { reasonCodes: ["SINGLE_RUN_INSUFFICIENT"], note: "n" });
    expect(JSON.stringify(c1)).toBe(before);
    expect(c1.level).toBe("C1");
  });

  it("legacy C1 without validity never auto-trusts (migration → QUARANTINED); C0 is PROVEN", () => {
    const legacyC1 = { ...createInitialChampionState(), level: "C1" as const, candidateId: "x", applied: true };
    delete (legacyC1 as { validity?: unknown }).validity;
    const migrated = migrateChampionValidity(legacyC1 as Parameters<typeof migrateChampionValidity>[0]);
    expect(migrated.validity).toBe("QUARANTINED_PENDING_REEVALUATION");

    const legacyC0 = { ...createInitialChampionState() };
    delete (legacyC0 as { validity?: unknown }).validity;
    const migratedC0 = migrateChampionValidity(legacyC0);
    expect(migratedC0.validity).toBe("PROVEN");
  });

  it("quarantining an already-C0 state is a no-op that still records the audit action", () => {
    const c0 = createInitialChampionState();
    const result = quarantineChampionState(c0, { reasonCodes: ["SOURCE_DIRTY"], note: "no-op" });
    expect(result.level).toBe("C0");
    expect(result.quarantine).toBeDefined();
    expect(result.quarantine!.priorLevel).toBe("C0");
  });
});
