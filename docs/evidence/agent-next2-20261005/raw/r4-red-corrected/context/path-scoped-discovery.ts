import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { Stats } from "node:fs";
import type { DiscoveredInstruction, InstructionDiscovery, InstructionDiscoveryOptions } from "@ar/contracts";

export interface PathScopedInstructionDiscoveryOptions {
  /** Explicit host workspace boundary, never inferred from model text. */
  workspaceRoot: string;
  /** Host/evidence-approved targets snapshotted once for each discovery. */
  targets?: () => readonly string[];
  maxDocuments?: number;
  maxBytesPerFile?: number;
}

export interface PathScopedDiscoveryMetrics {
  probes: number;
  reads: number;
  cacheHits: number;
  rejectedTargets: number;
  truncatedDocuments: number;
}

/** Experimental adapter. Probe only target/cwd ancestry inside the host root;
 *  missing intermediate AGENTS.md never stops the walk. No subtree scan or
 *  symlink traversal occurs. The default discovery implementation is separate. */
export class PathScopedInstructionDiscovery implements InstructionDiscovery {
  readonly metrics: PathScopedDiscoveryMetrics = { probes: 0, reads: 0, cacheHits: 0, rejectedTargets: 0, truncatedDocuments: 0 };
  private readonly root: string;
  private readonly cache = new Map<string, { revision: string; maxBytes: number; content: string; sizeBytes: number; truncated: boolean }>();

  constructor(private readonly options: PathScopedInstructionDiscoveryOptions) {
    this.root = resolve(options.workspaceRoot);
  }

  async discover(cwd: string, opts: InstructionDiscoveryOptions = {}): Promise<DiscoveredInstruction[]> {
    const canonicalRoot = await this.canonicalRoot();
    const cwdPath = canonicalRoot === undefined ? undefined : await this.safeStat(resolve(cwd), canonicalRoot);
    if (canonicalRoot === undefined || !cwdPath?.stat.isDirectory()) throw new Error("Path-scoped instruction discovery requires a real cwd inside its workspace root");
    const current = cwdPath.path;
    const targets = [...(this.options.targets?.() ?? [])];
    const directories = new Set<string>();
    const addAncestors = (directory: string): void => {
      for (let dir = directory; this.within(dir); dir = dirname(dir)) {
        directories.add(dir);
        if (dir === this.root) break;
      }
    };
    addAncestors(current);
    for (const target of targets) {
      if (target.split(/[\\/]/u).includes("..")) { this.metrics.rejectedTargets++; continue; }
      const path = resolve(current, target);
      const checked = await this.safeStat(path, canonicalRoot);
      if (checked === undefined) { this.metrics.rejectedTargets++; continue; }
      addAncestors(checked.stat.isDirectory() ? checked.path : dirname(checked.path));
    }
    const depth = (dir: string): number => dir === this.root ? 0 : relative(this.root, dir).split(sep).length;
    const ordered = [...directories].sort((a, b) => depth(a) - depth(b) || a.localeCompare(b));
    // The explicit cwd document has last precedence, and is deduplicated when
    // it is also the root. Independent target packages share ancestor docs.
    if (current !== this.root) {
      ordered.splice(ordered.indexOf(current), 1);
      ordered.push(current);
    }
    const maxDocuments = finiteBudget(opts.maxDocuments ?? this.options.maxDocuments ?? 4);
    const maxBytes = finiteBudget(opts.maxBytesPerFile ?? this.options.maxBytesPerFile ?? 50_000);
    const docs: DiscoveredInstruction[] = [];
    for (const dir of ordered) {
      if (docs.length >= maxDocuments) break;
      const path = join(dir, "AGENTS.md");
      const loaded = await this.readDoc(path, maxBytes, canonicalRoot);
      if (loaded === undefined) continue;
      const truncated = loaded.truncated;
      if (truncated) this.metrics.truncatedDocuments++;
      docs.push({ path, scope: dir === this.root ? "root" : dir === current ? "cwd" : "nested",
        sizeBytes: loaded.sizeBytes, content: loaded.content,
        truncated, detectedAt: Date.now() });
    }
    return docs;
  }

  private within(path: string, root = this.root): boolean {
    const rel = relative(root, path);
    return rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
  }

  /** Windows realpath expands legitimate 8.3 names. Validate actual link
   *  components before using that canonical root as a containment basis. */
  private async canonicalRoot(): Promise<string | undefined> {
    try {
      for (let path = this.root; ; path = dirname(path)) {
        const stat = await lstat(path); this.metrics.probes++;
        if (stat.isSymbolicLink() || (path === this.root && !stat.isDirectory())) return undefined;
        if (dirname(path) === path) break;
      }
      return await realpath(this.root);
    } catch { return undefined; }
  }

