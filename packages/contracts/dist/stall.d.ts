/**
 * P2-41 — stall detection V2.
 *
 * The pre-existing runtime gate terminates on CONSECUTIVE IDENTICAL tool calls
 * (same name + args). That is a strong signal but too narrow: a model can spin
 * without ever calling the identical call twice in a row (A→B→A→B), or beat on a
 * file it keeps reading unchanged, or repeat the same error. This module defines
 * the full STALL PATTERN vocabulary and a pure, window-based classifier so those
 * patterns are recognized from the observable tool trail.
 *
 * False-positive control (the plan's key requirement): a pattern is only reported
 * when the recent window shows NO progress. Progress is represented by a change
 * in a call's RESULT FINGERPRINT (the call produced a new result), by a differing
 * call/args (a new action), or by an explicit `noteProgress` (side-effect landed,
 * compaction, verification improvement). Stalls are judged only over that
 * unchanged window — never from model wording.
 *
 * This module is pure and dependency-free so it can live in contracts.
 */
/**
 * Explicit progress signals the runtime can report to cancel a stall score.
 * A side effect landing (artifact/file diff), a verification improving and a
 * changed plan are all progress; seeing any of them means the current run is
 * NOT stalled even if it repeats a call.
 */
export type ProgressSignal = "new_artifact" | "new_file_diff" | "new_evidence" | "changed_plan" | "verification_improved";
/** The stall patterns V2 can classify from a tool-call window. */
export type StallPattern = "identical_tool" | "alternating_loop" | "repeated_error" | "repeated_read_no_change" | "verification_fix_loop" | "no_progress";
/** One tool execution captured in the rolling stall window. All fields are
 *  pre-computed by the runtime (never derived from model wording). */
export interface ToolCallTrace {
    name: string;
    /** Stable-serialized args ("name:args" key). */
    argsKey: string;
    /** Fingerprint of the tool RESULT; identical calls with a DIFFERENT result
     *  are progress, not a stall. */
    resultFingerprint?: string;
    /** Error classification code when the call failed (non-undefined). */
    errorCode?: string;
    /** Read-only (no state change) — used for the repeated-read pattern. */
    isRead?: boolean;
}
export declare const STALL_WINDOW_SIZE = 8;
export declare const MIN_IDENTICAL = 2;
export declare const MIN_ALTERNATING_OBSERVATIONS = 4;
export declare const MIN_REPEATED_ERROR = 3;
export declare const MIN_REPEATED_READ = 2;
/** A verification fix loop needs a read->write->read shape and a β-floor window. */
export declare const MIN_VERIFICATION_FIX_LOOP = 3;
/** Classify a rolling window of tool executions into a stall pattern, or null
 *  when no stall is present. Ordered most-specific-first; a stronger pattern
 *  (e.g. alternating loop over a plain identical run) wins. Requires an
 *  UNCHANGED window (no progress signal) — a window with differing results or
 *  differing calls is never a stall. */
export declare function detectStallPattern(window: readonly ToolCallTrace[]): StallPattern | null;
//# sourceMappingURL=stall.d.ts.map