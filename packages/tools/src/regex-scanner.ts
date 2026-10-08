import { Worker } from "node:worker_threads";

/** Total time budget per grep operation, including all selected files. */
export const REGEX_SEARCH_BUDGET_MS = 5000;

interface MatchPosition { line: number; column: number }
interface PendingScan<T> { resolve: (matches: T) => void; reject: (error: Error) => void }
export interface SymbolMatch { line: number; kind: string; name: string; text: string }

// Pure computation only: this worker has no filesystem, child-process, or
// network operations. A data URL makes plain Node dist, development loaders,
// and the portable release use the same self-contained worker implementation.
const SOURCE = String.raw`
import { parentPort, workerData } from "node:worker_threads";
const expression = workerData.mode === "symbols" ? null : new RegExp(workerData.pattern, workerData.caseSensitive ? "" : "i");
const symbols = workerData.mode === "symbols" ? workerData.patterns.map(p => ({ kind: p.kind, expression: new RegExp(p.source, p.flags) })) : null;
const want = workerData.want ? new RegExp(workerData.want, "i") : null;
parentPort.on("message", ({ text, maxHits }) => {
  if (symbols) {
    const matches = [];
    const lineStarts = [0];
    for (let i = 0; i < text.length; i++) if (text[i] === "\n") lineStarts.push(i + 1);
    const lineAt = offset => {
      let lo = 0, hi = lineStarts.length;
      while (lo + 1 < hi) { const mid = (lo + hi) >>> 1; if (lineStarts[mid] <= offset) lo = mid; else hi = mid; }
      return lo + 1;
    };
    for (const { kind, expression: scanner } of symbols) {
      scanner.lastIndex = 0;
      let found;
      while (matches.length < maxHits && (found = scanner.exec(text)) !== null) {
        if (!want || want.test(found[0])) matches.push({ line: lineAt(found.index), kind, name: found[1], text: found[0].slice(0, workerData.maxLine) });
        if (found[0].length === 0) scanner.lastIndex++;
      }
      if (matches.length >= maxHits) break;
    }
    parentPort.postMessage(matches);
    return;
  }
  const lines = text.split("\n");
  const matches = [];
  for (let i = 0; i < lines.length && matches.length < maxHits; i++) {
    const column = lines[i].search(expression);
    if (column >= 0) matches.push({ line: i + 1, column: column + 1 });
  }
  parentPort.postMessage(matches);
});
`;

/** Isolate potentially exponential model-supplied regex from the UI/runtime
 * event loop. One worker and one budget cover an entire multi-file grep.
 * Permission and filesystem selection remain in ToolOrchestrator/navigate. */
class RegexComputeWorker<T> {
  private readonly worker: Worker;
  private readonly timer: ReturnType<typeof setTimeout>;
  private pending?: PendingScan<T>;
  private failure?: Error;
  private termination?: Promise<number>;
  private readonly onAbort: () => void;

  constructor(workerData: Record<string, unknown>, private readonly signal?: AbortSignal, budgetMs = REGEX_SEARCH_BUDGET_MS) {
    signal?.throwIfAborted();
    this.worker = new Worker(new URL(`data:text/javascript,${encodeURIComponent(SOURCE)}`), { workerData });
    this.onAbort = () => this.stop(new Error("regex search cancelled"));
    this.timer = setTimeout(() => this.stop(new Error(
      workerData.mode === "symbols"
        ? `REGEX_SEARCH_LIMIT: symbol heuristics exceeded the ${budgetMs}ms total search budget; narrow the selected path or use grep_search with literal=true. No complete negative result is available.`
        : `REGEX_SEARCH_LIMIT: regex computation exceeded the ${budgetMs}ms total search budget; simplify the expression or use literal=true. No complete negative result is available.`,
    )), budgetMs);
    this.worker.on("message", (matches: T) => {
      const pending = this.pending; this.pending = undefined; pending?.resolve(matches);
    });
    this.worker.on("error", error => this.stop(new Error(`REGEX_SEARCH_WORKER_ERROR: ${error instanceof Error ? error.message : String(error)}`)));
    this.worker.on("exit", code => {
      if (!this.termination) this.stop(new Error(`REGEX_SEARCH_WORKER_ERROR: worker exited unexpectedly (${code})`));
    });
    signal?.addEventListener("abort", this.onAbort, { once: true });
    if (signal?.aborted) this.onAbort();
  }

  private stop(error: Error): void {
    if (!this.failure) this.failure = error;
    clearTimeout(this.timer);
    this.signal?.removeEventListener("abort", this.onAbort);
    const pending = this.pending; this.pending = undefined; pending?.reject(this.failure);
    if (!this.termination) this.termination = this.worker.terminate();
  }

  async scan(text: string, maxHits: number): Promise<T> {
    this.signal?.throwIfAborted();
    if (this.failure) throw this.failure;
    if (this.pending) throw new Error("regex scanner accepts sequential files only");
    return new Promise((resolve, reject) => {
      this.pending = { resolve, reject };
      try { this.worker.postMessage({ text, maxHits }); }
      catch (error) { this.stop(error instanceof Error ? error : new Error(String(error))); }
    });
  }

  async close(): Promise<void> {
    this.stop(new Error("regex scanner closed"));
    await this.termination;
  }
}

export class RegexScanner extends RegexComputeWorker<MatchPosition[]> {
  constructor(pattern: string, caseSensitive: boolean, signal?: AbortSignal, budgetMs = REGEX_SEARCH_BUDGET_MS) {
    super({ mode: "grep", pattern, caseSensitive }, signal, budgetMs);
  }
}

/** The existing heuristic symbol patterns can backtrack too; isolate their
 * global scans under exactly the same lifecycle and total budget as grep. */
export class SymbolRegexScanner extends RegexComputeWorker<SymbolMatch[]> {
  constructor(patterns: ReadonlyArray<{ label: string; re: RegExp }>, want: string | null,
    signal?: AbortSignal, budgetMs = REGEX_SEARCH_BUDGET_MS, maxLine = 2000) {
    super({ mode: "symbols", patterns: patterns.map(p => ({ kind: p.label, source: p.re.source, flags: p.re.flags })), want, maxLine }, signal, budgetMs);
  }
}
