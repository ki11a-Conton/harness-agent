// P2-3: memory scope resolver — memory is scoped by repository identity, not
// by a bare cwd string. Git repositories get a stable id from the remote URL
// (falling back to the repo root); non-git workspaces hash the normalized
// workspace root. The scope the bridge uses for retrieval/persistence is
// derived from the identity unless the caller pins an explicit scope.

import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { resolve } from "node:path";
import type { MemoryScope } from "@ar/contracts";

const execFileAsync = promisify(execFile);

/** Normalize path separators to forward slashes for stable cross-platform ids. */
function normalizePath(p: string): string {
  return p.replace(/\\/g, "/");
}

/** Stable repository identity (P2-3): a git repo is identified by its remote
 *  URL when available (repo root as fallback), a non-git workspace by the
 *  normalized root path hash. `id` is stable across machines for the same
 *  repository — that is what makes memory portable between checkouts. */
export interface RepositoryIdentity {
  kind: "git" | "path";
  /** Stable hash id (16 hex chars of sha256 over remote/root). */
  id: string;
  /** Resolved repository/workspace root. */
  root: string;
}

/** Resolve the repository identity for a working directory (P2-3). Git
 *  detection is best-effort: any failure (no git binary, no .git, not a git
 *  work tree) degrades to a path identity — never throws. */
export async function resolveRepositoryIdentity(cwd: string): Promise<RepositoryIdentity> {
  try {
    const { stdout: rootOut } = await execFileAsync("git", ["rev-parse", "--show-toplevel"], {
      cwd,
      timeout: 5000,
    });
    const root = normalizePath(rootOut.trim());
    if (root === "") throw new Error("empty git root");
    let remote = "";
    try {
      const { stdout } = await execFileAsync("git", ["config", "--get", "remote.origin.url"], {
        cwd,
        timeout: 5000,
      });
      remote = stdout.trim();
    } catch {
      // no origin remote → fall back to the repo root hash
    }
    const source = remote !== "" ? remote : root;
    return { kind: "git", id: stableHash(source), root };
  } catch {
    const root = normalizePath(resolve(cwd));
    return { kind: "path", id: stableHash(root), root };
  }
}

/** The memory scope for a repository identity (P2-3): git repositories are
 *  "repository"-scoped, non-git workspaces "workspace"-scoped. An explicit
 *  scope (e.g. from HarnessConfig.memory.scope) always wins. */
export function memoryScopeFor(
  identity: RepositoryIdentity,
  explicit?: MemoryScope,
): MemoryScope {
  if (explicit !== undefined) return explicit;
  return identity.kind === "git" ? "repository" : "workspace";
}

/** Deterministic 16-hex-char hash used for repository/scope ids. */
export function stableHash(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}
