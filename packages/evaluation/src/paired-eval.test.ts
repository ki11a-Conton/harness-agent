import { describe, expect, it } from "vitest";
import type { EvalOutcome } from "./runner.js";
import { buildPairedReport, claimFor, classifyPaired } from "./paired-eval.js";

function run(
  caseId: string,
  opts: {
    status?: EvalOutcome["status"];
    grade?: string;
    violations?: string[];
    toolCalls?: number;
    tokens?: number;
    cost?: number;
    latency?: number;
    retries?: number;
    compactions?: number;
    recoveryEvents?: number;
  } = {},
): EvalOutcome {
  return {
    caseId,
    status: opts.status ?? "passed",
    actualStatus: "completed",
    events: Array.from({ length: opts.recoveryEvents ?? 0 }, () => ({
      id: 1 as never,
      sessionId: "s" as never,
      sequence: 1,
      timestamp: 0,
      type: "recovery.decided" as const,
      payload: { action: "retry_safe" },
    })),
    metrics: {
      turn_count: 1,
      tool_call_count: opts.toolCalls ?? 0,
      tokens_input: Math.round((opts.tokens ?? 0) * 0.7),
      tokens_output: Math.round((opts.tokens ?? 0) * 0.3),
      context_tokens: 0,
      compaction_count: opts.compactions ?? 0,
      duration_ms: opts.latency ?? 0,
      retry_count: opts.retries ?? 0,
      verification_failures: 0,
      human_interventions: 0,
      estimated_cost: opts.cost ?? 0,
      usage_unknown: 0,
      cache_tokens_read: 0,
      cache_tokens_created: 0,
      model_call_count: 1,
    },
    violations: opts.violations ?? [],
    suite: "regression",
    judgeVersion: "1.0.0",
    ...(opts.grade !== undefined ? { grade: opts.grade } : {}),
  };
}

describe("P21-3 paired evaluation", () => {
  it("classifies per-case wins/losses/ties honestly", () => {
    const pass = { passed: true, grade: "verified_complete", securityViolations: 0, toolCalls: 1, tokens: 10, estimatedCostUsd: 0, latencyMs: 0, recoveryCount: 0, compactionCount: 0 };
    const fail = { ...pass, passed: false };
    expect(classifyPaired(pass, pass)).toBe("tie");
    expect(classifyPaired(fail, fail)).toBe("both_failed");
    expect(classifyPaired(pass, fail)).toBe("baseline_only_passed");
    expect(classifyPaired(fail, pass)).toBe("candidate_only_passed");
  });

  it("requires baseline and candidate to run the SAME cases (never drops a twin)", () => {
    expect(() =>
      buildPairedReport([run("a")], [run("a"), run("b")], "stub"),
    ).not.toThrow();
    expect(() =>
      buildPairedReport([run("a"), run("b")], [run("a")], "stub"),
    ).toThrow(/SAME cases/);
  });

  it("aggregates the full metric set and per-case outcomes", () => {
    const report = buildPairedReport(
      [
        run("a", { status: "passed", grade: "verified_complete", toolCalls: 2, tokens: 100, cost: 0.01 }),
        run("b", { status: "failed", grade: "verification_failed", violations: ["security.escape"], toolCalls: 5, tokens: 300, retries: 2, compactions: 1 }),
      ],
      [
        run("a", { status: "passed", grade: "verified_complete", toolCalls: 3, tokens: 120, cost: 0.012 }),
        run("b", { status: "passed", grade: "verified_complete", toolCalls: 6, tokens: 400, retries: 1 }),
      ],
      "real-model",
    );
    expect(report.aggregated.cases).toBe(2);
    expect(report.aggregated.candidateWins).toBe(1);
    expect(report.aggregated.baselineWins).toBe(0);
    expect(report.aggregated.ties).toBe(1);
    expect(report.aggregated.netPassedDelta).toBe(1);
    expect(report.aggregated.toolCallsDelta).toBe(2); // (3+6)-(2+5)
    expect(report.aggregated.tokensDelta).toBe(120);
    expect(report.aggregated.costUsdDelta).toBeCloseTo(0.002);
    expect(report.aggregated.recoveryDelta).toBe(-1); // (0+1)-(0+2)
    expect(report.aggregated.compactionDelta).toBe(-1);
  });

  it("verified-completion rates come from the P19-1 grade, never wording", () => {
    const report = buildPairedReport(
      [
        run("a", { status: "passed", grade: "verified_complete" }),
        run("b", { status: "passed", grade: "unverified_complete" }),
      ],
      [
        run("a", { status: "passed", grade: "verified_complete" }),
        run("b", { status: "passed", grade: "verified_complete" }),
      ],
      "real-model",
    );
    expect(report.aggregated.baselineVerifiedRate).toBe(0.5);
    expect(report.aggregated.candidateVerifiedRate).toBe(1);
  });

  it("TRUTH RULE: stub mode claims mechanism-real passed, never 'stronger'", () => {
    const report = buildPairedReport([run("a")], [run("a")], "stub");
    expect(report.mode).toBe("stub");
    expect(report.claim).toContain("mechanism-real passed (stub provider)");
    expect(report.claim).toContain("does NOT claim the agent is stronger");
    expect(report.claim).toContain("No real-model evidence");
  });

  it("claimFor: real-model claim reports wins/losses/ties and flags cost increases", () => {
    const real = claimFor("real-model", {
      cases: 2, candidateWins: 1, baselineWins: 0, ties: 1, bothFailed: 0,
      netPassedDelta: 1, toolCallsDelta: 3, tokensDelta: 150, costUsdDelta: 0.02,
      candidateVerifiedRate: 1, baselineVerifiedRate: 0.5, recoveryDelta: 0, compactionDelta: 0,
    });
    expect(real).toContain("1W/0L/1T");
    expect(real).toContain("verified completion 0.500 → 1.000");
    expect(real).toContain("needs success-rate justification (P21-4)");
    const noCost = claimFor("real-model", {
      cases: 1, candidateWins: 0, baselineWins: 0, ties: 1, bothFailed: 0,
      netPassedDelta: 0, toolCallsDelta: 0, tokensDelta: 0, costUsdDelta: 0,
      candidateVerifiedRate: 1, baselineVerifiedRate: 1, recoveryDelta: 0, compactionDelta: 0,
    });
    expect(noCost).toContain("cost not increased");
  });
});