  /** Reject every symlink component, including the document and target. */
  private async safeStat(path: string, canonicalRoot: string): Promise<{ stat: Stats; path: string } | undefined> {
    const base = this.within(path) ? this.root : this.within(path, canonicalRoot) ? canonicalRoot : undefined;
    if (base === undefined) return undefined;
    try {
      const rel = relative(base, path);
      let current = base;
      let stat = await lstat(current); this.metrics.probes++;
      if (stat.isSymbolicLink()) return undefined;
      for (const segment of rel === "" ? [] : rel.split(sep)) {
        current = join(current, segment);
        stat = await lstat(current); this.metrics.probes++;
        if (stat.isSymbolicLink()) return undefined;
      }
      const canonical = await realpath(path);
      if (!this.within(canonical, canonicalRoot)) return undefined;
      // Keep provenance and ancestry in the host root's spelling even when
      // cwd/targets arrive in its canonical (long-name) spelling.
      return { stat, path: resolve(this.root, relative(canonicalRoot, canonical)) };
    } catch { return undefined; }
  }

  private async readDoc(path: string, maxBytes: number, canonicalRoot: string): Promise<{ content: string; sizeBytes: number; truncated: boolean } | undefined> {
    const checked = await this.safeStat(path, canonicalRoot);
    if (checked === undefined || !checked.stat.isFile()) { this.cache.delete(path); return undefined; }
    const revision = revisionOf(checked.stat);
    const cached = this.cache.get(path);
    if (cached?.revision === revision && cached.maxBytes === maxBytes) { this.metrics.cacheHits++; return cached; }
    // Never retain a stale capture when its replacement cannot be verified.
    this.cache.delete(path);
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      // A regular file may become a FIFO between the pathname check and open.
      // NONBLOCK prevents that race from hanging before we can check its type.
      handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
      const opened = await handle.stat();
      const current = await this.safeStat(path, canonicalRoot);
      if (!opened.isFile() || !current?.stat.isFile() || revisionOf(opened) !== revision || revisionOf(current.stat) !== revision) return undefined;
      // Capture only the declared prefix and at most one UTF-8 code point of
      // lookahead. Large repository files must never allocate their full size.
      const bytes = Buffer.alloc(Math.min(opened.size, maxBytes + 4));
      let captured = 0;
      while (captured < bytes.length) {
        const { bytesRead } = await handle.read(bytes, captured, bytes.length - captured, captured);
        if (bytesRead === 0) break;
        captured += bytesRead;
      }
      this.metrics.reads++;
      if (captured !== bytes.length) return undefined;
      const after = await this.safeStat(path, canonicalRoot);
      const afterOpened = await handle.stat();
      if (!afterOpened.isFile() || !after?.stat.isFile() || revisionOf(afterOpened) !== revision || revisionOf(after.stat) !== revision) return undefined;
      const truncated = opened.size > maxBytes;
      const value = { revision, maxBytes, content: boundedText(bytes.subarray(0, captured), maxBytes, opened.size, truncated), sizeBytes: opened.size, truncated };
      // Bound cache retention as targets switch; eviction changes cost only.
      if (this.cache.size >= 256) this.cache.delete(this.cache.keys().next().value!);
      this.cache.set(path, value);
      return value;
    } catch { this.cache.delete(path); return undefined; }
    finally {
      // Cleanup is best-effort per document, just as in default discovery.
      try { await handle?.close(); } catch {
        process.stderr.write("[degraded] path-scoped-discovery.close: instruction handle cleanup failed\n");
      }
    }
  }
}

function revisionOf(stat: Stats): string {
  return [stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs].join(":");
}

function finiteBudget(value: number): number {
  if (!Number.isFinite(value) || value < 0) throw new Error("Path-scoped instruction budget must be finite and non-negative");
  return Math.floor(value);
}

function boundedText(bytes: Buffer, maxBytes: number, sizeBytes: number, truncated: boolean): string {
  // Only an unfinished trailing code point in a bounded lookahead capture is
  // permitted. Malformed input cannot expand the byte budget via replacement.
  const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
  decoder.decode(bytes, { stream: truncated && bytes.length < sizeBytes });
  if (!truncated) return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  const marker = "\n# [truncated]";
  const markerBytes = Buffer.byteLength(marker);
  const suffix = maxBytes >= markerBytes ? marker : "";
  let end = Math.max(0, maxBytes - Buffer.byteLength(suffix));
  while (end > 0 && end < bytes.length && (bytes[end]! & 0xc0) === 0x80) end--;
  let prefix = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes.subarray(0, end));
  const newline = prefix.lastIndexOf("\n");
  if (newline >= 0) prefix = prefix.slice(0, newline);
  return prefix + suffix;
}
