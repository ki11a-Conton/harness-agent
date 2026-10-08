/**
 * Complete-line byte truncation adapted from pi's
 * packages/coding-agent/src/core/tools/truncate.ts (truncateHead), and its
 * read.ts pagination. Copyright (c) 2025 Mario Zechner, MIT.
 * The full notice is retained in third_party/coding-prompts/pi-MIT.txt.
 * Unlike the upstream normalised view, this helper preserves CRLF bytes.
 * Bounded chunk scanning also follows DeepSeek harness's MIT
 * packages/fs/tool-fs/src/read-render.ts (buildWindow); no provider or sandbox
 * implementation is copied. See licenses/deepseek-harness-MIT.txt.
 */
import { createHash } from "node:crypto";
import type { FileHandle } from "node:fs/promises";
export const DEFAULT_READ_LINES = 2000;
export const DEFAULT_READ_BYTES = 50 * 1024;

export interface ReadWindow {
  startLine: number;
  endLine: number;
  totalLines: number;
  truncated: boolean;
  truncatedBy?: "lines" | "bytes";
  nextOffset?: number;
  firstLineExceedsLimit?: boolean;
  hint?: string;
  content: string;
}

function windowResult(selected: string[], offset: number, totalLines: number, exceeded: boolean, maxBytes: number): ReadWindow {
  const next = offset + selected.length;
  const truncated = next <= totalLines;
  const firstLineExceedsLimit = exceeded && selected.length === 0;
  return {
    startLine: offset, endLine: selected.length ? next - 1 : offset - 1, totalLines,
    truncated,
    ...(truncated ? { truncatedBy: exceeded ? "bytes" as const : "lines" as const } : {}),
    ...(truncated && !firstLineExceedsLimit ? { nextOffset: next } : {}),
    ...(firstLineExceedsLimit ? { firstLineExceedsLimit: true,
      hint: `Line ${offset} exceeds maxBytes=${maxBytes}; increase maxBytes (up to 1048576), or inspect it with an approved exec. No partial line was returned.` } : {}),
    content: selected.join("\n"),
  };
}

/** Window a text snapshot by 1-based lines without returning partial UTF-8. */
export function readWindow(content: string, offset = 1, limit = DEFAULT_READ_LINES, maxBytes = DEFAULT_READ_BYTES): ReadWindow {
  const lines = content === "" ? [] : content.split("\n");
  if (content.endsWith("\n")) lines.pop();
  if (offset > Math.max(1, lines.length)) throw new Error(`offset ${offset} is beyond end of file (${lines.length} lines)`);
  const selected: string[] = [];
  let bytes = 0;
  let exceeded = false;
  for (let i = offset - 1; i < lines.length && selected.length < limit; i++) {
    const line = lines[i]!;
    const cost = Buffer.byteLength(line, "utf8") + (selected.length > 0 ? 1 : 0);
    if (bytes + cost > maxBytes) { exceeded = true; break; }
    selected.push(line); bytes += cost;
  }
  return windowResult(selected, offset, lines.length, exceeded, maxBytes);
}

/** Scan an owned descriptor with bounded memory. The complete file is scanned
 * for line counts and (when requested) its raw-byte SHA, but only the selected
 * complete lines are retained. Even a multi-gigabyte unterminated line cannot
 * grow the retained buffer. Descriptor lifetime belongs to read_file's lock. */
export async function readWindowFromHandle(handle: FileHandle, options: {
  offset?: number; limit?: number; maxBytes?: number; versioned?: boolean; signal: AbortSignal;
}): Promise<ReadWindow & { bytes: number; sha256?: string }> {
  const offset = options.offset ?? 1;
  const limit = options.limit ?? DEFAULT_READ_LINES;
  const maxBytes = options.maxBytes ?? DEFAULT_READ_BYTES;
  const digest = options.versioned ? createHash("sha256") : undefined;
  const buffer = Buffer.allocUnsafe(64 * 1024);
  const selected: string[] = [];
  let currentLine = 1, totalBytes = 0, outputBytes = 0, lineBytes = 0;
  let parts: Buffer[] = [];
  let exceeded = false, endedWithNewline = false;

  const capture = (part: Buffer): void => {
    lineBytes += part.length;
    if (currentLine < offset || selected.length >= limit || exceeded) return;
    const separator = selected.length > 0 ? 1 : 0;
    if (outputBytes + separator + lineBytes > maxBytes) { exceeded = true; parts = []; return; }
    if (part.length) parts.push(Buffer.from(part));
  };
  const completeLine = (): void => {
    if (currentLine >= offset && selected.length < limit && !exceeded) {
      const text = Buffer.concat(parts).toString("utf8");
      const bytes = Buffer.byteLength(text, "utf8");
      // Invalid input may expand to replacement characters during decoding;
      // apply the output-byte budget to rendered text as well as raw bytes.
      if (outputBytes + (selected.length ? 1 : 0) + bytes > maxBytes) exceeded = true;
      else { outputBytes += (selected.length ? 1 : 0) + bytes; selected.push(text); }
    }
    parts = []; lineBytes = 0; currentLine++;
  };
  for (;;) {
    options.signal.throwIfAborted();
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
    options.signal.throwIfAborted();
    if (bytesRead === 0) break;
    const chunk = buffer.subarray(0, bytesRead);
    totalBytes += bytesRead; digest?.update(chunk);
    let position = 0;
    while (position < chunk.length) {
      const newline = chunk.indexOf(10, position);
      const end = newline < 0 ? chunk.length : newline;
      capture(chunk.subarray(position, end));
      if (newline < 0) { endedWithNewline = false; break; }
      completeLine(); endedWithNewline = true; position = newline + 1;
    }
  }
  const totalLines = totalBytes === 0 ? 0 : currentLine - (endedWithNewline ? 1 : 0);
  if (totalBytes > 0 && !endedWithNewline) completeLine();
  if (offset > Math.max(1, totalLines)) throw new Error(`offset ${offset} is beyond end of file (${totalLines} lines)`);
  return { bytes: totalBytes, ...(digest ? { sha256: digest.digest("hex") } : {}),
    ...windowResult(selected, offset, totalLines, exceeded, maxBytes) };
}
