/** Incremental SSE framing for the provider transport. A message is delimited
 * by a blank line, and its data fields are joined with LF. Network chunks and
 * SSE lines are independent, including a CRLF split between two reads.
 * Non-data fields/comments carry no chat-completion payload.
 */
export class SseEventDecoder {
  // Keep the BOM visible so exactly one leading BOM is consumed below.
  private readonly utf8 = new TextDecoder("utf-8", { ignoreBOM: true });
  private line = "";
  private data: string[] = [];
  private skipLf = false;
  private started = false;

  push(bytes: Uint8Array): string[] {
    return this.consume(this.utf8.decode(bytes, { stream: true }));
  }

  /** Retain Harness's EOF compatibility: a complete final JSON payload is
   * accepted even if the compatible server omitted the terminating blank line.
   * JSON validity and normal completion evidence remain the provider's checks.
   */
  finish(): string[] {
    const events = this.consume(this.utf8.decode());
    if (this.line.length > 0) { this.acceptLine(this.line, events); this.line = ""; }
    this.dispatch(events);
    return events;
  }

  private consume(text: string): string[] {
    const events: string[] = [];
    if (!text.length) return events;
    if (!this.started) {
      this.started = true;
      // The optional leading BOM may itself have spanned network reads.
      if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
    }
    let start = 0;
    for (let index = 0; index < text.length; index++) {
      const code = text.charCodeAt(index);
      if (this.skipLf) {
        this.skipLf = false;
        if (code === 10) { start = index + 1; continue; }
      }
      if (code !== 10 && code !== 13) continue;
      this.acceptLine(this.line + text.slice(start, index), events);
      this.line = "";
      this.skipLf = code === 13;
      start = index + 1;
    }
    this.line += text.slice(start);
    return events;
  }

  private acceptLine(line: string, events: string[]): void {
    if (!line.length) { this.dispatch(events); return; }
    const colon = line.indexOf(":");
    const field = colon < 0 ? line : line.slice(0, colon);
    if (field !== "data") return;
    let value = colon < 0 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    this.data.push(value);
  }

  private dispatch(events: string[]): void {
    if (this.data.length > 0) events.push(this.data.join("\n"));
    this.data = [];
  }
}
