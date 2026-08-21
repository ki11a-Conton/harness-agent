import type { ToolDefinition } from "@ar/contracts";
export interface SearchFilesInput {
    pattern: string;
    path?: string;
    maxResults?: number;
}
/**
 * search_files (VS-001). Recursive glob over the workspace subtree.
 * Skips .git, node_modules and other VCS/dependency dirs by default.
 */
export declare const searchFilesTool: ToolDefinition<SearchFilesInput, string[]>;
//# sourceMappingURL=search-files.d.ts.map