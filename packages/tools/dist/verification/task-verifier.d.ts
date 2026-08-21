import type { SessionId, TaskSpec, VerificationContext, VerificationResult, Verifier } from "@ar/contracts";
import { ProcessExecutor } from "../process/executor.js";
export interface TaskVerifierDeps {
    executor?: ProcessExecutor;
    /** P8-2: per-step evidence callback (verification.step_started /
     *  verification.step_completed in the runtime). Receives the stable step
     *  ref so subagent testsRun and reports can reference it, plus the session
     *  id so the host can attribute the event without another lookup. */
    onStep?: (event: {
        ref: string;
        phase: "started" | "completed";
        kind: string;
        description: string;
        passed?: boolean;
        detail?: string;
        sessionId?: SessionId;
    }) => void;
}
/**
 * TaskVerifier (VS-001): executes the verification specs of a TaskSpec.
 *
 * - command    → runs the command; pass = exit code 0 (uses ProcessExecutor)
 * - artifact   → pass = file exists (and, for mustChange, appeared in changedPaths)
 * - requirement→ cannot be verified automatically; fails closed until a model
 *                reviewer is wired (documented limitation, no fake passes).
 *
 * The verifier is a pure service: no permission/sandbox short-circuits here;
 * commands are expected to arrive pre-authorized from the agent runtime.
 */
export declare class TaskVerifier implements Verifier {
    private readonly executor;
    private readonly onStep?;
    constructor(deps?: TaskVerifierDeps);
    /** cwd-relative POSIX-style path for glob matching. */
    private rel;
    verify(task: TaskSpec, context: VerificationContext): Promise<VerificationResult>;
    private runCheck;
    /** P1-14: diff check — expected change set vs. unexpected destructive edits.
     *  Paths are matched the same way artifact checks match (cwd-relative,
     *  normalized, case-insensitive on case-insensitive filesystems). */
    private checkDiff;
    private checkCommand;
    private checkArtifact;
    private checkRequirement;
    private err;
}
//# sourceMappingURL=task-verifier.d.ts.map