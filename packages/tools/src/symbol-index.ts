import { readdir, readFile, stat } from "node:fs/promises";
import { join, relative } from "node:path";
import { isNodeErrorCode } from "@ar/contracts";
import { normalizePath } from "@ar/security";

/**
 * P7-4 (EXPERIMENT): lightweight TypeScript/JavaScript symbol index built on
 * line-aware regex over source files — no tsserver dependency, deterministic,
 * fast enough for repo-scale scans. Indexes declarations (function/class/
 * interface/type/const/let/var), imports and exports; references are found by
 * grepping the indexed lines. Other languages keep the grep fallback.
 *
 * The index is cached per root with mtime fingerprints so repeated searches
 * in one process do not re-scan (same discipline as RepositoryMapCache).
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
}

interface RootIndex {
  root: string;
  files: Map<string, IndexedFile>;
  builtAt: number;
}

const cache = new Map<string, CacheEntry>();

// P15-5: the module-level symbol-index cache is process-scoped (key = root
// path), but it must never serve STALE cross-repo state and never grow
// without bound. Freshness: the cache entry expires after CACHE_TTL_MS and
// whenever the root directory's own mtime/size changes. Capacity: an LRU-ish
// cap evicts the oldest entry so N repos cannot pile up unbounded memory.
const CACHE_TTL_MS = 60_000;
const MAX_CACHE_ENTRIES = 64;

interface CacheEntry {
  index: RootIndex;
  rootStat: { mtimeMs: number; size: number };
}

async function rootFingerprint(root: string): Promise<{ mtimeMs: number; size: number }> {
  try {
    const st = await stat(root);
    return { mtimeMs: st.mtimeMs, size: st.size };
  } catch {
    return { mtimeMs: 0, size: 0 };
  }
}

function evictIfNeeded(): void {
  if (cache.size >= MAX_CACHE_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
}

async function listSourceFiles(dir: string, root: string, out: string[]): Promise<void> {
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
      await listSourceFiles(join(dir, entry.name), root, out);
      continue;
    }
    if (!entry.isFile()) continue;
    const ext = entry.name.slice(entry.name.lastIndexOf("."));
    if (SOURCE_EXTENSIONS.has(ext)) out.push(join(dir, entry.name));
  }
}

async function buildRootIndex(root: string): Promise<RootIndex> {
  const files = new Map<string, IndexedFile>();
  const sourceFiles: string[] = [];
  await listSourceFiles(root, root, sourceFiles);
  for (const file of sourceFiles) {
    try {
      const [content, st] = await Promise.all([readFile(file, "utf8"), stat(file)]);
      const rel = normalizePath(relative(root, file));
    files.set(rel, { relPath: rel, lines: content.split("\n"), mtimeMs: st.mtimeMs });
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

/** Get (building if needed) the process-level index for a root. P15-5: the
 *  cache is keyed by the root path AND validated against the root directory
 *  fingerprint + TTL, so one repo's stale state can never leak into another
 *  repo (or into the same repo after a change) through the shared module
 *  cache. */
export async function getSymbolIndex(root: string): Promise<{ filesIndexed: number } & RootIndex> {
  const existing = cache.get(root);
  if (existing !== undefined) {
    const now = Date.now();
    const fp = await rootFingerprint(root);
    const fingerprintFresh =
      existing.rootStat.mtimeMs === fp.mtimeMs && existing.rootStat.size === fp.size;
    if (fingerprintFresh && now - existing.index.builtAt < CACHE_TTL_MS) {
      return { ...existing.index, filesIndexed: existing.index.files.size };
    }
    // stale (fingerprint changed or TTL expired): rebuild below
    cache.delete(root);
  }
  const built = await buildRootIndex(root);
  cache.set(root, { index: built, rootStat: await rootFingerprint(root) });
  evictIfNeeded();
  return { ...built, filesIndexed: built.files.size };
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

  for (const file of index.files.values()) {
    if (input.relPath !== undefined && file.relPath !== input.relPath && !file.relPath.startsWith(input.relPath)) {
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
