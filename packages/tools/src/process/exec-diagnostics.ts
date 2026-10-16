/*!
MIT License

Copyright (c) 2025 Mario Zechner

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
*/
// UTF-8 boundary trimming adapted from pi OutputAccumulator.trimTail:
// HARNESS-SRC-FORK@1a46ea13de9a3f5e6987c5dd0319b2000fe49c92,
// pi-main/packages/coding-agent/src/core/tools/output-accumulator.ts.
// Only its bounded in-memory tail is adapted; there is no file I/O here.
export const EXEC_DIAGNOSTIC_TAIL_BYTES = 768;

/** Receives already decoded executor chunks. The independent stdout/stderr
 * tails together fit the existing 2000-byte context tail preview. */
export class ExecDiagnosticTail {
  private tailText = '';
  private total = 0;
  readonly maxBytes: number;

  constructor(policyLimit = EXEC_DIAGNOSTIC_TAIL_BYTES) {
    this.maxBytes = Math.max(0, Math.min(EXEC_DIAGNOSTIC_TAIL_BYTES, Math.floor(policyLimit))) || 0;
  }

  append(text: string): void {
    this.total = Math.min(Number.MAX_SAFE_INTEGER, this.total + Buffer.byteLength(text, 'utf8'));
    if (this.maxBytes === 0 || text.length === 0) return;
    const buffer = Buffer.from(this.tailText + text, 'utf8');
    let start = Math.max(0, buffer.length - this.maxBytes);
    while (start < buffer.length && (buffer[start]! & 0xc0) === 0x80) start++;
    // toString owns only the bounded suffix, never the original large chunk.
    this.tailText = buffer.subarray(start).toString('utf8');
  }

  get text(): string { return this.tailText; }
  get observedBytes(): number { return this.total; }
}
