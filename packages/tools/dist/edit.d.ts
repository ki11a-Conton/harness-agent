/**
 * P2-28 File Edit Primitive Improvements.
 *
 * The old edit_file always read + rewrote the whole file and replaced the FIRST
 * occurrence of an anchor silently — replaceAll avoided ambiguity, but there was
 * no way to (a) target a specific occurrence, (b) edit by LINE RANGE instead of
 * reproducing surrounding text, or (c) see WHAT changed (a recorded diff).
 *
 * This module provides pure, deterministic primitives:
 *   applyReplace       — text-anchor replace with `occurrence` / `replaceAll`
 *                        control, still defaulting to "first occurrence" for
 *                        backward compatibility.
 *   applyLineRange     — structured, range-based edit (1-based inclusive lines),
 *                        so the agent never has to reproduce the whole file for
 *                        a local change.
 *   lineDiff           — a lightweight before/after line diff for evidence.
 *
 * All are pure over strings → exhaustively unit-testable; the edit_file tool
 * consumes them.
 */
export interface ApplyReplaceOptions {
    /** Replace all occurrences (mutually exclusive with `occurrence`). */
    replaceAll?: boolean;
    /** Replace exactly the Nth (1-based) occurrence. */
    occurrence?: number;
}
export interface ApplyResult {
    ok: boolean;
    content: string;
    /** Number of replacements actually made. */
    count: number;
    /** Total occurrences of the anchor found in the original content. */
    matched: number;
    error?: string;
}
/**
 * Text-anchor replace. Defaults to first occurrence (backward compatible).
 * When `occurrence` is given, it must be within range or the call fails loudly
 * (never guesses). `replaceAll` replaces every occurrence.
 */
export declare function applyReplace(content: string, oldText: string, newText: string, options?: ApplyReplaceOptions): ApplyResult;
/** Structured line-range edit: replace lines [lineStart..lineEnd] (1-based,
 *  inclusive) with `replacement` (which may span multiple lines). */
export declare function applyLineRange(content: string, lineStart: number, lineEnd: number, replacement: string): ApplyResult;
/**
 * Lightweight before/after line diff (for evidence / observability). Common
 * prefix/suffix are trimmed; only the changed region is emitted, capped to
 * `maxLines` per side.
 */
export declare function lineDiff(before: string, after: string, maxLines?: number): string[];
//# sourceMappingURL=edit.d.ts.map