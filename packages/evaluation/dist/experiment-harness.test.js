import { describe, expect, it } from "vitest";
import { ExperimentHarness, computeComparisons, renderReport } from "./experiment-harness.js";
const CONFIG = {
    id: "compaction-test",
    variants: [
        { name: "baseline", mechanism: "compaction", overrides: { strategy: "aggressive" } },
        { name: "experimental", mechanism: "compaction", overrides: { strategy: "conservative" } },
    ],
    baseline: "baseline",
    runs: 3,
};
describe("P2-9 experiment harness", () => {
    it("default runBenchmark produces a completed result", async () => {
        const harness = new ExperimentHarness();
        const report = await harness.run({
            ...CONFIG,
            variants: [{ name: "single", mechanism: "test", overrides: {} }],
        });
        expect(report.results).toHaveLength(1);
        expect(report.results[0].status).toBe("completed");
        expect(report.results[0].variantName).toBe("single");
        expect(report.results[0].durationMs).toBeGreaterThanOrEqual(0);
        expect(report.results[0].metrics.passRate).toBeGreaterThan(0);
    });
    it("run with 2 variants produces 2 results", async () => {
        const harness = new ExperimentHarness();
        const report = await harness.run(CONFIG);
        expect(report.results).toHaveLength(2);
        expect(report.results[0].variantName).toBe("baseline");
        expect(report.results[1].variantName).toBe("experimental");
        expect(report.configId).toBe("compaction-test");
    });
    it("computeComparisons produces deltas between baseline and variants", () => {
        const results = [
            { variantName: "baseline", mechanism: "compaction", status: "completed", metrics: { passRate: 0.9, tokens: 1000 }, startedAt: 0, durationMs: 100 },
            { variantName: "experimental", mechanism: "compaction", status: "completed", metrics: { passRate: 0.8, tokens: 800 }, startedAt: 0, durationMs: 80 },
        ];
        const comparisons = computeComparisons(CONFIG, results);
        expect(comparisons).toHaveLength(2);
        const passRateCmp = comparisons.find((c) => c.metric === "passRate");
        expect(passRateCmp.delta).toBeCloseTo(0.1, 6);
        expect(passRateCmp.variantA).toBe("baseline");
        expect(passRateCmp.variantB).toBe("experimental");
    });
    it("renderReport includes variant names and metrics", () => {
        const report = {
            configId: "test",
            results: [
                { variantName: "a", mechanism: "m", status: "completed", metrics: { score: 0.95 }, startedAt: 0, durationMs: 50 },
            ],
            comparisons: [],
            startedAt: 0,
            completedAt: 100,
        };
        const text = renderReport(report);
        expect(text).toContain("test");
        expect(text).toContain("a");
        expect(text).toContain("0.95");
    });
    it("a failing variant is reported with error", async () => {
        const harness = new ExperimentHarness({
            runBenchmark: async () => { throw new Error("benchmark crashed"); },
        });
        const report = await harness.run({
            ...CONFIG,
            variants: [{ name: "bad", mechanism: "test", overrides: {} }],
        });
        expect(report.results[0].status).toBe("failed");
        expect(report.results[0].error).toContain("benchmark crashed");
    });
});
//# sourceMappingURL=experiment-harness.test.js.map