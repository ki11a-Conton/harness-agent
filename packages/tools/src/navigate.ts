/**
 * P2-29 Search / Code Navigation Tools.
 *
 * Unified navigation primitives so the agent does not have to guess at paths
 * by repeatedly issuing read_file attempts:
 *   - file search   → existing search_files (glob) tool
 *   - text search   → grepFiles()  (regex over file contents)
 *   - symbol search → symbolSearch() (regex fallback when no symbol index)
 *   - repo tree     → repoTree()   (nested tree of files/dirs)
 *   - dependency    → deferred (needs a real graph; read only when an index exists)
 *
 * No symbol index is maintained (out of scope), so symbol search degrades to a
 * clear, documented fallback: a small set of language-agnostic symbol regexes
 * over matched lines. The fallback is honest — it returns `fallback: true` and a
 * `indexer` note so consumers know this is heuristic, not a semantic index.
 *
 * All functions are pure-ish over a root dir, skip VCS/dependency dirs
 * (.git / node_modules / .svg? no), cap output, and guard against binary and
 * oversized files. They are read-only.
 */
import { promises as fs, type Dirent } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { matchGlob } from "@ar/security";
import { RegexScanner, SymbolRegexScanner } from "./regex-scanner.js";

const SKIP_DIRS = new Set([".git", "node_modules", ".DS_Store", "dist", "build", "coverage"]);
const MAX_READ_BYTES = 512 * 1024; // skip files larger than this for text search
const MAX_LINE = 2000;

/** Resolve an approved search selection without following user-selected links.
 * Ancestor lstat calls only validate the path; source enumeration and reads
 * must start at the returned file or directory, never at its workspace root.
 * The workspace root itself is trusted and may be an alias/junction. */
export async function resolveSearchScope(
  root: string,
  relPath = ".",
  ignoredDirectories: ReadonlySet<string> = SKIP_DIRS,
): Promise<{ root: string; path: string; relPath: string; type: "file" | "directory" } | null> {
  const base = resolve(root);
  const path = resolve(base, relPath);
  const selected = normalizeSlashes(relative(base, path)) || ".";
  if (isAbsolute(selected) || selected === ".." || selected.startsWith("../")) return null;
  if (selected === ".") return { root: base, path, relPath: selected, type: "directory" };
  const parts = selected.split("/");
  for (let i = 1; i <= parts.length; i += 1) {
    const current = await fs.lstat(join(base, ...parts.slice(0, i))).catch(() => null);
    if (!current || current.isSymbolicLink()) return null;
    if (current.isDirectory()) {
      if (ignoredDirectories.has(parts[i - 1]!)) return null;
      if (i === parts.length) return { root: base, path, relPath: selected, type: "directory" };
    } else if (i === parts.length && current.isFile()) {
      return { root: base, path, relPath: selected, type: "file" };
    } else {
      return null;
    }
  }
  return null;
}

export interface GrepHit {
  file: string;
  line: number;
  column: number;
  text: string;
  /** Present only when the matching source line exceeds the rendered budget. */
  truncated?: boolean;
}

export interface GrepScanSummary {
  complete: boolean;
  scannedFiles: number;
  skippedOversizedFiles: number;
  skippedBinaryFiles: number;
  unreadableFiles: number;
  unreadableDirectories: number;
  truncatedLines: number;
  limitReached: boolean;
  maxFileBytes: number;
  unavailableScope?: boolean;
}

export function createGrepScanSummary(): GrepScanSummary {
  return { complete: true, scannedFiles: 0, skippedOversizedFiles: 0, skippedBinaryFiles: 0,
    unreadableFiles: 0, unreadableDirectories: 0, truncatedLines: 0, limitReached: false, maxFileBytes: MAX_READ_BYTES };
}

export interface GrepFilesInput {
  pattern: string;
  root: string;
  relPath?: string;
  caseSensitive?: boolean;
  literal?: boolean;
  /** Restrict to file basenames matching this glob (e.g. "*.ts"). */
  fileGlob?: string | null;
  maxHits?: number;
  signal?: AbortSignal;
  /** Caller-owned diagnostics; hits remain a plain JSON-serializable array. */
  summary?: GrepScanSummary;
}

