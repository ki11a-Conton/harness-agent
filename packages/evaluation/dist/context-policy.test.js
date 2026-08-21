import { describe, expect, it } from "vitest";
import { chooseBestContextPolicy, runPolicyEffects } from "./context-policy.js";
function assess(name, passes, total, tokens, drops) {
    const runs = Array.from({ length: total }, (_, i) => ({
        passed: i < passes,
        tokens,
        droppedContext: drops > 0 && i < drops,
    }));
    // Reuse runPolicyEffects for realism, then recompute costShape manually.
    const eff = runPolicyEffects(runs, runs.map((r) => r.passed));
    void eff;
    const passed = runs.filter((r) => r.passed && !r.droppedContext).length;
    const criticalDrops = runs.filter((r) => r.droppedContext).length;
    const totalTokens = runs.reduce((s, r) => s + r.tokens, 0);
    const passRate = total === 0 ? 0 : passed / total;
    const tokenFactor = totalTokens > 0 ? Math.min(1, 32_000 / totalTokens) : 1;
    return {
        name,
        costScore: Math.round(passRate * 100 * (0.8 + 0.2 * tokenFactor)),
        passRate,
        totalTokens,
        criticalDrops,
    };
}
const CHAMP = assess("champion", 7, 10, 1500, 0); // pass 0.7
describe("P3-11 context policy — benchmark auto-select", () => {
    it("promotes the best cost-adjusted policy that beats the champion", () => {
        const candidates = [
            assess("compact-early", 8, 10, 1000, 0), // pass 0.8
            assess("topk-2", 6, 10, 900, 0),
        ];
        const d = chooseBestContextPolicy(CHAMP, candidates);
        expect(d.keepChampion).toBe(false);
        expect(d.promotedName).toBe("compact-early");
    });
    it("rejects a policy that drops critical context even if it looks fast", () => {
        const dropping = assess("aggressive", 9, 10, 400, 2); // 2 critical drops
        const d = chooseBestContextPolicy(CHAMP, [dropping], { maxCriticalDrops: 0 });
        expect(d.keepChampion).toBe(true);
        expect(d.promotedName).toBe(null);
        expect(d.reasons.join(" ")).toContain("excluded");
    });
    it("keeps the champion when nothing beats it", () => {
        const d = chooseBestContextPolicy(CHAMP, [assess("weaker", 6, 10, 1500, 0)]);
        expect(d.keepChampion).toBe(true);
    });
});
//# sourceMappingURL=context-policy.test.js.map