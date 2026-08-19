import { z } from "zod";
import type { ToolDefinition, ToolExecutionContext, ToolResult } from "@ar/contracts";
import { errorInfo } from "@ar/contracts";
import { snapshotEnvironment, snapshotSummary, type EnvironmentSnapshot } from "../env-snapshot.js";

/**
 * P2-32 env_snapshot tool. Read-only; captures environment capability facts once
 * (OS, cwd, runtime versions, git state, package manager, network policy, tool
 * availability, security-redaction contract) so the model stops re-probing.
 * Network policy is supplied here (never probed); env values are never captured.
 */

export interface EnvSnapshotToolInput {
  networkMode?: string;
  /** Restrict how many runtime binaries are probed (0 = none). */
  probeLimit?: number;
}

const inputSchema = z.object({
  networkMode: z.string().optional(),
  probeLimit: z.number().int().min(0).max(12).optional(),
});

export const envSnapshotTool: ToolDefinition<
  EnvSnapshotToolInput,
  EnvironmentSnapshot & { summary: string }
> = {
  name: "env_snapshot",
  description:
    "Capture the environment capability snapshot once (OS, cwd, runtime versions, package manager, git state, tool list). Secrets-safe: env VALUES are never captured; network policy is supplied, not probed.",
  inputSchema,
  risk: "readonly",
  metadata: {
    name: "env_snapshot",
    version: "1.0.0",
    sideEffect: false,
    network: false,
    filesystem: true,
    process: true, // reads `--version` of local binaries
    interactive: false,
    retry: "safe",
    concurrencySafe: true,
  },
  async execute(input: EnvSnapshotToolInput, context: ToolExecutionContext): Promise<ToolResult<EnvironmentSnapshot & { summary: string }>> {
    try {
      const snap = await snapshotEnvironment({
        cwd: context.cwd,
        networkMode: input.networkMode ?? "deny",
        probeLimit: input.probeLimit,
        // available tool names are supplied by registry-level callers; a bare
        // tool has no registry view, so we keep the list empty here.
        availableTools: [],
      });
      return {
        status: "success",
        output: { ...snap, summary: snapshotSummary(snap) },
        evidence: [{ type: "file", description: `env_snapshot: ${snapshotSummary(snap)}`, source: context.cwd, timestamp: Date.now() }],
      };
    } catch (err) {
      return {
        status: "failed",
        error: errorInfo("PROCESS_ERROR", err instanceof Error ? err.message : String(err)),
      };
    }
  },
};