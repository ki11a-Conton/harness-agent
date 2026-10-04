import { constants, type Dirent, type Stats } from "node:fs";
import { lstat, open, readdir, stat } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import type {
  DiscoveredInstruction,
  InstructionDiscovery,
  InstructionDiscoveryOptions,
} from "@ar/contracts";
import { isNodeErrorCode } from "@ar/contracts";

const DEFAULT_MAX_BYTES_PER_FILE = 50_000;
const DEFAULT_MAX_DOCUMENTS = 4;
const DOC_FILE_NAME = "AGENTS.md";

/** Directories never scanned for nested instruction documents (CTX-001). */
const SKIPPED_DIRECTORIES: ReadonlySet<string> = new Set([
  "node_modules",
  ".git",
  "dist",
  "out",
  "build",
  ".cache",
]);

interface Candidate {
  path: string;
  scope: "root" | "nested" | "cwd";
  depth: number;
}

/**
 * Hierarchical instruction discovery (CTX-001).
 *
 * Scope semantics:
 * - "root":   the topmost AGENTS.md found while walking up the ancestor chain
 *             of cwd (the climb stops at the first ancestor without the file,
 *             or at the filesystem root). Listed first in the result.
 * - "nested": AGENTS.md files found under cwd's subtree; the scan starts at
 *             cwd's child directories (never cwd itself), skips the
 *             allowlisted directories above and does not follow symlinks.
 *             Listed by ascending directory depth (ties by path).
 * - "cwd":    cwd's own AGENTS.md, listed last. When that document is also
 *             the topmost of the ancestor chain (cwd is the repository root),
 *             it appears exactly once with scope "cwd" (no separate root).
 *
 * The three scopes are mutually exclusive buckets: a path is never reported
 * twice. Ancestor-chain documents strictly between cwd and the topmost root
 * fit no bucket and are not reported.
 *
 * Reading is best-effort: a document that cannot be read (EACCES, race) is
 * skipped silently. An invalid cwd (missing, not a directory) rejects.
 */
export class HierarchicalInstructionDiscovery implements InstructionDiscovery {
  async discover(
    cwd: string,
    opts: InstructionDiscoveryOptions = {},
  ): Promise<DiscoveredInstruction[]> {
    const maxBytesPerFile = finiteBudget(opts.maxBytesPerFile ?? DEFAULT_MAX_BYTES_PER_FILE);
    const maxDocuments = finiteBudget(opts.maxDocuments ?? DEFAULT_MAX_DOCUMENTS);

    const root = resolve(cwd);
    const rootStat = await stat(root);
    if (!rootStat.isDirectory()) {
      throw new Error(`Instruction discovery: cwd is not a directory: ${root}`);
    }

    const chain = await this.findAncestorDocs(root);
    const cwdDoc = join(root, DOC_FILE_NAME);
    const topmost = chain.length > 0 ? chain[chain.length - 1] : undefined;

    const candidates: Candidate[] = [];
    if (topmost !== undefined) {
      candidates.push({
        path: topmost,
        scope: topmost === cwdDoc ? "cwd" : "root",
        depth: -1,
      });
    }

    const nested: Candidate[] = [];
    await this.scanNestedChildren(root, root, nested);
    nested.sort(
      (a, b) => a.depth - b.depth || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0),
    );
    for (const nestedCandidate of nested) {
      candidates.push(nestedCandidate);
    }

    if (chain[0] === cwdDoc && topmost !== cwdDoc) {
      candidates.push({ path: cwdDoc, scope: "cwd", depth: 0 });
    }

    const seen = new Set<string>();
    const ordered: Candidate[] = [];
    for (const candidate of candidates) {
      if (seen.has(candidate.path)) continue;
      seen.add(candidate.path);
      ordered.push(candidate);
    }

