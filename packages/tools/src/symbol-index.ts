import { opendir, realpath, stat } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { setImmediate as yieldToEventLoop } from "node:timers/promises";
import { isNodeErrorCode } from "@ar/contracts";
import { normalizePath } from "@ar/security";
import { resolveSearchScope } from "./navigate.js";
import { IndexedSourceError, MAX_INDEXED_SOURCE_BYTES, readIndexedSource as readFile } from "./indexed-source-reader.js";

/**
 * P7-4 (EXPERIMENT): lightweight TypeScript/JavaScript symbol index built on
 * line-aware regex over source files — no tsserver dependency, deterministic,
 * fast enough for repo-scale scans. Indexes declarations (function/class/
 * interface/type/const/let/var), imports and exports; references are found by
 * grepping the indexed lines. Other languages keep the grep fallback.
 *
 * The index is cached per normalized root and selected scope. Queries validate the source file
 * set and file stats, reusing unchanged contents; concurrent queries share
 * that validation. A TTL periodically forces a full content refresh.
 */

export type SymbolRole = "definition" | "import" | "export" | "reference" | "unknown";

/** Shape-compatible with navigate.SymbolHit (file/line/kind/name/text) so the
 *  tool result surface is identical whether the index or the grep produced it.
 *  `role` rides along for consumers that understand it. */
export interface SymbolHit {
  file: string;
  line: number;
  kind: string;
  name: string;
  text: string;
  role?: SymbolRole;
  /** The source line was shortened around the match. */
  truncated?: boolean;
}

export interface SymbolSearchIndexResult {
  fallback: false;
  indexer: "ts-regex-index";
  hits: SymbolHit[];
  filesIndexed: number;
  indexFresh: boolean;
  hasUnindexedFiles: boolean;
  complete: boolean;
  lexicalSummary: LexicalScanSummary;
}

export interface LexicalScanSummary {
  complete: boolean;
  scannedFiles: number;
  unreadableFiles: number;
  unreadableDirectories: number;
  skippedOversizedFiles: number;
  limitedLongLines: number;
  changedFiles: number;
  unavailableScope: boolean;
  fileLimitReached: boolean;
  entryLimitReached: boolean;
  depthLimitReached: boolean;
  limitReached: boolean;
  maxFileBytes: number;
  maxLineChars: number;
  maxFiles: number;
  maxEntries: number;
  maxDepth: number;
  visitedEntries: number;
}

const SOURCE_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"]);
export const SYMBOL_INDEX_SKIP_DIRS: ReadonlySet<string> = new Set(["node_modules", ".git", "dist", "build", "out", ".cache", "coverage", ".DS_Store"]);
const MAX_HIT_LINE = 2000;
const MAX_INDEXED_LINE_CHARS = 1024 * 1024;
const LONG_LINE_CHUNK = 64 * 1024;
const MAX_INDEX_FILES = 20_000;
const MAX_INDEX_ENTRIES = 50_000;
const MAX_INDEX_DEPTH = 128;
const MAX_CACHED_FILE_BYTES = 8 * 1024 * 1024;
const MAX_SCOPE_CONTENT_BYTES = 16 * 1024 * 1024;
const MAX_GLOBAL_CACHE_BYTES = 32 * 1024 * 1024;
const MAX_ACTIVE_LAZY_READS = 4;

function freshSummary(): LexicalScanSummary {
  return { complete: true, scannedFiles: 0, unreadableFiles: 0, unreadableDirectories: 0, skippedOversizedFiles: 0, limitedLongLines: 0,
    changedFiles: 0, unavailableScope: false, fileLimitReached: false, entryLimitReached: false, depthLimitReached: false, limitReached: false,
    maxFileBytes: MAX_INDEXED_SOURCE_BYTES, maxLineChars: MAX_INDEXED_LINE_CHARS, maxFiles: MAX_INDEX_FILES,
    maxEntries: MAX_INDEX_ENTRIES, maxDepth: MAX_INDEX_DEPTH, visitedEntries: 0 };
}

