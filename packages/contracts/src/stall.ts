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
export type ProgressSignal =
  | "new_artifact"
  | "new_file_diff"
  | "new_evidence"
  | "changed_plan"
  | "verification_improved";

/** The stall patterns V2 can classify from a tool-call window. */
export type StallPattern =
  | "identical_tool"
  | "alternating_loop"
  | "repeated_error"
  | "repeated_read_no_change"
  | "verification_fix_loop"
  | "no_progress";

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

export const STALL_WINDOW_SIZE = 8;
export const MIN_IDENTICAL = 2;
export const MIN_ALTERNATING_OBSERVATIONS = 4;
export const MIN_REPEATED_ERROR = 3;
export const MIN_REPEATED_READ = 2;
/** A verification fix loop needs a read->write->read shape and a β-floor window. */
export const MIN_VERIFICATION_FIX_LOOP = 3;

function sameTrace(a: ToolCallTrace, b: ToolCallTrace): boolean {
  return a.name === b.name && a.argsKey === b.argsKey && a.resultFingerprint === b.resultFingerprint;
}

/** Classify a rolling window of tool executions into a stall pattern, or null
 *  when no stall is present. Ordered most-specific-first; a stronger pattern
 *  (e.g. alternating loop over a plain identical run) wins. Requires an
 *  UNCHANGED window (no progress signal) — a window with differing results or
 *  differing calls is never a stall. */
export function detectStallPattern(window: readonly ToolCallTrace[]): StallPattern | null {
  const n = window.length;
  if (n < 2) return null;

  // A→B→A→B … clean period-2 cycle: every even-indexed trace equals the first
  // and every odd-indexed equals the second, with the two symbols distinct AND
  // each occurrence reproducing the same result fingerprint (truly no progress).
  if (n >= MIN_ALTERNATING_OBSERVATIONS) {
    const s0 = window[0]!;
    const s1 = window[1]!;
    if (!sameTrace(s0, s1)) {
      let clean = true;
      for (let i = 0; i < n; i += 1) {
        if (!sameTrace(window[i]!, i % 2 === 0 ? s0 : s1)) {
          clean = false;
          break;
        }
      }
      if (clean) return "alternating_loop";
    }
  }

  // Repeated read of the same file/args returning the same result with no
  // intervening state change.
  if (n >= MIN_REPEATED_READ) {
    const tail = window.slice(n - MIN_REPEATED_READ);
    if (tail.every((t) => t.isRead === true) && tail.every((t, _, arr) => sameTrace(t, arr[0]!))) {
      return "repeated_read_no_change";
    }
  }

  // Verification fix loop: the model keeps attempting FIXES (a non-read / write
  // call) but the verification reads between them never change — read -> write ->
  // read all returning the SAME feedback fingerprint, with a write landing
  // between two reads. This is the stuck "edit then re-run the check" cycle.
  if (n >= MIN_VERIFICATION_FIX_LOOP && detectVerificationFixLoop(window)) {
    return "verification_fix_loop";
  }

  // The same failure code repeated (regardless of which call). Checked before
  // identical_tool so a streak of identical FAILING calls reports the more
  // informative "repeated_error" rather than a generic identical streak.
  if (n >= MIN_REPEATED_ERROR) {
    const tail = window.slice(n - MIN_REPEATED_ERROR);
    const code = tail[0]!.errorCode;
    if (code !== undefined && tail.every((t) => t.errorCode === code)) return "repeated_error";
  }

  // Consecutive identical call with an unchanged result.
  const last = window[n - 1]!;
  if (n >= MIN_IDENTICAL && allSame(window, last)) return "identical_tool";

  // no_progress: a long window where the CALLS churn but every RESULT is
  // identical — the model does varied actions yet nothing changes. Distinct
  // from identical_tool (identical calls), and only fires once the window is
  // long enough to bound false positives on legitimate one-shot progress.
  if (n >= STALL_WINDOW_SIZE) {
    const firstResult = window[0]!.resultFingerprint;
    if (
      firstResult !== undefined &&
      window.every((t) => t.resultFingerprint === firstResult) &&
      !allSame(window, last)
    ) {
      return "no_progress";
    }
  }

  return null;
}

/**
 * Verification-fix-loop detector. A read that returns *changed* feedback is
 * progress (the model's verification moved), so only reads with an UNCHANGED
 * fingerprint count. A write sandwiched between two such unchanged reads means a
 * fix was attempted yet the model's own verification never moved — the classic
 * stuck edit→re-check loop.
 */
function detectVerificationFixLoop(window: readonly ToolCallTrace[]): boolean {
  let previousRead: ToolCallTrace | undefined;
  let sawWriteBetweenReads = false;
  let reads = 0;
  for (const t of window) {
    if (t.isRead && t.resultFingerprint !== undefined) {
      if (previousRead !== undefined && previousRead.resultFingerprint !== t.resultFingerprint) {
        // Verification moved — not a fix loop.
        return false;
      }
      reads += 1;
      previousRead = t;
    } else if (!t.isRead && previousRead !== undefined) {
      // A write/action after a read is a fix attempt; with a later read it
      // proves the model's own verification never moved.
      sawWriteBetweenReads = true;
    }
  }
  return reads >= 2 && sawWriteBetweenReads;
}

function allSame(window: readonly ToolCallTrace[], ref: ToolCallTrace): boolean {
  for (const t of window) if (!sameTrace(t, ref)) return false;
  return true;
}