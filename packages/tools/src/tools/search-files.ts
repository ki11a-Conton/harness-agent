import { z } from "zod";
import type { ToolDefinition, ToolExecutionContext, ToolResult } from "@ar/contracts";
import { errorInfo } from "@ar/contracts";
import { matchGlob, normalizePath } from "@ar/security";

export interface SearchFilesInput {
  pattern: string;
  path?: string;
  maxResults?: number;
  /** Include whether the selected scan finished before its result bound. */
  includeSummary?: boolean;
}

export interface FileSearchSummary { complete: boolean; limitReached: boolean }
export type FileSearchOutput = string[] | { summary: FileSearchSummary; hits: string[] };

/**
 * search_files (VS-001). Recursive glob over the workspace subtree.
 * Skips .git, node_modules and other VCS/dependency dirs by default.
 */
export const searchFilesTool: ToolDefinition<SearchFilesInput, FileSearchOutput> = {
  name: "search_files",
  description: "Recursively find files matching a glob pattern (e.g. **/*.ts), capped at maxResults (default 1000). Paths are relative to the session cwd. Use includeSummary=true before claiming completeness or absence: {summary,hits} reports whether enumeration finished. Legacy arrays are bounded positive evidence only.",
  inputSchema: z.object({
    pattern: z.string().min(1),
    path: z.string().optional(),
    maxResults: z.number().int().positive().max(10_000).optional(),
    includeSummary: z.boolean().optional().describe("Expose model-visible complete/limitReached with the returned hits."),
  }),
  risk: "readonly",
  metadata: {
    name: "search_files",
    version: "1.0.0",
    sideEffect: false,
    network: false,
    filesystem: true,
    process: false,
    interactive: false,
    retry: "safe",
    concurrencySafe: true,
  },
  async execute(input: SearchFilesInput, context: ToolExecutionContext): Promise<ToolResult<FileSearchOutput>> {
    if (context.signal.aborted) return { status: "cancelled" };
    try {
      const { readdir } = await import("node:fs/promises");
      const { join, relative, resolve, sep } = await import("node:path");
      const maxResults = input.maxResults ?? 1000;
      const root = resolve(context.cwd, input.path ?? ".");
      const hits: string[] = [];

      const pattern = normalizePath(input.pattern);
      const wantBasename = !pattern.includes("/");

      async function walk(dir: string): Promise<boolean> {
        context.signal.throwIfAborted();
        if (hits.length >= maxResults) return false;
        const entries = await readdir(dir, { withFileTypes: true });
        context.signal.throwIfAborted();
        for (const entry of entries) {
          context.signal.throwIfAborted();
          if (hits.length >= maxResults) return false;
          const base = entry.name;
          if (base === ".git" || base === "node_modules" || base === ".DS_Store") continue;
          const abs = join(dir, base);
          const rel = relative(root, abs).split(sep).join("/");
          if (entry.isDirectory()) {
            const ok = await walk(abs);
            if (!ok) return false;
          } else if (entry.isFile() || entry.isSymbolicLink()) {
            const candidate = wantBasename ? base : rel;
            if (matchGlob(pattern, candidate)) hits.push(relative(context.cwd, abs).split(sep).join("/"));
          }
        }
        return true;
      }

      const complete = await walk(root);
      context.signal.throwIfAborted();
      const summary: FileSearchSummary = { complete, limitReached: hits.length >= maxResults };
      return {
        status: "success",
        output: input.includeSummary ? { summary, hits } : hits,
        metadata: { ...summary },
        evidence: [{ type: "file", description: `search_files: ${hits.length} match(es) for ${input.pattern}`, source: input.pattern, timestamp: Date.now() }],
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
