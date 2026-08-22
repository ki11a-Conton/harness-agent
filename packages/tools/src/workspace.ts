/**
 * P2-30+ Monorepo workspace resolution.
 *
 * Makes package-boundary detection aware of declared workspaces instead of
 * treating every nested manifest as a package root. Reads the two canonical
 * sources:
 *   - `pnpm-workspace.yaml` → top-level `packages:` list
 *   - root `package.json` → `workspaces` (array or `{ packages: [...] }`)
 *
 * Patterns use a small glob dialect supporting `*` (one segment), `**` (any
 * number of segments), `?` (one char in a segment) and `!` negation. A
 * directory is a workspace member iff it matches at least one positive pattern
 * and no matching negation. When no workspaces are declared (`explicit:false`)
 * callers must keep their existing fallback (scan all manifests) so behavior
 * is unchanged for non-monorepo repos.
 */
import { promises as fs } from "node:fs";
import { join, resolve } from "node:path";
import { isNodeErrorCode } from "@ar/contracts";

const SKIP_DIRS = new Set([
  ".git",
  "node_modules",
  ".DS_Store",
  "dist",
  "build",
  "coverage",
  "__pycache__",
  ".venv",
  "venv",
  "target",
  ".next",
]);

export interface WorkspaceSettings {
  /** Glob patterns exactly as declared (positive + `!` negations). */
  patterns: string[];
  /** Concrete repo-relative member directories that match the patterns. */
  members: string[];
  /** True when a workspaces source was found (patterns are authoritative). */
  explicit: boolean;
  /** Repo-relative dirs that were tried as glob candidate roots. */
  candidateDirs: string[];
}

interface RawPattern {
  original: string;
  negate: boolean;
  pattern: string;
}

/** Load the workspaces patterns from pnpm-workspace.yaml + package.json. */
export async function loadWorkspacePatterns(root: string): Promise<string[]> {
  const patterns: string[] = [];

  const pnpmYaml = await fs
    .readFile(join(root, "pnpm-workspace.yaml"), "utf8")
    .catch(() => "");
  if (pnpmYaml) {
    const lines = pnpmYaml.split("\n");
    let inPackages = false;
    const stopRe = /^[A-Za-z_][\w.-]*\s*:/;
    for (const raw of lines) {
      const line = raw.replace(/\r$/, "");
      if (/^\s*packages\s*:/.test(line)) {
        inPackages = true;
        // inline array form: packages: [ "a", "b" ]
        const bracket = line.slice(line.indexOf(":") + 1).match(/\[([\s\S]*)\]$/);
        if (bracket) {
          for (const item of bracket[1]!.split(",")) pushItem(item, patterns);
          inPackages = false;
        }
        continue;
      }
      if (!inPackages) continue;
      const trimmed = line.trim();
      if (trimmed === "" || trimmed.startsWith("#")) continue;
      if (!/^\s+/.test(line) && stopRe.test(trimmed)) break; // next top-level key
      pushItem(trimmed, patterns);
    }
  }

  const pkg = await fs.readFile(join(root, "package.json"), "utf8").catch(() => "");
  if (pkg) {
    try {
      const parsed = JSON.parse(pkg) as {
        workspaces?: string[] | { packages?: string[] };
      };
      const ws = parsed.workspaces;
      if (Array.isArray(ws)) patterns.push(...ws);
      else if (ws && Array.isArray(ws.packages)) patterns.push(...ws.packages);
    } catch (err) {
      // P14-6: an unparsable root manifest falls through to the line-parser
      // path — the failure is reported (manifest integrity evidence).
      process.stderr.write(`[degraded] workspace.parse-root-manifest: ${err instanceof Error ? err.message : String(err)}\n`);
    }
  }

  return dedupe(patterns.map((p) => p.trim()).filter(Boolean));
}

