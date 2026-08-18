import { describe, expect, it, vi } from "vitest";
import type { LearningCandidate } from "./candidate.js";
import { LearningPromoter } from "./promoter.js";
import type { PromoteDeps } from "./promoter.js";

function candidate(overrides: Partial<LearningCandidate> = {}): LearningCandidate {
  return {
    id: "cand-1",
    kind: "memory",
    content: "learned lesson",
    proposedAt: 1_752_000_000_000,
    securityChecked: false,
    ...overrides,
  };
}

type MockedDeps = PromoteDeps & {
  securityCheck: ReturnType<typeof vi.fn>;
  benchmarkBefore: ReturnType<typeof vi.fn>;
  benchmarkAfter: ReturnType<typeof vi.fn>;
  persist: ReturnType<typeof vi.fn>;
};

function makeDeps(overrides: Partial<PromoteDeps> = {}): MockedDeps {
  return {
    securityCheck: vi.fn(async (_c: LearningCandidate) => ({ ok: true })),
    benchmarkBefore: vi.fn(async () => 10),
    benchmarkAfter: vi.fn(async () => 12),
    persist: vi.fn(async () => {}),
    ...overrides,
  } as MockedDeps;
}

const promoter = new LearningPromoter();

describe("LearningPromoter.promote (§147/§194 promotion gate)", () => {
  it("promotes when security passes and the benchmark improves", async () => {
    const c = candidate();
    const deps = makeDeps();
    const decision = await promoter.promote(c, deps);

    expect(decision.action).toBe("promoted");
    expect(decision.reason).toContain("10");
    expect(decision.reason).toContain("12");
    expect(deps.persist).toHaveBeenCalledTimes(1);
  });

  it("records the measured scores on the candidate before persisting", async () => {
    const c = candidate();
    const deps = makeDeps();
    await promoter.promote(c, deps);

    expect(c.benchmarkScoreBefore).toBe(10);
    expect(c.benchmarkScoreAfter).toBe(12);
  });

  it("rejects on security failure even with a high score, and never runs benchmarks", async () => {
    const c = candidate();
    const deps = makeDeps({
      securityCheck: vi.fn(async () => ({ ok: false, reason: "dangerous skill change" })),
    });
    const decision = await promoter.promote(c, deps);

    expect(decision.action).toBe("rejected");
    expect(decision.reason).toContain("dangerous skill change");
    expect(deps.benchmarkBefore).not.toHaveBeenCalled();
    expect(deps.benchmarkAfter).not.toHaveBeenCalled();
    expect(deps.persist).not.toHaveBeenCalled();
  });

  it("lets a throwing security check propagate (never auto-promote on error)", async () => {
    const c = candidate();
    const deps = makeDeps({
      securityCheck: vi.fn(async () => {
        throw new Error("security service unavailable");
      }),
    });

    await expect(promoter.promote(c, deps)).rejects.toThrow(
      "security service unavailable",
    );
    expect(deps.persist).not.toHaveBeenCalled();
  });

  it("rejects when the score does not improve (after == before)", async () => {
    const deps = makeDeps({ benchmarkAfter: vi.fn(async () => 10) });
    const decision = await promoter.promote(candidate(), deps);

    expect(decision.action).toBe("rejected");
    expect(decision.reason).toContain("accidental success");
    expect(deps.persist).not.toHaveBeenCalled();
  });

  it("rejects when the score decreased", async () => {
    const deps = makeDeps({ benchmarkAfter: vi.fn(async () => 8) });
    const decision = await promoter.promote(candidate(), deps);

    expect(decision.action).toBe("rejected");
    expect(decision.reason).toContain("8");
    expect(deps.persist).not.toHaveBeenCalled();
  });

  it("rejects when there is no baseline (NaN) and never calls benchmarkAfter", async () => {
    const deps = makeDeps({ benchmarkBefore: vi.fn(async () => NaN) });
    const decision = await promoter.promote(candidate(), deps);

    expect(decision.action).toBe("rejected");
    expect(decision.reason).toContain("baseline");
    expect(deps.benchmarkAfter).not.toHaveBeenCalled();
    expect(deps.persist).not.toHaveBeenCalled();
  });

  it("rejects when the baseline benchmark throws, preserving the error in the reason", async () => {
    const deps = makeDeps({
      benchmarkBefore: vi.fn(async () => {
        throw new Error("benchmark service down");
      }),
    });
    const decision = await promoter.promote(candidate(), deps);

    expect(decision.action).toBe("rejected");
    expect(decision.reason).toContain("benchmark service down");
    expect(deps.benchmarkAfter).not.toHaveBeenCalled();
    expect(deps.persist).not.toHaveBeenCalled();
  });

  it("rejects an unmeasurable after-score instead of treating it as a gain", async () => {
    const deps = makeDeps({ benchmarkAfter: vi.fn(async () => NaN) });
    const decision = await promoter.promote(candidate(), deps);

    expect(decision.action).toBe("rejected");
    expect(decision.reason).toContain("not measurable");
    expect(deps.persist).not.toHaveBeenCalled();
  });

  it("honors a configurable threshold with an inclusive boundary", async () => {
    const atBoundary = makeDeps({
      threshold: 2,
      benchmarkAfter: vi.fn(async () => 12),
    });
    expect((await promoter.promote(candidate(), atBoundary)).action).toBe("rejected");

    const aboveBoundary = makeDeps({
      threshold: 2,
      benchmarkAfter: vi.fn(async () => 13),
    });
    expect((await promoter.promote(candidate(), aboveBoundary)).action).toBe("promoted");
  });

  it("uses a default threshold of 0", async () => {
    const deps = makeDeps({ benchmarkAfter: vi.fn(async () => 10) });
    const decision = await promoter.promote(candidate(), deps);
    expect(decision.action).toBe("rejected");
    expect(decision.reason).toContain("threshold 0");
  });

  it("passes the candidate through to persist with its kind intact", async () => {
    const c = candidate({ kind: "skill" });
    const deps = makeDeps();
    await promoter.promote(c, deps);

    const persisted = deps.persist.mock.calls[0]?.[0];
    expect(persisted).toBe(c);
    expect(persisted?.kind).toBe("skill");
    expect(persisted?.content).toBe("learned lesson");
    expect(persisted?.benchmarkScoreBefore).toBe(10);
    expect(persisted?.benchmarkScoreAfter).toBe(12);
  });

  it("passes the candidate to the security check", async () => {
    const c = candidate();
    const deps = makeDeps();
    await promoter.promote(c, deps);

    expect(deps.securityCheck).toHaveBeenCalledTimes(1);
    expect(deps.securityCheck.mock.calls[0]?.[0]).toBe(c);
  });

  it("treats memory and skill candidates identically for identical scores", async () => {
    const memory = candidate({ kind: "memory" });
    const skill = candidate({ kind: "skill" });
    const memoryDeps = makeDeps();
    const skillDeps = makeDeps();

    const memoryDecision = await promoter.promote(memory, memoryDeps);
    const skillDecision = await promoter.promote(skill, skillDeps);

    expect(memoryDecision.action).toBe("promoted");
    expect(skillDecision.action).toBe("promoted");
    expect(skillDeps.persist).toHaveBeenCalledTimes(1);
    expect(skillDeps.persist.mock.calls[0]?.[0]?.kind).toBe("skill");
  });

  it("persists exactly once per successful promotion", async () => {
    const deps = makeDeps();
    await promoter.promote(candidate(), deps);
    expect(deps.persist).toHaveBeenCalledTimes(1);
  });

  it("never persists on rejection", async () => {
    const deps = makeDeps({ benchmarkAfter: vi.fn(async () => 9) });
    await promoter.promote(candidate(), deps);
    expect(deps.persist).not.toHaveBeenCalled();
  });
});

