import { scoreCost } from "./cost-model.js";
import { seededRandom } from "./planner-executor.js";
export const ROUTING_THRESHOLD = 0.5;
/** A specialist lane needs this many cue hits before it may be chosen at all.
 *  A single keyword is too thin to trust and must fall back to the generalist. */
export const MIN_CUES_TO_ROUTE = 2;
/** Default specialist lanes (plan.md). Cues are structural, never model wording. */
export const DEFAULT_SPECIALISTS = [
    {
        type: "debugging",
        keywords: ["debug", "bug", "fix", "error", "exception", "crash", "trace", "stack"],
        pathHints: [],
    },
    {
        type: "coding",
        keywords: ["implement", "refactor", "function", "class", "module", "api", "feature"],
        pathHints: [],
    },
    {
        type: "research",
        keywords: ["research", "survey", "investigate", "search", "compare", "report"],
        pathHints: [],
    },
    {
        type: "docs",
        keywords: ["doc", "document", "comment", "readme", "usage", "explain", "guide"],
        pathHints: [".md", "doc", "docs", "readme"],
    },
    {
        type: "data",
        keywords: ["data", "csv", "dataset", "parse", "query", "aggregate", "clean"],
        pathHints: [".csv", ".json", ".tsv", "data", "dataset"],
    },
];
/**
 * Deterministic specialist classification. For each lane we count cue hits
 * across its keywords + path hints. A lane is routed ONLY when it is a *clear*
 * winner: it has at least `MIN_CUES_TO_ROUTE` hits and strictly beats every
 * other lane (a tie collapses to the generalist). Confidence is the winner's
 * margin over the runner-up, so it never penalizes a lane just for having many
 * cues the task happens not to hit.
 */
export function classifyTaskType(caseDef, specialists = DEFAULT_SPECIALISTS, threshold = ROUTING_THRESHOLD) {
    const text = (caseDef.task ?? "").toLowerCase();
    const paths = Object.keys(caseDef.fixture ?? {});
    const laneMatches = new Map();
    for (const specialist of specialists) {
        let matches = 0;
        for (const keyword of specialist.keywords) {
            if (text.includes(keyword))
                matches += 1;
        }
        for (const hint of specialist.pathHints) {
            if (paths.some((p) => p.toLowerCase().includes(hint)))
                matches += 1;
        }
        laneMatches.set(specialist.type, matches);
    }
    const ranked = [...laneMatches.entries()].sort((a, b) => b[1] - a[1]);
    const bestType = ranked[0]?.[0];
    const maxMatches = ranked[0]?.[1] ?? 0;
    // Strict lead: the winner beats every other lane; any tie at the top drops
    // both below the routing bar via `secondBest`.
    const secondBest = maxMatches > 0 ? Math.max(0, ...ranked.slice(1).map(([, m]) => m)) : 0;
    // Clear-winner rule: needs enough cues AND a strict lead (no tie).
    const clearWinner = maxMatches >= MIN_CUES_TO_ROUTE && maxMatches > secondBest;
    // Decisiveness margin vs the runner-up, scaled so it never punishes a lane
    // for having many keywords the task doesn't hit.
    const confidence = maxMatches <= 0 ? 0 : Math.min(1, maxMatches / (maxMatches + secondBest + 1));
    const usesSpecialist = clearWinner && confidence >= threshold;
    return {
        caseId: caseDef.id,
        type: usesSpecialist && bestType !== undefined ? bestType : "generalist",
        confidence: round(confidence),
        cues: maxMatches,
        usesSpecialist,
    };
}
export const DEFAULT_ROUTER_MODEL = {
    routingTokensPerCase: 400,
    routingLatencyMsPerCase: 600,
    specialistPassGain: 0.15,
    mismatchPassPenalty: 0.2,
    fallbackOnLowConfidence: true,
};
// ---------------------- Simulation ------------------------------------------
function resolveRouterModel(partial) {
    const m = DEFAULT_ROUTER_MODEL;
    return {
        routingTokensPerCase: partial?.routingTokensPerCase ?? m.routingTokensPerCase,
        routingLatencyMsPerCase: partial?.routingLatencyMsPerCase ?? m.routingLatencyMsPerCase,
        specialistPassGain: partial?.specialistPassGain ?? m.specialistPassGain,
        mismatchPassPenalty: partial?.mismatchPassPenalty ?? m.mismatchPassPenalty,
        fallbackOnLowConfidence: partial?.fallbackOnLowConfidence ?? m.fallbackOnLowConfidence,
    };
}
/**
 * Simulate a routing-policy run for one case. The generalist is the identity
 * champion. The specialist_router adds the routing pass; when routed to the
 * *correct* specialist it stochastically lifts pass, when mis-routed it
 * stochastically drops pass, and low-confidence tasks fall back to the
 * generalist behavior. Seeded for reproducibility.
 *
 * Correctness is decided against `truthLane` when the caller supplies it (a
 * judge/known-answer truth layer that never feeds the router's own decision);
 * when omitted, a documented confidence heuristic is used instead.
 */
