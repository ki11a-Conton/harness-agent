/**
 * E4-05 — canonical PairKey + exact multiset pairing.
 */
import { describe, expect, it } from "vitest";
import { evaluatePairing, pairKeyV3, type PairableOutcome } from "./paired-key.js";

function o(caseId: string, repetition: number, passed: boolean, suite = "s"): PairableOutcome {
  return { suite, caseId, repetition, passed };
}

describe("E4-05 pairKeyV3", () => {
  it("is collision-free across (suite, caseId, repetition)", () => {
    // naive `caseId + rep` would collide these; NUL-delimited does not.
    const a = pairKeyV3({ suite: "s", caseId: "ab", repetition: 1 });
    const b = pairKeyV3({ suite: "s", caseId: "a", repetition: 11 });
    expect(a).not.toBe(b);
    // different suite, same caseId+rep → distinct keys
    expect(pairKeyV3({ suite: "x", caseId: "c", repetition: 1 }))
      .not.toBe(pairKeyV3({ suite: "y", caseId: "c", repetition: 1 }));
  });
});

describe("E4-05 evaluatePairing", () => {
  it("positive: identical 1..2 reps over the same cases pairs cleanly", () => {
    const baseline = [o("c1", 1, false), o("c2", 1, true), o("c1", 2, false), o("c2", 2, true)];
    const candidate = [o("c1", 1, true), o("c2", 1, true), o("c1", 2, true), o("c2", 2, true)];
    const r = evaluatePairing(baseline, candidate);
    expect(r.pairComplete).toBe(true);
    expect(r.violations).toEqual([]);
    expect(r.repetitions).toBe(2);
    expect(r.cases).toBe(4);
    // rep1: c1 flips false→true (+1); rep2: c1 flips (+1) → each rep +1
    expect(r.perRepetitionDeltas).toEqual([1, 1]);
    expect(r.netPassedDelta).toBe(2);
    // sum of per-repetition deltas equals the net delta (no double count)
    expect(r.perRepetitionDeltas.reduce((s, d) => s + d, 0)).toBe(r.netPassedDelta);
  });

  it("repro: baseline rep=1 only, candidate rep=1..2 → INVALID (extra keys)", () => {
    const baseline = [o("c1", 1, false), o("c2", 1, false), o("c3", 1, false)];
    const candidate = [
      o("c1", 1, true), o("c2", 1, true), o("c3", 1, true),
      o("c1", 2, true), o("c2", 2, true), o("c3", 2, true),
    ];
    const r = evaluatePairing(baseline, candidate);
    expect(r.pairComplete).toBe(false);
    expect(r.violations.some((v) => v.includes("missing in baseline"))).toBe(true);
  });

  it("candidate missing rep=2 → INVALID", () => {
    const baseline = [o("c1", 1, false), o("c1", 2, false)];
    const candidate = [o("c1", 1, true)]; // missing rep 2
    const r = evaluatePairing(baseline, candidate);
    expect(r.pairComplete).toBe(false);
    expect(r.violations.some((v) => v.includes("missing in candidate") || v.includes("contiguous"))).toBe(true);
  });

  it("baseline extra rep=3 → INVALID", () => {
    const baseline = [o("c1", 1, false), o("c1", 2, false), o("c1", 3, false)];
    const candidate = [o("c1", 1, true), o("c1", 2, true)];
    const r = evaluatePairing(baseline, candidate);
    expect(r.pairComplete).toBe(false);
  });

  it("duplicate PairKey within one arm → INVALID (never a silent overwrite)", () => {
    const baseline = [o("c1", 1, false), o("c1", 1, true)]; // same key twice
    const candidate = [o("c1", 1, true)];
    const r = evaluatePairing(baseline, candidate);
    expect(r.pairComplete).toBe(false);
    expect(r.violations.some((v) => v.includes("duplicate PairKey"))).toBe(true);
  });

  it("repetition 0 → INVALID (out of range)", () => {
    const baseline = [o("c1", 0, false)];
    const candidate = [o("c1", 0, true)];
    const r = evaluatePairing(baseline, candidate);
    expect(r.pairComplete).toBe(false);
    expect(r.violations.some((v) => v.includes("repetition 0"))).toBe(true);
  });

  it("different suite, same caseId → NOT paired together (missing/extra)", () => {
    const baseline = [o("c1", 1, false, "suiteA")];
    const candidate = [o("c1", 1, true, "suiteB")];
    const r = evaluatePairing(baseline, candidate);
    expect(r.pairComplete).toBe(false);
  });

  it("a missing twin is never 0-filled into the net delta", () => {
    // candidate has an extra unpaired case that passes; it must NOT inflate the
    // paired net delta (only paired keys count).
    const baseline = [o("c1", 1, false)];
    const candidate = [o("c1", 1, true), o("cX", 1, true)];
    const r = evaluatePairing(baseline, candidate);
    expect(r.pairComplete).toBe(false); // extra key
    expect(r.netPassedDelta).toBe(1); // only the paired c1 contributes
  });
});
