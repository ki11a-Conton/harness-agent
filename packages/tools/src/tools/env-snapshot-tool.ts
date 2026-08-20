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

/** Factory deps (plan.md P0-7): all host wiring facts are injected as
 *  functions — evaluated per call — so the snapshot always reflects the LIVE
 *  registry / network policy instead of a stale snapshot taken at build time. */
export interface EnvSnapshotToolDeps {
  networkMode: () => string;
  /** Tool names visible to the default registry (used by the snapshot). */
  availableTools: () => readonly string[];
  /** Host wiring facts (plan.md P0-7 output additions). */
  workspaceRoot?: () => string;
  harnessProfile?: () => string;
}

/**
 * Factory: bind the host's network mode + tool list (production composition
 * root). All deps are functions evaluated per call (live, not a build-time
 * freeze). Env VALUES / API keys / tokens are never captured — only network
 * policy, tool names and the workspace root are reported.
 */
export function createEnvSnapshotTool(
  deps: EnvSnapshotToolDeps,
): ToolDefinition<EnvSnapshotToolInput, EnvironmentSnapshot & { summary: string }> {
  return {
    name: "env_snapshot",
    description:
      "Capture the environment capability snapshot once (OS, cwd, runtime versions, package manager, git state, tool list, harness profile, network policy). Secrets-safe: env VALUES are never captured; network policy is supplied, not probed.",
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
          networkMode: deps.networkMode(),
          probeLimit: input.probeLimit,
          availableTools: [...deps.availableTools()],
          ...(deps.workspaceRoot !== undefined ? { workspaceRoot: deps.workspaceRoot() } : {}),
          ...(deps.harnessProfile !== undefined ? { harnessProfile: deps.harnessProfile() } : {}),
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
}

/** Backward-compatible default instance: deny network, no tool list. */
export const envSnapshotTool = createEnvSnapshotTool({
  networkMode: () => "deny",
  availableTools: () => [],
});