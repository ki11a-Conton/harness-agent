export const DEFAULT_WRITE_SAFETY_CONFIG = {
    largeFileBytes: 4096,
    tinyReplacementRatio: 0.2,
};
export function assessWriteSafety(facts, config = DEFAULT_WRITE_SAFETY_CONFIG) {
    const cfg = { ...DEFAULT_WRITE_SAFETY_CONFIG, ...config };
    // Brand-new file: nothing to lose.
    if (!facts.exists) {
        return decision("safe", ["create"], "new file creation, nothing to overwrite", false, false);
    }
    // Append is additive: previous bytes are preserved by construction.
    if (facts.append) {
        const flags = ["append"];
        if (facts.untracked && !facts.hasCheckpoint) {
            flags.push("untracked_file", "no_backup_checkpoint");
            return decision("caution", flags, "appending to an untracked file without a backup checkpoint", false, true);
        }
        return decision("safe", flags, "append preserves existing bytes", false, false);
    }
    // ---- overwrite of an existing file ----
    const flags = [];
    const ratio = facts.originalBytes > 0 ? facts.newBytes / facts.originalBytes : Number.POSITIVE_INFINITY;
    const shrinkHazard = facts.originalBytes >= cfg.largeFileBytes && ratio <= cfg.tinyReplacementRatio;
    if (shrinkHazard)
        flags.push("large_to_tiny_overwrite");
    if (facts.untracked)
        flags.push("untracked_file");
    if (!facts.hasCheckpoint)
        flags.push("no_backup_checkpoint");
    // The incident: existing large file collapsed to a tiny replacement, and there
    // is no checkpoint to restore it from → do not proceed without approval.
    if (shrinkHazard && !facts.hasCheckpoint) {
        return decision("danger", flags, `existing ${facts.originalBytes}B file replaced by ${facts.newBytes}B with no backup checkpoint`, true, true);
    }
    // Overwriting an untracked file without any checkpoint: recoverable only by us
    // keeping the old bytes around, so require a checkpoint before treating it as safe.
    if (facts.untracked && !facts.hasCheckpoint) {
        return decision("caution", flags, "overwriting an untracked file without a backup checkpoint", false, true);
    }
    // Tracked by git (recoverable) or backed up by a checkpoint → safe to proceed.
    return decision("safe", flags, facts.hasCheckpoint
        ? "overwrite recoverable via checkpoint"
        : "overwrite recoverable via version control", false, false);
}
function decision(level, flags, reason, escalateToApproval, checkpointRecommended) {
    return { level, flags, reason, escalateToApproval, checkpointRecommended };
}
//# sourceMappingURL=write-safety.js.map