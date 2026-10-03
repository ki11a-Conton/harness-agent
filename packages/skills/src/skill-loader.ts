import type { Dirent, Stats } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import type {
  Skill,
  SkillId,
  SkillLoader,
  SkillLoaderOptions,
} from "@ar/contracts";
import { AgentError, errorInfo, newSkillId } from "@ar/contracts";
import { detectPromptInjection, detectSecrets } from "@ar/security";
import { skillDenialCode, type SkillSecurityDenial } from "./skill-security.js";
import * as fsPromises from "node:fs/promises";

const DEFAULT_MAX_METADATA_BYTES = 64 * 1024;
const DEFAULT_MAX_BODY_BYTES = 256 * 1024;
const DEFAULT_MAX_SKILLS = 1000;
const SKILL_FILE = "SKILL.md";

interface SkillRevision {
  identity: string;
  maxMetadataBytes: number;
  root: string;
}

interface DiscoveryCache {
  key: string;
  directories: Map<string, { identity: string; children: string[]; hasSkill: boolean }>;
  metadata: Map<string, { identity: string; skill: Skill }>;
}

/** mtime alone misses atomic replacement and restored timestamps. */
function fileIdentity(st: Stats): string {
  return [st.dev, st.ino, st.size, st.mtimeMs, st.ctimeMs, st.mode].join(":");
}

/** Directories never scanned for skill packages (mirrors CTX-001 discovery.ts). */
const SKIPPED_DIRECTORIES: ReadonlySet<string> = new Set([
  "node_modules",
  ".git",
  "dist",
  "out",
  "build",
  ".cache",
]);

export interface FileSkillLoaderDeps {
  /** Injectable fs module for tests; defaults to node:fs/promises. */
  fs?: typeof fsPromises;
  /** Injectable clock; defaults to Date.now. */
  now?: () => number;
  /** Injectable SkillId generator; defaults to contracts newSkillId. */
  newSkillId?: () => SkillId;
  /** Optional callback fired when a skill body is denied (injection or secret). */
  onSecurityDenied?: (event: SkillSecurityDenial) => void;
  /** P17-3: body cache capacity (default 64). Bounded — stale bodies are
   *  evicted; file revision invalidation keeps entries fresh. */
  maxCachedBodies?: number;
}

/** Marker appended to a truncated body so callers can detect truncation. */
export function truncationMarker(bytes: number): string {
  return `# [truncated at ${bytes} bytes]`;
}

/**
 * SKILL-001: progressive skill loading — metadata visible, body on demand.
 *
 * discover() reads at most maxMetadataBytes per SKILL.md (fs.open + read on a
 * bounded prefix; the file is never read whole) and only parses frontmatter,
 * so it stays cheap even for huge skills. The body is read only by load().
 */
export class FileSkillLoader implements SkillLoader {
  private readonly fs: typeof fsPromises;
  private readonly now: () => number;
  private readonly makeSkillId: () => SkillId;
  private readonly onSecurityDenied?: FileSkillLoaderDeps["onSecurityDenied"];
  /** One revision cache belongs to this loader, never to a process-wide name.
   *  Bodies remain bounded; directory entries and metadata are retained only
   *  for the current discovery configuration. */
  private readonly bodyCache = new Map<string, { identity: string; content: string }>();
  private discoveryCache?: DiscoveryCache;
  private readonly revisions = new WeakMap<Skill, SkillRevision>();
  private readonly maxCachedBodies: number;

  constructor(deps: FileSkillLoaderDeps = {}) {
    this.fs = deps.fs ?? fsPromises;
    this.now = deps.now ?? Date.now;
    this.makeSkillId = deps.newSkillId ?? newSkillId;
    this.onSecurityDenied = deps.onSecurityDenied;
    this.maxCachedBodies = deps.maxCachedBodies ?? 64;
  }

  /** P17-3: controlled cache invalidation — drop the cached body for one
   *  skill path, or the whole body cache when `path` is omitted. */
  invalidateBodyCache(path?: string): void {
    if (path === undefined) {
      this.bodyCache.clear();
      return;
    }
    this.bodyCache.delete(path);
  }

