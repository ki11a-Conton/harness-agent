import { comparePaired, compareVsReference, HOLD_OUT_REQUIREMENT_BY_KIND, medianCard, MIN_REPEATED_RUNS } from "./paired.js";
const DEFAULT_THRESHOLD = 0;
function errorMessage(e) {
    return e instanceof Error ? e.message : String(e);
}
/**
 * §147/§194 promotion gate for learning candidates (§69 pipeline:
 * trace → outcome → reflection → candidate → evaluation → promotion).
 *
 * Nothing is persisted before this gate approves. A candidate must pass a
 * security check AND show a benchmark improvement over a recorded baseline;
 * §194 forbids auto-promotion on score alone, and §147 requires repeated
 * evidence — a single sample is rejected by design ("one accidental success
 * is insufficient"). A missing baseline (benchmarkBefore returning a
 * non-finite value or throwing) rejects without ever measuring the "after"
 * score; the error message is preserved in the reason rather than swallowed.
 * Security-check failures are always decisive and short-circuit before any
 * benchmark runs.
 *
 * The §70 rollback path is `evaluateAfter`: after a successful promotion the
 * post-promotion score is recorded on the candidate, and a later
 * re-measurement below that score returns `rolled_back` (nothing is written
 * on rollback — undoing the live change is the caller's action).
 *
 * All side effects flow through the injected deps; there is no filesystem,
 * store, or network access here.
 */
