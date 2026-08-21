/**
 * P0-13: command classification for the agent's working state.
 * Classifies shell commands into kinds so the runtime can distinguish
 * test runs from typechecks, builds, lints, etc.
 */
export type CommandKind = "test" | "typecheck" | "build" | "lint" | "format" | "package_install" | "git" | "general";
export interface ClassifiedCommand {
    command: string;
    kind: CommandKind;
    confidence: "high" | "medium" | "low";
}
export declare function classifyCommand(command: string): ClassifiedCommand;
//# sourceMappingURL=command-classification.d.ts.map