  async discover(opts: SkillLoaderOptions): Promise<Skill[]> {
    if (opts.roots.length === 0) return [];
    const maxMetadataBytes = opts.maxMetadataBytes ?? DEFAULT_MAX_METADATA_BYTES;
    const maxSkills = opts.maxSkills ?? DEFAULT_MAX_SKILLS;

    const roots = opts.roots.map((root) => resolve(root));
    const key = JSON.stringify([roots, maxMetadataBytes, maxSkills]);
    if (this.discoveryCache?.key !== key) {
      this.discoveryCache = { key, directories: new Map(), metadata: new Map() };
    }
    const cache = this.discoveryCache;

    // Check each known directory's revision once, readdir only changed/new
    // directories. A nested addition changes its immediate parent, so it is
    // discovered without a full directory-listing pass on every step.
    const dirs = new Map<string, string>(); // SKILL.md path -> owning directory
    const visited = new Set<string>();
    for (const root of roots) {
      await this.collectSkillDirs(root, dirs, cache, visited);
    }
    for (const path of cache.directories.keys()) {
      if (!visited.has(path)) cache.directories.delete(path);
    }
    for (const path of cache.metadata.keys()) {
      if (!dirs.has(path)) cache.metadata.delete(path);
    }

    // Deterministic output: ordered by SKILL.md path, deduplicated across
    // overlapping roots (first occurrence wins).
    const paths = [...dirs.keys()].sort();
    const skills: Skill[] = [];
    for (const skillPath of paths) {
      if (skills.length >= maxSkills) break;
      const root = dirs.get(skillPath)!;
      const identity = await this.identityOf(skillPath, "file");
      if (identity === undefined) {
        cache.metadata.delete(skillPath);
        continue;
      }
      const cached = cache.metadata.get(skillPath);
      const skill = cached?.identity === identity
        ? cached.skill
        : await this.readMetadata(skillPath, maxMetadataBytes, root, identity);
      if (skill !== undefined) cache.metadata.set(skillPath, { identity, skill });
      if (skill !== undefined) skills.push(skill);
    }
    return skills;
  }

  async load(
    skill: Skill,
    opts?: Pick<SkillLoaderOptions, "maxBodyBytes">,
  ): Promise<Skill> {
    return this.loadBody(skill, opts, false);
  }

  /** Step records must not acquire a new body's manifest after selection.
   *  A changed/deleted file is skipped by the provider until the next step. */
  async loadSnapshot(
    skill: Skill,
    opts?: Pick<SkillLoaderOptions, "maxBodyBytes">,
  ): Promise<Skill> {
    return this.loadBody(skill, opts, true);
  }

