import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { errorInfo } from "@ar/contracts";
export function createFakeMcpTool(options) {
    const schema = z.object({ id: z.string().min(1) });
    return {
        name: options.name,
        description: options.description,
        inputSchema: schema,
        risk: "readonly",
        metadata: {
            name: options.name,
            version: "1.0.0",
            sideEffect: false,
            network: false,
            filesystem: true,
            process: false,
            interactive: false,
            retry: "safe",
            concurrencySafe: true,
        },
        async execute(input, context) {
            try {
                if (options.delayMs !== undefined && options.delayMs > 0) {
                    await new Promise((resolve) => setTimeout(resolve, options.delayMs));
                }
                let content = "";
                try {
                    content = await readFile(join(context.cwd, options.sourceFile), "utf8");
                }
                catch {
                    content = `(no connector record for id=${input.id})`;
                }
                return { status: "success", output: content };
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
//# sourceMappingURL=fake-mcp.js.map