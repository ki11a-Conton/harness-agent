import { describe, expect, it } from "vitest";
import {
  assertIndependentReviewerIsolation,
  assertReviewerToolIsolation,
  assessReviewerCandidate,
  buildReviewerPrompt,
  parseReviewerVerdict,
  REVIEWER_CANDIDATE_ENABLED,
  REVIEWER_FORBIDDEN_TOOLS,
  REVIEWER_READ_ONLY_TOOLS,
  runIndependentReview,
  type IndependentReviewerInput,
} from "./independent-reviewer.js";

const BASE_INPUT: IndependentReviewerInput = {
  userRequirement: "fix the flaky test",
  diff: { changedPaths: ["src/app.ts", "test/app.test.ts"] },
  verificationEvidence: [
    { type: "test", source: "pnpm test", passed: true },
  ],
  repoInstructions: "run tests before declaring done",
};

describe("P19-2 independent reviewer isolation", () => {
  it("the candidate is NOT enabled by default", () => {
    expect(REVIEWER_CANDIDATE_ENABLED).toBe(false);
  });

  it("read-only tool surface has no write/exec/network tools", () => {
    for (const tool of REVIEWER_READ_ONLY_TOOLS) {
      expect(REVIEWER_FORBIDDEN_TOOLS).not.toContain(tool);
    }
  });

  it("whitelist guard rejects a non-whitelisted key (fail-closed)", () => {
    expect(() =>
      assertIndependentReviewerIsolation({ ...BASE_INPUT, randomField: 42 } as never),
    ).toThrow(/non-whitelisted input key "randomField"/);
    expect(() =>
      assertIndependentReviewerIsolation({ ...BASE_INPUT, foo: "bar" } as never),
    ).toThrow(/non-whitelisted input key "foo"/);
  });

  it("guard rejects hidden-reasoning and inherited-context keys even when whitelisted-shaped", () => {
    expect(() =>
      assertIndependentReviewerIsolation({ ...BASE_INPUT, transcript: "x" } as never),
    ).toThrow(/hidden\/inherited key "transcript"/);
    expect(() =>
      assertIndependentReviewerIsolation({ ...BASE_INPUT, worker_thoughts: [] } as never),
    ).toThrow(/hidden\/inherited key "worker_thoughts"/);
    expect(() =>
      assertIndependentReviewerIsolation({ ...BASE_INPUT, reasoning: "..." } as never),
    ).toThrow(/hidden\/inherited key "reasoning"/);
    expect(() =>
      assertIndependentReviewerIsolation({ ...BASE_INPUT, memory: { x: 1 } } as never),
    ).toThrow(/hidden\/inherited key "memory"/);
    expect(() =>
      assertIndependentReviewerIsolation({ ...BASE_INPUT, skill: ["x"] } as never),
    ).toThrow(/hidden\/inherited key "skill"/);
    expect(() =>
      assertIndependentReviewerIsolation({ ...BASE_INPUT, hook: ["x"] } as never),
    ).toThrow(/hidden\/inherited key "hook"/);
  });

  it("tool isolation rejects write/exec/network tools", () => {
    expect(() =>
      assertReviewerToolIsolation([...REVIEWER_READ_ONLY_TOOLS, "write_file"]),
    ).toThrow(/not read-only/);
    expect(() => assertReviewerToolIsolation(["exec"])).toThrow(/not read-only/);
    expect(() => assertReviewerToolIsolation(["http_request"])).toThrow(/not read-only/);
    expect(() => assertReviewerToolIsolation([...REVIEWER_READ_ONLY_TOOLS])).not.toThrow();
  });

  it("prompt carries ONLY the whitelisted surface — no reasoning, no memory", () => {
    const prompt = buildReviewerPrompt(BASE_INPUT);
    expect(prompt).toContain("fix the flaky test");
    expect(prompt).toContain("src/app.ts");
    expect(prompt).toContain("pnpm test");
    expect(prompt).toContain("READ-ONLY reviewer");
    expect(prompt).not.toMatch(/transcript|reasoning|memory|chain.of.thought/i);
  });
});

