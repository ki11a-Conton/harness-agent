const DEFAULT_IMPROVEMENT_THRESHOLD = 1;
let proposalSequence = 0;
/** Recursively collect every string in a payload (raw matching, no JSON escaping). */
function payloadStrings(payload) {
    const out = [];
    const walk = (value) => {
        if (typeof value === "string") {
            out.push(value);
        }
        else if (Array.isArray(value)) {
            for (const item of value)
                walk(item);
        }
        else if (typeof value === "object" && value !== null) {
            for (const member of Object.values(value))
                walk(member);
        }
    };
    walk(payload);
    return out;
}
function mentions(component, event) {
    return payloadStrings(event.payload).some((text) => text.includes(component.name) || text.includes(component.path));
}
/**
 * Create a `draft` proposal (§134 prediction → change). The target component
 * is the inventory entry most often mentioned by evidence payloads (ties →
 * first in inventory order); `evidenceRefs` records the ids of the evidence
 * events implicating it. Honest fallbacks: empty inventory → component
 * "unknown" with no refs; no mentions → first component with no refs (never a
 * fabricated association).
 */
export function proposeChange(deps) {
    proposalSequence += 1;
    const { inventory, evidence, hypothesis, expectedImprovement } = deps;
    let target;
    let best = 0;
    for (const component of inventory) {
        const score = evidence.filter((event) => mentions(component, event)).length;
        if (target === undefined || score > best) {
            target = component;
            best = score;
        }
    }
    return {
        id: `hc_${proposalSequence}`,
        hypothesis,
        expectedImprovement,
        component: target === undefined ? "unknown" : target.name,
        evidenceRefs: target === undefined
            ? []
            : evidence
                .filter((event) => mentions(target, event))
                .map((event) => event.id),
        status: "draft",
    };
}
function errorMessage(e) {
    return e instanceof Error ? e.message : String(e);
}
/**
 * §177 held-out evaluation gate (§150): accept only when the changed harness
 * improves success over the unchanged harness by at least `threshold`
 * (default 1) without a safety regression (zero-violation case count). A
 * missing baseline or a missing/errored after-benchmark rejects fail-closed
 * — acceptance without measured evidence is the §177 hazard. Status
 * transitions draft → accepted/rejected on the proposal object.
 */
export async function evaluateProposal(proposal, deps) {
    if (proposal.status !== "draft") {
        return {
            action: "reject",
            reason: `proposal ${proposal.id} is not in draft status (status: ${proposal.status}); a proposal is evaluated exactly once`,
        };
    }
    const threshold = deps.threshold ?? DEFAULT_IMPROVEMENT_THRESHOLD;
    let before;
    try {
        before = await deps.benchmarkBefore();
    }
    catch (e) {
        proposal.status = "rejected";
        return {
            action: "reject",
            reason: `no baseline benchmark (benchmarkBefore failed: ${errorMessage(e)}); repeated evidence requires a recorded pre-change baseline`,
        };
    }
    if (before === undefined) {
        proposal.status = "rejected";
        return {
            action: "reject",
            reason: "no baseline benchmark recorded; repeated evidence requires a recorded pre-change baseline",
        };
    }
    let after;
    try {
        after = await deps.benchmarkAfter();
    }
    catch (e) {
        proposal.status = "rejected";
        return {
            action: "reject",
            reason: `after-change benchmark failed (${errorMessage(e)}); acceptance requires a measured held-out comparison`,
        };
    }
    if (after === undefined) {
        proposal.status = "rejected";
        return {
            action: "reject",
            reason: "no after-change benchmark recorded; acceptance requires a measured held-out comparison",
        };
    }
    const gain = after.summary.b.success - after.summary.a.success;
    if (gain < threshold) {
        proposal.status = "rejected";
        return {
            action: "reject",
            reason: `no significant improvement: success went from ${after.summary.a.success} to ${after.summary.b.success} (gain ${gain}, threshold ${threshold})`,
        };
    }
    if (after.summary.b.safety < after.summary.a.safety) {
        proposal.status = "rejected";
        return {
            action: "reject",
            reason: `safety regression: zero-violation cases fell from ${after.summary.a.safety} to ${after.summary.b.safety}`,
        };
    }
    proposal.status = "accepted";
    return {
        action: "accept",
        reason: `success improved from ${after.summary.a.success} to ${after.summary.b.success} (gain ${gain}) with no safety regression (${after.summary.a.safety} → ${after.summary.b.safety} zero-violation cases)`,
    };
}
/**
 * §177 rollback: undo a change that regressed after acceptance. Requires an
 * accepted proposal (rolling back a never-accepted change is a caller bug and
 * throws); awaits `revert` exactly once, then marks the proposal rolled back.
 * A throwing `revert` propagates — never swallowed.
 */
export async function rollbackProposal(proposal, deps) {
    if (proposal.status !== "accepted") {
        throw new Error(`cannot roll back proposal ${proposal.id}: expected status "accepted", found "${proposal.status}"`);
    }
    await deps.revert();
    proposal.status = "rolled_back";
    return { action: "rolled_back" };
}
//# sourceMappingURL=harness-evolution.js.map