import type { ToolDefinition } from "@ar/contracts";
import { type EnvironmentSnapshot } from "../env-snapshot.js";
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
export declare function createEnvSnapshotTool(deps: EnvSnapshotToolDeps): ToolDefinition<EnvSnapshotToolInput, EnvironmentSnapshot & {
    summary: string;
}>;
/** Backward-compatible default instance: deny network, no tool list. */
export declare const envSnapshotTool: ToolDefinition<EnvSnapshotToolInput, EnvironmentSnapshot & {
    summary: string;
}>;
//# sourceMappingURL=env-snapshot-tool.d.ts.map