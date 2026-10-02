import { readdir, readFile, stat } from "node:fs/promises";
import { join, relative, resolve, posix } from "node:path";
import { isNodeErrorCode } from "@ar/contracts";
import { normalizePath } from "@ar/security";

/**
 * P7-4 (EXPERIMENT): lightweight TypeScript/JavaScript symbol index built on
 * line-aware regex over source files — no tsserver dependency, deterministic,
 * fast enough for repo-scale scans. Indexes declarations (function/class/
 * interface/type/const/let/var), imports and exports; references are found by
 * grepping the indexed lines. Other languages keep the grep fallback.
 *
 * The index is cached per normalized root. Queries validate the source file
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

const IMPORT_RE = /import\s+(?:type\s+)?[^'"]*?\b([A-Za-z_$][\w$]*)\b[^'"]*?from\s+['"]/;
const NAMED_IMPORT_RE = /import\s+(?:type\s+)?\{([^}]*)\}\s*from\s+['"]/;
const EXPORT_RE = /export\s+(?:\{[^}]*\}|default|const|function|class|interface|type|enum)/;

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
// path), but it must never serve STALE cross-repo state and never grow
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

async function buildRootIndex(root: string, previous?: RootIndex, forceRefresh = false): Promise<RootIndex> {
  const files = new Map<string, IndexedFile>();
  const sourceFiles: string[] = [];
  await listSourceFiles(root, sourceFiles);
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
 *  across callers for the same normalized workspace root. */
export async function getSymbolIndex(root: string): Promise<{ filesIndexed: number } & RootIndex> {
  const normalizedRoot = resolve(root);
  const pending = flights.get(normalizedRoot);
  if (pending) return pending;
  const load = async () => {
    const existing = cache.get(normalizedRoot);
    const forceRefresh = !existing || Date.now() - existing.lastFullRefreshAt >= CACHE_TTL_MS;
    const built = await buildRootIndex(normalizedRoot, existing?.index, forceRefresh);
    cache.delete(normalizedRoot);
    cache.set(normalizedRoot, {
      index: built,
      lastFullRefreshAt: forceRefresh ? built.builtAt : existing!.lastFullRefreshAt,
    });
    evictIfNeeded();
    return { ...built, filesIndexed: built.files.size };
  };
  const promise = load();
  flights.set(normalizedRoot, promise);
  try {
    return await promise;
  } finally {
    if (flights.get(normalizedRoot) === promise) flights.delete(normalizedRoot);
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
  const index = await getSymbolIndex(root);
  const needle = symbol.toLowerCase();
  const maxHits = input.maxHits ?? 200;
  const hits: SymbolHit[] = [];
  // The tool defaults to ".". Normalize aliases and require a directory
  // boundary so "src/a" cannot select "src/ab" or "a.ts" select "a.tsx".
  const scope = posix.normalize(normalizePath(input.relPath ?? ".")).replace(/\/$/, "");

  for (const file of index.files.values()) {
    if (scope !== "." && file.relPath !== scope && !file.relPath.startsWith(`${scope}/`)) {
      continue;
    }
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
        const exportMatch = EXPORT_RE.test(line);
        if (exportMatch) {
          role = "export";
          kind = "export";
        } else {
          const named = line.match(NAMED_IMPORT_RE);
          if (named !== null && named[1]!.split(",").some((part) => part.trim().toLowerCase() === needle)) {
            role = "import";
            kind = "import";
          } else if (IMPORT_RE.test(line)) {
            const im = line.match(IMPORT_RE);
            if (im !== null && im[1]!.toLowerCase() === needle) {
              role = "import";
              kind = "import";
            }
          }
        }
      }
      hits.push({ file: file.relPath, line: i + 1, kind, name: symbol, text: line.trim(), role });
    }
  }
  return { fallback: false, indexer: "ts-regex-index", hits, filesIndexed: index.files.size, indexFresh: true };
}