function markReadFailure(summary: LexicalScanSummary, error: unknown): void {
  summary.complete = false;
  if (error instanceof IndexedSourceError && error.code === "SOURCE_TOO_LARGE") summary.skippedOversizedFiles++;
  else if (error instanceof IndexedSourceError && error.code === "SOURCE_CHANGED") summary.changedFiles++;
  else summary.unreadableFiles++;
}

export function isIndexedSourceFile(path: string): boolean {
  return SOURCE_EXTENSIONS.has(path.slice(path.lastIndexOf(".")));
}

const DECL_PATTERNS: ReadonlyArray<{ kind: string; re: RegExp }> = [
  { kind: "function", re: /(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/ },
  { kind: "class", re: /(?:export\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/ },
  { kind: "interface", re: /(?:export\s+)?interface\s+([A-Za-z_$][\w$]*)/ },
  { kind: "type", re: /(?:export\s+)?type\s+([A-Za-z_$][\w$]*)\s*=/ },
  { kind: "const", re: /(?:export\s+)?const\s+([A-Za-z_$][\w$]*)/ },
  { kind: "enum", re: /(?:export\s+)?enum\s+([A-Za-z_$][\w$]*)/ },
];

/** An unclosed repeated `export {` must not repeatedly rescan the line tail. */
function isExportLine(line: string): boolean {
  const prefix = /\bexport\s+/.exec(line);
  if (!prefix) return false;
  const rest = line.slice(prefix.index + prefix[0].length);
  if (rest.startsWith("{")) return rest.indexOf("}") >= 0;
  return /^(?:default|const|function|class|interface|type|enum)/.test(rest);
}

/** Heuristic import classification with bounded, single-pass operations.
 * The old two lazy wildcards around an identifier could backtrack
 * quadratically on a long malformed `import` line and block cancellation. */
function importsBinding(line: string, needle: string): boolean {
  const prefix = /\bimport\s+/.exec(line);
  if (!prefix) return false;
  let rest = line.slice(prefix.index + prefix[0].length);
  rest = rest.replace(/^type\s+/, "");
  const from = /\bfrom\s*['"]/.exec(rest);
  if (!from) return false;
  const bindings = rest.slice(0, from.index).trim();
  if (bindings.startsWith("{")) {
    const end = bindings.indexOf("}");
    if (end < 0) return false;
    return bindings.slice(1, end).split(",").some(part => {
      const local = part.trim().replace(/^type\s+/, "").split(/\s+as\s+/).at(-1);
      return local?.toLowerCase() === needle;
    });
  }
  const namespace = /^\*\s+as\s+([A-Za-z_$][\w$]*)/.exec(bindings);
  if (namespace) return namespace[1]!.toLowerCase() === needle;
  const defaultBinding = /^([A-Za-z_$][\w$]*)/.exec(bindings);
  return defaultBinding?.[1]?.toLowerCase() === needle;
}

/** Map an offset in the lowercase search string back to the original line.
 * For example, lowercasing U+0130 expands it into two UTF-16 code units. */
async function originalMatchOffset(line: string, lower: string, offset: number, signal?: AbortSignal): Promise<number> {
  if (line.length === lower.length) return offset;
  let original = 0, folded = 0, visited = 0;
  for (const character of line) {
    if (++visited % 16384 === 0) { await yieldToEventLoop(); signal?.throwIfAborted(); }
    const next = folded + character.toLowerCase().length;
    if (offset < next) return original;
    folded = next; original += character.length;
  }
  return line.length;
}

/** For unusually long/minified lines, bound temporary lowercase strings and
 * keep searching across chunk boundaries. Classification remains heuristic. */
async function longLineMatchOffset(line: string, needle: string, signal?: AbortSignal): Promise<number | undefined> {
  if (needle.length > LONG_LINE_CHUNK / 2) return undefined;
  const overlap = needle.length * 2 + 4;
  let chunks = 0;
  for (let cursor = 0; cursor < line.length; cursor += LONG_LINE_CHUNK) {
    if (++chunks % 16 === 0) await yieldToEventLoop();
    signal?.throwIfAborted();
    let begin = Math.max(0, cursor - overlap);
    let end = Math.min(line.length, cursor + LONG_LINE_CHUNK);
    if (begin > 0 && /[\uDC00-\uDFFF]/u.test(line[begin]!)) begin--;
    if (end < line.length && /[\uD800-\uDBFF]/u.test(line[end - 1]!)) end++;
    const segment = line.slice(begin, end), lower = segment.toLowerCase();
    const index = lower.indexOf(needle);
    if (index >= 0) return begin + await originalMatchOffset(segment, lower, index, signal);
  }
  return undefined;
}

interface IndexedFile {
  relPath: string;
  /** Undefined when this file is read on demand instead of retained in cache. */
  content?: string;
  mtimeMs: number;
  ctimeMs: number;
  size: number;
}

interface RootIndex {
  root: string;
  realRoot: string;
  files: Map<string, IndexedFile>;
  builtAt: number;
  hasUnindexedFiles: boolean;
  lexicalSummary: LexicalScanSummary;
}

const cache = new Map<string, CacheEntry>();
type LoadedIndex = { filesIndexed: number } & RootIndex;
interface SharedFlight<T> {
  controller: AbortController;
  promise: Promise<T>;
  subscribers: number;
  settled: boolean;
}
const flights = new Map<string, SharedFlight<LoadedIndex>>();
interface LazyReadFlight extends SharedFlight<string> { releaseSlot?: () => void }
interface LazyReadLease { content: string; release: () => void }
interface SlotWaiter { signal: AbortSignal; resolve: (release: () => void) => void; reject: (error: unknown) => void; onAbort: () => void }
const sourceFlights = new Map<string, LazyReadFlight>();
const slotWaiters: SlotWaiter[] = [];
let activeLazyReads = 0;

function releaseLazySlot(): () => void {
  let released = false;
  return () => {
    if (released) return;
    released = true;
    while (slotWaiters.length) {
      const waiter = slotWaiters.shift()!;
      waiter.signal.removeEventListener("abort", waiter.onAbort);
      if (waiter.signal.aborted) { waiter.reject(waiter.signal.reason); continue; }
      waiter.resolve(releaseLazySlot());
      return;
    }
    activeLazyReads--;
  };
}

function acquireLazySlot(signal: AbortSignal): Promise<() => void> {
  signal.throwIfAborted();
  if (activeLazyReads < MAX_ACTIVE_LAZY_READS) { activeLazyReads++; return Promise.resolve(releaseLazySlot()); }
  return new Promise((resolve, reject) => {
    const waiter: SlotWaiter = { signal, resolve, reject, onAbort: () => {
      const index = slotWaiters.indexOf(waiter);
      if (index >= 0) { slotWaiters.splice(index, 1); signal.removeEventListener("abort", waiter.onAbort); reject(signal.reason); }
    } };
    slotWaiters.push(waiter);
    signal.addEventListener("abort", waiter.onAbort, { once: true });
    if (signal.aborted) waiter.onAbort();
  });
}

function finishLazyFlight(key: string, flight: LazyReadFlight): void {
  if (!flight.settled || flight.subscribers !== 0) return;
  if (sourceFlights.get(key) === flight) sourceFlights.delete(key);
  flight.releaseSlot?.(); flight.releaseSlot = undefined;
}

/** A resolved read remains leased until each query finishes scanning it. */
function subscribeLazy(key: string, flight: LazyReadFlight, signal?: AbortSignal): Promise<LazyReadLease> {
  flight.subscribers++;
  return new Promise((resolve, reject) => {
    let released = false;
    const release = (): boolean => {
      if (released) return false;
      released = true; signal?.removeEventListener("abort", onAbort); flight.subscribers--;
      if (flight.subscribers === 0) {
        if (!flight.settled) flight.controller.abort();
        else finishLazyFlight(key, flight);
      }
      return true;
    };
    const onAbort = () => { if (release()) reject(signal!.reason); };
    flight.promise.then(
      content => {
        if (released) return;
        signal?.removeEventListener("abort", onAbort);
        resolve({ content, release: () => { release(); } });
      },
      error => { if (release()) reject(error); },
    );
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) onAbort();
  });
}

/** A caller owns its wait, not other callers' work. Stop the shared scan only
 * after its last subscriber leaves; always observe the worker's settlement. */
function subscribe<T>(flight: SharedFlight<T>, signal?: AbortSignal): Promise<T> {
  flight.subscribers++;
  return new Promise((resolve, reject) => {
    let finished = false;
    const release = (): boolean => {
      if (finished) return false;
      finished = true;
      signal?.removeEventListener("abort", onAbort);
      flight.subscribers--;
      if (flight.subscribers === 0 && !flight.settled) flight.controller.abort();
      return true;
    };
    const onAbort = () => { if (release()) reject(signal!.reason); };
    flight.promise.then(
      index => { if (release()) resolve(index); },
      error => { if (release()) reject(error); },
    );
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) onAbort();
  });
}

// P15-5: the module-level symbol-index cache is process-scoped (key = root
// plus selected scope), but it must never serve STALE cross-repo state and never grow
// without bound. File-level validation catches edits inside nested directories
// whose parent root stat did not change. TTL also covers changes preserving
// both size and mtime. Capacity evicts the least recently used root.
const CACHE_TTL_MS = 60_000;
const MAX_CACHE_ENTRIES = 64;
let cacheBytes = 0;

interface CacheEntry {
  index: RootIndex;
  lastFullRefreshAt: number;
  bytes: number;
}

function deleteCacheEntry(key: string): void {
  const entry = cache.get(key);
  if (entry) { cacheBytes -= entry.bytes; cache.delete(key); }
}

function indexWeight(index: RootIndex): number {
  let bytes = 512;
  for (const file of index.files.values()) bytes += 256 + file.relPath.length * 2 + (file.content?.length ?? 0) * 2;
  return bytes;
}

function evictIfNeeded(): void {
  while (cache.size > MAX_CACHE_ENTRIES || cacheBytes > MAX_GLOBAL_CACHE_BYTES) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    deleteCacheEntry(oldest);
  }
}

