import type { Dirent } from "node:fs";
import { readdir } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import type {
  Skill,
  SkillId,
  SkillLoader,
  SkillLoaderOptions,
} from "@ar/contracts";
import { AgentError, errorInfo, newSkillId } from "@ar/contracts";
import { detectPromptInjection, detectSecrets } from "@ar/security";
import * as fsPromises from "node:fs/promises";

const DEFAULT_MAX_METADATA_BYTES = 64 * 1024;
const DEFAULT_MAX_BODY_BYTES = 256 * 1024;
const DEFAULT_MAX_SKILLS = 1000;
const SKILL_FILE = "SKILL.md";

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
  onSecurityDenied?: (event: { detection: "injection" | "secret"; reasons: string[]; content: string; path: string; source: string }) => void;
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

  constructor(deps: FileSkillLoaderDeps = {}) {
    this.fs = deps.fs ?? fsPromises;
    this.now = deps.now ?? Date.now;
    this.makeSkillId = deps.newSkillId ?? newSkillId;
    this.onSecurityDenied = deps.onSecurityDenied;
  }

  async discover(opts: SkillLoaderOptions): Promise<Skill[]> {
    if (opts.roots.length === 0) return [];
    const maxMetadataBytes = opts.maxMetadataBytes ?? DEFAULT_MAX_METADATA_BYTES;
    const maxSkills = opts.maxSkills ?? DEFAULT_MAX_SKILLS;

    // One recursive pass per root. A ghost root, or a root that is a file,
    // produces nothing (an unreadable subtree is skipped silently).
    const dirs = new Map<string, string>(); // SKILL.md path -> owning directory
    for (const root of opts.roots) {
      await this.collectSkillDirs(resolve(root), dirs);
    }

    // Deterministic output: ordered by SKILL.md path, deduplicated across
    // overlapping roots (first occurrence wins).
    const paths = [...dirs.keys()].sort();
    const skills: Skill[] = [];
    for (const skillPath of paths) {
      if (skills.length >= maxSkills) break;
      const skill = await this.readMetadata(skillPath, maxMetadataBytes);
      if (skill !== undefined) skills.push(skill);
    }
    return skills;
  }

  async load(
    skill: Skill,
    opts?: Pick<SkillLoaderOptions, "maxBodyBytes">,
  ): Promise<Skill> {
    const maxBodyBytes = opts?.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
    let content: string;
    try {
      content = await this.fs.readFile(skill.path, "utf8");
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
          "SECURITY_DENIED",
          `skill load blocked: injection detected in ${skill.path} (${injection.reasons.join(", ")})`,
        ),
      );
    }
    const secret = detectSecrets(content);
    if (secret.hasSecret) {
      this.onSecurityDenied?.({ detection: "secret", reasons: secret.secrets, content, path: skill.path, source: "skill-loader" });
      throw new AgentError(
        errorInfo(
          "SECURITY_DENIED",
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
    return { ...skill, status: "loaded", body };
  }

  /** Recursively collects directories that contain a SKILL.md file. */
  private async collectSkillDirs(
    dir: string,
    out: Map<string, string>,
  ): Promise<void> {
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
    for (const child of childDirs) {
      await this.collectSkillDirs(child, out);
    }
  }

  /**
   * Reads only the first maxBytes bytes of the SKILL.md and builds the
   * metadata-only Skill. Unreadable files are skipped (best effort).
   */
  private async readMetadata(
    skillPath: string,
    maxBytes: number,
  ): Promise<Skill | undefined> {
    const prefix = await this.readPrefix(skillPath, maxBytes);
    if (prefix === undefined) return undefined;
    const headers = parseFrontmatter(prefix);
    const dirName = basename(dirname(skillPath));
    return {
      id: this.makeSkillId(),
      path: skillPath,
      manifest: {
        name: headers.name ?? dirName,
        description: headers.description ?? "",
        version: headers.version ?? "0.0.0",
        requiredTools: splitList(headers.requiredTools),
      },
      status: "discovered",
      body: undefined,
      discoveredAt: this.now(),
      headers,
    };
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