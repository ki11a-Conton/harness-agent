/**
 * P3-17 — Formal Invariants.
 *
 * The key security properties of the harness are written as INVARIANT tests:
 * pure, deterministic predicate checks over recorded/structural facts. They are
 * deliberately NOT effect models and do NOT fabricate behaviour — each check
 * inspects a concrete snapshot (state timeline, capability claims, tool calls,
 * verification results, memory writes, network decisions, delegation records,
 * replay plan) and reports pass/fail with a reason.
 *
 * Numbering follows plan.md P3-17 and stays stable for consumers:
 *
 *   INV-001 terminal state cannot transition
 *   INV-002 child cannot gain parent-unavailable capability
 *   INV-003 unsafe tool is never auto retried
 *   INV-004 completed verification cannot be fabricated
 *   INV-005 child context isolation
 *   INV-006 benchmark holdout judge secrecy
 *   INV-007 memory unsafe content cannot persist
 *   INV-008 network denied cannot execute
 *   INV-009 delegation bounded
 *   INV-010 replay cannot duplicate known completed unsafe side effect
 *
 * Every invariant is exposed as both a standalone predicate and part of
 * `checkInvariants`, so the runtime can gate a release/commit on all of them
 * passing and a failure can be traced back to the exact violating record.
 */
import { isPathWithin } from "@ar/contracts";
export const ALL_INVARIANTS = [
    "INV-001",
    "INV-002",
    "INV-003",
    "INV-004",
    "INV-005",
    "INV-006",
    "INV-007",
    "INV-008",
    "INV-009",
    "INV-010",
];
function ok(invariant, label) {
    return { invariant, label, ok: true, violations: [] };
}
function bad(invariant, label, violations) {
    return { invariant, label, ok: violations.length === 0, violations };
}
export const TERMINAL_STATES = [
    "verified_complete",
    "failed",
    "cancelled",
    "security_denied",
];
export function isTerminalState(state) {
    return TERMINAL_STATES.includes(state);
}
/**
 * Given an ordered state timeline (oldest → newest) for one run/session, the
 * invariant holds iff no snapshot AFTER the first terminal snapshot differs
 * from it (i.e. a terminal state never transitions to another state).
 */
export function invTerminalStateCannotTransition(timeline) {
    const violations = [];
    let terminalSeen;
    for (const snap of timeline) {
        if (terminalSeen === undefined && isTerminalState(snap.state)) {
            terminalSeen = snap;
            continue;
        }
        if (terminalSeen !== undefined && snap.state !== terminalSeen.state) {
            violations.push({
                at: snap.at,
                detail: `run transitioned out of terminal state "${terminalSeen.state}" into "${snap.state}"`,
            });
        }
    }
    return bad("INV-001", "terminal state cannot transition", violations);
}
export const CAPABILITY_DIMENSIONS = [
    "tool",
    "filesystem",
    "network",
    "process",
];
function itemWithin(dimension, bound, needle) {
    if (bound === undefined)
        return false; // none conferred ⇒ nothing allowed
    if (bound.includes("*"))
        return true;
    if (dimension === "filesystem") {
        // P14-1: shared pure boundary-aware containment (no raw string prefix).
        // The invariant checker operates on already-canonical inputs, exactly like
        // composeCapabilities — a sibling root or traversal never masquerades as
        // inside the conferred root.
        return bound.some((root) => root === "*" || isPathWithin(needle, root, false));
    }
    return bound.includes(needle);
}
/**
 * The invariant holds iff for every dimension the child declared, every item it
 * declared is available to the parent (i.e. the child insists on nothing the
 * parent lacks). This is the no-escalation core of the capability boundary.
 */
