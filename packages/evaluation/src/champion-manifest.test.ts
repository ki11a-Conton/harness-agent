import { describe, expect, it } from "vitest";
import {
  assertAllPromotedFeaturesRollbackable,
  buildChampionManifest,
  renderChampionManifest,
  rollbackSwitchOf,
} from "./champion-manifest.js";

const INPUTS = [
  {
    feature: "context_pipeline_v5",
    promotedAt: "2026-08-22T00:00:00.000Z",
    evidenceReport: "paired-eval/context-v5.md",
    benchmarkDelta: { netPassedDelta: 3, tokensDelta: -100, verifiedDelta: 0.05 },
  },
  {
    feature: "memory_retrieval",
    promotedAt: "2026-08-22T00:00:00.000Z",
    evidenceReport: "paired-eval/memory.md",
    benchmarkDelta: { netPassedDelta: 2, tokensDelta: 150, verifiedDelta: 0 },
    securityStatus: "attention" as const,
  },
];

describe("P21-6 champion manifest", () => {
  it("builds one entry per promoted feature with full evidence identity", () => {
    const manifest = buildChampionManifest(INPUTS, "2026-08-22T01:00:00.000Z");
    expect(manifest.schemaVersion).toBe(1);
    expect(manifest.updatedAt).toBe("2026-08-22T01:00:00.000Z");
    expect(manifest.entries).toHaveLength(2);
    const memory = manifest.entries.find((e) => e.feature === "memory_retrieval")!;
    expect(memory.promotedAt).toBe("2026-08-22T00:00:00.000Z");
    expect(memory.evidenceReport).toBe("paired-eval/memory.md");
    expect(memory.benchmarkDelta).toEqual({ netPassedDelta: 2, tokensDelta: 150, verifiedDelta: 0 });
    expect(memory.securityStatus).toBe("attention");
  });

  it("every promoted feature carries a concrete rollback switch (P21-2 disabled config)", () => {
    const manifest = buildChampionManifest(INPUTS);
    const context = manifest.entries.find((e) => e.feature === "context_pipeline_v5")!;
    expect(context.rollback).toBe(true);
    expect(context.rollbackConfig).toEqual({ features: { context: false } });
    assertAllPromotedFeaturesRollbackable(manifest);
  });

  it("rollbackSwitchOf answers 'how do I turn this off' mechanically", () => {
    const manifest = buildChampionManifest(INPUTS);
    expect(rollbackSwitchOf(manifest, "memory_retrieval")).toEqual({ features: { memory: false } });
    expect(rollbackSwitchOf(manifest, "never-promoted")).toBeUndefined();
  });

  it("fails closed when a feature has no P21-2 candidate (no rollback switch exists)", () => {
    expect(() =>
      buildChampionManifest([
        { feature: "magic_mechanism", promotedAt: "t", evidenceReport: "r", benchmarkDelta: { netPassedDelta: 1, tokensDelta: 0, verifiedDelta: 0 } },
      ]),
    ).toThrow(/unknown feature/);
  });

  it("renders the manifest table with rollback instructions", () => {
    const lines = renderChampionManifest(buildChampionManifest(INPUTS));
    const text = lines.join("\n");
    expect(text).toContain("# CHAMPION_MANIFEST");
    expect(text).toContain("context_pipeline_v5");
    expect(text).toContain("off via {\"features\":{\"context\":false}}");
    expect(text).toContain("every promoted feature is individually rollbackable");
  });
});
