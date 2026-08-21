import { describe, expect, it } from "vitest";
import { ExperimentHarness, computeCrossModel } from "./experiment-harness.js";
const CROSS_CONFIG = {
    id: "cross-model-test",
    variants: [
        { name: "baseline", mechanism: "compaction", overrides: { threshold: 0.8 } },
        { name: "mechanism", mechanism: "compaction", overrides: { threshold: 0.5 } },
    ],
    baseline: "baseline",
    models: ["gpt-4-class", "gpt-3.5-class"],
    runs: 1,
};
function result(variantName, model, metrics) {
    return {
        variantName,
        mechanism: "compaction",
        status: "completed",
        metrics,
        model,
        startedAt: 0,
        durationMs: 10,
    };
}
describe("P2-15 cross-model analysis — single model no analysis", () => {
    it("returns undefined when models < 2", () => {
        const config = { ...CROSS_CONFIG, models: undefined };
        const results = [
            result("baseline", "default", { passRate: 0.9 }),
            result("mechanism", "default", { passRate: 0.8 }),
        ];
        expect(computeCrossModel(config, results)).toBeUndefined();
        expect(computeCrossModel({ ...CROSS_CONFIG, models: ["only-one"] }, results)).toBeUndefined();
    });
});
describe("P2-15 cross-model analysis — detection", () => {
    it("flags harms-weaker: mechanism helps strong but regresses weak", () => {
        const config = CROSS_CONFIG;
        const results = [
            result("baseline", "gpt-4-class", { passRate: 0.9 }),
            result("baseline", "gpt-3.5-class", { passRate: 0.7 }),
            result("mechanism", "gpt-4-class", { passRate: 0.95 }), // strong +0.05
            result("mechanism", "gpt-3.5-class", { passRate: 0.5 }), // weak -0.20
        ];
        const analysis = computeCrossModel(config, results);
        const finding = analysis.findings.find((f) => f.kind === "harms-weaker");
        expect(finding).toBeDefined();
        expect(finding.metric).toBe("passRate");
        expect(finding.strongDelta).toBeCloseTo(0.05, 6);
        expect(finding.weakDelta).toBeCloseTo(-0.2, 6);
        expect(analysis.counts["harms-weaker"]).toBe(1);
    });
    it("flags improves-only-strong: mechanism moves only the strong model", () => {
        const results = [
            result("baseline", "gpt-4-class", { passRate: 0.9 }),
            result("baseline", "gpt-3.5-class", { passRate: 0.7 }),
            result("mechanism", "gpt-4-class", { passRate: 0.95 }), // strong +0.05
            result("mechanism", "gpt-3.5-class", { passRate: 0.7 }), // weak unchanged
        ];
        const findings = computeCrossModel(CROSS_CONFIG, results).findings;
        expect(findings.some((f) => f.kind === "improves-only-strong" && f.metric === "passRate")).toBe(true);
    });
    it("flags improves-only-weak for the reverse", () => {
        const results = [
            result("baseline", "gpt-4-class", { passRate: 0.9 }),
            result("baseline", "gpt-3.5-class", { passRate: 0.7 }),
            result("mechanism", "gpt-4-class", { passRate: 0.9 }), // strong unchanged
            result("mechanism", "gpt-3.5-class", { passRate: 0.75 }), // weak +0.05
        ];
        const findings = computeCrossModel(CROSS_CONFIG, results).findings;
        expect(findings.some((f) => f.kind === "improves-only-weak")).toBe(true);
    });
    it("classifies a consistent improvement as consistent", () => {
        const results = [
            result("baseline", "gpt-4-class", { passRate: 0.9 }),
            result("baseline", "gpt-3.5-class", { passRate: 0.7 }),
            result("mechanism", "gpt-4-class", { passRate: 0.95 }),
            result("mechanism", "gpt-3.5-class", { passRate: 0.8 }),
        ];
        const counts = computeCrossModel(CROSS_CONFIG, results).counts;
        expect(counts["consistent"]).toBe(1);
        expect(counts["harms-weaker"]).toBeUndefined();
    });
    it("uses explicit modelCapabilities over ordering when provided", () => {
        const config = {
            ...CROSS_CONFIG,
            models: ["small", "large"],
            modelCapabilities: { small: "weak", large: "strong" },
        };
        const results = [
            result("baseline", "large", { passRate: 0.9 }),
            result("baseline", "small", { passRate: 0.7 }),
            result("mechanism", "large", { passRate: 0.95 }),
            result("mechanism", "small", { passRate: 0.5 }),
        ];
        const analysis = computeCrossModel(config, results);
        expect(analysis.model.strong).toBe("large");
        expect(analysis.model.weak).toBe("small");
        expect(analysis.findings.some((f) => f.kind === "harms-weaker")).toBe(true);
    });
});
describe("P2-15 harness run — per-model results and report wiring", () => {
    it("runs each variant under every model and tags results + comparisons + crossModel", async () => {
        let calls = 0;
        const harness = new ExperimentHarness({
            runBenchmark: async (variant, _config, model) => {
                calls += 1;
                const strongModel = model === "gpt-4-class";
                const basePass = strongModel ? 0.9 : 0.7;
                // Re-enact a harms-weaker mechanism deterministically.
                const delta = variant.name === "mechanism" ? (strongModel ? 0.05 : -0.2) : 0;
                return result(variant.name, model, { passRate: basePass + delta });
            },
        });
        const report = await harness.run(CROSS_CONFIG);
        expect(calls).toBe(4); // 2 variants × 2 models
        expect(report.results).toHaveLength(4);
        expect(report.results.map((r) => r.model).sort()).toEqual(["gpt-3.5-class", "gpt-3.5-class", "gpt-4-class", "gpt-4-class"]);
        expect(report.crossModel).toBeDefined();
        expect(report.crossModel.findings.some((f) => f.kind === "harms-weaker")).toBe(true);
        // Comparisons are model-confined: one comparison per model.
        expect(report.comparisons).toHaveLength(2);
        for (const cmp of report.comparisons) {
            expect(["gpt-4-class", "gpt-3.5-class"]).toContain(cmp.model);
        }
    });
    it("a per-model failure is recorded against that model only", async () => {
        const harness = new ExperimentHarness({
            runBenchmark: async (variant, _config, model) => {
                if (variant.name === "mechanism" && model === "gpt-3.5-class") {
                    throw new Error("weak model benchmark crashed");
                }
                return result(variant.name, model, { passRate: 0.8 });
            },
        });
        const report = await harness.run(CROSS_CONFIG);
        const weak = report.results.find((r) => r.variantName === "mechanism" && r.model === "gpt-3.5-class");
        expect(weak.status).toBe("failed");
        expect(weak.error).toContain("weak model benchmark crashed");
    });
});
//# sourceMappingURL=cross-model.test.js.map