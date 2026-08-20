/**
 * P0-13: command classification for the agent's working state.
 * Classifies shell commands into kinds so the runtime can distinguish
 * test runs from typechecks, builds, lints, etc.
 */

export type CommandKind =
  | "test"
  | "typecheck"
  | "build"
  | "lint"
  | "format"
  | "package_install"
  | "git"
  | "general";

export interface ClassifiedCommand {
  command: string;
  kind: CommandKind;
  confidence: "high" | "medium" | "low";
}

/** High-confidence test patterns. */
const TEST_PATTERNS = [
  /\b(vitest|jest|pytest|go\s+test|cargo\s+test|cargo\s+nextest|mvn\s+test|gradle\s+test)\b/i,
  /\bpnpm\s+test\b/, /\bnpm\s+(run\s+)?test\b/, /\bnode\s+.*test\b/i,
];

/** High-confidence typecheck patterns. */
const TYPECHECK_PATTERNS = [
  /\b(tsc)\b/, /\b(pnpm\s+typecheck|npm\s+run\s+typecheck)\b/,
  /\b(pyright|mypy|flow\s+check)\b/i,
];

/** High-confidence build patterns. */
const BUILD_PATTERNS = [
  /\b(pnpm\s+build|npm\s+run\s+build|npm\s+build|yarn\s+build)\b/,
  /\b(cargo\s+build|go\s+build|mvn\s+(compile|package|install)|gradle\s+build)\b/,
  /\b(make\b)/i,
];

/** High-confidence lint patterns. */
const LINT_PATTERNS = [
  /\b(eslint|tslint|pylint|ruff|golangci-lint)\b/i,
  /\b(pnpm\s+lint|npm\s+run\s+lint)\b/,
];

/** High-confidence format patterns. */
const FORMAT_PATTERNS = [
  /\b(prettier|black|gofmt|rustfmt)\b/i,
  /\b(pnpm\s+format|npm\s+run\s+format)\b/,
];

/** High-confidence package-install patterns. */
const INSTALL_PATTERNS = [
  /\b(pnpm\s+(install|add|update|remove)|npm\s+(install|ci|add|update|remove)|yarn\s+(add|remove))\b/,
  /\b(pip\s+install|poetry\s+add|cargo\s+(add|update|install))\b/i,
];

/** High-confidence git patterns. */
const GIT_PATTERNS = [
  /^git\s+/,
];

export function classifyCommand(command: string): ClassifiedCommand {
  // High-confidence checks first
  for (const pattern of TEST_PATTERNS) {
    if (pattern.test(command)) return { command, kind: "test", confidence: "high" };
  }
  for (const pattern of TYPECHECK_PATTERNS) {
    if (pattern.test(command)) return { command, kind: "typecheck", confidence: "high" };
  }
  for (const pattern of BUILD_PATTERNS) {
    if (pattern.test(command)) return { command, kind: "build", confidence: "high" };
  }
  for (const pattern of LINT_PATTERNS) {
    if (pattern.test(command)) return { command, kind: "lint", confidence: "high" };
  }
  for (const pattern of FORMAT_PATTERNS) {
    if (pattern.test(command)) return { command, kind: "format", confidence: "high" };
  }
  for (const pattern of INSTALL_PATTERNS) {
    if (pattern.test(command)) return { command, kind: "package_install", confidence: "high" };
  }
  for (const pattern of GIT_PATTERNS) {
    if (pattern.test(command)) return { command, kind: "git", confidence: "high" };
  }

  // Medium-confidence: commands with "test" or "check" in the name
  if (/\btest/i.test(command)) {
    return { command, kind: "test", confidence: "medium" };
  }
  if (/\bcheck\b/i.test(command)) {
    return { command, kind: "typecheck", confidence: "medium" };
  }
  if (/\bbuild\b/i.test(command)) {
    return { command, kind: "build", confidence: "medium" };
  }

  return { command, kind: "general", confidence: "low" };
}