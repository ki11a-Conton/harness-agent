import type { AgentEvent } from "@ar/contracts";
import type { BenchReport } from "@ar/evaluation";
import type { ComponentInventory } from "./inventory.js";
/**
 * §134/§177 harness change lifecycle: propose a change with trace evidence,
 * evaluate it against a held-out head-to-head benchmark (§133/§150), and
 * roll it back when it regresses. Read-only scaffolding — nothing here
 * mutates the harness; all side effects flow through injected deps.
 */
export type HarnessChangeStatus = "draft" | "accepted" | "rejected" | "rolled_back";
export interface HarnessChangeProposal {
    id: string;
    hypothesis: string;
    expectedImprovement: string;
    /** Inventory component the change targets ("unknown" when the inventory is empty). */
    component: string;
    /** Ids of the evidence events that implicate the target component, in evidence order. */
    evidenceRefs: string[];
    status: HarnessChangeStatus;
}
export interface EvaluateProposalDeps {
    /** Pre-change baseline (§147: repeated evidence requires a recorded baseline). */
    benchmarkBefore: () => Promise<BenchReport | undefined>;
    /** Held-out comparison after the change: summary.a = unchanged, summary.b = changed harness. */
    benchmarkAfter: () => Promise<BenchReport | undefined>;
    /** Minimum required success gain; boundary inclusive (default 1). */
    threshold?: number;
}
export type EvaluateProposalResult = {
    action: "accept" | "reject";
    reason: string;
};
export interface RollbackProposalDeps {
    revert: () => Promise<void>;
}
export type RollbackProposalResult = {
    action: "rolled_back";
};
/**
 * Create a `draft` proposal (§134 prediction → change). The target component
 * is the inventory entry most often mentioned by evidence payloads (ties →
 * first in inventory order); `evidenceRefs` records the ids of the evidence
 * events implicating it. Honest fallbacks: empty inventory → component
 * "unknown" with no refs; no mentions → first component with no refs (never a
 * fabricated association).
 */
export declare function proposeChange(deps: {
    inventory: ComponentInventory[];
    evidence: AgentEvent[];
    hypothesis: string;
    expectedImprovement: string;
}): HarnessChangeProposal;
/**
 * §177 held-out evaluation gate (§150): accept only when the changed harness
 * improves success over the unchanged harness by at least `threshold`
 * (default 1) without a safety regression (zero-violation case count). A
 * missing baseline or a missing/errored after-benchmark rejects fail-closed
 * — acceptance without measured evidence is the §177 hazard. Status
 * transitions draft → accepted/rejected on the proposal object.
 */
export declare function evaluateProposal(proposal: HarnessChangeProposal, deps: EvaluateProposalDeps): Promise<EvaluateProposalResult>;
/**
 * §177 rollback: undo a change that regressed after acceptance. Requires an
 * accepted proposal (rolling back a never-accepted change is a caller bug and
 * throws); awaits `revert` exactly once, then marks the proposal rolled back.
 * A throwing `revert` propagates — never swallowed.
 */
export declare function rollbackProposal(proposal: HarnessChangeProposal, deps: RollbackProposalDeps): Promise<RollbackProposalResult>;
//# sourceMappingURL=harness-evolution.d.ts.map