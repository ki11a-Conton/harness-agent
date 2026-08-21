import { z } from "zod";
import { resolve } from "node:path";
import { errorInfo } from "@ar/contracts";
import { discoverCommands, summarize } from "../command-discovery.js";
const inputSchema = z.object({
    path: z.string().min(1).optional(),
});
export const discoverCommandsTool = {
    name: "discover_commands",
    description: "Discover the real test/build/lint/typecheck/check commands from the repo (package.json, pyproject.toml, Cargo.toml, Makefile, CI workflows, AGENTS.md). Returns tagged discoveries + a strongest-per-kind summary.",
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
    async execute(input, context) {
        try {
            const root = resolve(context.cwd, input.path ?? ".");
            const result = await discoverCommands(root);
            return {
                status: "success",
                output: { ...result, summary: summarize(result.discovered) },
                evidence: [{ type: "file", description: `discover_commands: ${result.discovered.length} command(s) from ${result.sourceFilesChecked.length} source(s)`, source: result.root, timestamp: Date.now() }],
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
//# sourceMappingURL=discover-commands-tool.js.map