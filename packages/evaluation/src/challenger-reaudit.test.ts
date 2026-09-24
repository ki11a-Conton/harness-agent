import { describe, expect, it } from "vitest";
import { join } from "node:path";
import { loadRunsFromArtifact, judgePairComparability } from "@ar/evaluation";

/** E1-12 — re-audit of the four historical challengers (free, deterministic).
 *
 * The historical evidence predates activation evidence (E1-04) and strict
 * provenance (E1-07). This audit reruns the E1-07 comparability gate on the
 * committed 2026-08-27 artifacts and verifies fail-closed behavior:
 * every challenger must be judged INCOMPARABLE (legacy_no_activation_evidence),
 * regardless of its historical +1 pass / -529K tokens claim.
 */

const BASE = join(process.cwd(), "benchmarks", "results", "2026-08-27-deepseek-v4-flash");
const challengerPath = (dir: string) =>
  join(process.cwd(), "benchmarks", "results", dir, "holdout.json");
const CHALLENGERS = [
  { dir: "2026-08-27-deepseek-v4-flash-deferred-schema", candidateId: "tool_selector_deferred_schema" },
  { dir: "2026-08-27-deepseek-v4-flash-memory-retrieval", candidateId: "memory_retrieval" },
  { dir: "2026-08-27-deepseek-v4-flash-adaptive-recovery", candidateId: "adaptive_recovery" },
  { dir: "2026-08-27-deepseek-v4-flash-adaptive-context", candidateId: "adaptive_context_policy" },
] as const;

describe("E1-12 historical challenger re-audit", () => {
  for (const ch of CHALLENGERS) {
    it(`${ch.candidateId} is INCOMPARABLE under strict E1-07 (no activation evidence)`, async () => {
      const baseRuns = await loadRunsFromArtifact(join(BASE, "holdout.json"));
      const cand = await loadRunsFromArtifact(challengerPath(ch.dir));
      expect(cand.runs.length).toBe(baseRuns.runs.length);
      const verdict = judgePairComparability(baseRuns.runs, cand.runs, {
        strict: true,
        candidateId: ch.candidateId,
      });
      // Fail-closed: legacy runs have no activation evidence → never comparable.
      expect(verdict.comparable).toBe(false);
      expect(verdict.reasons).toContain("legacy_no_activation_evidence");
      // The context hash must still MATCH (the fixture/judge context was the
      // same — only the candidate wiring differed). If this ever fails, the
      // historical comparison was invalid for an additional reason.
      expect(verdict.contextHashStatus).toBe("matched");
    });
  }

  it("every historical challenger dir has a valid holdout artifact", async () => {
    for (const ch of CHALLENGERS) {
      const cand = await loadRunsFromArtifact(challengerPath(ch.dir));
      expect(cand.runs.length).toBeGreaterThan(0);
    }
  });
});