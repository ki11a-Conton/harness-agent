/**
 * Q-1: verification gate extracted from runtime.ts. Owns the single
 * runVerificationGate method — completion-policy checks (no-side-effects /
 * requires-changed-file / requires-verification) plus the RuntimeVerifier
 * wiring. Method body is byte-for-byte the one that lived on AgentRuntime;
 * only `this.<field>` → `this.deps.<field>` changed.
 */
import { RuntimeVerifier } from "../verification/runtime-verifier.js";
export class VerificationController {
    deps;
    constructor(deps) {
        this.deps = deps;
    }
    async runVerificationGate(ctx) {
        const { session, turnId } = ctx;
        // P1-15: completion policy runs before the verifier — objective task
        // requirements gate completion even when no verifier is configured.
        const policy = this.deps.task?.completionPolicy;
        const changed = [...(this.deps.changedPathsProvider?.() ?? [])];
        if (policy?.requiresNoSideEffects === true && changed.length > 0) {
            const sample = changed.slice(0, 5).join(", ");
            return {
                status: "failed",
                reason: `completion policy: task requires no side effects but ${changed.length} file(s) changed (${sample}${changed.length > 5 ? ", …" : ""})`,
            };
        }
        if (policy?.requiresChangedFile === true && changed.length === 0) {
            return {
                status: "failed",
                reason: "completion policy: task requires a changed file but nothing was changed",
            };
        }
        if (this.deps.task === undefined || this.deps.verifier === undefined) {
            if (policy?.requiresVerification === true && this.deps.verifier === undefined) {
                return {
                    status: "blocked",
                    reason: "completion policy: task requires verification but no verifier is configured",
                };
            }
            return undefined;
        }
        // P8-1: auto-orchestrated verification plan — derive specs from the change
        // set when the task did not declare any. The gate always runs on the same
        // path (explicit specs win; a planner output of [] keeps the TaskVerifier's
        // deterministic fail-closed level-0 result).
        const task = this.deps.task;
        let verification = task.verification;
        if ((verification === undefined || verification.length === 0) && this.deps.planVerification !== undefined) {
            verification = await this.deps.planVerification({
                task,
                changedPaths: changed,
                cwd: session.cwd,
            });
        }
        const gate = await new RuntimeVerifier(this.deps.verifier).verifyTurn(verification === undefined ? task : { ...task, verification }, session.id, turnId, this.deps.store, {
            cwd: session.cwd,
            runStartedAt: this.deps.now(),
            changedPaths: changed,
            ...(this.deps.baselineFilesProvider !== undefined
                ? { baselineFiles: [...this.deps.baselineFilesProvider()] }
                : {}),
        });
        return { status: gate.status, reason: gate.reason };
    }
}
//# sourceMappingURL=verification-controller.js.map