describe("P19-2 fail-closed verdict parsing", () => {
  it("parses a strict approve JSON", () => {
    expect(parseReviewerVerdict('{"verdict":"approve"}')).toEqual({ verdict: "approve" });
  });

  it("parses a flag JSON with summary", () => {
    expect(parseReviewerVerdict('{"verdict":"flag","summary":"missing test coverage"}')).toEqual({
      verdict: "flag",
      summary: "missing test coverage",
    });
  });

  it("prose / malformed JSON / empty are UNPARSEABLE (never approve)", () => {
    expect(parseReviewerVerdict("I think this is fine")).toBeUndefined();
    expect(parseReviewerVerdict('{"verdict":"unknown"}')).toBeUndefined();
    expect(parseReviewerVerdict('{"approve":true}')).toBeUndefined();
    expect(parseReviewerVerdict("   ")).toBeUndefined();
  });
});

describe("P19-2 runIndependentReview (fail-closed)", () => {
  it("approves ONLY on a structurally valid approve verdict", async () => {
    const out = await runIndependentReview(BASE_INPUT, {
      generate: async () => '{"verdict":"approve"}',
    });
    expect(out.verdict).toBe("approve");
  });

  it("a parse failure is degraded — NEVER fail-open approve", async () => {
    const out = await runIndependentReview(BASE_INPUT, {
      generate: async () => "looks good to me, ship it!",
    });
    expect(out.verdict).toBe("degraded");
    expect(out.error).toMatch(/unparseable/);
  });

  it("a thrown generation error is degraded, not approve", async () => {
    const out = await runIndependentReview(BASE_INPUT, {
      generate: async () => {
        throw new Error("model unreachable");
      },
    });
    expect(out.verdict).toBe("degraded");
    expect(out.error).toMatch(/model unreachable/);
  });

  it("a smuggled input key is degraded before any model call", async () => {
    const generate = (): Promise<string> => {
      throw new Error("must never be called");
    };
    const out = await runIndependentReview(
      { ...BASE_INPUT, transcript: "smuggled" } as never,
      { generate },
    );
    expect(out.verdict).toBe("degraded");
    expect(out.error).toMatch(/isolation guard rejected/);
  });
});

describe("P19-2 benchmarkable candidate assessment", () => {
  it("baseline ships every latent defect; a flagging reviewer catches net defects", () => {
    const cases = [
      { id: "a", latentDefect: true, verificationPassed: true, reviewerVerdict: "flag" as const },
      { id: "b", latentDefect: true, verificationPassed: true, reviewerVerdict: "approve" as const },
      { id: "c", latentDefect: false, verificationPassed: true, reviewerVerdict: "approve" as const },
    ];
    const a = assessReviewerCandidate(cases, { enabled: true, candidateId: "rv1" });
    expect(a.baseline.defectsSlipped).toBe(2);
    expect(a.challenger.defectsSlipped).toBe(1);
    expect(a.challenger.defectsCaught).toBe(1);
    expect(a.challenger.degraded).toBe(0);
  });

  it("a degraded reviewer is never silently promoted", () => {
    const cases = [
      { id: "a", latentDefect: true, verificationPassed: true, reviewerVerdict: "degraded" as const },
      { id: "b", latentDefect: true, verificationPassed: true, reviewerVerdict: "degraded" as const },
    ];
    const a = assessReviewerCandidate(cases, { enabled: true });
    // The degraded reviewer caught NOTHING — the gate must not promote it.
    expect(a.challenger.defectsCaught).toBe(0);
    expect(a.decision.promote).toBe(false);
    expect(a.decision.code).toBe("no_defect_value");
  });

  it("false-positive noise blocks promotion (too_noisy)", () => {
    const cases = [
      { id: "a", latentDefect: true, verificationPassed: true, reviewerVerdict: "flag" as const },
      { id: "b", latentDefect: false, verificationPassed: true, reviewerVerdict: "flag" as const },
      { id: "c", latentDefect: false, verificationPassed: true, reviewerVerdict: "flag" as const },
      { id: "d", latentDefect: false, verificationPassed: true, reviewerVerdict: "flag" as const },
      { id: "e", latentDefect: false, verificationPassed: true, reviewerVerdict: "flag" as const },
    ];
    const a = assessReviewerCandidate(cases, { enabled: true });
    // 1 catch - 4 FPs => net -3, and FP rate = 4/4 = 1.0 > 0.3.
    expect(a.decision.promote).toBe(false);
    expect(a.decision.code).toBe("no_defect_value");
  });

  it("disabled candidate yields unverified-equivalent neutral assessment (no promote)", () => {
    const cases = [
      { id: "a", latentDefect: true, verificationPassed: true, reviewerVerdict: "unverified" as const },
    ];
    const a = assessReviewerCandidate(cases, { enabled: false });
    expect(a.enabled).toBe(false);
    expect(a.decision.promote).toBe(false);
  });
});
