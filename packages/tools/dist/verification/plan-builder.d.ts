import type { VerificationSpec } from "@ar/contracts";
/**
 * P8-1: Verification Plan Builder. Instead of "every task runs the whole
 * repository", a plan narrows verification to what the change touched:
 *
 *   changed package → targeted test (when the change matches a test file)
 *                   → affected package test
 *                   → repo typecheck / build
 *
 * The plan is deterministic and command-driven: it consumes the discovered
 * workspace commands (P7-6 / discover_commands) and the turn's file change
 * set. No commands discovered → an honest empty plan (verification is not
 * invented).
 */
export interface VerificationPlanStep {
    kind: "command";
    command: string;
    /** Working directory for the step; defaults to the repo root. */
    cwd?: string;
    /** Required steps gate completion; optional steps are advisory only. */
    required: boolean;
}
export interface VerificationPlan {
    steps: VerificationPlanStep[];
    /** Human-readable reasoning for each step (evidence for the gate). */
    rationale: string[];
}
export interface VerificationPlanInput {
    root: string;
    filesChanged: readonly string[];
    /** kind → command (from command discovery: test/typecheck/build/...). */
    commands?: Record<string, string>;
}
/**
 * Build a deterministic verification plan for the change set.
 */
export declare function buildVerificationPlan(input: VerificationPlanInput): VerificationPlan;
/**
 * P8-1 runtime wiring: convert a VerificationPlan into the VerificationSpec
 * list a TaskVerifier executes. Command steps map to `command` specs with the
 * planned cwd; `required` is advisory for the completion gate (the verifier
 * has no per-step gating — P8-2 exposes every step as an event instead).
 */
export declare function planToVerificationSpecs(plan: VerificationPlan): VerificationSpec[];
//# sourceMappingURL=plan-builder.d.ts.map