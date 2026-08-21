import type { ToolDefinition } from "@ar/contracts";
import { type CommandDiscoveryResult } from "../command-discovery.js";
/**
 * P2-31 discover_commands tool. Read-only; policy (permission + sandbox path
 * scoping) stays in the orchestrator. Returns the repo's discovered test/build/
 * lint/typecheck/check commands plus the strongest per-kind summary, so the
 * agent stops guessing `npm test`.
 */
export interface DiscoverCommandsToolInput {
    path?: string;
}
export declare const discoverCommandsTool: ToolDefinition<DiscoverCommandsToolInput, CommandDiscoveryResult & {
    summary: Partial<Record<string, string>>;
}>;
//# sourceMappingURL=discover-commands-tool.d.ts.map