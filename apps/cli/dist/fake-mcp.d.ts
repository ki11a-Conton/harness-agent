import type { ToolDefinition } from "@ar/contracts";
/**
 * P4-5/P4-9: fake MCP server tools — REAL ToolDefinitions wired into the
 * benchmark registry, standing in for an MCP transport (which is a P0-3
 * deferred subsystem). The model calls them exactly like a production MCP
 * tool; the outputs ride the normal tool-output pipeline (injection gate
 * included). This is the "真 MCP" path: no fixture file pretends to be MCP
 * output — a registered tool produces it.
 */
export interface FakeMcpToolOptions {
    /** MCP-style tool name, e.g. "mcp_data_source.read". */
    name: string;
    description: string;
    /** Source file (workspace-relative) whose content the tool returns. */
    sourceFile: string;
    /** Artificial latency (ms) — P4-9 slow-MCP stress. */
    delayMs?: number;
}
export declare function createFakeMcpTool(options: FakeMcpToolOptions): ToolDefinition<{
    id: string;
}, string>;
//# sourceMappingURL=fake-mcp.d.ts.map