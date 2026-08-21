/**
 * Q-1: verification gate extracted from runtime.ts. Owns the single
 * runVerificationGate method — completion-policy checks (no-side-effects /
 * requires-changed-file / requires-verification) plus the RuntimeVerifier
 * wiring. Method body is byte-for-byte the one that lived on AgentRuntime;
 * only `this.<field>` → `this.deps.<field>` changed.
 */
import type { SessionStore, TaskSpec, VerificationSpec, Verifier } from "@ar/contracts";
import type { TurnContext } from "./turn-helpers.js";
export interface VerificationGateResult {
    status: "passed" | "failed" | "blocked";
    reason: string;
}
export interface VerificationControllerDeps {
    task?: TaskSpec;
    verifier?: Verifier;
    store: SessionStore;
    now: () => number;
    changedPathsProvider?: () => readonly string[];
    baselineFilesProvider?: () => readonly string[];
    /**
     * P8-1: runtime-side verification plan auto-orchestration. When the task
     * carries no verification specs, the planner derives them from the change
     * set (and discovered commands) and the gate runs them. An empty plan is an
     * honest "nothing to verify" — the TaskVerifier still fails closed.
     */
    planVerification?: (input: {
        task: TaskSpec;
        changedPaths: string[];
        cwd: string;
    }) => VerificationSpec[] | Promise<VerificationSpec[]>;
}
export declare class VerificationController {
    private readonly deps;
    constructor(deps: VerificationControllerDeps);
    runVerificationGate(ctx: TurnContext): Promise<VerificationGateResult | undefined>;
}
//# sourceMappingURL=verification-controller.d.ts.map