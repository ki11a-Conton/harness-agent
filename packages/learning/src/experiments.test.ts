import { describe, expect, it } from "vitest";
import {
  REVIEWER_PROFILE,
  routeSpecialist,
  suggestConcurrency,
  suggestMemoryTopK,
} from "./experiments.js";

describe("PHASE 13 challengers (EXPERIMENT)", () => {
  it("P13-2: reviewer profile is read-only and audit-focused", () => {
    expect(REVIEWER_PROFILE.allowTools).not.toContain("write_file");
    expect(REVIEWER_PROFILE.allowTools).not.toContain("edit_file");
    expect(REVIEWER_PROFILE.systemPrompt).toContain("independent reviewer");
  });

  it("P13-3: routes debugger/reviewer/explorer by goal keywords", () => {
    expect(routeSpecialist("fix the crash in parser")!.id).toBe("debugger");
    expect(routeSpecialist("review the change for correctness")!.id).toBe("reviewer");
    expect(routeSpecialist("find where the config lives")!.id).toBe("explorer");
    expect(routeSpecialist("refactor the module")).toBeUndefined(); // generalist
    expect(routeSpecialist("")).toBeUndefined();
  });

  it("P13-4: suggests memory topK from observed ROI", () => {
    // Entries above the mean ROI are kept (5 > 3 mean → 1 entry).
    expect(suggestMemoryTopK([{ roiPer1k: 5 }, { roiPer1k: 3 }, { roiPer1k: 1 }])).toBe(1);
    // Half above mean → keep those.
    expect(suggestMemoryTopK([{ roiPer1k: 10 }, { roiPer1k: 0 }, { roiPer1k: 0 }])).toBe(1);
    // No data → fallback.
    expect(suggestMemoryTopK([])).toBe(5);
  });

  it("P13-5: shrinks concurrency under conflicts, grows with headroom", () => {
    expect(suggestConcurrency({ activeChildren: 2, maxConcurrent: 4, tokenBudgetRemainingFraction: 0.9, recentConflicts: 1, recentRecoveries: 0 })).toBe(2);
    expect(suggestConcurrency({ activeChildren: 1, maxConcurrent: 2, tokenBudgetRemainingFraction: 0.9, recentConflicts: 0, recentRecoveries: 0 })).toBe(3);
    expect(suggestConcurrency({ activeChildren: 3, maxConcurrent: 3, tokenBudgetRemainingFraction: 0.2, recentConflicts: 0, recentRecoveries: 0 })).toBe(3);
  });
});
