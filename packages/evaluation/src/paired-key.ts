/**
 * E4-05 — Canonical paired-experiment key + exact multiset pairing.
 *
 * The pre-E4-05 evaluator paired baseline↔candidate by `caseId` alone and
 * collapsed repetitions into a `Map<caseId, …>`, so a candidate that ran
 * rep 1..2 against a baseline that ran only rep 1 still looked "pair complete"
 * and could be scored ACCEPT on mispaired repetitions. This module makes the
 * pairing exact and the mispairing impossible to hide:
 *
 *   - canonical PairKey = suite ␀ caseId ␀ repetition (NUL-delimited, no
 *     concatenation ambiguity);
 *   - duplicate PairKey on insert is a violation (never a silent overwrite);
 *   - baseline and candidate key SETS must be identical (missing / extra →
 *     violation);
 *   - each arm's repetitions must be exactly the contiguous range 1..N
 *     (repetition 0 or a gap → violation);
 *   - deltas are computed only over PAIRED keys (both arms present) — a missing
 *     twin is never 0-filled into the aggregate.
 */

/** The minimal outcome shape the pairing needs (a structural subset of
 *  CaseOutcomeV3, so it is trivially testable without full artifacts). */
export interface PairableOutcome {
  suite: string;
  caseId: string;
  repetition: number;
  passed: boolean;
}

export interface PairingResult {
  /** True only when there are ZERO pairing violations. */
  pairComplete: boolean;
  /** Human-readable, stable violation strings (empty when pairComplete). */
  violations: string[];
  /** Distinct repetitions observed (max of both arms). */
  repetitions: number;
  /** Net-passed delta over PAIRED keys only (candidate − baseline). */
  netPassedDelta: number;
  /** Per-repetition net-passed delta over the paired keys at that rep. */
  perRepetitionDeltas: number[];
  /** Number of distinct paired cases. */
  cases: number;
}

/** Canonical, collision-free PairKey. NUL cannot appear in a suite/caseId, so
 *  the encoding is unambiguous (unlike `caseId + ":" + rep` collisions). */
export function pairKeyV3(o: { suite: string; caseId: string; repetition: number }): string {
  return `${o.suite}\u0000${o.caseId}\u0000${o.repetition}`;
}

function buildPairMap(
  outcomes: PairableOutcome[],
  label: string,
  violations: string[],
): Map<string, PairableOutcome> {
  const map = new Map<string, PairableOutcome>();
  for (const o of outcomes) {
    const key = pairKeyV3(o);
    if (map.has(key)) {
      violations.push(`${label}: duplicate PairKey ${JSON.stringify([o.suite, o.caseId, o.repetition])}`);
    } else {
      map.set(key, o);
    }
  }
  return map;
}

function validateRepetitionSet(reps: Set<number>, label: string, violations: string[]): void {
  if (reps.size === 0) return;
  if (reps.has(0)) {
    violations.push(`${label}: repetition 0 is out of range (must be exactly 1..repeat)`);
  }
  const max = Math.max(...reps);
  for (let r = 1; r <= max; r++) {
    if (!reps.has(r)) {
      violations.push(`${label}: missing repetition ${r} (must be contiguous 1..${max})`);
    }
  }
}

/** Evaluate exact pairing + paired deltas between two arms' outcomes. */
export function evaluatePairing(baseline: PairableOutcome[], candidate: PairableOutcome[]): PairingResult {
  const violations: string[] = [];
  const bMap = buildPairMap(baseline, "baseline", violations);
  const cMap = buildPairMap(candidate, "candidate", violations);

  // Key-set equality (missing / extra).
  for (const key of bMap.keys()) {
    if (!cMap.has(key)) violations.push(`PairKey present in baseline but missing in candidate: ${JSON.stringify(key.split("\u0000"))}`);
  }
  for (const key of cMap.keys()) {
    if (!bMap.has(key)) violations.push(`PairKey present in candidate but missing in baseline: ${JSON.stringify(key.split("\u0000"))}`);
  }

  // Repetition contiguity per arm.
  const bReps = new Set(baseline.map((o) => o.repetition));
  const cReps = new Set(candidate.map((o) => o.repetition));
  validateRepetitionSet(bReps, "baseline", violations);
  validateRepetitionSet(cReps, "candidate", violations);

  const repetitions = Math.max(0, ...[...bReps, ...cReps]);

  // Paired deltas over keys present in BOTH arms only (no 0-fill).
  const commonKeys = [...bMap.keys()].filter((k) => cMap.has(k));
  let netPassedDelta = 0;
  for (const key of commonKeys) {
    const b = bMap.get(key)!;
    const c = cMap.get(key)!;
    if (c.passed && !b.passed) netPassedDelta += 1;
    else if (!c.passed && b.passed) netPassedDelta -= 1;
  }

  const repValues = [...cReps].filter((r) => r >= 1).sort((a, b) => a - b);
  const perRepetitionDeltas = repValues.map((rep) => {
    let d = 0;
    for (const key of commonKeys) {
      const c = cMap.get(key)!;
      if (c.repetition !== rep) continue;
      const b = bMap.get(key)!;
      if (c.passed && !b.passed) d += 1;
      else if (!c.passed && b.passed) d -= 1;
    }
    return d;
  });

  return {
    pairComplete: violations.length === 0,
    violations,
    repetitions,
    netPassedDelta,
    perRepetitionDeltas,
    cases: commonKeys.length,
  };
}