describe("LearningPromoter.evaluateAfter (§70 rollback)", () => {
  it("rolls back when the current score falls below the recorded post-promotion score", async () => {
    const c = candidate();
    const deps = makeDeps();
    const promoted = await promoter.promote(c, deps);
    expect(promoted.action).toBe("promoted");
    expect(deps.persist).toHaveBeenCalledTimes(1);

    const decision = await promoter.evaluateAfter(c, {
      benchmarkCurrent: async () => 9,
    });

    expect(decision.action).toBe("rolled_back");
    expect(decision.reason).toContain("12");
    expect(decision.reason).toContain("9");
    expect(deps.persist).toHaveBeenCalledTimes(1);
  });

  it("keeps the promotion when the current score still holds", async () => {
    const c = candidate();
    const deps = makeDeps();
    await promoter.promote(c, deps);

    const decision = await promoter.evaluateAfter(c, {
      benchmarkCurrent: async () => 12,
    });

    expect(decision.action).toBe("promoted");
    expect(decision.reason).toContain("12");
    expect(deps.persist).toHaveBeenCalledTimes(1);
  });

  it("rolls back when the current score is unmeasurable (fail-closed)", async () => {
    const c = candidate();
    const deps = makeDeps();
    await promoter.promote(c, deps);

    const decision = await promoter.evaluateAfter(c, {
      benchmarkCurrent: async () => NaN,
    });

    expect(decision.action).toBe("rolled_back");
    expect(decision.reason).toContain("not measurable");
  });

  it("rejects when the candidate was never promoted", async () => {
    const decision = await promoter.evaluateAfter(candidate(), {
      benchmarkCurrent: async () => 50,
    });

    expect(decision.action).toBe("rejected");
    expect(decision.reason).toContain("never promoted");
  });
});

describe("decision reasons", () => {
  it("every decision carries a non-empty, specific reason", async () => {
    const cases = await Promise.all([
      promoter.promote(candidate(), makeDeps()),
      promoter.promote(candidate(), makeDeps({ benchmarkAfter: vi.fn(async () => 10) })),
      promoter.promote(candidate(), makeDeps({ benchmarkBefore: vi.fn(async () => NaN) })),
      promoter.promote(
        candidate(),
        makeDeps({ securityCheck: vi.fn(async () => ({ ok: false })) }),
      ),
      promoter.evaluateAfter(candidate(), { benchmarkCurrent: async () => 50 }),
    ]);

    for (const decision of cases) {
      expect(decision.reason.length).toBeGreaterThan(0);
    }
    expect(cases.map((d) => d.action)).toEqual([
      "promoted",
      "rejected",
      "rejected",
      "rejected",
      "rejected",
    ]);
  });
});
