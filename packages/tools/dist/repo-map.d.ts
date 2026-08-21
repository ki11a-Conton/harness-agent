export interface RepoFile {
    /** Repo-relative "/"-separated path. */
    path: string;
    size: number;
}
export interface LanguageStat {
    lang: string;
    count: number;
}
export interface RepoPackage {
    /** Repo-relative directory containing the manifest. */
    dir: string;
    name: string;
    version?: string;
    /** Resolved entrypoint candidates (main/module/bin + src/main index files). */
    entrypoints: string[];
    /** Detected test/build/lint command hints (P2-31 may deepen this). */
    testCommands: string[];
    hasLockfile: boolean;
    prodDeps: string[];
    devDeps: string[];
    /**
     * P2-30+: names of OTHER local packages this package depends on (the
     * intra-repo dependency graph). Populated from the `workspace:` protocol plus,
     * when the repo declares workspaces, from sibling-name matches.
     */
    internalDeps: string[];
    /** P2-30+: deps declared with the `workspace:` protocol (strong intra-repo refs). */
    workspaceDeps: string[];
}
/** P2-30+: intra-repo package dependency graph link. */
export interface PackageDependency {
    name: string;
    internalDeps: string[];
}
export interface RepositoryMap {
    root: string;
    fileCount: number;
    files: RepoFile[];
    packages: RepoPackage[];
    languages: LanguageStat[];
    /** Repo-relative entrypoint candidates aggregated from all packages. */
    entrypoints: string[];
    /** Aggregated command hints such as `test: npm test`. */
    testCommands: string[];
    fingerprint: string;
    builtAt: number;
    /** false when the file cap was hit and the file tree is truncated. */
    complete: boolean;
    /** P2-30+: declared monorepo workspace globs and their concrete members. */
    workspaces: {
        patterns: string[];
        members: string[];
    } | null;
    /** P2-30+: full intra-repo package dependency graph. */
    dependencyGraph: PackageDependency[];
}
export interface StatEntry {
    path: string;
    size: number;
    mtimeMs: number;
}
/** Cheap stat walk returning repo-relative entries, skipping VCS/dep dirs. */
export declare function scanRepoStats(root: string, maxFiles?: number): Promise<StatEntry[]>;
export declare function repoFingerprint(entries: StatEntry[]): string;
export interface RepoMapOptions {
    root: string;
    maxFiles?: number;
}
export declare class RepositoryMapCache {
    private readonly rootResolved;
    private readonly maxFiles;
    private map;
    private build;
    private dirtyPath;
    private readonly counters;
    constructor(opts: RepoMapOptions);
    /** Cache statistics — useful for evaluating the value of the cache. */
    get stats(): {
        hits: number;
        builds: number;
        lastBuildMs: number;
    };
    /** True when a fresh map is already held (no work needed on next get()). */
    isFresh(): boolean;
    /** Return the current cached map or null if never built / invalidated. */
    peek(): RepositoryMap | null;
    /**
     * Get the repository map. Reuses the cache when the stat fingerprint is
     * unchanged; rebuilds (deduplicating concurrent calls) when the repo changed
     * or the cache was invalidated / dirty-marked.
     */
    get(): Promise<RepositoryMap>;
    /**
     * Incremental invalidation from the mutation surface: record that a path
     * changed so the next get() rebuilds even if size + rounded mtime match
     * (covers quick rewrites in the same mtime tick).
     */
    noteChange(relPath?: string): void;
    /** Drop the cached map entirely; the next get() rebuilds from scratch. */
    invalidate(): void;
    private doBuild;
}
/**
 * P2-30+: resolve the intra-repo dependency graph. A package's internal deps are
 * the local packages it references via the `workspace:` protocol; plus, when the
 * repo explicitly declares workspaces, sibling packages referenced by bare name
 * in its dependencies. Name matches are only trusted as internal when the repo
 * is known to be a monorepo, so a published dep that merely shares a local name
 * is not spuriously linked.
 */
export declare function resolvePackageGraph(packages: RepoPackage[], workspacesExplicit?: boolean): PackageDependency[];
//# sourceMappingURL=repo-map.d.ts.map