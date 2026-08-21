import { z } from "zod";
import { errorInfo } from "@ar/contracts";
import { snapshotEnvironment, snapshotSummary } from "../env-snapshot.js";
const inputSchema = z.object({
    networkMode: z.string().optional(),
    probeLimit: z.number().int().min(0).max(12).optional(),
});
/**
 * Factory: bind the host's network mode + tool list (production composition
 * root). All deps are functions evaluated per call (live, not a build-time
 * freeze). Env VALUES / API keys / tokens are never captured — only network
 * policy, tool names and the workspace root are reported.
 */
export function createEnvSnapshotTool(deps) {
    return {
        name: "env_snapshot",
        description: "Capture the environment capability snapshot once (OS, cwd, runtime versions, package manager, git state, tool list, harness profile, network policy). Secrets-safe: env VALUES are never captured; network policy is supplied, not probed.",
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
        async execute(input, context) {
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
            }
            catch (err) {
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
//# sourceMappingURL=env-snapshot-tool.js.map