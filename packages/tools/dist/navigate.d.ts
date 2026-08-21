export interface GrepHit {
    file: string;
    line: number;
    column: number;
    text: string;
}
export interface GrepFilesInput {
    pattern: string;
    root: string;
    relPath?: string;
    caseSensitive?: boolean;
    /** Restrict to file basenames matching this glob (e.g. "*.ts"). */
    fileGlob?: string | null;
    maxHits?: number;
}
/** Recursive walk yielding files (with rel path), skipping VCS/dep dirs. */
export declare function walkFiles(root: string, rel: string | undefined, onFile: (abs: string, rel: string) => Promise<boolean | void>, onDir?: (dirs: string[], abs: string, rel: string) => void): Promise<void>;
export declare function grepFiles(input: GrepFilesInput): Promise<GrepHit[]>;
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
export declare function symbolSearch(input: SymbolSearchInput): Promise<{
    fallback: true;
    indexer: string;
    hits: SymbolHit[];
}>;
export declare function escapeRegExp(s: string): string;
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
}
/** Nested directory/file tree of the repo (for orientation / repo map). */
export declare function repoTree(input: RepoTreeInput): Promise<RepoTreeEntry[]>;
/** Walk a directory's immediate children (used by repo_tree to avoid re-list). */
export declare function normalizeSlashes(p: string): string;
//# sourceMappingURL=navigate.d.ts.map