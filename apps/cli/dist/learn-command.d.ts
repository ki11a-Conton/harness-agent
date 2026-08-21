import type { MemoryStore } from "@ar/contracts";
import type { LearningCandidateStore } from "@ar/harness";
import type { CommandResult } from "./commands.js";
export interface LearnDeps {
    candidates: LearningCandidateStore;
    /** Memory store the promotion writes into (absent → promote is refused). */
    memoryStore?: MemoryStore;
    /** Workspace root for memory scope resolution (default process.cwd()). */
    cwd?: string;
    now?: () => number;
}
export declare function learnCmd(rest: string[], deps: LearnDeps): Promise<CommandResult>;
//# sourceMappingURL=learn-command.d.ts.map