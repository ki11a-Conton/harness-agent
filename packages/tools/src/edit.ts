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
  const matches = allMatchesIndexes(content, oldText);
  if (matches.length === 0) {
    return { ok: false, content, count: 0, matched: 0, error: "anchor not found" };
  }

  if (options.replaceAll) {
    const replaced = content.split(oldText).join(newText);
    return { ok: true, content: replaced, count: matches.length, matched: matches.length };
  }

  const occurrence = options.occurrence;
  if (occurrence !== undefined) {
    if (occurrence < 1 || occurrence > matches.length) {
      return {
        ok: false,
        content,
        count: 0,
        matched: matches.length,
        error: `occurrence ${occurrence} out of range (file has ${matches.length})`,
      };
    }
    const idx = matches[occurrence - 1]!;
    const replaced = content.slice(0, idx) + newText + content.slice(idx + oldText.length);
    return { ok: true, content: replaced, count: 1, matched: matches.length };
  }

  // Default: first occurrence (unchanged behaviour).
  const idx = matches[0]!;
  const replaced = content.slice(0, idx) + newText + content.slice(idx + oldText.length);
  return { ok: true, content: replaced, count: 1, matched: matches.length };
}

/** Structured line-range edit: replace lines [lineStart..lineEnd] (1-based,
 *  inclusive) with `replacement` (which may span multiple lines). */
export function applyLineRange(
  content: string,
  lineStart: number,
  lineEnd: number,
  replacement: string,
): ApplyResult {
  const lines = content.split("\n");
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
  // 1-based inclusive → JS slice: removed = lines.slice(lineStart-1, lineEnd).
  const removedCount = Math.max(0, Math.min(lineEnd, lines.length) - (lineStart - 1));
  const head = lines.slice(0, lineStart - 1);
  const tail = lines.slice(Math.min(lineEnd, lines.length));
  const replaceLines = replacement.length === 0 ? [] : replacement.split("\n");
  return {
    ok: true,
    content: [...head, ...replaceLines, ...tail].join("\n"),
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