async function listSourceFiles(dir: string, out: { files: string[]; hasUnindexedFiles: boolean }, summary: LexicalScanSummary, signal: AbortSignal, depth = 0): Promise<void> {
  signal.throwIfAborted();
  let directory: Awaited<ReturnType<typeof opendir>> | undefined;
  try {
    directory = await opendir(dir, { bufferSize: 64 });
    signal.throwIfAborted();
    while (true) {
      signal.throwIfAborted();
      const entry = await directory.read();
      signal.throwIfAborted();
      if (!entry) break;
      if (summary.visitedEntries >= MAX_INDEX_ENTRIES) { summary.entryLimitReached = true; summary.complete = false; return; }
      summary.visitedEntries++;
      if (summary.visitedEntries % 1024 === 0) await yieldToEventLoop();
      signal.throwIfAborted();
      if (entry.isDirectory()) {
        if (SYMBOL_INDEX_SKIP_DIRS.has(entry.name)) continue;
        if (depth >= MAX_INDEX_DEPTH) { summary.depthLimitReached = true; summary.complete = false; continue; }
        await listSourceFiles(join(dir, entry.name), out, summary, signal, depth + 1);
        if (summary.fileLimitReached || summary.entryLimitReached) return;
        continue;
      }
      if (!entry.isFile()) continue;
      if (isIndexedSourceFile(entry.name)) {
        out.files.push(join(dir, entry.name));
        if (out.files.length >= MAX_INDEX_FILES) { summary.fileLimitReached = true; summary.complete = false; return; }
      } else out.hasUnindexedFiles = true;
    }
  } catch (err) {
    signal.throwIfAborted();
    if (!isNodeErrorCode(err, "ENOENT")) {
      process.stderr.write(`[degraded] symbol-index.listSourceFiles: ${err instanceof Error ? err.message : String(err)}\n`);
    }
    summary.unreadableDirectories++; summary.complete = false;
  } finally {
    await directory?.close();
  }
}

