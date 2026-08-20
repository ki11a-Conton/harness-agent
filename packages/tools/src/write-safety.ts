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
export type WriteSafetyFlag =
  | "create"
  | "append"
  | "large_to_tiny_overwrite"
  | "untracked_file"
  | "no_backup_checkpoint";

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

export const DEFAULT_WRITE_SAFETY_CONFIG: Required<WriteSafetyConfig> = {
  largeFileBytes: 4096,
  tinyReplacementRatio: 0.2,
};

export interface WriteSafetyDecision {
  level: WriteSafetyLevel;
  flags: WriteSafetyFlag[];
  reason: string;
  /** Should the caller route this write into an approval flow / refuse it? */
  escalateToApproval: boolean;
  /** Should the caller recommend capturing a P2-26 checkpoint first? */
  checkpointRecommended: boolean;
}

export function assessWriteSafety(
  facts: WriteSafetyFacts,
  config: WriteSafetyConfig = DEFAULT_WRITE_SAFETY_CONFIG,
): WriteSafetyDecision {
  const cfg: Required<WriteSafetyConfig> = { ...DEFAULT_WRITE_SAFETY_CONFIG, ...config };

  // Brand-new file: nothing to lose.
  if (!facts.exists) {
    return decision("safe", ["create"], "new file creation, nothing to overwrite", false, false);
  }

  // Append is additive: previous bytes are preserved by construction.
  if (facts.append) {
    const flags: WriteSafetyFlag[] = ["append"];
    if (facts.untracked && !facts.hasCheckpoint) {
      flags.push("untracked_file", "no_backup_checkpoint");
      return decision(
        "caution",
        flags,
        "appending to an untracked file without a backup checkpoint",
        false,
        true,
      );
    }
    return decision("safe", flags, "append preserves existing bytes", false, false);
  }

  // ---- overwrite of an existing file ----
  const flags: WriteSafetyFlag[] = [];
  const ratio =
    facts.originalBytes > 0 ? facts.newBytes / facts.originalBytes : Number.POSITIVE_INFINITY;
  const shrinkHazard =
    facts.originalBytes >= cfg.largeFileBytes && ratio <= cfg.tinyReplacementRatio;

  if (shrinkHazard) flags.push("large_to_tiny_overwrite");
  if (facts.untracked) flags.push("untracked_file");
  if (!facts.hasCheckpoint) flags.push("no_backup_checkpoint");

  // The incident: existing large file collapsed to a tiny replacement, and there
  // is no checkpoint to restore it from → do not proceed without approval.
  if (shrinkHazard && !facts.hasCheckpoint) {
    return decision(
      "danger",
      flags,
      `existing ${facts.originalBytes}B file replaced by ${facts.newBytes}B with no backup checkpoint`,
      true,
      true,
    );
  }

  // Overwriting an untracked file without any checkpoint: recoverable only by us
  // keeping the old bytes around, so require a checkpoint before treating it as safe.
  if (facts.untracked && !facts.hasCheckpoint) {
    return decision(
      "caution",
      flags,
      "overwriting an untracked file without a backup checkpoint",
      false,
      true,
    );
  }

  // Tracked by git (recoverable) or backed up by a checkpoint → safe to proceed.
  return decision(
    "safe",
    flags,
    facts.hasCheckpoint
      ? "overwrite recoverable via checkpoint"
      : "overwrite recoverable via version control",
    false,
    false,
  );
}

function decision(
  level: WriteSafetyLevel,
  flags: WriteSafetyFlag[],
  reason: string,
  escalateToApproval: boolean,
  checkpointRecommended: boolean,
): WriteSafetyDecision {
  return { level, flags, reason, escalateToApproval, checkpointRecommended };
}