/** Recursive walk yielding files (with rel path), skipping VCS/dep dirs. */
export async function walkFiles(
  root: string,
  rel = ".",
  onFile: (abs: string, rel: string) => Promise<boolean | void>,
  onDir?: (dirs: string[], abs: string, rel: string) => void,
  signal?: AbortSignal,
  onUnreadableDirectory?: (path: string) => void,
): Promise<void> {
  // Keep the public void result; the private recursive result propagates a
  // callback's stop through every ancestor, including later sibling subtrees.
  async function visit(relDir: string): Promise<boolean> {
    signal?.throwIfAborted();
    let entries: Dirent[];
    try {
      entries = await fs.readdir(join(root, relDir), { withFileTypes: true });
    } catch {
      signal?.throwIfAborted();
      onUnreadableDirectory?.(join(root, relDir));
      return true; // an unreadable subtree does not stop its readable siblings
    }
    signal?.throwIfAborted();
    if (onDir) onDir(entries.map((e) => e.name), join(root, relDir), relDir);
    for (const e of entries) {
      signal?.throwIfAborted();
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name)) continue;
        if (!(await visit(relDir === "." ? e.name : `${relDir}/${e.name}`))) return false;
      } else if (e.isFile()) {
        const relFile = relDir === "." ? e.name : `${relDir}/${e.name}`;
        if ((await onFile(join(root, relFile), relFile)) === false) return false;
      }
    }
    return true;
  }
  await visit(rel === "" ? "." : rel);
}

export function grepFiles(input: GrepFilesInput): Promise<GrepHit[]> {
  return (async () => {
    const { root, relPath, signal } = input;
    signal?.throwIfAborted();
    let re: RegExp;
    try {
      re = new RegExp(input.literal ? escapeRegExp(input.pattern) : input.pattern, input.caseSensitive ? "" : "i");
    } catch (err) {
      throw err; // exposed by caller as a schema/argument error
    }
    const hits: GrepHit[] = [];
    const summary = input.summary ?? createGrepScanSummary();
    const scope = await resolveSearchScope(root, relPath ?? ".");
    signal?.throwIfAborted();
    if (!scope) { summary.complete = false; summary.unavailableScope = true; return hits; }
    let scanner: RegexScanner | undefined;
    const searchFile = async (abs: string, relFile: string): Promise<boolean | void> => {
      signal?.throwIfAborted();
      if (hits.length >= (input.maxHits ?? 200)) return false;
      if (input.fileGlob) {
        const candidate = relFile.split("/").pop()!;
        if (!matchGlob(input.fileGlob!, candidate)) return;
      }
      let stat;
      try {
        stat = await fs.stat(abs);
      } catch {
        signal?.throwIfAborted();
        summary.unreadableFiles++; summary.complete = false;
        return;
      }
      signal?.throwIfAborted();
      if (stat.size > MAX_READ_BYTES) { summary.skippedOversizedFiles++; summary.complete = false; return; }
      let text: string;
      try {
        text = await fs.readFile(abs, { encoding: "utf8", signal });
      } catch {
        signal?.throwIfAborted();
        summary.unreadableFiles++; summary.complete = false;
        return; // binary or unreadable → skip
      }
      signal?.throwIfAborted();
      summary.scannedFiles++;
      // Refuse obvious binary content.
      if (text.includes("\u0000")) { summary.skippedBinaryFiles++; return; }
      const lines = text.split("\n");
      const remaining = (input.maxHits ?? 200) - hits.length;
      let positions: Array<{ line: number; column: number }>;
      if (input.literal) {
        // Escaped fixed strings cannot introduce regex backtracking. Keep the
        // existing JS case-insensitive matching semantics without a worker.
        positions = [];
        for (let i = 0; i < lines.length && positions.length < remaining; i++) {
          signal?.throwIfAborted(); const column = lines[i]!.search(re);
          if (column >= 0) positions.push({ line: i + 1, column: column + 1 });
        }
      } else {
        scanner ??= new RegexScanner(input.pattern, input.caseSensitive ?? false, signal);
        positions = await scanner.scan(text, remaining);
        signal?.throwIfAborted();
      }
      for (const position of positions) {
        const line = lines[position.line - 1]!;
        const m = position.column - 1;
        const truncated = line.length > MAX_LINE;
        if (truncated) summary.truncatedLines++;
        // Keep the actual match visible even when it occurs near a long line's tail.
        let begin = truncated ? Math.max(0, m - Math.floor(MAX_LINE / 2)) : 0;
        if (begin > 0 && /[\uDC00-\uDFFF]/u.test(line[begin]!)) begin--;
        let end = Math.min(line.length, begin + MAX_LINE);
        if (end < line.length && /[\uD800-\uDBFF]/u.test(line[end - 1]!)) end--;
        hits.push({ file: relFile, line: position.line, column: position.column, text: line.slice(begin, end), ...(truncated ? { truncated: true } : {}) });
      }
      // Stop at the matching file itself, before reading another directory.
      if (hits.length >= (input.maxHits ?? 200)) { summary.complete = false; summary.limitReached = true; return false; }
      return true;
    };
    try {
      if (scope.type === "file") await searchFile(scope.path, scope.relPath);
      else await walkFiles(scope.root, scope.relPath, searchFile, undefined, signal, () => {
        summary.unreadableDirectories++; summary.complete = false;
      });
      signal?.throwIfAborted();
      return hits;
    } finally {
      await scanner?.close();
    }
  })();
}