export function simulateSpecialistRun(outcome, decision, policy, options = {}) {
    const model = resolveRouterModel(options.model);
    const random = seededRandom((options.seed ?? 7) + outcome.caseId.length * 3);
    const passed = outcome.status === "passed";
    const tokens = outcome.metrics.tokens_input + outcome.metrics.tokens_output;
    if (policy === "generalist") {
        return {
            caseId: outcome.caseId,
            policy,
            routed: false,
            routedCorrect: false,
            routedWrong: false,
            passed,
            tokens,
            durationMs: outcome.metrics.duration_ms,
        };
    }
    const routed = model.fallbackOnLowConfidence ? decision.usesSpecialist : true;
    if (!routed) {
        // Fall back to generalist behavior, but still pay the routing pass.
        return {
            caseId: outcome.caseId,
            policy,
            routed: false,
            routedCorrect: false,
            routedWrong: false,
            passed,
            tokens: tokens + model.routingTokensPerCase,
            durationMs: outcome.metrics.duration_ms + model.routingLatencyMsPerCase,
        };
    }
    // Correct vs mis-routed: prefer an explicit truth lane; else the documented
    // confidence heuristic (a routed decision with thin cue support is likely a
    // mis-route).
    let routedCorrect;
    let routedWrong;
    if (options.truthLane !== undefined) {
        routedCorrect = decision.type === options.truthLane;
        routedWrong = decision.type !== options.truthLane;
    }
    else {
        routedWrong = isThinlySupported(decision);
        routedCorrect = !routedWrong;
    }
    let effectivePass = passed;
    // Pass-gain: recover a fraction of previously-failed correct-routed cases.
    if (routedCorrect && !passed && random() < model.specialistPassGain) {
        effectivePass = true;
    }
    // Mismatch penalty: regress previously-passed mis-routed cases.
    if (routedWrong && passed && random() < model.mismatchPassPenalty) {
        effectivePass = false;
    }
    return {
        caseId: outcome.caseId,
        policy,
        routed: true,
        routedCorrect,
        routedWrong,
        passed: effectivePass,
        tokens: tokens + model.routingTokensPerCase,
        durationMs: outcome.metrics.duration_ms + model.routingLatencyMsPerCase,
    };
}
/** Mismatch heuristic: a routed decision whose winning lane has sparse cue
 *  support is treated as a likely mis-route (the classifier over-reached). */
