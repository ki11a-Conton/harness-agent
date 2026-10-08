import { z } from "zod";
import type { ToolDefinition, ToolExecutionContext, ToolResult } from "@ar/contracts";
import { errorInfo } from "@ar/contracts";
import { createGrepScanSummary, grepFiles, repoTree, symbolSearch, type GrepScanSummary, type GrepHit, type SymbolHit, type RepoTreeEntry } from "../navigate.js";
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
  /** Fixed-string search, useful for source text containing regex syntax. */
  literal?: boolean;
  maxResults?: number;
  /** Include scan completeness in the model-visible output rather than only metadata. */
  includeSummary?: boolean;
}

export const grepSearchTool: ToolDefinition<GrepFilesToolInput, GrepHit[] | { summary: GrepScanSummary; hits: GrepHit[] }> = {
  name: "grep_search",
  description:
    "Regex text search in a selected workspace file or directory (skips .git/node_modules/dist/build); literal=true searches source text as a fixed string. Returns {file,line,column,text} hits; long matching lines are rendered around their match with truncated=true. Use includeSummary=true when verifying absence or scan completeness: {summary,hits} exposes capped/oversized/unreadable scans. Legacy arrays are positive evidence only; omitted files report SCAN_INCOMPLETE. Files above 512KiB require a targeted read or approved exec search.",
  inputSchema: z.object({
    pattern: z.string().min(1).max(8192),
    path: z.string().optional(),
    fileGlob: z.string().nullish(),
    caseSensitive: z.boolean().optional(),
    literal: z.boolean().optional().describe("Search the exact fixed string rather than regex; use for source text containing regex metacharacters."),
    maxResults: z.number().int().positive().max(5000).optional(),
    includeSummary: z.boolean().optional().describe("Set true before claiming no matches: exposes incomplete scans and omitted files in the model-visible {summary,hits}."),
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
  async execute(input: GrepFilesToolInput, context: ToolExecutionContext): Promise<ToolResult<GrepHit[] | { summary: GrepScanSummary; hits: GrepHit[] }>> {
    try {
      const summary = createGrepScanSummary();
      const hits = await grepFiles({
        pattern: input.pattern,
        root: context.cwd,
        relPath: input.path ?? ".",
        caseSensitive: input.caseSensitive ?? false,
        literal: input.literal ?? false,
        fileGlob: input.fileGlob ?? null,
        maxHits: input.maxResults ?? 200,
        signal: context.signal,
        summary,
      });
      // The legacy array cannot carry model-visible completeness diagnostics.
      // Do not let omitted files turn into a false negative assertion.
      if (!input.includeSummary && (summary.skippedOversizedFiles > 0 || summary.unreadableFiles > 0 || summary.unreadableDirectories > 0 || summary.unavailableScope)) {
        return { status: "failed", output: hits, metadata: { ...summary }, error: errorInfo("PROCESS_ERROR",
          `SCAN_INCOMPLETE: search skipped ${summary.skippedOversizedFiles} oversized file(s), ${summary.unreadableFiles} unreadable file(s), ${summary.unreadableDirectories} unreadable directory(s)${summary.unavailableScope ? "; selected scope is unavailable" : ""}. Returned hits are positive evidence only; use includeSummary=true, a targeted paged read_file, or an approved exec before claiming absence.`,
          { retryable: false, safeToRetry: false }) };
      }
      return {
        status: "success",
        output: input.includeSummary ? { summary, hits } : hits,
        metadata: { ...summary },
        evidence: [{ type: "file", description: `grep_search: ${hits.length} hit(s) for ${input.pattern}`, source: input.pattern, timestamp: Date.now() }],
      };
    } catch (err) {
      if (context.signal.aborted) return { status: "cancelled" };
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
        signal: context.signal,
      });
      return {
        status: "success",
        output: tree,
        evidence: [{ type: "file", description: `repo_tree: ${tree.length} entry(ies)`, source: input.path ?? ".", timestamp: Date.now() }],
      };
    } catch (err) {
      if (context.signal.aborted) return { status: "cancelled" };
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
    "Find symbols (functions/classes/types/consts/imports) by name within the selected file or directory. Prefers matching TypeScript/JavaScript index hits (fallback:false); otherwise uses a heuristic regex fallback (fallback:true).",
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
      context.signal.throwIfAborted();
      // P7-4 (EXPERIMENT): prefer matching TS/JS hits. Unrelated indexed files
      // must not mask other languages' existing heuristic fallback.
      const indexed = await indexedSymbolSearch({
        symbol: input.symbol,
        root: context.cwd,
        relPath: input.path ?? ".",
        maxHits: input.maxResults ?? 200,
      });
      context.signal.throwIfAborted();
      if (indexed.hits.length > 0) {
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
        signal: context.signal,
      });
      return {
        status: "success",
        output: res,
        evidence: [{ type: "file", description: `symbol_search: ${res.hits.length} symbol(s) for ${input.symbol}`, source: input.symbol, timestamp: Date.now() }],
      };
    } catch (err) {
      if (context.signal.aborted) return { status: "cancelled" };
      return {
        status: "failed",
        error: errorInfo("PROCESS_ERROR", err instanceof Error ? err.message : String(err)),
      };
    }
  },
};
