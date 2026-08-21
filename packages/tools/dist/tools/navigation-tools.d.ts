import type { ToolDefinition } from "@ar/contracts";
import { type GrepHit, type SymbolHit, type RepoTreeEntry } from "../navigate.js";
/**
 * P2-29 navigation tools. Read-only; policy (permission + sandbox path scoping)
 * stays in the orchestrator. These give the agent real navigation so it stops
 * guessing paths via repeated read_file attempts.
 */
export interface GrepFilesToolInput {
    pattern: string;
    path?: string;
    fileGlob?: string | null;
    caseSensitive?: boolean;
    maxResults?: number;
}
export declare const grepSearchTool: ToolDefinition<GrepFilesToolInput, GrepHit[]>;
export interface RepoTreeToolInput {
    path?: string;
    depth?: number;
    maxEntries?: number;
}
export declare const repoTreeTool: ToolDefinition<RepoTreeToolInput, RepoTreeEntry[]>;
export interface SymbolSearchToolInput {
    symbol: string;
    path?: string;
    maxResults?: number;
}
export declare const symbolSearchTool: ToolDefinition<SymbolSearchToolInput, {
    fallback: boolean;
    indexer: string;
    hits: SymbolHit[];
    filesIndexed?: number;
}>;
//# sourceMappingURL=navigation-tools.d.ts.map