function pushItem(trimmed: string, out: string[]): void {
  const m = /^-\s*(.+)$/.exec(trimmed) ?? /^([^#].+)$/.exec(trimmed);
  const raw = (m ? m[1]! : trimmed).trim().replace(/[,;]$/, "");
  const unquoted = raw.replace(/^["']|["']$/g, "").trim();
  if (unquoted) out.push(unquoted);
}

/** Convert a single glob pattern into a matching function over dir strings. */
function globMatcher(pattern: string): (dir: string) => boolean {
  const parts = pattern.split("/");
  let out = "^";
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i]!;
    if (part === "**") {
      // `**` matches zero or more whole path segments; its slash handling
      // differs by position so boundary cases (apps, apps/web, a/x/b) all work.
      if (i === 0) out += "(?:[^/]+/)*";
      else if (i === parts.length - 1) out += "(?:/.*)?";
      else out += "(?:/[^/]+)*";
      continue;
    }
    // A leading `**` consumes the following slash, so the next normal segment
    // must not re-add it.
    if (i > 0 && !(i === 1 && parts[0] === "**")) out += "/";
    let seg = "";
    for (const ch of part) {
      if (ch === "*") seg += "[^/]*";
      else if (ch === "?") seg += "[^/]";
      else seg += ch.replace(/[.\-+^$\[\](){}|\\]/g, "\\$&");
    }
    out += seg;
  }
  out += "$";
  const re = new RegExp(out);
  return (dir: string): boolean => re.test(dir);
}

/** Match candidate dirs against a list of positive/negated glob patterns. */
export function matchGlobDirs(patterns: string[], candidateDirs: string[]): string[] {
  const raw: RawPattern[] = patterns.map((pattern) => ({
    original: pattern,
    negate: pattern.startsWith("!"),
    pattern: pattern.startsWith("!") ? pattern.slice(1) : pattern,
  }));
  const positives = raw.filter((r) => !r.negate);
  const negatives = raw.filter((r) => r.negate);
  const positiveRe = positives.map((p) => globMatcher(p.pattern));
  const negativeRe = negatives.map((p) => globMatcher(p.pattern));

  const matched = new Set<string>();
  for (const dir of candidateDirs) {
    let hit = false;
    if (positiveRe.length === 0) {
      hit = true; // only negations → everything is a member unless excluded
    } else {
      for (const m of positiveRe) {
        if (m(dir)) {
          hit = true;
          break;
        }
      }
    }
    if (!hit) continue;
    if (negativeRe.some((m) => m(dir))) continue;
    matched.add(dir);
  }
  return [...matched].sort();
}

/** Collect repo-relative directory paths (excluding VCS / dependency dirs). */
export async function listDirs(root: string): Promise<string[]> {
  const out: string[] = [];
  async function walk(dir: string, rel: string): Promise<void> {
    let entries;
    try {
      entries = await fs.readdir(join(root, dir), { withFileTypes: true });
    } catch {
      return;
    }
    if (rel !== "") out.push(rel);
    for (const e of entries) {
      if (!e.isDirectory() || SKIP_DIRS.has(e.name)) continue;
      const subRel = rel ? `${rel}/${e.name}` : e.name;
      await walk(subRel, subRel);
    }
  }
  await walk("", "");
  return out;
}

/** Full workspace resolution: patterns + matched members + candidates. */
export async function resolveWorkspace(
  root: string,
  candidateDirs?: string[],
): Promise<WorkspaceSettings> {
  const abs = resolve(root);
  const patterns = await loadWorkspacePatterns(abs);
  if (patterns.length === 0) {
    return { patterns: [], members: [], explicit: false, candidateDirs: candidateDirs ?? [] };
  }
  const dirs = candidateDirs ?? (await listDirs(abs));
  return { patterns, members: matchGlobDirs(patterns, dirs), explicit: true, candidateDirs: dirs };
}

function dedupe<T>(arr: T[]): T[] {
  return [...new Set(arr)];
}