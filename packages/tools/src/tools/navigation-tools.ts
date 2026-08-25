import { z } from "zod";
import type { ToolDefinition, ToolExecutionContext, ToolResult } from "@ar/contracts";
import { errorInfo } from "@ar/contracts";
import { grepFiles, repoTree, symbolSearch, type GrepHit, type SymbolHit, type RepoTreeEntry } from "../navigate.js";
import { indexedSymbolSearch } from "../symbol-index.js";

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

export const grepSearchTool: ToolDefinition<GrepFilesToolInput, GrepHit[]> = {
  name: "grep_search",
  description:
    "Regex text search over file contents in the workspace (skips .git/node_modules/dist/build). Returns {file,line,column,text} hits.",
  inputSchema: z.object({
    pattern: z.string().min(1),
    path: z.string().optional(),
    fileGlob: z.string().nullish(),
    caseSensitive: z.boolean().optional(),
    maxResults: z.number().int().positive().max(5000).optional(),
  }),
  risk: "readonly",
  metadata: {
    name: "grep_search",
    version: "1.0.0",
    sideEffect: false,
    network: false,
    filesystem: true,
    process: false,
    interactive: false,
    retry: "safe",
    concurrencySafe: true,
  },
  async execute(input: GrepFilesToolInput, context: ToolExecutionContext): Promise<ToolResult<GrepHit[]>> {
    try {
      const hits = await grepFiles({
        pattern: input.pattern,
        root: context.cwd,
        relPath: input.path ?? ".",
        caseSensitive: input.caseSensitive ?? false,
        fileGlob: input.fileGlob ?? null,
        maxHits: input.maxResults ?? 200,
      });
      return {
        status: "success",
        output: hits,
        evidence: [{ type: "file", description: `grep_search: ${hits.length} hit(s) for ${input.pattern}`, source: input.pattern, timestamp: Date.now() }],
      };
    } catch (err) {
      const invalidRegex =
        err instanceof Error && /Invalid regular expression|Invalid regex flag/i.test(err.message);
      return {
        status: "failed",
        error: errorInfo(
          invalidRegex ? "TOOL_SCHEMA_ERROR" : "PROCESS_ERROR",
          err instanceof Error ? err.message : String(err),
        ),
      };
    }
  },
};

export interface RepoTreeToolInput {
  path?: string;
  depth?: number;
  maxEntries?: number;
}

export const repoTreeTool: ToolDefinition<RepoTreeToolInput, RepoTreeEntry[]> = {
  name: "repo_tree",
  description:
    "Return the nested file/dir tree of the workspace (skips .git/node_modules/dist/build). Useful for orientation instead of guessing paths.",
  inputSchema: z.object({
    path: z.string().optional(),
    depth: z.number().int().min(0).max(12).optional(),
    maxEntries: z.number().int().positive().max(5000).optional(),
  }),
  risk: "readonly",
  metadata: {
    name: "repo_tree",
    version: "1.0.0",
    sideEffect: false,
    network: false,
    filesystem: true,
    process: false,
    interactive: false,
    retry: "safe",
    concurrencySafe: true,
  },
  async execute(input: RepoTreeToolInput, context: ToolExecutionContext): Promise<ToolResult<RepoTreeEntry[]>> {
    try {
      const tree = await repoTree({
        root: context.cwd,
        relPath: input.path ?? ".",
        depth: input.depth ?? 6,
        maxEntries: input.maxEntries ?? 500,
      });
      return {
        status: "success",
        output: tree,
        evidence: [{ type: "file", description: `repo_tree: ${tree.length} entry(ies)`, source: input.path ?? ".", timestamp: Date.now() }],
      };
    } catch (err) {
      return {
        status: "failed",
        error: errorInfo("PROCESS_ERROR", err instanceof Error ? err.message : String(err)),
      };
    }
  },
};

export interface SymbolSearchToolInput {
  symbol: string;
  path?: string;
  maxResults?: number;
}

export const symbolSearchTool: ToolDefinition<
  SymbolSearchToolInput,
  { fallback: boolean; indexer: string; hits: SymbolHit[]; filesIndexed?: number }
> = {
  name: "symbol_search",
  description:
    "Find symbols (functions/classes/types/consts/imports) by name. Uses the P7-4 light TypeScript/JavaScript index when the workspace has source files (fallback:false), otherwise a grep fallback (fallback:true).",
  inputSchema: z.object({
    symbol: z.string().min(1),
    path: z.string().optional(),
    maxResults: z.number().int().positive().max(5000).optional(),
  }),
  risk: "readonly",
  metadata: {
    name: "symbol_search",
    version: "1.0.0",
    sideEffect: false,
    network: false,
    filesystem: true,
    process: false,
    interactive: false,
    retry: "safe",
    concurrencySafe: true,
  },
  async execute(
    input: SymbolSearchToolInput,
    context: ToolExecutionContext,
  ): Promise<ToolResult<{ fallback: boolean; indexer: string; hits: SymbolHit[]; filesIndexed?: number }>> {
    try {
      // P7-4 (EXPERIMENT): prefer the light TS/JS index when it indexed any
      // source file; otherwise fall back to the grep search.
      const indexed = await indexedSymbolSearch({
        symbol: input.symbol,
        root: context.cwd,
        relPath: input.path ?? ".",
        maxHits: input.maxResults ?? 200,
      });
      if (indexed.filesIndexed > 0) {
        return {
          status: "success",
          output: indexed,
          evidence: [
            {
              type: "file",
              description: `symbol_search: ${indexed.hits.length} symbol(s) for ${input.symbol} (${indexed.filesIndexed} files indexed)`,
              source: input.symbol,
              timestamp: Date.now(),
            },
          ],
        };
      }
      const res = await symbolSearch({
        symbol: input.symbol,
        root: context.cwd,
        relPath: input.path ?? ".",
        maxHits: input.maxResults ?? 200,
      });
      return {
        status: "success",
        output: res,
        evidence: [{ type: "file", description: `symbol_search: ${res.hits.length} symbol(s) for ${input.symbol}`, source: input.symbol, timestamp: Date.now() }],
      };
    } catch (err) {
      return {
        status: "failed",
        error: errorInfo("PROCESS_ERROR", err instanceof Error ? err.message : String(err)),
      };
    }
  },
};