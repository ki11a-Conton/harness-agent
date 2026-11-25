import { DEFAULT_READ_BYTES } from "./read-window.js";

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
  /** Refuse a second possible start, including an overlapping one, before rendering changes. */
  requireUnique?: boolean;
}

export interface ApplyResult {
  ok: boolean;
  content: string;
  /** Number of replacements actually made. */
  count: number;
  /** Non-overlapping matches for ordinary replacements. A uniqueness failure stops at the second candidate. */
  matched: number;
  ambiguous?: true;
  /** Diagnostic read window only; it never authorizes a replacement. */
  reread?: { offset: number; limit: number };
  error?: string;
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

/** Locate the first two candidate starts for an actionable error. Offsets are
 * in the LF view without the BOM. Columns use 1-based UTF-16 code units, as
 * grep_search does. Only scan line boundaries when reporting a conflict. */
function duplicateAnchor(text: string, anchor: string, first: number, bomLength: number): string | undefined {
  const second = text.indexOf(anchor, first + 1);
  if (second < 0) return;
  let line = 1, lineStart = 0;
  let newline = text.indexOf("\n");
  function location(offset: number): string {
    while (newline >= 0 && newline < offset) {
      line++;
      lineStart = newline + 1;
      newline = text.indexOf("\n", lineStart);
    }
    const column = offset - lineStart + 1 + (line === 1 ? bomLength : 0);
    return `line ${line}, column ${column}`;
  }
  return `anchor is ambiguous at ${location(first)} and ${location(second)}; read the target lines and use a unique anchor`;
}

/** An exact miss may still identify a useful read window. Compare whole
 * lines, ignoring only leading ASCII spaces and tabs. A partial scan cannot
 * establish uniqueness, so over-budget inputs get the ordinary miss. */
function indentationReadWindow(text: string, anchor: string, anchoredAtStart: boolean): ApplyResult["reread"] {
  if (!anchor || anchor.length > 4096 || text.length > 256 * 1024) return;
  const requiresNewline = anchor.endsWith("\n");
  const withoutIndent = (line: string) => line.replace(/^[ \t]+/, "");
  const wanted = (requiresNewline ? anchor.slice(0, -1) : anchor).split("\n").map(withoutIndent);
  if (wanted.length > 32 || !wanted.some(line => line.length > 0)) return;

  const lines = text.split("\n", 8193);
  if (lines.length > 8192) return;
  const endsWithNewline = text.endsWith("\n");
  if (endsWithNewline) lines.pop();
  const normalized = lines.map(withoutIndent);
  const eligibleLines = lines.length - (requiresNewline && !endsWithNewline ? 1 : 0);
  const lastStart = eligibleLines - wanted.length;
  let start: number | undefined;
  for (let i = 0; i <= lastStart; i++) {
    if (anchoredAtStart && i > 0) break;
    if (!wanted.every((line, j) => normalized[i + j] === line)) continue;
    if (start !== undefined) return;
    start = i;
  }
  if (start === undefined) return;
  // The suggested page must fit the default reader, including a possible
  // BOM and a CR at each original line ending removed by lfView.
  const block = lines.slice(start, start + wanted.length).join("\n");
  if (Buffer.byteLength(block) + 3 + wanted.length > DEFAULT_READ_BYTES) return;
  return { offset: start + 1, limit: wanted.length };
}

/** Prefer the touched line's terminator, then the preceding line, then LF. */
function localEol(content: string, offset: number, newline = content.indexOf("\n", offset)): string {
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
  if (options.replaceAll && options.occurrence !== undefined) {
    return { ok: false, content, count: 0, matched: 0, error: "occurrence and replaceAll=true are mutually exclusive" };
  }
  if (oldText.length === 0) {
    return { ok: false, content, count: 0, matched: 0, error: "oldText must not be empty" };
  }
  const bom = content.startsWith("\ufeff") ? "\ufeff" : "";
  const body = content.slice(bom.length);
  const view = lfView(body);
  const includesBom = bom.length > 0 && oldText.startsWith(bom);
  const anchor = oldText.slice(includesBom ? bom.length : 0).replace(/\r\n/g, "\n");
  const first = anchor.length ? view.text.indexOf(anchor) : -1;
  if (options.requireUnique && !includesBom && first >= 0) {
    const error = duplicateAnchor(view.text, anchor, first, bom.length);
    if (error) return { ok: false, content, count: 0, matched: 2, ambiguous: true, error };
  }
  // Splice original blocks; each occurrence gets its own local EOL, so
  // replaceAll does not homogenize an existing mixed-EOL file.
  const occurrence = options.occurrence ?? 1;
  const replacement = includesBom && newText.startsWith(bom) ? newText.slice(bom.length) : newText;
  const hasLineBreak = replacement.includes("\n");
  let lineEnd = -1;
  let inserted = replacement;
  let matched = 0;
  let count = 0;
  let cursor = 0;
  const parts = [bom];
  const chunks: string[] = [];
  for (let index = first;
    index >= 0 && (!includesBom || index === 0);
    index = options.requireUnique || includesBom ? -1 : view.text.indexOf(anchor, index + anchor.length)) {
    matched++;
    if (!options.replaceAll && matched !== occurrence) continue;
    const start = view.originalOffset(index);
    const end = view.originalOffset(index + anchor.length);
    // Match starts advance monotonically. Reuse the rendered replacement
    // until the original line changes, even for many matches on a single line.
    if (hasLineBreak && start > lineEnd) {
      const newline = body.indexOf("\n", start);
      lineEnd = newline < 0 ? body.length : newline;
      inserted = replacementEol(replacement, localEol(body, start, newline));
    }
    parts.push(body.slice(cursor, start), inserted);
    // Dense replaceAll can produce millions of tiny slices. Join batches so
    // temporary array slots stay bounded independently of the match count.
    if (parts.length >= 4096) {
      chunks.push(parts.join(""));
      parts.length = 0;
    }
    cursor = end;
    count++;
  }
  if (matched === 0) {
    return {
      ok: false, content, count: 0, matched, error: "anchor not found",
      reread: indentationReadWindow(view.text, anchor, includesBom),
    };
  }
  if (count === 0) {
    return { ok: false, content, count, matched, error: `occurrence ${occurrence} out of range (file has ${matched})` };
  }
  parts.push(body.slice(cursor));
  chunks.push(parts.join(""));
  return { ok: true, content: chunks.join(""), count, matched };
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
    if (first < 0 || (includesBom && first !== 0)) {
      return { ...fail(`edits[${editIndex}] anchor not found in the original snapshot`),
        reread: indentationReadWindow(view.text, anchor, includesBom) };
    }
    if (!includesBom) {
      const error = duplicateAnchor(view.text, anchor, first, bom.length);
      if (error) return fail(`edits[${editIndex}] ${error}`);
    }
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
  // Keep the trailing empty logical line. Stop once the next line's
  // offset is known, or use EOF when the requested end must be clamped.
  let line = 1;
  let offset = 0;
  let startOffset: number | undefined;
  for (; line <= lineEnd; line++) {
    if (line === lineStart) startOffset = offset;
    const newline = body.indexOf("\n", offset);
    if (newline < 0) break;
    offset = newline + 1;
  }
  const hasFollowingLine = line > lineEnd;
  const start = startOffset ?? body.length;
  const end = hasFollowingLine ? offset : body.length;
  const removedCount = Math.max(0, Math.min(lineEnd, line) - lineStart + 1);
  const eol = localEol(body, start);
  let inserted = replacementEol(bom && start === 0 && replacement.startsWith(bom) ? replacement.slice(bom.length) : replacement, eol);
  let head = body.slice(0, start);
  if (inserted.length > 0) {
    if (startOffset === undefined) {
      // Preserve the legacy out-of-bounds start behavior: append a new line.
      inserted = eol + inserted;
    } else if (hasFollowingLine) {
      // The final touched line separates replacement from the untouched tail.
      const boundary = body[end - 2] === "\r" ? "\r\n" : "\n";
      inserted += boundary;
    } else if (body.endsWith("\n") && !inserted.endsWith("\n")) {
      // Replacing through EOF retains the original terminal newline.
      inserted += body.endsWith("\r\n") ? "\r\n" : "\n";
    }
  } else if (!hasFollowingLine && !body.endsWith("\n") && head.endsWith("\n")) {
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
 * Bounded before/after preview. Scan line boundaries without retaining an
 * array for every line: short/empty-line generated files can have millions
 * of lines in a few MiB. Preserve the existing prefix/suffix and EOF semantics.
 * Emit at most maxLines per side; long lines retain bounded, detached head/tail
 * text with an explicit truncation marker. This is a preview, not verification.
 */
export function lineDiff(before: string, after: string, maxLines = 6): string[] {
  if (before === after) return ["(no change)"];
  const lineEnd = (text: string, start: number) => {
    const end = text.indexOf("\n", start);
    return end < 0 ? text.length : end;
  };
  let beforeStart = 0, afterStart = 0;
  while (beforeStart <= before.length && afterStart <= after.length) {
    const b = lineEnd(before, beforeStart), a = lineEnd(after, afterStart);
    if (b - beforeStart !== a - afterStart || before.slice(beforeStart, b) !== after.slice(afterStart, a)) break;
    beforeStart = b + 1; afterStart = a + 1;
  }
  let beforeEnd = before.length, afterEnd = after.length;
  while (beforeEnd >= beforeStart && afterEnd >= afterStart) {
    // lastIndexOf(..., -1) clamps to zero, so an empty first line needs
    // an explicit boundary rather than accidentally including its LF.
    const b = beforeEnd === 0 ? 0 : before.lastIndexOf("\n", beforeEnd - 1) + 1;
    const a = afterEnd === 0 ? 0 : after.lastIndexOf("\n", afterEnd - 1) + 1;
    if (beforeEnd - b !== afterEnd - a || before.slice(b, beforeEnd) !== after.slice(a, afterEnd)) break;
    beforeEnd = b - 1; afterEnd = a - 1;
  }
  const out: string[] = [];
  const preview = (line: string) => {
    // Joining bounded code points detaches substrings from a potentially huge
    // original backing string. Do not split a surrogate pair at either edge.
    const copy = (text: string) => Array.from(text).join("");
    if (line.length <= 1024) return copy(line);
    const head = line.slice(0, 512).replace(/[\uD800-\uDBFF]$/, "");
    const tail = line.slice(-512).replace(/^[\uDC00-\uDFFF]/, "");
    return copy(head) + " … [truncated] … " + copy(tail);
  };
  const append = (text: string, start: number, end: number, prefix: string, action: string) => {
    let count = 0, omitted = false;
    for (let cursor = start; cursor <= end;) {
      const next = lineEnd(text, cursor);
      if (count >= maxLines) omitted = true;
      else out.push(prefix + preview(text.slice(cursor, Math.min(next, end))));
      count++; cursor = Math.min(next, end) + 1;
    }
    if (omitted) out.push(`…${count} line(s) ${action}`);
  };
  append(before, beforeStart, beforeEnd, "- ", "removed");
  append(after, afterStart, afterEnd, "+ ", "added");
  return out;
}
