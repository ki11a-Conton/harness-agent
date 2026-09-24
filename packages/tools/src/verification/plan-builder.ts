import { classifyCommand } from "../command-classifier.js";
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

const TEST_FILE_RE = /\.(test|spec)\.(ts|tsx|js|jsx|mjs|cjs)$/;

/** Best-effort package directory of a changed file (dir containing its
 *  nearest package.json); falls back to the repo root. */
function packageDirOf(changedFile: string, root: string): string {
  const segments = changedFile.split("/");
  // Walk up: repo-relative "src/lib/a.ts" → package boundary heuristic:
  // treat the top-level dir as the package when it has no package.json
  // knowledge; a real implementation would consult the package manifest.
  if (segments.length > 1) return segments[0]!;
  return root;
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

  const changedTests = input.filesChanged.filter((file) => TEST_FILE_RE.test(file));
  const packageDirs = new Set(input.filesChanged.map((file) => packageDirOf(file, input.root)));

  if (testCommand !== undefined) {
    if (changedTests.length > 0) {
      // 1. Targeted: run the changed test file(s) directly.
      steps.push({ kind: "command", command: `${testCommand} ${changedTests.join(" ")}`, required: false });
      rationale.push(`targeted test for changed test file(s): ${changedTests.join(", ")}`);
    }
    if (packageDirs.size === 1 && [...packageDirs][0] !== input.root) {
      steps.push({ kind: "command", command: testCommand, cwd: [...packageDirs][0], required: true });
      rationale.push(`affected package test (package: ${[...packageDirs][0]})`);
    }
    if (!steps.some((step) => step.command === testCommand)) {
      steps.push({ kind: "command", command: testCommand, required: true });
      rationale.push("repository test suite");
    }
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
 * list a TaskVerifier executes. Command steps map to `command` specs with the
 * planned cwd; `required` is advisory for the completion gate (the verifier
 * has no per-step gating — P8-2 exposes every step as an event instead).
 */
export function planToVerificationSpecs(plan: VerificationPlan): VerificationSpec[] {
  return plan.steps
    .filter((step) => step.kind === "command")
    .map((step) => {
      const parts = step.command.split(/\s+/);
      const command = parts[0] ?? "";
      const args = parts.slice(1).filter((arg) => arg.length > 0);
      return {
        kind: "command" as const,
        command,
        ...(args.length > 0 ? { args } : {}),
        description: `planned: ${step.command}`,
      };
    });
}
