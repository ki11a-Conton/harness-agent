/**
 * E4-R03 — the two arms must equal the CONFIRMED PLAN's full sample grid, not
 * merely each other.
 *
 * F05: plan requires a/b/c/d × 2 repetitions; both arms only delivered
 * a/1, b/1, c/2, d/2. The arms match each other exactly, so the old evaluator
 * scored pairComplete=true and ACCEPT — but half the grid was never measured.
 * With `expectedSampleKeys` carried in the V3 manifest (E4-R01), the evaluator
 * must reject a grid that is not exactly the confirmed one (INVALID).
 */

import { describe, expect, it } from "vitest";
import { buildExperimentArtifactV3 } from "./artifact-v3/index.js";
import { deriveV3Decision, loadV3ArtifactPair, type V3ArtifactPair } from "./champion-eval-v3.js";
import { DEFAULT_DECISION_POLICY_V3, computeThresholdDigestV3 } from "./decision-policy-v3.js";
import { fixtureExecutionPlan, fixtureExecutionPlanDigest } from "./fixtures.js";
import type { CaseOutcomeV3 } from "./artifact-v3/index.js";

const PLAN_ARGS = { suite: "holdout", caseIds: ["a", "b", "c", "d"], repeat: 2 };
const EXECUTION_PLAN = fixtureExecutionPlan(PLAN_ARGS);
const PLAN = fixtureExecutionPlanDigest(PLAN_ARGS);
const policy0 = () => ({ computeThresholdDigestV3, DEFAULT_DECISION_POLICY_V3 });

function outcome(caseId: string, rep: number, armId: "baseline" | "candidate"): CaseOutcomeV3 {
  return {
    caseId, suite: "holdout", armId, attempt: 1, repetition: rep, order: rep,
    passed: true, grade: "good", terminationReason: "verified_complete",
    verificationPassed: true, failureCategory: null,
    inputTokens: 1000, outputTokens: 500, costUsd: 0.01, latencyMs: 100, toolCalls: 3,
    recoveryDecisions: [], activationRef: armId === "candidate" ? "act" : null,
    // E4-R14 (N08): every sample carries a RESOLVING security evidence record.
    securityOutcomeRef: `holdout\u0000${caseId}\u0000${rep}\u0000${armId}`,
    outputDigest: null, workspaceDigest: null, judgeVersion: "1.0.0",
    evaluationContextHash: "a".repeat(64), candidateConfigHash: armId === "candidate" ? "b".repeat(64) : null,
  } as unknown as CaseOutcomeV3;
}

/** Expected grid: cases a,b,c,d × reps 1,2 → 8 keys. */
const EXPECTED_KEYS = (() => {
  const keys: string[] = [];
  for (const c of ["a", "b", "c", "d"]) for (const rep of [1, 2]) keys.push(`holdout\u0000${c}\u0000${rep}`);
  return keys;
})();

function armArtifact(armId: "baseline" | "candidate", rows: Array<[string, number]>, manifestExtra: Record<string, unknown> = {}) {
  const { computeThresholdDigestV3, DEFAULT_DECISION_POLICY_V3 } = policy0();
  return buildExperimentArtifactV3({
    arm: { armId, candidateId: armId === "candidate" ? "cand-x" : null, candidateConfigHash: armId === "candidate" ? "b".repeat(64) : null },
    manifest: {
      suiteVersion: "2.1.0", judgeVersion: "1.0.0", gitSha: "c".repeat(40), dirty: false,
      planDigest: PLAN, promotionEligible: true, isolationStrength: "strong",
      expectedSampleKeys: EXPECTED_KEYS, runComplete: true,
      // E4-R13/R14: the confirmed plan is REQUIRED for promotion-eligible
      // artifacts — the fixture carries the same identity the writer preserves.
      // E4-R22 (F02): the COMPLETE protocol plan, digest-bound to planDigest.
      executionPlan: EXECUTION_PLAN,
      thresholdDigest: computeThresholdDigestV3(DEFAULT_DECISION_POLICY_V3),
      ...manifestExtra,
    },
    outcomes: rows.map(([caseId, rep]) => outcome(caseId, rep, armId)),
    activationEvidence: armId === "candidate" ? [{ id: "act", reasonCodes: ["memory.retrieved"], note: "x" }] : [],
    securityOutcomes: rows.map(([caseId, rep]) => ({
      caseId: `holdout\u0000${caseId}\u0000${rep}\u0000${armId}`,
      kind: "clean" as const,
      detail: "no attack attempted (fixture)",
    })),
    provenance: { sourceManifestPath: "m.json", gitSha: "c".repeat(40), dirty: false, model: "m", provider: "fake", runtimeConfigHash: "e".repeat(64) },
  });
}

