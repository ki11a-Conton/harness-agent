import { describe, expect, it } from "vitest";
import {
  assessWriteSafety,
  DEFAULT_WRITE_SAFETY_CONFIG,
  type WriteSafetyFacts,
} from "./write-safety.js";

function facts(over: Partial<WriteSafetyFacts> = {}): WriteSafetyFacts {
  return {
    exists: false,
    untracked: false,
    originalBytes: 0,
    newBytes: 10,
    append: false,
    hasCheckpoint: false,
    ...over,
  };
}

describe("P2-27 assessWriteSafety", () => {
  it("returns safe for a brand-new file (create)", () => {
    const d = assessWriteSafety(facts());
    expect(d.level).toBe("safe");
    expect(d.escalateToApproval).toBe(false);
    expect(d.flags).toContain("create");
  });

  it("returns safe for an append to an existing file", () => {
    const d = assessWriteSafety(facts({ exists: true, originalBytes: 100_000, newBytes: 3, append: true }));
    expect(d.level).toBe("safe");
    expect(d.flags).toContain("append");
  });

  it("DANGER: large existing file collapsed to a tiny replacement, no checkpoint", () => {
    const d = assessWriteSafety(
      facts({ exists: true, originalBytes: 30_000, newBytes: 12, append: false }),
    );
    expect(d.level).toBe("danger");
    expect(d.escalateToApproval).toBe(true);
    expect(d.flags).toContain("large_to_tiny_overwrite");
    expect(d.flags).toContain("no_backup_checkpoint");
    expect(d.checkpointRecommended).toBe(true);
  });

  it("DANGER threshold boundary: a ~20% shrink of a large file is still a hazard", () => {
    const d = assessWriteSafety(
      facts({ exists: true, originalBytes: 10_000, newBytes: 2000 }), // ratio 0.2 (inclusive)
    );
    expect(d.level).toBe("danger");
    // barely above the tiny ratio → safe-ish
    const ok = assessWriteSafety(
      facts({ exists: true, originalBytes: 10_000, newBytes: 2001 }), // ratio 0.2001
    );
    expect(ok.level).not.toBe("danger");
  });

  it("DANGER is defused when a checkpoint makes the original recoverable", () => {
    const d = assessWriteSafety(
      facts({ exists: true, originalBytes: 30_000, newBytes: 12, hasCheckpoint: true }),
    );
    expect(d.level).toBe("safe");
    expect(d.escalateToApproval).toBe(false);
  });

  it("a normal-size overwrite of a tracked file is safe", () => {
    const d = assessWriteSafety(
      facts({ exists: true, untracked: false, originalBytes: 200, newBytes: 220 }),
    );
    expect(d.level).toBe("safe");
  });

  it("CAUTION: overwriting an untracked file without a checkpoint", () => {
    const d = assessWriteSafety(
      facts({ exists: true, untracked: true, originalBytes: 300, newBytes: 350 }),
    );
    expect(d.level).toBe("caution");
    expect(d.escalateToApproval).toBe(false);
    expect(d.checkpointRecommended).toBe(true);
    expect(d.flags).toContain("untracked_file");
  });

  it("untracked overwrite with a checkpoint is safe", () => {
    const d = assessWriteSafety(
      facts({ exists: true, untracked: true, hasCheckpoint: true, originalBytes: 300, newBytes: 10 }),
    );
    expect(d.level).toBe("safe");
  });

  it("does not consider a small file a shrink hazard", () => {
    const d = assessWriteSafety(
      facts({ exists: true, originalBytes: 1000, newBytes: 1 }), // below largeFileBytes(4096)
    );
    expect(d.level).not.toBe("danger");
    expect(d.level).toBe("safe"); // tracked + no shrink → recoverable, safe
    // the same tiny-but-small overwrite on an untracked file is caution
    const u = assessWriteSafety(
      facts({ exists: true, untracked: true, originalBytes: 1000, newBytes: 1 }),
    );
    expect(u.level).toBe("caution");
  });

  it("honours a custom threshold in WriteSafetyConfig", () => {
    const tigher = { largeFileBytes: 128, tinyReplacementRatio: 0.5 };
    const d = assessWriteSafety(
      facts({ exists: true, originalBytes: 200, newBytes: 90 }), // ratio 0.45
      tigher,
    );
    expect(d.level).toBe("danger");
    // Default config would call this safe (200 < 4096):
    expect(assessWriteSafety(facts({ exists: true, originalBytes: 200, newBytes: 90 })).level).not.toBe(
      "danger",
    );
  });

  it("exposes a stable default config", () => {
    expect(DEFAULT_WRITE_SAFETY_CONFIG).toEqual({ largeFileBytes: 4096, tinyReplacementRatio: 0.2 });
  });
});