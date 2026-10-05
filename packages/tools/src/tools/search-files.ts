import { z } from "zod";
import type { ToolDefinition, ToolExecutionContext, ToolResult } from "@ar/contracts";
import { errorInfo } from "@ar/contracts";
import { matchGlob } from "@ar/security";

export interface SearchFilesInput {
  pattern: string;
  path?: string;
  maxResults?: number;
}

/**
 * search_files (VS-001). Recursive glob over the workspace subtree.
 * Skips .git, node_modules and other VCS/dependency dirs by default.
 */
export const searchFilesTool: ToolDefinition<SearchFilesInput, string[]> = {
  name: "search_files",
  description: "Recursively find files matching a glob pattern (e.g. **/*.ts).",
  inputSchema: z.object({
    pattern: z.string().min(1),
    path: z.string().optional(),
    maxResults: z.number().int().positive().max(10_000).optional(),
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
  async execute(input: SearchFilesInput, context: ToolExecutionContext): Promise<ToolResult<string[]>> {
    if (context.signal.aborted) return { status: "cancelled" };
    try {
      const { readdir } = await import("node:fs/promises");
      const { join, relative, resolve, sep } = await import("node:path");
      const maxResults = input.maxResults ?? 1000;
      const root = resolve(context.cwd, input.path ?? ".");
      const hits: string[] = [];

      const wantBasename = !input.pattern.includes("/");

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
            if (matchGlob(input.pattern, candidate)) hits.push(relative(context.cwd, abs).split(sep).join("/"));
          }
        }
        return true;
      }

      await walk(root);
      context.signal.throwIfAborted();
      return {
        status: "success",
        output: hits,
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