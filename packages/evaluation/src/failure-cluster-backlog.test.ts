import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * E1-15 — the failure-cluster backlog is a machine-readable artifact derived
 * from the on-disk historical results. This test guards its structural
 * integrity and that its cluster counts match the baseline holdout artifact
 * (no fabricated numbers).
 */
describe("failure-cluster backlog (E1-15)", () => {
  it("backlog JSON exists and has the expected schema", async () => {
    const raw = await readFile(join(process.cwd(), "docs", "evolution", "e1-failure-cluster-backlog.json"), "utf8");
    const backlog = JSON.parse(raw) as {
      schemaVersion: string;
      baseline: { total: number; passed: number; termination: Record<string, number> };
      clusters: Record<string, { count: number }>;
      nextRound: { rank: number; candidate: string; blockedBy: string }[];
    };
    expect(backlog.schemaVersion).toBe("1.0.0");
    expect(backlog.baseline.total).toBe(30);
    expect(backlog.nextRound.length).toBeGreaterThan(0);
  });

  it("cluster counts match the baseline holdout artifact", async () => {
    const raw = await readFile(join(process.cwd(), "docs", "evolution", "e1-failure-cluster-backlog.json"), "utf8");
    const backlog = JSON.parse(raw) as { clusters: Record<string, { count: number }>; baseline: { termination: Record<string, number> } };
    // agent_limit + verification_failed + model_error == baseline failed count.
    const clusterSum = backlog.clusters.agent_limit!.count
      + backlog.clusters.verification_failed!.count
      + backlog.clusters.model_error!.count;
    const termSum = Object.values(backlog.baseline.termination).reduce((a, b) => a + b, 0);
    expect(clusterSum).toBe(termSum);
    expect(clusterSum).toBe(21); // 30 - 9 passed on baseline holdout
  });

  it("every next-round candidate is a registered registry candidate", async () => {
    const raw = await readFile(join(process.cwd(), "docs", "evolution", "e1-failure-cluster-backlog.json"), "utf8");
    const backlog = JSON.parse(raw) as { nextRound: { candidate: string }[] };
    const registryRaw = await readFile(join(process.cwd(), "packages", "evaluation", "src", "candidate-registry.ts"), "utf8");
    for (const item of backlog.nextRound) {
      expect(registryRaw).toContain(`id: "${item.candidate}"`);
    }
  });
});
