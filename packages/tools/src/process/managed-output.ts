import { utf8Prefix } from "./utf8-output.js";

export interface ManagedOutputChunk { stream: "stdout" | "stderr"; text: string; offset: number }

/** A bounded, combined-stream UTF-8 tail with absolute decoded-byte cursors.
 * Missing bytes and a cursor inside a character are reported, never invented. */
export class ManagedOutput {
  private chunks: ManagedOutputChunk[] = [];
  private retained = 0;
  totalBytes = 0;
  constructor(readonly capacity: number) {
    if (!Number.isSafeInteger(capacity) || capacity < 0 || capacity > 65536) throw new RangeError("invalid output capacity");
  }
  get floor(): number { return this.totalBytes - this.retained; }
  append(stream: "stdout" | "stderr", text: string): void {
    const offset = this.totalBytes;
    this.totalBytes += Buffer.byteLength(text);
    if (!text) return;
    this.chunks.push({ stream, text, offset });
    this.retained += this.totalBytes - offset;
    while (this.retained > this.capacity) {
      const first = this.chunks[0]!;
      const bytes = Buffer.from(first.text);
      if (bytes.length <= this.retained - this.capacity) {
        this.retained -= bytes.length; this.chunks.shift(); continue;
      }
      let drop = this.retained - this.capacity;
      while (drop < bytes.length && (bytes[drop]! & 0xc0) === 0x80) drop++;
      first.text = bytes.subarray(drop).toString("utf8"); first.offset += drop;
      this.retained -= drop;
      if (!first.text) this.chunks.shift();
    }
  }
  read(cursor: number, maxBytes = this.capacity) {
    if (!Number.isSafeInteger(cursor) || cursor < 0 || cursor > this.totalBytes) throw new RangeError("invalid output cursor");
    const chunks: ManagedOutputChunk[] = [];
    let nextCursor = Math.max(cursor, this.floor), lostBytes = nextCursor - cursor;
    let remaining = maxBytes;
    for (const chunk of this.chunks) {
      const bytes = Buffer.from(chunk.text);
      if (chunk.offset + bytes.length <= nextCursor) continue;
      let skip = Math.max(0, nextCursor - chunk.offset);
      while (skip < bytes.length && (bytes[skip]! & 0xc0) === 0x80) skip++;
      lostBytes += chunk.offset + skip - nextCursor;
      nextCursor = chunk.offset + skip;
      const text = utf8Prefix(bytes.subarray(skip).toString("utf8"), remaining);
      if (!text) break;
      chunks.push({ stream: chunk.stream, text, offset: nextCursor });
      const delivered = Buffer.byteLength(text);
      nextCursor += delivered; remaining -= delivered;
      if (delivered < bytes.length - skip || remaining === 0) break;
    }
    return { chunks, nextCursor, lostBytes, incomplete: lostBytes > 0, totalBytes: this.totalBytes, retainedBytes: this.retained };
  }
}
