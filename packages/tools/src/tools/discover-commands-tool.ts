import { z } from "zod";
import { resolve } from "node:path";
import type { ToolDefinition, ToolExecutionContext, ToolResult } from "@ar/contracts";
import { errorInfo } from "@ar/contracts";
import { discoverCommands, summarize, type CommandDiscoveryResult } from "../command-discovery.js";

/**
 * P2-31 discover_commands tool. Read-only; policy (permission + sandbox path
 * scoping) stays in the orchestrator. Returns the repo's discovered test/build/
 * lint/typecheck/check commands plus the strongest per-kind summary, so the
 * agent stops guessing `npm test`.
 */

export interface DiscoverCommandsToolInput {
  path?: string;
}

const inputSchema = z.object({
  path: z.string().min(1).optional(),
});

export const discoverCommandsTool: ToolDefinition<DiscoverCommandsToolInput, CommandDiscoveryResult & { summary: Partial<Record<string, string>> }> = {
  name: "discover_commands",
  description:
    "Discover the real test/build/lint/typecheck/check commands from the repo (package.json, pyproject.toml, Cargo.toml, Makefile, CI workflows, AGENTS.md). Returns tagged discoveries + a strongest-per-kind summary.",
  inputSchema,
  risk: "readonly",
  metadata: {
    name: "discover_commands",
    version: "1.0.0",
    sideEffect: false,
    network: false,
    filesystem: true,
    process: false,
    interactive: false,
    retry: "safe",
    concurrencySafe: false, // scans the tree; orchestrator serializes heavy calls
  },
  async execute(input: DiscoverCommandsToolInput, context: ToolExecutionContext): Promise<ToolResult<CommandDiscoveryResult & { summary: Partial<Record<string, string>> }>> {
    try {
      const root = resolve(context.cwd, input.path ?? ".");
      const result = await discoverCommands(root);
      return {
        status: "success",
        output: { ...result, summary: summarize(result.discovered) },
        evidence: [{ type: "file", description: `discover_commands: ${result.discovered.length} command(s) from ${result.sourceFilesChecked.length} source(s)`, source: result.root, timestamp: Date.now() }],
      };
    } catch (err) {
      return {
        status: "failed",
        error: errorInfo("PROCESS_ERROR", err instanceof Error ? err.message : String(err)),
      };
    }
  },
};