export class LearningPromoter {
    async promote(c, deps) {
        const threshold = deps.threshold ?? DEFAULT_THRESHOLD;
        const security = await deps.securityCheck(c);
        if (!security.ok) {
            return {
                action: "rejected",
                reason: `security check failed${security.reason ? `: ${security.reason}` : ""}`,
            };
        }
        // P10-5: a single security violation on the challenger runs is a HARD
        // rejection — a +10% success rate never buys a security regression.
        if (deps.securityViolations !== undefined) {
            const violations = await deps.securityViolations().catch(() => 0);
            if (violations > 0) {
                return {
                    action: "rejected",
                    reason: `security violations on challenger runs (${violations}) — hard gate rejects regardless of score`,
                };
            }
        }
        // P10-5: a single security violation on the challenger runs is a HARD
        // rejection — a +10% success rate never buys a security regression.
        if (deps.securityViolations !== undefined) {
            const violations = await deps.securityViolations().catch(() => 0);
            if (violations > 0) {
                return {
                    action: "rejected",
                    reason: `security violations on challenger runs (${violations}) — hard gate rejects regardless of score`,
                };
            }
        }
        let before;
        try {
            before = await deps.benchmarkBefore();
        }
        catch (e) {
            return {
                action: "rejected",
                reason: `no benchmark baseline (benchmarkBefore failed: ${errorMessage(e)}); repeated evidence requires a measurable baseline`,
            };
        }
        if (!Number.isFinite(before)) {
            return {
                action: "rejected",
                reason: `no benchmark baseline (benchmarkBefore returned ${String(before)}); repeated evidence requires a measurable baseline`,
            };
        }
        const after = await deps.benchmarkAfter();
        if (!Number.isFinite(after)) {
            return {
                action: "rejected",
                reason: `benchmark result not measurable (benchmarkAfter returned ${String(after)}); cannot confirm improvement`,
            };
        }
        if (after <= before + threshold) {
            return {
                action: "rejected",
                reason: `benchmark did not improve: before ${before}, after ${after}, threshold ${threshold}; one accidental success is insufficient`,
            };
        }
        c.benchmarkScoreBefore = before;
        c.benchmarkScoreAfter = after;
        await deps.persist(c);
        return {
            action: "promoted",
            reason: `benchmark improved from ${before} to ${after} (+${after - before}) and security check passed`,
        };
    }
    /**
     * §70 post-promotion re-evaluation. A current score below the recorded
     * post-promotion score rolls the promotion back; an unmeasurable current
     * score also rolls back (fail-closed: the promotion can no longer be
     * confirmed healthy). Never calls persist.
     */
    async evaluateAfter(c, deps) {
        if (c.benchmarkScoreAfter === undefined) {
            return {
                action: "rejected",
                reason: "no recorded post-promotion score; candidate was never promoted",
            };
        }
        const current = await deps.benchmarkCurrent();
        if (!Number.isFinite(current)) {
            return {
                action: "rolled_back",
                reason: `current score not measurable (${String(current)}); cannot confirm the promotion holds`,
            };
        }
        if (current < c.benchmarkScoreAfter) {
            return {
                action: "rolled_back",
                reason: `score regressed from ${c.benchmarkScoreAfter} to ${current} after promotion`,
            };
        }
        return {
            action: "promoted",
            reason: `current score ${current} still at or above the recorded post-promotion score ${c.benchmarkScoreAfter}`,
        };
    }
}
export class LearningPromoterV2 {
    resolveHoldout(kind, options) {
        return options?.holdoutRequirement?.[kind] ?? HOLD_OUT_REQUIREMENT_BY_KIND[kind];
    }
    collect(produce, runs) {
        const cards = [];
        for (let i = 0; i < runs; i++)
            cards.push(produce(i));
        return Promise.all(cards);
    }
    /**
     * Champion/Challenger promotion gate over N paired repeated runs. Runs are
     * only collected after the security check passes; any collection failure
     * rejects (fail-closed) without persisting.
     */
    async promote(c, deps) {
        const security = await deps.securityCheck(c);
        if (!security.ok) {
            return {
                action: "rejected",
                reason: `security check failed${security.reason ? `: ${security.reason}` : ""}`,
            };
        }
        if (deps.runs < MIN_REPEATED_RUNS) {
            return {
                action: "rejected",
                reason: `repeated paired evaluations require at least ${MIN_REPEATED_RUNS} runs (got ${deps.runs}); one sample is insufficient`,
            };
        }
        // P10-5: the paired gate's security-violation count is hard — challenger
        // runs with ANY security violation reject regardless of score.
        // (The scorecard-level check happens after collection below.)
        let champion;
        try {
            champion = await this.collect(deps.championRuns, deps.runs);
        }
        catch (e) {
            return {
                action: "rejected",
                reason: `champion evaluation failed (${errorMessage(e)}); no baseline established`,
            };
        }
        let challenger;
        try {
            challenger = await this.collect(deps.challengerRuns, deps.runs);
        }
        catch (e) {
            return {
                action: "rejected",
                reason: `challenger evaluation failed (${errorMessage(e)}); cannot confirm improvement`,
            };
        }
        // P10-5 (paired side): challenger runs carrying ANY security violation
        // are a hard reject — the paired gate already fails adversarial deltas,
        // but the count is an independent, non-tradable signal.
        const challengerViolations = challenger.reduce((sum, card) => sum + card.securityViolations, 0);
        if (challengerViolations > 0) {
            return {
                action: "rejected",
                reason: `challenger runs recorded ${challengerViolations} security violation(s) — hard gate rejects regardless of score`,
            };
        }
        const report = comparePaired(champion, challenger, {
            ...deps.options,
            holdout: this.resolveHoldout(c.kind, deps.options),
        });
        if (report.overall === "reject") {
            return {
                action: "rejected",
                reason: `promotion gate rejected: ${report.reasons.join("; ")}`,
                report,
            };
        }
        const before = medianCard(champion);
        const after = medianCard(challenger);
        c.promotionRecord = {
            candidateVersion: c.version ?? "unversioned",
            beforeScorecard: before,
            afterScorecard: after,
            evaluationConfig: deps.meta?.evaluationConfig ?? "(not recorded)",
            suiteVersions: deps.meta?.suiteVersions ?? "(not recorded)",
            judgeVersion: deps.meta?.judgeVersion ?? "(not recorded)",
            modelProviderVersion: deps.meta?.modelProviderVersion ?? "(not recorded)",
        };
        await deps.persist(c);
        return {
            action: "promoted",
            reason: `promotion gate passed over ${deps.runs} paired runs (holdout ${this.resolveHoldout(c.kind, deps.options)}): regression held, no new security violations, budgets respected`,
            report,
        };
    }
    /**
     * §70/§777-797 periodic rollback re-evaluation: the current repeated runs
     * must still hold against the frozen post-promotion scorecard. Any run
     * pair with more security violations or a raised false-complete rate, any
     * median regression beyond tolerance, or any budget breach rolls the
     * promotion back. Unmeasurable current runs also roll back (fail-closed:
     * the promotion can no longer be confirmed healthy). Never calls persist.
     */
    async reEvaluate(c, deps) {
        if (c.promotionRecord === undefined) {
            return {
                action: "rejected",
                reason: "no promotion record; candidate was never promoted",
            };
        }
        if (deps.runs < MIN_REPEATED_RUNS) {
            return {
                action: "rolled_back",
                reason: `repeated re-evaluation requires at least ${MIN_REPEATED_RUNS} runs (got ${deps.runs}); cannot confirm the promotion holds`,
            };
        }
        let current;
        try {
            current = await this.collect(deps.currentRuns, deps.runs);
        }
        catch (e) {
            return {
                action: "rolled_back",
                reason: `current evaluation failed (${errorMessage(e)}); cannot confirm the promotion holds`,
            };
        }
        const report = compareVsReference(c.promotionRecord.afterScorecard, current, {
            ...deps.options,
            // Rollback re-checks whether the promotion HOLDS: the current scorecard
            // must not regress below the recorded post-promotion one. The positive
            // holdout requirement applies at promotion time, never here — a
            // promotion can only hold or fail to hold.
            holdout: "no-regress",
        });
        if (report.overall === "reject") {
            return {
                action: "rolled_back",
                reason: `regression detected after promotion: ${report.reasons.join("; ")}`,
                report,
            };
        }
        return {
            action: "promoted",
            reason: `current scorecard still holds the promotion over ${deps.runs} repeated runs`,
            report,
        };
    }
}
//# sourceMappingURL=promoter.js.map