  private async loadBody(
    skill: Skill,
    opts: Pick<SkillLoaderOptions, "maxBodyBytes"> | undefined,
    strict: boolean,
  ): Promise<Skill> {
    const maxBodyBytes = opts?.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
    const discovered = this.revisions.get(skill);
    let identity: string;
    let content: string;
    try {
      const current = await this.identityOf(skill.path, "file");
      if (current === undefined) throw new Error("Skill file is missing or is not a regular file");
      identity = current;
      if (strict && discovered?.identity !== identity) throw new Error("Skill snapshot revision changed");
      const cached = this.bodyCache.get(skill.path);
      if (cached !== undefined && cached.identity === identity) {
        content = cached.content;
      } else {
        content = await this.fs.readFile(skill.path, "utf8");
        // Do not cache or inject a body whose file changed during the read.
        if (await this.identityOf(skill.path, "file") !== identity) {
          throw new Error("Skill revision changed during body read");
        }
        this.bodyCache.set(skill.path, { identity, content });
        if (this.bodyCache.size > this.maxCachedBodies) {
          // Evict the oldest insertion (Map preserves insertion order).
          const oldest = this.bodyCache.keys().next().value;
          if (oldest !== undefined) this.bodyCache.delete(oldest);
        }
      }
    } catch (cause) {
      // A skill discovered moments ago should still exist; if it does not,
      // surface it instead of fabricating a body.
      throw new AgentError(
        errorInfo("INTERNAL_ERROR", `Skill body load failed: ${skill.path}`, {
          cause,
        }),
      );
    }
    // Issue 6: a skill body is untrusted content that ends up in the model
    // context; refuse to load it when it carries prompt-injection content.
    const injection = detectPromptInjection(content);
    if (injection.hasInjection) {
      this.onSecurityDenied?.({ detection: "injection", reasons: injection.reasons, content, path: skill.path, source: "skill-loader" });
      throw new AgentError(
        errorInfo(
          skillDenialCode("injection"),
          `skill load blocked: injection detected in ${skill.path} (${injection.reasons.join(", ")})`,
        ),
      );
    }
    const secret = detectSecrets(content);
    if (secret.hasSecret) {
      this.onSecurityDenied?.({ detection: "secret", reasons: secret.secrets, content, path: skill.path, source: "skill-loader" });
      throw new AgentError(
        errorInfo(
          skillDenialCode("secret"),
          `skill load blocked: secret detected in ${skill.path} (${secret.secrets.join(", ")})`,
        ),
      );
    }
    let body = content;
    if (Buffer.byteLength(content) > maxBodyBytes) {
      body =
        truncateAtLineBoundary(content, maxBodyBytes) +
        "\n" +
        truncationMarker(Buffer.byteLength(content)) +
        "\n";
    }
    // The body keeps the file verbatim (frontmatter included): Skill.body is
    // the SKILL.md file content; headers are already parsed separately, so
    // callers can strip the frontmatter themselves if needed.
    // The legacy load API accepts an old record and refreshes its manifest
    // with its body; strict loading keeps the exact discovered record.
    const revision: SkillRevision = {
      identity,
      maxMetadataBytes: discovered?.maxMetadataBytes ?? DEFAULT_MAX_METADATA_BYTES,
      root: discovered?.root ?? skill.provenance?.root ?? dirname(skill.path),
    };
    const current = discovered?.identity === identity
      ? skill
      : this.metadataFromPrefix(
          skill.path,
          Buffer.from(content).subarray(0, revision.maxMetadataBytes).toString("utf8"),
          revision.root,
          skill,
        );
    const loaded: Skill = { ...current, status: "loaded", body };
    this.revisions.set(loaded, revision);
    return loaded;
  }

