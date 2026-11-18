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

export interface ReadPage {
  startLine: number;
  endLine: number;
  truncated: boolean;
  truncatedBy?: "lines" | "bytes";
  nextOffset?: number;
  firstLineExceedsLimit?: boolean;
  hint?: string;
  content: string;
}

export interface ReadWindow extends ReadPage {
  totalLines: number;
}

export type ScannedReadWindow =
  | (ReadWindow & { bytes: number; sha256?: string; scanComplete?: never })
  | (ReadWindow & { bytes: number; scanComplete: true; scannedBytes: number })
  | (ReadPage & { scanComplete: false; scannedBytes: number });

function windowResult(selected: string[], offset: number, totalLines: number | undefined, exceeded: boolean, maxBytes: number): ReadPage {
  const next = offset + selected.length;
  const truncated = totalLines === undefined || next <= totalLines;
  const firstLineExceedsLimit = exceeded && selected.length === 0;
  return {
    startLine: offset, endLine: selected.length ? next - 1 : offset - 1,
    ...(totalLines === undefined ? {} : { totalLines }),
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
  return { ...windowResult(selected, offset, lines.length, exceeded, maxBytes), totalLines: lines.length };
}

/** Scan an owned descriptor with bounded memory. By default count all lines
 * and optionally hash the whole file. Window mode only scans until it has the
 * page and evidence of continuation, or sees EOF. The caller owns the handle. */
export async function readWindowFromHandle(handle: FileHandle, options: {
  offset?: number; limit?: number; maxBytes?: number; versioned?: boolean; scan?: "window"; signal: AbortSignal;
}): Promise<ScannedReadWindow> {
  const offset = options.offset ?? 1;
  const limit = options.limit ?? DEFAULT_READ_LINES;
  const maxBytes = options.maxBytes ?? DEFAULT_READ_BYTES;
  const earlyStop = options.scan === "window";
  const digest = options.versioned ? createHash("sha256") : undefined;
  const buffer = Buffer.allocUnsafe(64 * 1024);
  const selected: string[] = [];
  let currentLine = 1, totalBytes = 0, outputBytes = 0, lineBytes = 0;
  let parts: Buffer[] = [];
  let exceeded = false, endedWithNewline = false;
  const unfinishedPage = (): ScannedReadWindow => ({
    scanComplete: false, scannedBytes: totalBytes,
    ...windowResult(selected, offset, undefined, exceeded, maxBytes),
  });

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
      // Any byte after a completed page proves another line exists, even
      // when it is blank or the page ended exactly at a native read boundary.
      if (earlyStop && selected.length === limit) return unfinishedPage();
      const newline = chunk.indexOf(10, position);
      const end = newline < 0 ? chunk.length : newline;
      capture(chunk.subarray(position, end));
      if (earlyStop && exceeded) return unfinishedPage();
      if (newline < 0) { endedWithNewline = false; break; }
      completeLine();
      if (earlyStop && exceeded) return unfinishedPage();
      endedWithNewline = true; position = newline + 1;
    }
  }
  const totalLines = totalBytes === 0 ? 0 : currentLine - (endedWithNewline ? 1 : 0);
  if (totalBytes > 0 && !endedWithNewline) completeLine();
  if (offset > Math.max(1, totalLines)) throw new Error(`offset ${offset} is beyond end of file (${totalLines} lines)`);
  const page = windowResult(selected, offset, totalLines, exceeded, maxBytes);
  if (earlyStop) return { scanComplete: true, scannedBytes: totalBytes, bytes: totalBytes, ...page, totalLines };
  return { bytes: totalBytes, ...(digest ? { sha256: digest.digest("hex") } : {}), ...page, totalLines };
}