function isThinlySupported(decision) {
    return decision.usesSpecialist && decision.cues <= 1;
}
// ---------------------- Aggregation & gate ---------------------------------
export function aggregateSpecialist(runs, policy, cost) {
    const passed = runs.filter((r) => r.passed).length;
    const costResult = scoreCost({
        status: runs.length > 0 && passed === runs.length ? "passed" : "failed",
        violations: [],
        metrics: {
            turn_count: runs.length,
            tool_call_count: runs.reduce((s, r) => (r.passed ? 1 : 0) + s, 0),
            tokens_input: Math.round(runs.reduce((s, r) => s + r.tokens, 0) * 0.7),
            tokens_output: Math.round(runs.reduce((s, r) => s + r.tokens, 0) * 0.3),
            context_tokens: 0,
            duration_ms: runs.reduce((s, r) => s + r.durationMs, 0),
            retry_count: 0,
            verification_failures: 0,
            human_interventions: 0,
            compaction_count: 0,
            estimated_cost: 0,
        },
        events: [],
    }, cost ?? {});
    return {
        policy,
        passRate: runs.length === 0 ? 0 : passed / runs.length,
        routedCount: runs.filter((r) => r.routed).length,
        correctlyRouted: runs.filter((r) => r.routedCorrect).length,
        misRouted: runs.filter((r) => r.routedWrong).length,
        totalTokens: runs.reduce((s, r) => s + r.tokens, 0),
        totalDurationMs: runs.reduce((s, r) => s + r.durationMs, 0),
        costScore: costResult.score,
    };
}
export function decideRoutingPromotion(input) {
    const minimumPassGain = input.gate?.minimumPassGain ?? 0.05;
    const maxMismatchRatio = input.gate?.maxMismatchRatio ?? 0.3;
    if (!input.asked) {
        // Nothing was ever routed: routing is pointless overhead.
        return {
            promote: false,
            code: "no_gain",
            reason: "rejected: no case was routed, so the router added only overhead",
            minimumPassGain,
            maxMismatchRatio,
        };
    }
    if (input.passDelta < minimumPassGain) {
        return {
            promote: false,
            code: "no_gain",
            reason: `rejected: specialist routing lifted pass rate by only ${round(input.passDelta)} (< ${minimumPassGain}); a token/latency-only router is not promotable`,
            minimumPassGain,
            maxMismatchRatio,
        };
    }
    if (input.mismatchRatio > maxMismatchRatio) {
        return {
            promote: false,
            code: "mismatch_regression",
            reason: `rejected: mis-routing ratio ${round(input.mismatchRatio, 3)} exceeds tolerance ${maxMismatchRatio}`,
            minimumPassGain,
            maxMismatchRatio,
        };
    }
    if (input.costScoreDelta <= 0) {
        return {
            promote: false,
            code: "cost_negative",
            reason: `rejected: cost-model delta ${round(input.costScoreDelta)} is not positive, so routing cost ate the value`,
            minimumPassGain,
            maxMismatchRatio,
        };
    }
    return {
        promote: true,
        code: "promote",
        reason: `promote: pass rate +${round(input.passDelta)} (≥ ${minimumPassGain}), mis-route ${round(input.mismatchRatio, 3)} (≤ ${maxMismatchRatio}), cost score +${round(input.costScoreDelta)}`,
        minimumPassGain,
        maxMismatchRatio,
    };
}
/** Run the Specialist Routing experiment end-to-end. */
export async function runRoutingExperiment(cases, runWorker, options = {}) {
    const baseline = [];
    const challenger = [];
    let asked = false;
    for (const caseDef of cases) {
        const outcome = await runWorker(caseDef);
        const decision = classifyTaskType(caseDef, options.specialists);
        const cfg = { model: options.model, seed: options.seed };
        const truthLane = options.truth?.(caseDef);
        baseline.push(simulateSpecialistRun(outcome, decision, "generalist", {
            model: options.model,
            seed: options.seed,
        }));
        const c = simulateSpecialistRun(outcome, decision, "specialist_router", {
            ...cfg,
            truthLane,
        });
        if (c.routed)
            asked = true;
        challenger.push(c);
    }
    const baselineAgg = aggregateSpecialist(baseline, "generalist", options.cost);
    const challengerAgg = aggregateSpecialist(challenger, "specialist_router", options.cost);
    const tokenDeltaRatio = baselineAgg.totalTokens === 0
        ? 0
        : (challengerAgg.totalTokens - baselineAgg.totalTokens) / baselineAgg.totalTokens;
    const latencyDeltaRatio = baselineAgg.totalDurationMs === 0
        ? 0
        : (challengerAgg.totalDurationMs - baselineAgg.totalDurationMs) / baselineAgg.totalDurationMs;
    const decision = decideRoutingPromotion({
        passDelta: challengerAgg.passRate - baselineAgg.passRate,
        mismatchRatio: challengerAgg.misRouted === 0
            ? 0
            : challengerAgg.misRouted / Math.max(1, challengerAgg.routedCount),
        costScoreDelta: challengerAgg.costScore - baselineAgg.costScore,
        asked,
        gate: options.gate,
    });
    return {
        baseline: baselineAgg,
        challenger: challengerAgg,
        cases: challenger,
        passDelta: challengerAgg.passRate - baselineAgg.passRate,
        routedRatio: challengerAgg.routedCount / Math.max(1, challenger.length),
        mismatchRatio: challengerAgg.misRouted === 0
            ? 0
            : challengerAgg.misRouted / Math.max(1, challengerAgg.routedCount),
        tokenDeltaRatio,
        latencyDeltaRatio,
        costScoreDelta: challengerAgg.costScore - baselineAgg.costScore,
        decision,
    };
}
export function renderSpecialistComparison(cmp) {
    return [
        "Specialist Routing Experiment",
        `cases: ${cmp.cases.length}`,
        `decision: ${cmp.decision.promote ? "PROMOTE" : "REJECT"} (${cmp.decision.code})`,
        cmp.decision.reason,
        "",
        `  pass rate                   ${round(cmp.baseline.passRate, 3)} → ${round(cmp.challenger.passRate, 3)}  (Δ ${round(cmp.passDelta, 3)})`,
        `  routed / mis-routed         ${cmp.challenger.routedCount} / ${cmp.challenger.misRouted}`,
        `  tokens                      ${cmp.baseline.totalTokens} → ${cmp.challenger.totalTokens}  (Δ ${round(cmp.tokenDeltaRatio * 100, 1)}%)`,
        `  latency (ms)                ${cmp.baseline.totalDurationMs} → ${cmp.challenger.totalDurationMs}  (Δ ${round(cmp.latencyDeltaRatio * 100, 1)}%)`,
        `  cost score                  ${cmp.baseline.costScore.toFixed(3)} → ${cmp.challenger.costScore.toFixed(3)}  (Δ ${round(cmp.costScoreDelta, 3)})`,
    ].join("\n");
}
function round(value, digits = 4) {
    const factor = 10 ** digits;
    return Math.round(value * factor) / factor;
}
//# sourceMappingURL=specialist-routing.js.map