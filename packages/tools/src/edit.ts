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

/** Locate every start index of `old` in `content` (non-overlapping). */
function allMatchesIndexes(content: string, old: string): number[] {
  const res: number[] = [];
  if (old.length === 0) return res;
  let i = 0;
  for (;;) {
    const k = content.indexOf(old, i);
    if (k < 0) break;
    res.push(k);
    i = k + old.length;
  }
  return res;
}

/** Match CRLF and LF in one view while retaining original offsets.
 * No other Unicode or punctuation normalization is performed. */
function lfView(content: string): { text: string; originalOffset: (index: number) => number } {
  let next = content.indexOf("\r\n");
  // Most source files already use LF. Do not allocate two per-character
  // arrays to edit a small anchor in a large file.
  if (next < 0) return { text: content, originalOffset: index => index };
  const boundaries: number[] = [];
  do {
    // A normalized boundary AFTER this LF includes the removed CR. The
    // boundary before it still points at the original CR, as in the old map.
    boundaries.push(next - boundaries.length + 1);
    next = content.indexOf("\r\n", next + 2);
  } while (next >= 0);
  return {
    text: content.replace(/\r\n/g, "\n"),
    originalOffset(index) {
      let low = 0, high = boundaries.length;
      while (low < high) {
        const middle = low + Math.floor((high - low) / 2);
        if (boundaries[middle]! <= index) low = middle + 1;
        else high = middle;
      }
      return index + low;
    },
  };
}

/** Prefer the touched line's terminator, then the preceding line, then LF. */
function localEol(content: string, offset: number): string {
  let newline = content.indexOf("\n", offset);
  if (newline < 0) newline = content.lastIndexOf("\n", offset - 1);
  return newline > 0 && content[newline - 1] === "\r" ? "\r\n" : "\n";
}

function replacementEol(text: string, eol: string): string {
  return text.replace(/\r\n|\n/g, eol);
}

/**
 * Text-anchor replace. Defaults to first occurrence (backward compatible).
 * When `occurrence` is given, it must be within range or the call fails loudly
 * (never guesses). `replaceAll` replaces every occurrence.
 */
export function applyReplace(
  content: string,
  oldText: string,
  newText: string,
  options: ApplyReplaceOptions = {},
): ApplyResult {
  if (oldText.length === 0) {
    return { ok: false, content, count: 0, matched: 0, error: "oldText must not be empty" };
  }
  const bom = content.startsWith("\ufeff") ? "\ufeff" : "";
  const body = content.slice(bom.length);
  const view = lfView(body);
  const includesBom = bom.length > 0 && oldText.startsWith(bom);
  const anchor = oldText.slice(includesBom ? bom.length : 0).replace(/\r\n/g, "\n");
  const matches = allMatchesIndexes(view.text, anchor).filter((index) => !includesBom || index === 0);
  if (matches.length === 0) {
    return { ok: false, content, count: 0, matched: 0, error: "anchor not found" };
  }

  const occurrence = options.occurrence;
  if (!options.replaceAll && occurrence !== undefined) {
    if (occurrence < 1 || occurrence > matches.length) {
      return {
        ok: false,
        content,
        count: 0,
        matched: matches.length,
        error: `occurrence ${occurrence} out of range (file has ${matches.length})`,
      };
    }
  }
  // Splice original blocks; each occurrence gets its own local EOL, so
  // replaceAll does not homogenize an existing mixed-EOL file.
  const selected = options.replaceAll ? matches : [matches[(occurrence ?? 1) - 1]!];
  let cursor = 0;
  const parts = [bom];
  for (const index of selected) {
    const start = view.originalOffset(index);
    const end = view.originalOffset(index + anchor.length);
    const replacement = includesBom && newText.startsWith(bom) ? newText.slice(bom.length) : newText;
    parts.push(body.slice(cursor, start), replacementEol(replacement, localEol(body, start)));
    cursor = end;
  }
  parts.push(body.slice(cursor));
  return { ok: true, content: parts.join(""), count: selected.length, matched: matches.length };
}

/** A group of unique, disjoint anchors in ONE original file snapshot. */
export interface TextEdit { oldText: string; newText: string }
export const MAX_BATCH_EDITS = 64;

/** Snapshot matching and overlap rejection adapted from pi's
 * applyEditsToNormalizedContent (Copyright 2025 Mario Zechner, MIT).
 * Unlike pi, retain Harness's original byte offsets/local EOL and do not
 * perform fuzzy/Unicode matching. License: third_party/coding-tools/pi-LICENSE.
 * This pure preflight never returns a partially changed string on failure. */
