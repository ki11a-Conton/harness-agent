import { utf8Prefix } from "./process/utf8-output.js";

// Reserve 1 KiB of the 32 KiB response for the envelope and scan summary.
export const GREP_CONTEXT_HIT_BYTES = 23 * 1024;
const CONTEXT_BYTES = 8 * 1024;
const CONTEXT_LINE_BYTES = 768;

export interface GrepContextLine {
  file: string;
  line: number;
  text: string;
  truncated?: true;
}

/** Build ordered, nonoverlapping context from the same text as the matches. */
export class GrepContext {
  readonly lines: GrepContextLine[] = [];
  truncated = false;
  private remainingBytes = CONTEXT_BYTES;
  private exhausted = false;

  constructor(private readonly radius: number) {}

  collect(file: string, source: readonly string[], matches: readonly { line: number }[]): void {
    if (this.exhausted || matches.length === 0) return;
    const hitLines = new Set(matches.map(match => match.line));
    let visitedThrough = 0;
    for (const { line } of matches) {
      const start = Math.max(1, line - this.radius, visitedThrough + 1);
      const end = Math.min(source.length, line + this.radius);
      for (let neighbor = start; neighbor <= end; neighbor++) {
        if (hitLines.has(neighbor)) continue;
        const raw = source[neighbor - 1]!;
        const text = utf8Prefix(raw, CONTEXT_LINE_BYTES);
        const row: GrepContextLine = { file, line: neighbor, text, ...(text.length < raw.length ? { truncated: true } : {}) };
        const bytes = Buffer.byteLength(JSON.stringify(row), "utf8") + 1;
        if (bytes > this.remainingBytes) {
          this.truncated = true;
          this.exhausted = true;
          return;
        }
        this.remainingBytes -= bytes;
        if (row.truncated) this.truncated = true;
        this.lines.push(row);
      }
      visitedThrough = end;
    }
  }
}
