/**
 * E4-R02 — F04: same case, two repetitions, two DIFFERENT security outcomes must
 * BOTH be preserved in the V3 artifact, each referenced by its own outcome.
 */

import { describe, expect, it } from "vitest";
import { buildV3ArtifactsFromPaired, type PairedV3Facts } from "./paired-v3-builder.js";
import type { PairedFinalizedPair } from "./paired-executor.js";
import type { EvalOutcome } from "./runner.js";
import type { SecurityOutcomeV2 } from "./security-outcome-v2.js";

function secOutcome(kind: SecurityOutcomeV2["kind"]): SecurityOutcomeV2 {
  return {
    schemaVersion: "1.0.0", caseId: "ho-01", armId: "candidate", kind,
    facts: kind === "ESCAPE" ? [{ factId: "f1", type: "unauthorized_escape", caseId: "ho-01", armId: "candidate", toolCallId: "c1" }] : [],
    hardBreach: kind === "ESCAPE",
    expectation: { expectedAttack: true, expectedDenial: true },
  } as unknown as SecurityOutcomeV2;
}

function sample(armId: "baseline" | "candidate", sec: SecurityOutcomeV2 | undefined): EvalOutcome {
  return {
    caseId: "ho-01", suite: "adversarial", armId, status: "passed", actualStatus: "completed",
    events: [], violations: [], judgeVersion: "1.0.0",
    securityOutcome: sec,
    metrics: {
      turn_count: 1, tool_call_count: 0, tokens_input: 10, tokens_output: 5, context_tokens: 0,
      compaction_count: 0, duration_ms: 1, retry_count: 0, verification_failures: 0, human_interventions: 0,
      estimated_cost: 0, usage_unknown: 0, cache_tokens_read: 0, cache_tokens_created: 0, model_call_count: 1,
    },
  } as unknown as EvalOutcome;
}

function pair(rep: number, candidateSec: SecurityOutcomeV2 | undefined): PairedFinalizedPair {
  const mk = (armId: "baseline" | "candidate", o: EvalOutcome) => ({
    arm: { armId, caseId: "ho-01", repetition: rep },
    valid: true, outcome: o, modelCallAttempts: 1, transportRetries: 0,
  });
  return {
    pairId: "p-" + rep, caseId: "ho-01", repetition: rep, order: "AB",
    baseline: mk("baseline", sample("baseline", undefined)),
    candidate: mk("candidate", sample("candidate", candidateSec)),
  } as unknown as PairedFinalizedPair;
}

const FACTS = {
  planDigest: "c".repeat(64), gitSha: "d".repeat(40), dirty: false, model: "m", provider: "fake",
  runtimeConfigHash: "e".repeat(64), suiteVersion: "2.1.0", judgeVersion: "1.0.0",
  candidateId: "cand-x", candidateConfigHash: "b".repeat(64), isolationStrength: "strong", promotionEligible: true,
} as PairedV3Facts;

describe("E4-R02 security outcomes are per-sample (F04)", () => {
  it("two repetitions of one case keep BOTH records, each referenced by its own outcome", () => {
    const { candidate } = buildV3ArtifactsFromPaired(
      [pair(0, secOutcome("ESCAPE")), pair(1, secOutcome("NO_ATTACK_ATTEMPT"))], FACTS,
    );
    const escaped = candidate.securityOutcomes.find((s) => s.kind === "escaped");
    const clean = candidate.securityOutcomes.find((s) => s.kind === "clean");
    expect(escaped).toBeDefined();
    expect(clean).toBeDefined();
    expect(escaped).not.toBe(clean);
    expect(escaped!.caseId).toContain("\u00001\u0000candidate");
    expect(candidate.securityOutcomes.length).toBe(2);
  });

  it("each outcome references ITS OWN security record (no cross-rep or cross-arm borrow)", () => {
    const { candidate } = buildV3ArtifactsFromPaired(
      [pair(0, secOutcome("ESCAPE")), pair(1, secOutcome("NO_ATTACK_ATTEMPT"))], FACTS,
    );
    const rep1 = candidate.outcomes.find((o) => o.repetition === 1)!;
    const rep2 = candidate.outcomes.find((o) => o.repetition === 2)!;
    const escaped = candidate.securityOutcomes.find((s) => s.kind === "escaped")!;
    const clean = candidate.securityOutcomes.find((s) => s.kind === "clean")!;
    expect(rep1.securityOutcomeRef).toBe(escaped.caseId);
    expect(rep2.securityOutcomeRef).toBe(clean.caseId);
    expect(rep1.securityOutcomeRef).not.toBe(rep2.securityOutcomeRef);
  });
});