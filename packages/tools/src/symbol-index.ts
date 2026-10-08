import { readdir, readFile, stat } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { isNodeErrorCode } from "@ar/contracts";
import { normalizePath } from "@ar/security";
import { resolveSearchScope } from "./navigate.js";

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
}

export interface SymbolSearchIndexResult {
  fallback: false;
  indexer: "ts-regex-index";
  hits: SymbolHit[];
  filesIndexed: number;
  indexFresh: boolean;
}

const SOURCE_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"]);
const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build", "out", ".cache", "coverage"]);

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

interface IndexedFile {
  relPath: string;
  lines: string[];
  mtimeMs: number;
  size: number;
}

interface RootIndex {
  root: string;
  files: Map<string, IndexedFile>;
  builtAt: number;
}

const cache = new Map<string, CacheEntry>();
const flights = new Map<string, Promise<{ filesIndexed: number } & RootIndex>>();

// P15-5: the module-level symbol-index cache is process-scoped (key = root
// plus selected scope), but it must never serve STALE cross-repo state and never grow
// without bound. File-level validation catches edits inside nested directories
// whose parent root stat did not change. TTL also covers changes preserving
// both size and mtime. Capacity evicts the least recently used root.
const CACHE_TTL_MS = 60_000;
const MAX_CACHE_ENTRIES = 64;

interface CacheEntry {
  index: RootIndex;
  lastFullRefreshAt: number;
}

function evictIfNeeded(): void {
  while (cache.size > MAX_CACHE_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
}

async function listSourceFiles(dir: string, out: string[]): Promise<void> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (err) {
    // P14-6: an unreadable/vanish directory is skipped — reported unless it
    // simply disappeared (ENOENT).
    if (!isNodeErrorCode(err, "ENOENT")) {
      process.stderr.write(`[degraded] symbol-index.listSourceFiles: ${err instanceof Error ? err.message : String(err)}\n`);
    }
    return;
  }
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      await listSourceFiles(join(dir, entry.name), out);
      continue;
    }
    if (!entry.isFile()) continue;
    const ext = entry.name.slice(entry.name.lastIndexOf("."));
    if (SOURCE_EXTENSIONS.has(ext)) out.push(join(dir, entry.name));
  }
}

async function buildRootIndex(
  scope: NonNullable<Awaited<ReturnType<typeof resolveSearchScope>>>,
  previous?: RootIndex,
  forceRefresh = false,
): Promise<RootIndex> {
  const { root } = scope;
  const files = new Map<string, IndexedFile>();
  const sourceFiles: string[] = [];
  if (scope.type === "file") {
    if (SOURCE_EXTENSIONS.has(scope.path.slice(scope.path.lastIndexOf(".")))) sourceFiles.push(scope.path);
  } else {
    await listSourceFiles(scope.path, sourceFiles);
  }
  for (const file of sourceFiles) {
    try {
      const st = await stat(file);
      const rel = normalizePath(relative(root, file));
      const existing = previous?.files.get(rel);
      if (!forceRefresh && existing?.mtimeMs === st.mtimeMs && existing.size === st.size) {
        files.set(rel, existing);
      } else {
        const content = await readFile(file, "utf8");
        files.set(rel, { relPath: rel, lines: content.split("\n"), mtimeMs: st.mtimeMs, size: st.size });
      }
    } catch (err) {
      // P14-6: an unreadable file is skipped from the index — reported unless
      // it vanished (ENOENT), never silent.
      if (!isNodeErrorCode(err, "ENOENT")) {
        process.stderr.write(`[degraded] symbol-index.read-file: ${err instanceof Error ? err.message : String(err)}\n`);
      }
    }
  }
  return { root, files, builtAt: Date.now() };
}

/** Get a fresh file-level index, sharing both cold builds and warm validation
 *  across callers for the same normalized workspace root and selected scope. */
export async function getSymbolIndex(root: string, relPath = "."): Promise<{ filesIndexed: number } & RootIndex> {
  const normalizedRoot = resolve(root);
  const scope = await resolveSearchScope(normalizedRoot, relPath, SKIP_DIRS);
  if (!scope) return { root: normalizedRoot, files: new Map(), builtAt: Date.now(), filesIndexed: 0 };
  const key = JSON.stringify([normalizedRoot, scope.relPath]);
  const pending = flights.get(key);
  if (pending) return pending;
  const load = async () => {
    const existing = cache.get(key);
    const forceRefresh = !existing || Date.now() - existing.lastFullRefreshAt >= CACHE_TTL_MS;
    const built = await buildRootIndex(scope, existing?.index, forceRefresh);
    cache.delete(key);
    cache.set(key, {
      index: built,
      lastFullRefreshAt: forceRefresh ? built.builtAt : existing!.lastFullRefreshAt,
    });
    evictIfNeeded();
    return { ...built, filesIndexed: built.files.size };
  };
  const promise = load();
  flights.set(key, promise);
  try {
    return await promise;
  } finally {
    if (flights.get(key) === promise) flights.delete(key);
  }
}

/** P7-4: search the light index; always succeeds with fallback:false. */
export async function indexedSymbolSearch(input: {
  symbol: string;
  root: string;
  relPath?: string;
  maxHits?: number;
}): Promise<SymbolSearchIndexResult> {
  const { symbol, root } = input;
  const index = await getSymbolIndex(root, input.relPath);
  const needle = symbol.toLowerCase();
  const maxHits = input.maxHits ?? 200;
  const hits: SymbolHit[] = [];
  for (const file of index.files.values()) {
    for (let i = 0; i < file.lines.length && hits.length < maxHits; i++) {
      const line = file.lines[i]!;
      const lower = line.toLowerCase();
      if (!lower.includes(needle)) continue;
      let role: SymbolRole = "reference";
      let kind = "reference";
      for (const pattern of DECL_PATTERNS) {
        const m = line.match(pattern.re);
        if (m !== null && m[1]!.toLowerCase() === needle) {
          role = "definition";
          kind = pattern.kind;
          break;
        }
      }
      if (role !== "definition") {
        const exportMatch = isExportLine(line);
        if (exportMatch) {
          role = "export";
          kind = "export";
        } else {
          if (importsBinding(line, needle)) {
            role = "import";
            kind = "import";
          }
        }
      }
      hits.push({ file: file.relPath, line: i + 1, kind, name: symbol, text: line.trim(), role });
    }
  }
  return { fallback: false, indexer: "ts-regex-index", hits, filesIndexed: index.files.size, indexFresh: true };
}