async function buildRootIndex(
  scope: NonNullable<Awaited<ReturnType<typeof resolveSearchScope>>>,
  realRoot: string,
  signal: AbortSignal,
  previous?: RootIndex,
  forceRefresh = false,
): Promise<RootIndex> {
  signal.throwIfAborted();
  const { root } = scope;
  const files = new Map<string, IndexedFile>();
  const sourceFiles = { files: [] as string[], hasUnindexedFiles: false };
  const summary = freshSummary();
  let cachedContentBytes = 0;
  if (scope.type === "file") {
    if (isIndexedSourceFile(scope.path)) sourceFiles.files.push(scope.path);
    else sourceFiles.hasUnindexedFiles = true;
  } else {
    await listSourceFiles(scope.path, sourceFiles, summary, signal);
  }
  for (const file of sourceFiles.files) {
    signal.throwIfAborted();
    try {
      const st = await stat(file);
      signal.throwIfAborted();
      if (!st.isFile()) { summary.unreadableFiles++; summary.complete = false; continue; }
      if (st.size > MAX_INDEXED_SOURCE_BYTES) { summary.skippedOversizedFiles++; summary.complete = false; continue; }
      const rel = normalizePath(relative(root, file));
      const existing = previous?.files.get(rel);
      const cacheFile = st.size <= MAX_CACHED_FILE_BYTES && cachedContentBytes + st.size * 2 <= MAX_SCOPE_CONTENT_BYTES;
      if (cacheFile && !forceRefresh && existing?.content !== undefined && existing.mtimeMs === st.mtimeMs && existing.ctimeMs === st.ctimeMs && existing.size === st.size) {
        files.set(rel, existing);
        cachedContentBytes += existing.content.length * 2;
      } else if (cacheFile) {
        const content = await readFile(file, { encoding: "utf8", signal, root, realRoot });
        signal.throwIfAborted();
        // The file may have grown between the outer stat and the reader's
        // snapshot. Do not retain content that no longer fits the cache.
        if (Buffer.byteLength(content, "utf8") <= MAX_CACHED_FILE_BYTES &&
            cachedContentBytes + content.length * 2 <= MAX_SCOPE_CONTENT_BYTES) {
          files.set(rel, { relPath: rel, content, mtimeMs: st.mtimeMs, ctimeMs: st.ctimeMs, size: st.size });
          cachedContentBytes += content.length * 2;
        } else {
          files.set(rel, { relPath: rel, mtimeMs: st.mtimeMs, ctimeMs: st.ctimeMs, size: st.size });
        }
      } else {
        files.set(rel, { relPath: rel, mtimeMs: st.mtimeMs, ctimeMs: st.ctimeMs, size: st.size });
      }
    } catch (err) {
      signal.throwIfAborted();
      markReadFailure(summary, err);
      // P14-6: an unreadable file is skipped from the index — reported unless
      // it vanished (ENOENT), never silent.
      if (!isNodeErrorCode(err, "ENOENT")) {
        process.stderr.write(`[degraded] symbol-index.read-file: ${err instanceof Error ? err.message : String(err)}\n`);
      }
    }
  }
  return { root, realRoot, files, builtAt: Date.now(), hasUnindexedFiles: sourceFiles.hasUnindexedFiles, lexicalSummary: summary };
}

