import type { WorkingState } from "@ar/contracts";
export type DiscoveredKind = "test" | "build" | "lint" | "typecheck" | "check" | "verify";
export type DiscoverySource = "package.json" | "pyproject" | "Cargo.toml" | "Makefile" | "CI" | "AGENTS.md";
export interface DiscoveredCommand {
    kind: DiscoveredKind;
    command: string;
    source: DiscoverySource;
    file: string;
    confidence: "high" | "medium" | "low";
}
export interface CommandDiscoveryResult {
    root: string;
    discovered: DiscoveredCommand[];
    sourceFilesChecked: string[];
}
/**
 * Robust CI `run:` extraction (P2-30+ multi-line YAML completeness). Unlike a
 * single regex, this line scanner understands YAML block scalars:
 *   - literal blocks `|`, `|+`, `|-` (each content line = its own command)
 *   - folded blocks `>`, `>+`, `>-` (content lines joined with a space)
 *   - block content indented deeper than the `run:` key, ending at the next
 *     top-level key / `-` sequence item / document marker (`---`) / EOF
 *   - `env:` / `working-directory:` keys that precede `run:` in a step
 *
 * Each shell segment (`&&`, `||`, `;`, `|`) is classified; results are
 * deduplicated by kind+command. An approximate parse never fabricates commands
 * that aren't present, so misses are safe for a hint-layer feature.
 */
export declare function parseCiRuns(text: string, file: string): DiscoveredCommand[];
/** Pick the single strongest command per kind. */
export declare function summarize(discovered: DiscoveredCommand[]): Partial<Record<DiscoveredKind, string>>;
/**
 * Write a compact, deduped summary into WorkingState.importantFacts so the run
 * loop retains the strongest discovered commands without guessing.
 */
export declare function mergeIntoWorkingState(state: WorkingState, result: CommandDiscoveryResult): void;
export declare function discoverCommands(root: string): Promise<CommandDiscoveryResult>;
//# sourceMappingURL=command-discovery.d.ts.map