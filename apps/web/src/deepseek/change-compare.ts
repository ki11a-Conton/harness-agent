/** Adapted verbatim from DeepSeek Harness workspace-changes/src/compare.ts.
 * Source: deepseek-ai/deepseek-harness@5badb15009ae1756c3afe0ae0cef1faafc290ccc.
 * Copyright (c) 2026 DeepSeek. MIT License; full license in third_party/deepseek-workspace-changes-MIT.txt.
 * Harness adapts the wire types and preserves EOF newline changes. */
import { structuredPatch } from "diff";

export interface WorkspaceDiffHunk {
  oldStart: number; oldLines: number; newStart: number; newLines: number; lines: string[];
}
const CONTEXT_LINES = 3;
export interface Comparison { hunks: WorkspaceDiffHunk[]; coarse: boolean; added: number; deleted: number }
function lines(text: string): string[] { return text === "" ? [] : (text.endsWith("\n") ? text.slice(0, -1) : text).split("\n"); }
function coarseLines(text: string, prefix: string): string[] {
  const result = lines(text).map(line => prefix + line);
  if (text !== "" && !text.endsWith("\n")) result.push("\\ No newline at end of file");
  return result;
}
export function compareText(before: string | null, after: string | null, timeoutMs: number): Comparison {
  const oldText = before ?? "";
  const newText = after ?? "";
  const patch = structuredPatch("", "", oldText, newText, undefined, undefined, { context: CONTEXT_LINES, timeout: timeoutMs });
  let hunks: WorkspaceDiffHunk[];
  let coarse = false;
  if (patch === undefined) {
    coarse = true;
    const oldLines = lines(oldText), newLines = lines(newText);
    hunks = [{ oldStart: 1, oldLines: oldLines.length, newStart: 1, newLines: newLines.length,
      lines: [...coarseLines(oldText, "-"), ...coarseLines(newText, "+")] }];
  } else {
    hunks = patch.hunks.map(({ oldStart, oldLines, newStart, newLines, lines: body }) =>
      ({ oldStart, oldLines, newStart, newLines, lines: body }));
  }
  let added = 0, deleted = 0;
  for (const hunk of hunks) for (const line of hunk.lines) {
    if (line.startsWith("+")) added += 1;
    else if (line.startsWith("-")) deleted += 1;
  }
  return { hunks, coarse, added, deleted };
}