export function invChildCapabilityIsConferredBound(claim) {
    const violations = [];
    for (const dimension of CAPABILITY_DIMENSIONS) {
        const declared = claim.declared[dimension] ?? [];
        const conferred = claim.conferred[dimension];
        for (const item of declared) {
            if (!itemWithin(dimension, conferred, item)) {
                violations.push({
                    at: `${dimension}:${item}`,
                    detail: `child declared "${item}" in ${dimension} which the parent does not confer`,
                });
            }
        }
    }
    return bad("INV-002", "child cannot gain parent-unavailable capability", violations);
}
/**
 * The invariant holds iff no unsafe tool is ever re-invoked by an automatic
 * retry. Manual/user-driven re-execution is allowed (and audited), but the
 * harness must never auto-retry a tool marked unsafe.
 */
export function invUnsafeToolNeverAutoRetried(calls) {
    const violations = [];
    for (const call of calls) {
        if (call.unsafe && call.autoRetry && call.retryAttempt > 0) {
            violations.push({
                at: call.toolId,
                detail: `unsafe tool auto-retried (attempt ${call.retryAttempt}); auto retry of an unsafe tool is forbidden`,
            });
        }
    }
    return bad("INV-003", "unsafe tool is never auto retried", violations);
}
/**
 * The invariant holds iff a reported pass is backed by at least one passed
 * check and some evidence; claiming completion on no data — or on a fully
 * failed check set — is treated as fabrication.
 */
export function invVerificationCannotBeFabricated(claims) {
    const violations = [];
    for (const claim of claims) {
        if (!claim.passed)
            continue; // a failed gate is fine
        const passedChecks = claim.checks.filter((c) => c.passed);
        if (passedChecks.length === 0) {
            violations.push({
                at: claim.caseId,
                detail: claim.checks.length === 0
                    ? "verification reported PASSED with zero checks (fabricated)"
                    : "verification reported PASSED while every check failed (fabricated)",
            });
        }
        else if (claim.evidence.length === 0) {
            violations.push({
                at: claim.caseId,
                detail: "verification reported PASSED with checks but no evidence artifact",
            });
        }
    }
    return bad("INV-004", "completed verification cannot be fabricated", violations);
}
/**
 * The invariant holds iff the child never observes anything it was not granted
 * — and in particular never observes parent-internal keys. Gaps are flagged.
 */
export function invChildContextIsolation(access) {
    const prefix = access.internalPrefix ?? "parent.";
    const violations = [];
    for (const obs of access.observed) {
        const granted = access.granted.includes(obs.key) || access.granted.includes("*");
        if (!granted) {
            violations.push({
                at: `${obs.at}:${obs.key}`,
                detail: `child observed context key "${obs.key}" that was not granted`,
            });
        }
        if (obs.key.startsWith(prefix)) {
            violations.push({
                at: `${obs.at}:${obs.key}`,
                detail: `child observed parent-internal context key "${obs.key}" (isolation breach)`,
            });
        }
    }
    return bad("INV-005", "child context isolation", violations);
}
/**
 * The invariant holds iff no holdout case is ever scored by a judge that has
 * not been activated for it — the judge must not see/score holdout answers
 * before activation, else the benchmark leaks into the pipeline.
 */
export function invHoldoutJudgeSecrecy(records) {
    const violations = [];
    for (const record of records) {
        if (record.holdout && !record.activated && record.scored) {
            violations.push({
                at: record.caseId,
                detail: "holdout case scored before judge activation (holdout secrecy breached)",
            });
        }
    }
    return bad("INV-006", "benchmark holdout judge secrecy", violations);
}
/**
 * The invariant holds iff unsafe content is never persisted. A write may be
 * rejected (good) but never both persisted and unsafe.
 */
export function invMemoryUnsafeContentCannotPersist(writes) {
    const violations = [];
    for (const write of writes) {
        if (write.unsafe && write.persisted) {
            violations.push({
                at: write.contentId,
                detail: write.rejected
                    ? "unsafe content was rejected yet still persisted (gate bypass)"
                    : "unsafe content persisted to memory",
            });
        }
    }
    return bad("INV-007", "memory unsafe content cannot persist", violations);
}
/**
 * The invariant holds iff a denied network action never executes. Deny must be
 * fail-closed: `allowed=false ⇒ executed=false`.
 */
