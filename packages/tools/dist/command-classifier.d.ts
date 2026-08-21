/**
 * P8-4: ONE command classifier shared by command discovery, verification plan
 * building and working-state classification. Before this, each subsystem had
 * its own regex matching (discovery's kind tagging, the verifier's command
 * matching, working-state build/test classification) — a single source keeps
 * "is this a test command?" consistent everywhere.
 */
export type CommandCategory = "test" | "build" | "lint" | "typecheck" | "check" | "verify" | "other";
export interface CommandClassification {
    category: CommandCategory;
    confidence: "high" | "medium" | "low";
}
/** Classify an arbitrary command string by keyword. `other` is the honest
 *  answer when nothing matches (never guess). */
export declare function classifyCommand(command: string): CommandClassification;
//# sourceMappingURL=command-classifier.d.ts.map