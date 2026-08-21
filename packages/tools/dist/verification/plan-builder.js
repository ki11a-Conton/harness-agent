import { classifyCommand } from "../command-classifier.js";
const TEST_FILE_RE = /\.(test|spec)\.(ts|tsx|js|jsx|mjs|cjs)$/;
/** Best-effort package directory of a changed file (dir containing its
 *  nearest package.json); falls back to the repo root. */
function packageDirOf(changedFile, root) {
    const segments = changedFile.split("/");
    // Walk up: repo-relative "src/lib/a.ts" → package boundary heuristic:
    // treat the top-level dir as the package when it has no package.json
    // knowledge; a real implementation would consult the package manifest.
    if (segments.length > 1)
        return segments[0];
    return root;
}
/**
 * Build a deterministic verification plan for the change set.
 */
export function buildVerificationPlan(input) {
    const steps = [];
    const rationale = [];
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
    }
    else {
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
export function planToVerificationSpecs(plan) {
    return plan.steps
        .filter((step) => step.kind === "command")
        .map((step) => {
        const parts = step.command.split(/\s+/);
        const command = parts[0] ?? "";
        const args = parts.slice(1).filter((arg) => arg.length > 0);
        return {
            kind: "command",
            command,
            ...(args.length > 0 ? { args } : {}),
            description: `planned: ${step.command}`,
        };
    });
}
//# sourceMappingURL=plan-builder.js.map