import type { MemoryScope } from "@ar/contracts";
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
export declare function resolveRepositoryIdentity(cwd: string): Promise<RepositoryIdentity>;
/** The memory scope for a repository identity (P2-3): git repositories are
 *  "repository"-scoped, non-git workspaces "workspace"-scoped. An explicit
 *  scope (e.g. from HarnessConfig.memory.scope) always wins. */
export declare function memoryScopeFor(identity: RepositoryIdentity, explicit?: MemoryScope): MemoryScope;
/** Deterministic 16-hex-char hash used for repository/scope ids. */
export declare function stableHash(value: string): string;
//# sourceMappingURL=scope-resolver.d.ts.map