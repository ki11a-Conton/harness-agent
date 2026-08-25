/**
 * P8-4: ONE command classifier shared by command discovery, verification plan
 * building and working-state classification. Before this, each subsystem had
 * its own regex matching (discovery's kind tagging, the verifier's command
 * matching, working-state build/test classification) — a single source keeps
 * "is this a test command?" consistent everywhere.
 */

export type CommandCategory =
  | "test"
  | "build"
  | "lint"
  | "typecheck"
  | "check"
  | "verify"
  | "other";

export interface CommandClassification {
  category: CommandCategory;
  confidence: "high" | "medium" | "low";
}

/** Classify an arbitrary command string by keyword. `other` is the honest
 *  answer when nothing matches (never guess). */
export function classifyCommand(command: string): CommandClassification {
  const lower = command.toLowerCase();
  if (lower.includes("typecheck") || /tsc\s+--(noemit|noEmit)/.test(lower)) {
    return { category: "typecheck", confidence: "high" };
  }
  if (/lint|eslint|clippy|flake8|ruff check|pylint/.test(lower)) {
    return { category: "lint", confidence: "high" };
  }
  if (/verify/.test(lower)) return { category: "verify", confidence: "medium" };
  if (/\bcheck\b/.test(lower)) return { category: "check", confidence: "medium" };
  if (/build/.test(lower)) return { category: "build", confidence: "high" };
  if (/test|jest|vitest|pytest|mocha|go test|cargo test/.test(lower)) {
    return { category: "test", confidence: "high" };
  }
  return { category: "other", confidence: "low" };
}