export function applyBatchReplace(content: string, edits: readonly TextEdit[]): ApplyResult {
  const fail = (error: string): ApplyResult => ({ ok: false, content, count: 0, matched: 0, error });
  if (!Array.isArray(edits) || edits.length === 0 || edits.length > MAX_BATCH_EDITS) {
    return fail(`edits must contain 1..${MAX_BATCH_EDITS} replacements`);
  }
  const bom = content.startsWith("\ufeff") ? "\ufeff" : "";
  const body = content.slice(bom.length);
  const view = lfView(body);
  const planned: { start: number; end: number; text: string; editIndex: number }[] = [];
  for (const [editIndex, edit] of edits.entries()) {
    if (!edit || typeof edit.oldText !== "string" || typeof edit.newText !== "string" || !edit.oldText.length) {
      return fail(`edits[${editIndex}] requires nonempty oldText and string newText`);
    }
    const includesBom = bom.length > 0 && edit.oldText.startsWith(bom);
    const anchor = edit.oldText.slice(includesBom ? bom.length : 0).replace(/\r\n/g, "\n");
    if (!anchor) return fail(`edits[${editIndex}] has an empty anchor after BOM removal`);
    const first = view.text.indexOf(anchor);
    if (first < 0 || (includesBom && first !== 0)) return fail(`edits[${editIndex}] anchor not found in the original snapshot`);
    // Count overlapping candidates too: "aa" in "aaa" is ambiguous.
    if (!includesBom && view.text.indexOf(anchor, first + 1) >= 0) return fail(`edits[${editIndex}] anchor is ambiguous; use a unique anchor`);
    const start = view.originalOffset(first), end = view.originalOffset(first + anchor.length);
    const text = includesBom && edit.newText.startsWith(bom) ? edit.newText.slice(bom.length) : edit.newText;
    planned.push({ start, end, text: replacementEol(text, localEol(body, start)), editIndex });
  }
  planned.sort((a, b) => a.start - b.start);
  for (let i = 1; i < planned.length; i++) {
    const previous = planned[i - 1]!, current = planned[i]!;
    if (previous.end > current.start) return fail(`edits[${previous.editIndex}] and edits[${current.editIndex}] overlap; merge them into one edit`);
  }
  const parts = [bom];
  let cursor = 0;
  for (const edit of planned) { parts.push(body.slice(cursor, edit.start), edit.text); cursor = edit.end; }
  parts.push(body.slice(cursor));
  const next = parts.join("");
  if (next === content) return fail("batch replacements produced no change");
  return { ok: true, content: next, count: planned.length, matched: planned.length };
}

/** Structured line-range edit: replace lines [lineStart..lineEnd] (1-based,
 *  inclusive) with `replacement` (which may span multiple lines). */
export function applyLineRange(
  content: string,
  lineStart: number,
  lineEnd: number,
  replacement: string,
): ApplyResult {
  if (!Number.isInteger(lineStart) || !Number.isInteger(lineEnd)) {
    return { ok: false, content, count: 0, matched: 0, error: "lineStart/lineEnd must be integers" };
  }
  if (lineStart < 1 || lineEnd < lineStart) {
    return {
      ok: false,
      content,
      count: 0,
      matched: 0,
      error: `invalid line range [${lineStart}, ${lineEnd}]`,
    };
  }
  const bom = content.startsWith("\ufeff") ? "\ufeff" : "";
  const body = content.slice(bom.length);
  // Include the trailing empty logical line for the existing count/clamp API.
  const starts = [0];
  for (let i = 0; i < body.length; i++) if (body[i] === "\n") starts.push(i + 1);
  const startIndex = Math.min(lineStart - 1, starts.length);
  const endIndex = Math.min(lineEnd, starts.length);
  const start = starts[startIndex] ?? body.length;
  const end = starts[endIndex] ?? body.length;
  const removedCount = Math.max(0, endIndex - (lineStart - 1));
  const eol = localEol(body, start);
  let inserted = replacementEol(bom && start === 0 && replacement.startsWith(bom) ? replacement.slice(bom.length) : replacement, eol);
  let head = body.slice(0, start);
  if (inserted.length > 0) {
    if (startIndex === starts.length) {
      // Preserve the legacy out-of-bounds start behavior: append a new line.
      inserted = eol + inserted;
    } else if (endIndex < starts.length) {
      // The final touched line separates replacement from the untouched tail.
      const boundary = body[end - 2] === "\r" ? "\r\n" : "\n";
      inserted += boundary;
    } else if (body.endsWith("\n") && !inserted.endsWith("\n")) {
      // Replacing through EOF retains the original terminal newline.
      inserted += body.endsWith("\r\n") ? "\r\n" : "\n";
    }
  } else if (endIndex === starts.length && !body.endsWith("\n") && head.endsWith("\n")) {
    // Removing the final unterminated line keeps the preceding line
    // unterminated, as in the existing LF range API.
    head = head.slice(0, head.endsWith("\r\n") ? -2 : -1);
  }
  return {
    ok: true,
    content: bom + head + inserted + body.slice(end),
    count: removedCount,
    matched: 0,
  };
}

/**
 * Lightweight before/after line diff (for evidence / observability). Common
 * prefix/suffix are trimmed; only the changed region is emitted, capped to
 * `maxLines` per side.
 */
export function lineDiff(before: string, after: string, maxLines = 6): string[] {
  const b = before.split("\n");
  const a = after.split("\n");
  let i = 0;
  while (i < b.length && i < a.length && b[i] === a[i]) i++;
  let js = 0;
  while (js < b.length - i && js < a.length - i && b[b.length - 1 - js] === a[a.length - 1 - js]) js++;
  const removed = b.slice(i, b.length - js);
  const added = a.slice(i, a.length - js);
  if (removed.length === 0 && added.length === 0) return ["(no change)"];
  const out: string[] = [];
  let n = 0;
  for (const l of removed) {
    if (n >= maxLines) {
      out.push(`…${removed.length} line(s) removed`);
      break;
    }
    out.push(`- ${l}`);
    n++;
  }
  n = 0;
  for (const l of added) {
    if (n >= maxLines) {
      out.push(`…${added.length} line(s) added`);
      break;
    }
    out.push(`+ ${l}`);
    n++;
  }
  return out;
}