/** Get a fresh file-level index, sharing both cold builds and warm validation
 *  across callers for the same normalized workspace root and selected scope. */
export async function getSymbolIndex(root: string, relPath = ".", signal?: AbortSignal): Promise<LoadedIndex> {
  signal?.throwIfAborted();
  const normalizedRoot = resolve(root);
  const scope = await resolveSearchScope(normalizedRoot, relPath, SYMBOL_INDEX_SKIP_DIRS);
  signal?.throwIfAborted();
  if (!scope) {
    const summary = freshSummary(); summary.complete = false; summary.unavailableScope = true;
    return { root: normalizedRoot, realRoot: normalizedRoot, files: new Map(), builtAt: Date.now(), filesIndexed: 0, hasUnindexedFiles: false, lexicalSummary: summary };
  }
  const key = JSON.stringify([normalizedRoot, scope.relPath]);
  const pending = flights.get(key);
  if (pending && !pending.controller.signal.aborted) return subscribe(pending, signal);
  const controller = new AbortController();
  const load = async () => {
    controller.signal.throwIfAborted();
    let realRoot: string;
    try { realRoot = await realpath(normalizedRoot); }
    catch (err) {
      controller.signal.throwIfAborted();
      const summary = freshSummary(); summary.complete = false; summary.unavailableScope = true;
      return { root: normalizedRoot, realRoot: normalizedRoot, files: new Map<string, IndexedFile>(), builtAt: Date.now(), filesIndexed: 0, hasUnindexedFiles: false, lexicalSummary: summary };
    }
    const previous = cache.get(key);
    const existing = previous?.index.realRoot === realRoot ? previous : undefined;
    const forceRefresh = !existing || Date.now() - existing.lastFullRefreshAt >= CACHE_TTL_MS;
    const built = await buildRootIndex(scope, realRoot, controller.signal, existing?.index, forceRefresh);
    controller.signal.throwIfAborted();
    deleteCacheEntry(key);
    const bytes = indexWeight(built);
    cache.set(key, {
      index: built,
      lastFullRefreshAt: forceRefresh ? built.builtAt : existing!.lastFullRefreshAt,
      bytes,
    });
    cacheBytes += bytes;
    evictIfNeeded();
    return { ...built, filesIndexed: built.files.size };
  };
  // Defer the scan until the creator has subscribed. A new flight may replace
  // an aborted one before its final I/O unwinds; that old finalizer must never
  // delete the replacement or publish partial data into the cache.
  const flight: SharedFlight<LoadedIndex> = { controller, subscribers: 0, settled: false, promise: Promise.resolve().then(load) };
  flight.promise = flight.promise.finally(() => {
    flight.settled = true;
    if (flights.get(key) === flight) flights.delete(key);
  });
  flights.set(key, flight);
  return subscribe(flight, signal);
}

