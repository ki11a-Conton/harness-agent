import { describe, expect, it } from "vitest";
import { configHash, stableStringify } from "./change.js";
import { buildAttributionReport, runPairedBenchmark, type PairedRunSide } from "./paired-evaluation.js";
import { LearningPromoter } from "./promoter.js";
import type { LearningCandidate } from "./candidate.js";

function candidate(): LearningCandidate {
  return {
    id: "cand-1",
    kind: "memory",
    content: "search the tree before guessing paths",
    proposedAt: 1,
    securityChecked: true,
  };
}

function side(success: (caseId: string) => boolean, violations = 0): PairedRunSide {
  return {
    configHash: "hash",
    run: async (caseId) => ({
      success: success(caseId),
      securityViolations: violations,
      latencyMs: 10,
      inputTokens: 100,
      outputTokens: 20,
      toolCalls: 2,
    }),
  };
}

describe("P10-1/P10-2: expressible change + frozen config hash", () => {
  it("stableStringify sorts keys; configHash is deterministic and order-independent", () => {
    expect(stableStringify({ b: 1, a: 2 })).toBe(stableStringify({ a: 2, b: 1 }));
    expect(configHash({ profile: "benchmark", limits: { maxToolCalls: 30 } })).toBe(
      configHash({ limits: { maxToolCalls: 30 }, profile: "benchmark" }),
    );
    expect(configHash({ a: 1 })).not.toBe(configHash({ a: 2 }));
  });
});

describe("P10-3: real paired benchmark", () => {
  it("compares champion vs challenger over repeated runs and reports a gate", async () => {
    const champion = side(() => true);
    const challenger = side((caseId) => caseId !== "hard-case");
    const output = await runPairedBenchmark({
      cases: ["easy-case", "hard-case"],
      champion,
      challenger,
      repeats: 2,
    });
    expect(output.report.overall).toBe("reject"); // challenger lost a case
    expect(output.report.reasons.length).toBeGreaterThan(0);
    expect(output.championHashes).toHaveLength(2);
  });

  it("a clearly better challenger promotes", async () => {
    const champion = side((caseId) => caseId === "a");
    const challenger = side(() => true);
    const output = await runPairedBenchmark({
      cases: ["a", "b"],
      champion,
      challenger,
      repeats: 2,
    });
    expect(output.report.overall).toBe("promote");
  });
});

describe("P10-4: regression attribution", () => {
  it("lists improved/regressed metrics with a summary", async () => {
    const champion = side(() => true, 0);
    const challenger = side(() => true, 1); // slower? no — same; but violations differ
    const output = await runPairedBenchmark({ cases: ["a"], champion, challenger, repeats: 2 });
    const attribution = buildAttributionReport(output.report, candidate());
    expect(attribution.candidateId).toBe("cand-1");
    expect(typeof attribution.summary).toBe("string");
    expect(attribution.improved.concat(attribution.regressed).length).toBeGreaterThan(0);
  });
});

describe("P10-5: promotion is not a score game", () => {
  it("V1 hard gate rejects on ANY security violation even with a score gain", async () => {
    const promoter = new LearningPromoter();
    const decision = await promoter.promote(candidate(), {
      securityCheck: async () => ({ ok: true }),
      benchmarkBefore: async () => 50,
      benchmarkAfter: async () => 60,
      securityViolations: async () => 1,
      persist: async () => {},
    });
    expect(decision.action).toBe("rejected");
    expect(decision.reason).toContain("security violations");
  });

  it("V1 promotes when no violations and threshold met", async () => {
    const promoter = new LearningPromoter();
    const decision = await promoter.promote(candidate(), {
      securityCheck: async () => ({ ok: true }),
      benchmarkBefore: async () => 50,
      benchmarkAfter: async () => 60,
      securityViolations: async () => 0,
      persist: async () => {},
    });
    expect(decision.action).toBe("promoted");
  });
});