/** Language-agnostic symbol patterns (fallback when no symbol index exists). */
const SYMBOL_PATTERNS: Array<{ label: string; re: RegExp }> = [
  { label: "function", re: /\bfunction\s+([A-Za-z_$][\w$]*)\b/g },
  { label: "class", re: /\bclass\s+([A-Za-z_$][\w$]*)\b/g },
  { label: "type", re: /\b(?:type|interface)\s+([A-Za-z_$][\w$]*)\b/g },
  { label: "const", re: /\bconst\s+([A-Za-z_$][\w$]*)\s*=/g },
  { label: "method", re: /\b([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*\{/g },
  { label: "export", re: /\bexport\s+(?:default\s+)?(?:function|class|const|type|interface)\s+([A-Za-z_$][\w$]*)/g },
  { label: "def", re: /\bdef\s+([A-Za-z_$][\w$]*)\s*\(/g }, // python
  { label: "import", re: /\b(?:import|require)\s*\(?['"]([^'"]+)['"]\)?/g },
];

export interface SymbolHit {
  file: string;
  line: number;
  kind: string;
  name: string;
  text: string;
}

export interface SymbolSearchInput extends Omit<GrepFilesInput, "pattern" | "maxHits"> {
  symbol: string;
  maxHits?: number;
}

/** Regex fallback symbol search. Returns `fallback: true` + an indexer note. */
export async function symbolSearch(input: SymbolSearchInput): Promise<{
  fallback: true;
  indexer: string;
  hits: SymbolHit[];
}> {
  input.signal?.throwIfAborted();
  const { root, relPath, symbol } = input;
  // Build a per-marker regex. `//g` not needed; we test the whole matched text.
  const want =
    symbol === "" ? null : `\\b${escapeRegExp(symbol)}\\b`;
  const hits: SymbolHit[] = [];
  const cap = input.maxHits ?? 200;
  const scope = await resolveSearchScope(root, relPath ?? ".");
  let scanner: SymbolRegexScanner | undefined;

  const searchFile = async (abs: string, relFile: string): Promise<boolean | void> => {
    input.signal?.throwIfAborted();
    if (hits.length >= cap) return false;
    let text: string;
    try {
      const stat = await fs.stat(abs);
      input.signal?.throwIfAborted();
      if (stat.size > MAX_READ_BYTES) return;
      text = await fs.readFile(abs, { encoding: "utf8", signal: input.signal });
    } catch {
      input.signal?.throwIfAborted();
      return;
    }
    input.signal?.throwIfAborted();
    if (text.includes("\u0000")) return;
    scanner ??= new SymbolRegexScanner(SYMBOL_PATTERNS, want, input.signal);
    const matched = await scanner.scan(text, cap - hits.length);
    input.signal?.throwIfAborted();
    hits.push(...matched.map(hit => ({ file: relFile, ...hit })));
    return hits.length < cap;
  };
  try {
    if (scope?.type === "file") {
      await searchFile(scope.path, scope.relPath);
    } else if (scope) {
      await walkFiles(scope.root, scope.relPath, searchFile, undefined, input.signal);
    }
  } finally {
    await scanner?.close();
  }

  return {
    fallback: true,
    indexer: "regex-symbol-fallback (no semantic symbol index; connect a language server/LSP index to upgrade)",
    hits,
  };
}

export function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export interface RepoTreeEntry {
  path: string;
  type: "file" | "dir";
  depth: number;
}

export interface RepoTreeInput {
  root: string;
  relPath?: string;
  depth?: number;
  maxEntries?: number;
  signal?: AbortSignal;
}

/** Nested directory/file tree of the repo (for orientation / repo map). */
export async function repoTree(input: RepoTreeInput): Promise<RepoTreeEntry[]> {
  input.signal?.throwIfAborted();
  const { root, relPath } = input;
  const start = resolve(root, relPath ?? ".");
  const base = resolve(root);
  const startRel = normalizeSlashes(relative(base, start)) || ".";
  const maxDepth = input.depth ?? 6;
  const cap = input.maxEntries ?? 500;
  const out: RepoTreeEntry[] = [];
  if (cap <= 0 || depthOf(startRel) >= maxDepth) return out;

  // Preserve the old subpath output's ancestors, but verify real directories
  // instead of synthesizing them from a filename. The trusted root itself may
  // be a symlink; only user-selected descendants must not follow symlinks.
  const ancestors: RepoTreeEntry[] = [];
  if (startRel !== ".") {
    const parts = startRel.split("/");
    for (let i = 1; i <= parts.length; i += 1) {
      const path = parts.slice(0, i).join("/");
      const stat = await fs.lstat(join(base, path)).catch(() => null);
      input.signal?.throwIfAborted();
      if (!stat?.isDirectory()) return out;
      ancestors.push({ path, type: "dir", depth: depthOf(path) });
    }
  }

  function append(entry: RepoTreeEntry): boolean {
    // An empty subtree still returns [] as before. Ancestors count toward the
    // same cap as files and directories and are emitted only for real entries.
    if (out.length === 0) {
      for (const ancestor of ancestors) {
        if (out.length >= cap) return false;
        out.push(ancestor);
      }
    }
    if (out.length >= cap) return false;
    out.push(entry);
    return out.length < cap;
  }

  async function visit(relDir: string): Promise<boolean> {
    input.signal?.throwIfAborted();
    let entries: Dirent[];
    try {
      entries = await fs.readdir(join(base, relDir), { withFileTypes: true });
    } catch {
      input.signal?.throwIfAborted();
      return true;
    }
    input.signal?.throwIfAborted();
    for (const entry of entries) {
      input.signal?.throwIfAborted();
      if (!entry.isDirectory() && !entry.isFile()) continue;
      if (entry.isDirectory() && SKIP_DIRS.has(entry.name)) continue;
      const path = relDir === "." ? entry.name : `${relDir}/${entry.name}`;
      const depth = depthOf(path);
      if (depth > maxDepth) continue;
      if (!append({ path, type: entry.isDirectory() ? "dir" : "file", depth })) return false;
      // At the boundary the directory itself is visible, but its children
      // cannot qualify, so never list them. A filled cap also stops globally.
      if (entry.isDirectory() && depth < maxDepth && !(await visit(path))) return false;
    }
    return true;
  }
  await visit(startRel);
  out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return out;
}

function depthOf(rel: string): number {
  return rel === "." ? 0 : rel.split("/").length;
}

/** Walk a directory's immediate children (used by repo_tree to avoid re-list). */
export function normalizeSlashes(p: string): string {
  return p.split(sep).join("/");
}
