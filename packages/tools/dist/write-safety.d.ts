/**
 * P2-27 Write Safety Guard.
 *
 * Prevents the class of incident that has actually happened before: a write tool
 * silently overwrites the WHOLE content of an existing file with a tiny
 * replacement, and because the file was untracked / not backed up, the previous
 * content is unrecoverable.
 *
 * The guard is a pure decision function over observable facts:
 *   existing file?            → `exists`
 *   tracked by git?           → `untracked`
 *   large overwrite?          → `originalBytes` vs `newBytes`
 *   append intended?          → `append`
 *   backup / checkpoint?      → `hasCheckpoint` (a P2-26 snapshot, for example)
 *
 * It emits a level + flags + a reason. `danger` maps to "do not proceed without
 * approval" and `caution` maps to "proceed but surface a checkpoint warning".
 * The decision is pure so it is exhaustively unit-testable; the write_file tool
 * + orchestrator consume it.
 *
 * This complements (does not replace) the permission/sandbox gates: it is about
 * WRITE-SHAPE SAFETY (data loss / recoverability), not about who may write.
 */
export type WriteSafetyLevel = "safe" | "caution" | "danger";
export type WriteSafetyFlag = "create" | "append" | "large_to_tiny_overwrite" | "untracked_file" | "no_backup_checkpoint";
export interface WriteSafetyFacts {
    /** Did the file exist before this write? */
    exists: boolean;
    /** File is inside a git repo but not tracked → history cannot recover it. */
    untracked: boolean;
    /** Bytes currently in the file (0 when `exists` is false). */
    originalBytes: number;
    /** Bytes the new content would occupy. */
    newBytes: number;
    /** True when the operation is an append (additive), not an overwrite. */
    append: boolean;
    /** True when a P2-26 checkpoint / snapshot makes the original recoverable. */
    hasCheckpoint: boolean;
}
export interface WriteSafetyConfig {
    /** Original files larger than this (bytes) count as "large". */
    largeFileBytes?: number;
    /** newBytes/originalBytes at or below this marks a "tiny replacement". */
    tinyReplacementRatio?: number;
}
export declare const DEFAULT_WRITE_SAFETY_CONFIG: Required<WriteSafetyConfig>;
export interface WriteSafetyDecision {
    level: WriteSafetyLevel;
    flags: WriteSafetyFlag[];
    reason: string;
    /** Should the caller route this write into an approval flow / refuse it? */
    escalateToApproval: boolean;
    /** Should the caller recommend capturing a P2-26 checkpoint first? */
    checkpointRecommended: boolean;
}
export declare function assessWriteSafety(facts: WriteSafetyFacts, config?: WriteSafetyConfig): WriteSafetyDecision;
//# sourceMappingURL=write-safety.d.ts.map