import { describe, expect, it } from "vitest";
import type { EvalCase } from "./eval-case.js";
import type { EvalOutcome } from "./runner.js";
import { choosePromoted } from "./evolution-loop.js";

function assessment(
  id: string,
  costScore: number,
  passRate: number,
  totalTokens: number,
  totalDurationMs: number,
) {
  return { id, costScore, passRate, totalTokens, totalDurationMs, securityFailures: 0 };
}

const CHAMP = assessment("champion", 70, 0.7, 1000, 5_000);

describe("P3-10 evolution loop — single most reliable promotion", () => {
  it("promotes the single best variant when it reliably beats the champion", () => {
    const variants = [
      assessment("A", 60, 0.6, 900, 4_000),
      assessment("B", 85, 0.9, 1500, 6_000),
      assessment("C", 75, 0.8, 1100, 5_500),
    ];
    const d = choosePromoted(CHAMP, variants);
    expect(d.keepChampion).toBe(false);
    expect(d.promotedId).toBe("B");
  });

  it("tie-breaks by pass rate then tokens when cost scores are equal", () => {
    const variants = [
      assessment("A", 80, 0.8, 1000, 5_000),
      assessment("B", 80, 0.9, 2000, 7_000),
    ];
    expect(choosePromoted(CHAMP, variants).promotedId).toBe("B");
  });

  it("keeps the champion when nothing beats it (no forced promotion)", () => {
    const variants = [assessment("A", 60, 0.6, 900, 4_000)];
    const d = choosePromoted(CHAMP, variants);
    expect(d.keepChampion).toBe(true);
    expect(d.promotedId).toBe(null);
  });

  it("requires a minimum lift over the champion", () => {
    const justMeet = assessment("A", 70, 0.7, 1000, 5_000); // delta 0 < minimumLift 1
    const d = choosePromoted(CHAMP, [justMeet], { minimumCostLift: 1 });
    expect(d.keepChampion).toBe(true);
  });

  it("excludes budget-exceeding variants and does not promote them", () => {
    const variants = [
      assessment("A", 95, 1.0, 99_999, 5000),
      assessment("B", 82, 0.9, 1200, 6_000),
    ];
    const d = choosePromoted(CHAMP, variants, { tokenBudget: 5_000, durationMsBudget: 10_000 });
    // A is highest-passing but blew the token budget → excluded; B (≤ budget) wins.
    expect(d.promotedId).toBe("B");
  });

  it("keeps the champion when every variant is out of budget", () => {
    const d = choosePromoted(CHAMP, [assessment("A", 95, 1.0, 99_999, 5000)], {
      tokenBudget: 1_000,
    });
    expect(d.keepChampion).toBe(true);
  });
});