    const docs: DiscoveredInstruction[] = [];
    for (const candidate of ordered.slice(0, Math.max(0, maxDocuments))) {
      const doc = await this.readDoc(candidate.path, candidate.scope, maxBytesPerFile);
      if (doc !== undefined) docs.push(doc);
    }
    return docs;
  }

  private async findAncestorDocs(startDir: string): Promise<string[]> {
    const found: string[] = [];
    let dir = startDir;
    while (true) {
      const candidate = join(dir, DOC_FILE_NAME);
      let exists = false;
      try {
        const candidateStat = await lstat(candidate);
        exists = candidateStat.isFile() && !candidateStat.isSymbolicLink();
      } catch (err) {
        // P14-6: a missing document is the EXPECTED case for ancestor climb —
        // explicitly kept as "not exists" (fail-closed: an unreadable doc is
        // not treated as a present instruction); only non-ENOENT failures are
        // reported.
        exists = false;
        if (!isNodeErrorCode(err, "ENOENT")) {
          process.stderr.write(`[degraded] discovery.stat: ${err instanceof Error ? err.message : String(err)}\n`);
        }
      }
      if (exists) {
        found.push(candidate);
      } else if (dir !== startDir) {
        break;
      }
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
    return found;
  }

  /** Seeds the nested scan at cwd's child directories (never cwd itself). */
  private async scanNestedChildren(
    startDir: string,
    base: string,
    out: Candidate[],
  ): Promise<void> {
    let entries: Dirent[];
    try {
      entries = await readdir(startDir, { withFileTypes: true });
    } catch {
      return; // unreadable subtree: skip it
    }
    for (const entry of entries) {
      if (entry.isSymbolicLink() || !entry.isDirectory()) continue;
      if (SKIPPED_DIRECTORIES.has(entry.name)) continue;
      await this.scanNestedDir(join(startDir, entry.name), base, out);
    }
  }

  private async scanNestedDir(
    dir: string,
    base: string,
    out: Candidate[],
  ): Promise<void> {
    let entries: Dirent[];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return; // unreadable subtree: skip it
    }
    const childDirs: string[] = [];
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (SKIPPED_DIRECTORIES.has(entry.name)) continue;
        childDirs.push(full);
      } else if (entry.isFile() && entry.name === DOC_FILE_NAME) {
        out.push({
          path: full,
          scope: "nested",
          depth: relativeDepth(dirname(full), base),
        });
      }
    }
    for (const child of childDirs) {
      await this.scanNestedDir(child, base, out);
    }
  }

  private async readDoc(
    path: string,
    scope: Candidate["scope"],
    maxBytes: number,
  ): Promise<DiscoveredInstruction | undefined> {
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      const fileStat = await lstat(path);
      if (!fileStat.isFile() || fileStat.isSymbolicLink()) return undefined;
      const revision = revisionOf(fileStat);
      // NOFOLLOW protects the final component where supported. NONBLOCK also
      // prevents a raced regular-file-to-FIFO replacement from hanging open.
      handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
      const opened = await handle.stat();
      const current = await lstat(path);
      if (!opened.isFile() || current.isSymbolicLink() || revisionOf(opened) !== revision || revisionOf(current) !== revision) return undefined;
      // Bound both allocation and application-level reads independently of
      // source size. Four lookahead bytes suffice for one UTF-8 code point.
      const bytes = Buffer.alloc(Math.min(opened.size, maxBytes + 4));
      let captured = 0;
      while (captured < bytes.length) {
        const { bytesRead } = await handle.read(bytes, captured, bytes.length - captured, captured);
        if (bytesRead === 0) break;
        captured += bytesRead;
      }
      if (captured !== bytes.length) return undefined;
      const after = await lstat(path);
      if (after.isSymbolicLink() || revisionOf(await handle.stat()) !== revision || revisionOf(after) !== revision) return undefined;
      const sizeBytes = opened.size;
      const truncated = sizeBytes > maxBytes;
      const result = boundedText(bytes.subarray(0, captured), maxBytes, sizeBytes, truncated);
      return {
        path,
        scope,
        sizeBytes,
        content: result,
        truncated,
        detectedAt: Date.now(),
      };
    } catch {
      return undefined;
    } finally {
      // Discovery is best-effort per document, including descriptor cleanup.
      // A close failure must not suppress unrelated readable instructions.
      try { await handle?.close(); } catch { /* already-read documents remain usable */ }
    }
  }
}

function relativeDepth(filePath: string, base: string): number {
  const rel = relative(base, filePath);
  if (rel === "") return 0;
  return rel.split(sep).length;
}

function finiteBudget(value: number): number {
  if (!Number.isFinite(value) || value < 0) throw new Error("Instruction discovery budget must be finite and non-negative");
  return Math.floor(value);
}

function revisionOf(value: Stats): string {
  return [value.dev, value.ino, value.size, value.mtimeMs, value.ctimeMs].join(":");
}

function boundedText(bytes: Buffer, maxBytes: number, sizeBytes: number, truncated: boolean): string {
  // Streaming decode permits only an unfinished trailing code point in the
  // lookahead capture. Malformed input never expands into replacement text.
  const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
  decoder.decode(bytes, { stream: truncated && bytes.length < sizeBytes });
  if (!truncated) return decoder.decode(bytes);
  const marker = `\n# [truncated at ${sizeBytes} bytes]`;
  const suffix = Buffer.byteLength(marker) <= maxBytes ? marker : "";
  let end = Math.max(0, maxBytes - Buffer.byteLength(suffix));
  // A code point whose start lies before the boundary and continuation at
  // the boundary is omitted whole. Exact boundaries keep the prefix intact.
  while (end > 0 && end < bytes.length && (bytes[end]! & 0xc0) === 0x80) end--;
  let prefix = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes.subarray(0, end));
  const newline = prefix.lastIndexOf("\n");
  if (newline >= 0) prefix = prefix.slice(0, newline);
  return prefix + suffix;
}