  /** Recursively collects directories that contain a SKILL.md file. */
  private async collectSkillDirs(
    dir: string,
    out: Map<string, string>,
    cache: DiscoveryCache,
    visited: Set<string>,
  ): Promise<void> {
    if (visited.has(dir)) return;
    visited.add(dir);
    const identity = await this.identityOf(dir, "directory");
    if (identity === undefined) {
      cache.directories.delete(dir);
      return;
    }
    const cached = cache.directories.get(dir);
    if (cached?.identity === identity) {
      if (cached.hasSkill) out.set(join(dir, SKILL_FILE), dir);
      for (const child of cached.children) await this.collectSkillDirs(child, out, cache, visited);
      return;
    }
    let entries: Dirent[];
    try {
      entries = await this.fs.readdir(dir, { withFileTypes: true });
    } catch {
      return; // missing or unreadable subtree: skip silently
    }
    let hasSkill = false;
    const childDirs: string[] = [];
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue; // never follow symlinks
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (SKIPPED_DIRECTORIES.has(entry.name)) continue;
        childDirs.push(full);
      } else if (entry.isFile() && entry.name === SKILL_FILE) {
        hasSkill = true;
      }
    }
    if (hasSkill) out.set(join(dir, SKILL_FILE), dir);
    cache.directories.set(dir, { identity, hasSkill, children: childDirs });
    for (const child of childDirs) {
      await this.collectSkillDirs(child, out, cache, visited);
    }
  }

  /**
   * Reads only the first maxBytes bytes of the SKILL.md and builds the
   * metadata-only Skill. Unreadable files are skipped (best effort).
   */
  private async readMetadata(
    skillPath: string,
    maxBytes: number,
    root: string,
    identity: string,
  ): Promise<Skill | undefined> {
    const prefix = await this.readPrefix(skillPath, maxBytes);
    if (prefix === undefined || await this.identityOf(skillPath, "file") !== identity) return undefined;
    const skill = this.metadataFromPrefix(skillPath, prefix, root);
    this.revisions.set(skill, { identity, maxMetadataBytes: maxBytes, root });
    return skill;
  }

  private metadataFromPrefix(skillPath: string, prefix: string, root: string, previous?: Skill): Skill {
    const headers = parseFrontmatter(prefix);
    const dirName = basename(dirname(skillPath));
    return {
      ...(previous ?? {}),
      id: previous?.id ?? this.makeSkillId(),
      path: skillPath,
      manifest: {
        name: headers.name ?? dirName,
        description: headers.description ?? "",
        version: headers.version ?? "0.0.0",
        requiredTools: splitList(headers.requiredTools),
        // P32-4: SKILL.md may declare required MCP servers (comma-separated
        // `mcp:<serverId>` ids; both singular and plural spellings accepted).
        requiredMcpServers:
          splitList(headers.requiredMcpServer) ?? splitList(headers.requiredMcpServers) ?? undefined,
      },
      status: "discovered",
      body: undefined,
      discoveredAt: previous?.discoveredAt ?? this.now(),
      headers,
      // P17-3: provenance/trust are part of the record — a filesystem skill
      // is semi-trusted; remote skills (fetched packages/MCP) are untrusted.
      provenance: {
        source: "local-filesystem",
        root,
        trust: "semi-trusted",
      },
    };
  }

  private async identityOf(path: string, kind: "file" | "directory"): Promise<string | undefined> {
    try {
      const st = await this.fs.lstat(path);
      if (st.isSymbolicLink() || (kind === "file" ? !st.isFile() : !st.isDirectory())) return undefined;
      return fileIdentity(st);
    } catch {
      return undefined;
    }
  }

  /** fs.open + read of the leading maxBytes bytes only (never the whole file). */
  private async readPrefix(
    path: string,
    maxBytes: number,
  ): Promise<string | undefined> {
    let handle: Awaited<ReturnType<typeof fsPromises.open>> | undefined;
    try {
      handle = await this.fs.open(path, "r");
      const buffer = Buffer.alloc(maxBytes);
      const { bytesRead } = await handle.read(buffer, 0, maxBytes, 0);
      return buffer.subarray(0, bytesRead).toString("utf8");
    } catch {
      return undefined;
    } finally {
      await handle?.close();
    }
  }
}

/**
 * Best-effort frontmatter parse of a `---\n<key: value> lines\n---` block.
 * Case-preserving keys; every line up to the closing `---` (or the end of the
 * read prefix) that contains a colon becomes a header. A truncated block
 * yields partial headers rather than an error.
 */
function parseFrontmatter(prefix: string): Record<string, string> {
  if (!prefix.startsWith("---")) return {};
  const headers: Record<string, string> = {};
  for (const rawLine of prefix.split(/\r?\n/).slice(1)) {
    if (rawLine.trim() === "---") break;
    const colon = rawLine.indexOf(":");
    if (colon < 0) continue;
    const key = rawLine.slice(0, colon).trim();
    if (key === "") continue;
    headers[key] = rawLine.slice(colon + 1).trim();
  }
  return headers;
}

function splitList(value: string | undefined): string[] | undefined {
  if (value === undefined) return undefined;
  return value
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item !== "");
}

function truncateAtLineBoundary(content: string, maxBytes: number): string {
  const lines = content.split("\n");
  const kept: string[] = [];
  let bytes = 0;
  for (const line of lines) {
    const lineBytes = Buffer.byteLength(line) + (kept.length > 0 ? 1 : 0);
    if (kept.length > 0 && bytes + lineBytes > maxBytes) break;
    kept.push(line);
    bytes += lineBytes;
  }
  return kept.join("\n");
}
