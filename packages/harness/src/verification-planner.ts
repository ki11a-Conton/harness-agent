import type { TaskSpec, VerificationSpec } from "@ar/contracts";
import { buildVerificationPlan, planToVerificationSpecs } from "@ar/tools";
import type { CommandHints } from "./command-discovery-service.js";

/**
 * P8-1: verification plan builder wired into the harness runtime.
 *
 * When a task declares no verification specs, the runtime asks this planner to
 * derive them from the change set and the discovered workspace commands
 * (P7-6 / discover_commands): original repo test → typecheck → build. A recipe
 * does not justify appending changed paths or guessing a package cwd.
 * No commands discovered → an honest empty
 * plan (verification is never invented; the TaskVerifier fails closed).
 */

export interface VerificationPlannerDeps {
  /** Lazy command-hints source (the harness CommandDiscoveryService). */
  commands?: ((cwd: string) => Promise<CommandHints | undefined>) | CommandHints;
}

export function createVerificationPlanner(
  deps: VerificationPlannerDeps = {},
): (input: { task: TaskSpec; changedPaths: string[]; cwd: string }) => Promise<VerificationSpec[]> {
  return async ({ changedPaths, cwd }) => {
    const hints = typeof deps.commands === "function" ? await deps.commands(cwd) : deps.commands;
    const plan = buildVerificationPlan({
      root: cwd,
      filesChanged: changedPaths,
      ...(hints !== undefined ? { commands: hints.commands } : {}),
    });
    return planToVerificationSpecs(plan);
  };
}
