import type { ToolDefinition } from "@ar/contracts";
export interface EditFileInput {
    path: string;
    /** Text-anchor mode: the substring to replace. Omit in line-range mode. */
    oldText?: string;
    newText?: string;
    /** Replace all occurrences of `oldText`. */
    replaceAll?: boolean;
    /** Replace exactly the Nth (1-based) occurrence. */
    occurrence?: number;
    /** Line-range mode: 1-based inclusive start line. */
    lineStart?: number;
    /** Line-range mode: 1-based inclusive end line. */
    lineEnd?: number;
    /** Line-range mode: replacement for the [lineStart..lineEnd] region. */
    replacement?: string;
}
export interface EditFileOutput {
    path: string;
    /** Text mode: number of replacements made. */
    replacements?: number;
    /** Line-range mode: number of lines replaced. */
    replacedLines?: number;
    /** Recorded before/after diff (P2-28). */
    diff: string[];
}
/**
 * edit_file (VS-001 + P2-28). Two modes:
 *  - text mode: replace `oldText` → `newText` (first occurrence by default,
 *    `occurrence` targets an exact one, `replaceAll` replaces all). Fails when
 *    an explicit occurrence is out of range — never guesses.
 *  - line-range mode: replace lines [lineStart..lineEnd] with `replacement`,
 *    so a local change never requires reproducing the whole file.
 * Every successful edit records a before/after diff in the output.
 * All policy enforcement stays in the orchestrator.
 */
export declare const editFileTool: ToolDefinition<EditFileInput, EditFileOutput>;
//# sourceMappingURL=edit-file.d.ts.map