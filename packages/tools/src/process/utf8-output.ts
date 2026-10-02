import { StringDecoder } from "node:string_decoder";

/** The longest complete-character prefix whose UTF-8 encoding fits the cap. */
export function utf8Prefix(text: string, maxBytes: number): string {
  if (!(maxBytes > 0)) return "";
  let bytes = 0;
  let end = 0;
  for (const character of text) {
    const codePoint = character.codePointAt(0)!;
    const size = codePoint <= 0x7f ? 1 : codePoint <= 0x7ff ? 2 : codePoint <= 0xffff ? 3 : 4;
    if (bytes + size > maxBytes) break;
    bytes += size;
    end += character.length;
  }
  if (end === text.length) return text;
  if (end === 0) return "";
  // Copy only the bounded prefix, so a sliced string cannot retain the entire
  // decoded chunk (or the original tool output) after the caller drops it.
  return Buffer.from(text.slice(0, end), "utf8").toString("utf8");
}

/** One stream's bounded capture, independent of its unbounded live delivery.
 * StringDecoder retains at most three incomplete UTF-8 bytes between writes.
 * After a character exceeds the remaining cap, capture stays closed so later
 * smaller characters cannot turn the retained text into a non-prefix. */
export class Utf8OutputCollector {
  private readonly decoder = new StringDecoder("utf8");
  private readonly chunks: string[] = [];
  private capturedBytes = 0;
  private ended = false;
  truncated = false;

  constructor(private readonly maxBytes: number) {}

  write(data: Buffer): string {
    if (this.ended) return "";
    return this.capture(this.decoder.write(data));
  }

  /** Flush only at EOF, once: a genuinely incomplete character becomes U+FFFD. */
  end(): string {
    if (this.ended) return "";
    this.ended = true;
    return this.capture(this.decoder.end());
  }

  get text(): string {
    return this.chunks.join("");
  }

  private capture(text: string): string {
    if (text.length === 0 || this.truncated) return text;
    const prefix = utf8Prefix(text, this.maxBytes - this.capturedBytes);
    if (prefix.length > 0) {
      this.chunks.push(prefix);
      this.capturedBytes += Buffer.byteLength(prefix, "utf8");
    }
    if (prefix.length < text.length) this.truncated = true;
    return text;
  }
}