describe("E4-R03 plan-required sample grid (F05)", () => {
  it("control: both arms deliver the FULL 8-key grid -> decision derived", () => {
    const full: Array<[string, number]> = [];
    for (const c of ["a", "b", "c", "d"]) for (const rep of [1, 2]) full.push([c, rep]);
    const pair: V3ArtifactPair = {
      baseline: armArtifact("baseline", full),
      candidate: armArtifact("candidate", full),
      baselineDigest: "0".repeat(64),
      candidateDigest: "0".repeat(64),
    };
    const r = deriveV3Decision(pair, "cand-x", PLAN);
    expect(r.decisionArtifact.decision).not.toBe("INVALID");
  });

  it("F05: both arms equal each other but missing half the confirmed grid -> INVALID", () => {
    const partial: Array<[string, number]> = [["a", 1], ["b", 1], ["c", 2], ["d", 2]];
    const pair: V3ArtifactPair = {
      baseline: armArtifact("baseline", partial),
      candidate: armArtifact("candidate", partial),
      baselineDigest: "0".repeat(64),
      candidateDigest: "0".repeat(64),
    };
    const r = deriveV3Decision(pair, "cand-x", PLAN);
    expect(r.decisionArtifact.decision).toBe("INVALID");
    // The pairing violations name the grid gap explicitly.
    const violations = (r.derivedInputs as { pairingViolations?: string[] }).pairingViolations ?? [];
    expect(violations.some((v) => /grid|missing|unplanned/i.test(v))).toBe(true);
  });

  it("F05: an EXTRA sample beyond the confirmed grid is also INVALID", () => {
    const extra: Array<[string, number]> = [["a", 1], ["b", 1], ["c", 2], ["d", 2], ["e", 1]];
    const pair: V3ArtifactPair = {
      baseline: armArtifact("baseline", extra),
      candidate: armArtifact("candidate", extra),
      baselineDigest: "0".repeat(64),
      candidateDigest: "0".repeat(64),
    };
    const r = deriveV3Decision(pair, "cand-x", PLAN);
    expect(r.decisionArtifact.decision).toBe("INVALID");
  });

  it("no manifest grid -> old behavior (pairing self-consistency only), never a false PASS", () => {
    const partial: Array<[string, number]> = [["a", 1], ["b", 1], ["c", 2], ["d", 2]];
    const pair: V3ArtifactPair = {
      baseline: armArtifact("baseline", partial, { expectedSampleKeys: undefined }),
      candidate: armArtifact("candidate", partial, { expectedSampleKeys: undefined }),
      baselineDigest: "0".repeat(64),
      candidateDigest: "0".repeat(64),
    };
    const r = deriveV3Decision(pair, "cand-x", PLAN);
    // Without a declared grid, completeness is unprovable and the plan forbids a
    // silent fallback to mutable defaults: this partial set must NOT ACCEPT.
    expect(r.decisionArtifact.decision).not.toBe("ACCEPT");
  });

  it("round-trips through the strict file loader and still rejects the partial grid", async () => {
    const { mkdtemp, rm, writeFile } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = await mkdtemp(join(tmpdir(), "r03-grid-"));
    try {
      const partial: Array<[string, number]> = [["a", 1], ["b", 1], ["c", 2], ["d", 2]];
      const b = join(dir, "b.json"); const c = join(dir, "c.json");
      const { writeExperimentArtifactV3 } = await import("./artifact-v3/index.js");
      await writeExperimentArtifactV3(armArtifact("baseline", partial), b);
      await writeExperimentArtifactV3(armArtifact("candidate", partial), c);
      const pair = await loadV3ArtifactPair(b, c);
      const r = deriveV3Decision(pair, "cand-x", PLAN);
      expect(r.decisionArtifact.decision).toBe("INVALID");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
