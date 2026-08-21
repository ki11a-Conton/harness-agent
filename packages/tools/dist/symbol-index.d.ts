/**
 * P7-4 (EXPERIMENT): lightweight TypeScript/JavaScript symbol index built on
 * line-aware regex over source files — no tsserver dependency, deterministic,
 * fast enough for repo-scale scans. Indexes declarations (function/class/
 * interface/type/const/let/var), imports and exports; references are found by
 * grepping the indexed lines. Other languages keep the grep fallback.
 *
 * The index is cached per root with mtime fingerprints so repeated searches
 * in one process do not re-scan (same discipline as RepositoryMapCache).
 */
export type SymbolRole = "definition" | "import" | "export" | "reference" | "unknown";
/** Shape-compatible with navigate.SymbolHit (file/line/kind/name/text) so the
 *  tool result surface is identical whether the index or the grep produced it.
 *  `role` rides along for consumers that understand it. */
export interface SymbolHit {
    file: string;
    line: number;
    kind: string;
    name: string;
    text: string;
    role?: SymbolRole;
}
export interface SymbolSearchIndexResult {
    fallback: false;
    indexer: "ts-regex-index";
    hits: SymbolHit[];
    filesIndexed: number;
    indexFresh: boolean;
}
interface IndexedFile {
    relPath: string;
    lines: string[];
    mtimeMs: number;
}
interface RootIndex {
    root: string;
    files: Map<string, IndexedFile>;
    builtAt: number;
}
/** Get (building if needed) the process-level index for a root. */
export declare function getSymbolIndex(root: string): Promise<{
    filesIndexed: number;
} & RootIndex>;
/** P7-4: search the light index; always succeeds with fallback:false. */
export declare function indexedSymbolSearch(input: {
    symbol: string;
    root: string;
    relPath?: string;
    maxHits?: number;
}): Promise<SymbolSearchIndexResult>;
export {};
//# sourceMappingURL=symbol-index.d.ts.map