export function invNetworkDeniedCannotExecute(decisions) {
    const violations = [];
    for (const decision of decisions) {
        if (!decision.allowed && decision.executed) {
            violations.push({
                at: decision.actionId,
                detail: "network action executed despite being denied by the network gate",
            });
        }
    }
    return bad("INV-008", "network denied cannot execute", violations);
}
/**
 * The invariant holds iff every delegation is within its depth bound, within
 * its fan-out count bound, and does not widen capability (subset/intersection).
 */
export function invDelegationBounded(records) {
    const violations = [];
    for (const record of records) {
        if (record.depth > record.maxDepth) {
            violations.push({
                at: record.delegateId,
                detail: `delegation depth ${record.depth} exceeds bound ${record.maxDepth}`,
            });
        }
        if (record.count > record.maxCount) {
            violations.push({
                at: record.delegateId,
                detail: `delegation fan-out ${record.count} exceeds bound ${record.maxCount}`,
            });
        }
        if (!record.capabilityNarrowed) {
            violations.push({
                at: record.delegateId,
                detail: "delegate effective capability is not a subset of the delegator's",
            });
        }
    }
    return bad("INV-009", "delegation bounded", violations);
}
/**
 * The invariant holds iff a replay never re-executes a side effect that is
 * already recorded as completed AND unsafe — such an effect must be replayed
 * as a no-op, not duplicated.
 */
export function invReplayNoDuplicateUnsafeSideEffect(known, replay) {
    const completedUnsafe = new Set(known.filter((s) => s.completed && s.unsafe).map((s) => s.effectId));
    const violations = [];
    for (const exec of replay) {
        if (exec.executed && completedUnsafe.has(exec.effectId)) {
            violations.push({
                at: exec.effectId,
                detail: "replay duplicated a known completed unsafe side effect (must be a no-op)",
            });
        }
    }
    return bad("INV-010", "replay cannot duplicate known completed unsafe side effect", violations);
}
/**
 * Run every invariant against one structural snapshot. Only provided sections
 * are checked; absent sections are treated as zero-violation (nothing to check,
 * which is a conservative "holds").
 */
const EMPTY_CAPABILITY_CLAIM = { conferred: {}, declared: {} };
export function checkInvariants(run) {
    const results = [];
    results.push(invTerminalStateCannotTransition(run.stateTimeline ?? []));
    results.push(invChildCapabilityIsConferredBound(run.capability ?? EMPTY_CAPABILITY_CLAIM));
    results.push(invUnsafeToolNeverAutoRetried(run.toolCalls ?? []));
    results.push(invVerificationCannotBeFabricated(run.verificationClaims ?? []));
    results.push(invChildContextIsolation(run.childContext ?? { granted: [], observed: [] }));
    results.push(invHoldoutJudgeSecrecy(run.scoring ?? []));
    results.push(invMemoryUnsafeContentCannotPersist(run.memoryWrites ?? []));
    results.push(invNetworkDeniedCannotExecute(run.networkDecisions ?? []));
    results.push(invDelegationBounded(run.delegations ?? []));
    results.push(invReplayNoDuplicateUnsafeSideEffect(run.sideEffects?.known ?? [], run.sideEffects?.replay ?? []));
    return results;
}
export function allPass(results) {
    return results.every((r) => r.ok);
}
export function violated(results) {
    return results.filter((r) => !r.ok);
}
/** Compact one-line-per-invariant rendering for gate summaries. */
export function renderInvariants(results) {
    return results
        .map((r) => {
        const status = r.ok ? "OK  " : "FAIL";
        const notes = r.ok ? "" : ` — ${r.violations.map((v) => v.at).join(", ")}`;
        return `${status} ${r.invariant} ${r.label}${notes}`;
    })
        .join("\n");
}
//# sourceMappingURL=formal-invariants.js.map