/** Share only the live read, never retain a large source after the final
 * query completes. A new file identity and an aborted old read get new flights. */
function readLazyFile(index: RootIndex, file: IndexedFile, signal?: AbortSignal): Promise<LazyReadLease> {
  signal?.throwIfAborted();
  const key = JSON.stringify([index.root, index.realRoot, file.relPath, file.size, file.mtimeMs, file.ctimeMs]);
  const pending = sourceFlights.get(key);
  if (pending && !pending.controller.signal.aborted) return subscribeLazy(key, pending, signal);
  const controller = new AbortController();
  const flight: LazyReadFlight = { controller, subscribers: 0, settled: false, promise: Promise.resolve().then(async () => {
    flight.releaseSlot = await acquireLazySlot(controller.signal);
    controller.signal.throwIfAborted();
    return readFile(resolve(index.root, file.relPath), {
      encoding: "utf8", signal: controller.signal, root: index.root, realRoot: index.realRoot,
    });
  }) };
  flight.promise = flight.promise.finally(() => {
    flight.settled = true;
    finishLazyFlight(key, flight);
  });
  sourceFlights.set(key, flight);
  return subscribeLazy(key, flight, signal);
}

/** P7-4: search the light index; always succeeds with fallback:false. */
export async function indexedSymbolSearch(input: {
  symbol: string;
  root: string;
  relPath?: string;
  maxHits?: number;
  signal?: AbortSignal;
}): Promise<SymbolSearchIndexResult> {
  const { symbol, root } = input;
  const index = await getSymbolIndex(root, input.relPath, input.signal);
  input.signal?.throwIfAborted();
  const needle = symbol.toLowerCase();
  const maxHits = input.maxHits ?? 200;
  const hits: SymbolHit[] = [];
  const summary = { ...index.lexicalSummary };
  let visited = 0;
  for (const file of index.files.values()) {
    if (hits.length >= maxHits) break;
    let content = file.content;
    let lease: LazyReadLease | undefined;
    if (content === undefined) {
      try {
        lease = await readLazyFile(index, file, input.signal);
        content = lease.content;
      } catch (err) {
        input.signal?.throwIfAborted(); markReadFailure(summary, err); continue;
      }
    }
    try {
      summary.scannedFiles++;
      let lineStart = 0, lineNumber = 1;
      while (lineStart <= content.length && hits.length < maxHits) {
        if (++visited % 1024 === 0) await yieldToEventLoop();
        input.signal?.throwIfAborted();
        const newline = content.indexOf("\n", lineStart);
        const lineEnd = newline < 0 ? content.length : newline;
        const line = content.slice(lineStart, lineEnd);
        lineStart = newline < 0 ? content.length + 1 : newline + 1;
        const currentLine = lineNumber++;
        const longLine = line.length > MAX_INDEXED_LINE_CHARS;
        let offset = 0;
        if (longLine) {
          summary.limitedLongLines++; summary.complete = false;
          const found = await longLineMatchOffset(line, needle, input.signal);
          if (found === undefined) continue;
          offset = found;
        } else {
          const lower = line.toLowerCase();
          if (!lower.includes(needle)) continue;
          if (line.length > MAX_HIT_LINE) offset = await originalMatchOffset(line, lower, lower.indexOf(needle), input.signal);
        }
        const truncated = line.length > MAX_HIT_LINE;
        let start = truncated ? Math.max(0, offset - Math.floor((MAX_HIT_LINE - Math.min(needle.length, MAX_HIT_LINE)) / 2)) : 0;
        if (start > 0 && /[\uDC00-\uDFFF]/u.test(line[start]!)) start--;
        let end = Math.min(line.length, start + MAX_HIT_LINE);
        if (end < line.length && /[\uD800-\uDBFF]/u.test(line[end - 1]!)) end--;
        const excerpt = line.slice(start, end);
        // RegExp match state can retain its input. Isolate the line before
        // classification so a short hit cannot pin a huge backing string.
        const classified = Buffer.from(longLine ? excerpt : line, "utf8").toString("utf8");
        let role: SymbolRole = "reference";
        let kind = "reference";
        for (const pattern of DECL_PATTERNS) {
          const m = classified.match(pattern.re);
          if (m !== null && m[1]!.toLowerCase() === needle) {
            role = "definition";
            kind = pattern.kind;
            break;
          }
        }
        if (role !== "definition") {
          const exportMatch = isExportLine(classified);
          if (exportMatch) {
            role = "export";
            kind = "export";
          } else {
            if (importsBinding(classified, needle)) {
              role = "import";
              kind = "import";
            }
          }
        }
        // A V8 substring can retain the entire source backing string even when
        // the visible hit is tiny. Copy the bounded excerpt into its own string.
        const text = Buffer.from(excerpt.trim(), "utf8").toString("utf8");
        hits.push({ file: file.relPath, line: currentLine, kind, name: symbol, text, role, ...(truncated ? { truncated: true } : {}) });
      }
    } finally { lease?.release(); }
  }
  input.signal?.throwIfAborted();
  if (hits.length >= maxHits) { summary.complete = false; summary.limitReached = true; }
  return { fallback: false, indexer: "ts-regex-index", hits, filesIndexed: index.files.size, indexFresh: summary.complete,
    hasUnindexedFiles: index.hasUnindexedFiles, complete: summary.complete, lexicalSummary: summary };
}
