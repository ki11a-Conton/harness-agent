/**
 * Complete-line byte truncation adapted from pi's
 * packages/coding-agent/src/core/tools/truncate.ts (truncateHead), and its
 * read.ts pagination. Copyright (c) 2025 Mario Zechner, MIT.
 * The full notice is retained in third_party/coding-prompts/pi-MIT.txt.
 * Pages preserve the original separators between selected lines.
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

/** A line's separator only enters the page if the following line fits. */
class PageLines {
  readonly chunks: string[] = [];
  private bytes = 0;
  private separator = "";

  constructor(readonly maxBytes: number) {}

  get remainingLineBytes(): number {
    return this.maxBytes - this.bytes - this.separator.length;
  }

  append(raw: string, followedByLf: boolean): boolean {
    const crlf = followedByLf && raw.endsWith("\r");
    const line = crlf ? raw.slice(0, -1) : raw;
    const bytes = Buffer.byteLength(line);
    if (bytes > this.remainingLineBytes) return false;
    this.chunks.push(this.separator + line);
    this.bytes += this.separator.length + bytes;
    this.separator = crlf ? "\r\n" : "\n";
    return true;
  }
}

function windowResult(page: PageLines, offset: number, totalLines: number | undefined, exceeded: boolean): ReadPage {
  const { chunks: selected, maxBytes } = page;
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
    content: selected.join(""),
  };
}

/** Window a text snapshot by 1-based lines without returning partial UTF-8. */
export function readWindow(content: string, offset = 1, limit = DEFAULT_READ_LINES, maxBytes = DEFAULT_READ_BYTES): ReadWindow {
  const lines = content === "" ? [] : content.split("\n");
  const endsWithLf = content.endsWith("\n");
  if (endsWithLf) lines.pop();
  if (offset > Math.max(1, lines.length)) throw new Error(`offset ${offset} is beyond end of file (${lines.length} lines)`);
  const page = new PageLines(maxBytes);
  let exceeded = false;
  for (let i = offset - 1; i < lines.length && page.chunks.length < limit; i++) {
    if (!page.append(lines[i]!, i + 1 < lines.length || endsWithLf)) { exceeded = true; break; }
  }
  return { ...windowResult(page, offset, lines.length, exceeded), totalLines: lines.length };
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
  const selected = new PageLines(maxBytes);
  let currentLine = 1, totalBytes = 0, lineBytes = 0;
  let parts: Buffer[] = [];
  let exceeded = false, endedWithNewline = false;
  const unfinishedPage = (): ScannedReadWindow => ({
    scanComplete: false, scannedBytes: totalBytes,
    ...windowResult(selected, offset, undefined, exceeded),
  });

  const capture = (part: Buffer): void => {
    if (!part.length || currentLine < offset || selected.chunks.length >= limit || exceeded) return;
    lineBytes += part.length;
    // At the cap, a final CR can still be the first byte of a CRLF split across reads.
    const possibleCr = part[part.length - 1] === 13 ? 1 : 0;
    if (lineBytes - possibleCr > selected.remainingLineBytes) { exceeded = true; parts = []; return; }
    parts.push(Buffer.from(part));
  };
  const completeLine = (followedByLf: boolean): void => {
    if (currentLine >= offset && selected.chunks.length < limit && !exceeded) {
      // Decoding invalid UTF-8 may expand its byte count. Check the rendered line too.
      exceeded = !selected.append(Buffer.concat(parts).toString("utf8"), followedByLf);
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
      if (earlyStop && selected.chunks.length === limit) return unfinishedPage();
      const newline = chunk.indexOf(10, position);
      const end = newline < 0 ? chunk.length : newline;
      capture(chunk.subarray(position, end));
      if (earlyStop && exceeded) return unfinishedPage();
      if (newline < 0) { endedWithNewline = false; break; }
      completeLine(true);
      if (earlyStop && exceeded) return unfinishedPage();
      endedWithNewline = true; position = newline + 1;
    }
  }
  const totalLines = totalBytes === 0 ? 0 : currentLine - (endedWithNewline ? 1 : 0);
  if (totalBytes > 0 && !endedWithNewline) completeLine(false);
  if (offset > Math.max(1, totalLines)) throw new Error(`offset ${offset} is beyond end of file (${totalLines} lines)`);
  const page = windowResult(selected, offset, totalLines, exceeded);
  if (earlyStop) return { scanComplete: true, scannedBytes: totalBytes, bytes: totalBytes, ...page, totalLines };
  return { bytes: totalBytes, ...(digest ? { sha256: digest.digest("hex") } : {}), ...page, totalLines };
}
