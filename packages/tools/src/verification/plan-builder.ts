import type { VerificationSpec } from "@ar/contracts";

/**
 * P8-1: Verification Plan Builder. Runs the discovered repository test,
 * typecheck and build entrypoints without changing their shell semantics.
 *
 * The plan is deterministic and command-driven: it consumes the discovered
 * workspace commands (P7-6 / discover_commands). A recipe does not establish
 * a runner's filename argument contract or a package working directory, so
 * changed paths cannot be interpolated into it. No commands discovered → an
 * honest empty plan (verification is not invented).
 */

export interface VerificationPlanStep {
  kind: "command";
  command: string;
  /** Host metadata; command specs execute in the verification context cwd.
   *  Discovered recipes never infer a package working directory. */
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
export function buildVerificationPlan(input: VerificationPlanInput): VerificationPlan {
  const steps: VerificationPlanStep[] = [];
  const rationale: string[] = [];
  const testCommand = input.commands?.["test"];
  const typecheckCommand = input.commands?.["typecheck"];
  const buildCommand = input.commands?.["build"];

  if (testCommand !== undefined) {
    steps.push({ kind: "command", command: testCommand, required: true });
    rationale.push("repository test suite — original discovered entrypoint");
  } else {
    rationale.push("no test command discovered — no test step planned");
  }

  if (typecheckCommand !== undefined) {
    steps.push({ kind: "command", command: typecheckCommand, required: false });
    rationale.push("repository typecheck");
  }
  if (buildCommand !== undefined) {
    steps.push({ kind: "command", command: buildCommand, required: false });
    rationale.push("repository build");
  }

  return { steps, rationale };
}

/**
 * P8-1 runtime wiring: convert a VerificationPlan into the VerificationSpec
 * list a TaskVerifier executes. Recipes remain full `command` strings with
 * no `args`: TaskVerifier must use its shell-recipe path rather than interpret
 * quoted source, operators or spaced paths as an argv vector. Explicit
 * program+args task specs do not pass through this conversion.
 * `required` is advisory for the completion gate (the verifier
 * has no per-step gating — P8-2 exposes every step as an event instead).
 */
export function planToVerificationSpecs(plan: VerificationPlan): VerificationSpec[] {
  return plan.steps
    .filter((step) => step.kind === "command")
    .map((step) => ({
      kind: "command" as const,
      command: step.command,
      description: `planned: ${step.command}`,
    }));
}
