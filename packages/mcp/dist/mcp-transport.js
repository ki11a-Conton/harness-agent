import { AgentError, errorInfo } from "@ar/contracts";
import { McpClient } from "./mcp-client.js";
import { createMcpToolAdapter } from "./mcp-tool-adapter.js";
import { StdioMcpClient } from "./stdio-client.js";
import { jsonSchemaToZod } from "./json-schema-zod.js";
export async function connectMcpServer(config, opts = {}) {
    const risk = opts.risk ?? "readonly";
    const networkBoundary = opts.networkBoundary ?? (config.kind === "stdio" ? "loopback" : "internet");
    const provenance = { serverId: config.id, trust: opts.trust ?? "untrusted", networkBoundary };
    const events = opts.events;
    const adapt = async (source) => {
        const toolLikes = await createMcpToolAdapter(source, { events, provenance });
        // stdio is a local child-process IPC channel — no network boundary is
        // crossed; http crosses the real network (and the sandbox must admit it).
        const network = config.kind === "http";
        return toolLikes.map((tool) => toToolDefinition(tool, config.id, risk, network));
    };
    if (config.kind === "http") {
        if (config.url === undefined) {
            throw new AgentError(errorInfo("NETWORK_ERROR", `mcp server "${config.id}": http transport requires a url`));
        }
        const client = new McpClient();
        await client.connect(config.url);
        const tools = await adapt(client);
        return {
            serverId: config.id,
            tools,
            close: async () => {
                await client.close();
            },
        };
    }
    // stdio
    if (config.command === undefined || config.command === "") {
        throw new AgentError(errorInfo("NETWORK_ERROR", `mcp server "${config.id}": stdio transport requires a command`));
    }
    const client = new StdioMcpClient(config.id, config.command, config.commandArgs ?? []);
    try {
        await client.initialize();
        const tools = await adapt(client);
        return {
            serverId: config.id,
            tools,
            close: async () => {
                await client.close();
            },
        };
    }
    catch (cause) {
        await client.close();
        throw cause;
    }
}
function toToolDefinition(tool, serverId, risk, network) {
    const schema = (tool.schema ?? {});
    return {
        name: tool.name,
        description: tool.description ?? `MCP tool ${serverId}/${tool.name}`,
        inputSchema: jsonSchemaToZod(schema),
        risk,
        metadata: {
            name: tool.name,
            version: "1.0.0",
            // MCP calls cross a process boundary (stdio) or the network (http);
            // side effects are unknown from the host side, so retry is never safe
            // and concurrency is serial.
            sideEffect: risk !== "readonly",
            network,
            filesystem: false,
            process: false,
            interactive: false,
            retry: "unknown",
            concurrencySafe: false,
            // Adapter provenance rides along so a result can always be traced back
            // to its server and the exact schema that produced it.
            ...(tool.provenance !== undefined ? { mcpProvenance: tool.provenance } : {}),
        },
        async execute(input, context) {
            try {
                const result = (await tool.handler({ args: input, ...(context.signal !== undefined ? { signal: context.signal } : {}) }));
                const rendered = renderMcpResult(result);
                if (result?.isError === true) {
                    return {
                        status: "failed",
                        error: errorInfo("PROCESS_ERROR", rendered),
                    };
                }
                return { status: "success", output: rendered };
            }
            catch (err) {
                if (err instanceof AgentError) {
                    return { status: "failed", error: err.info };
                }
                return {
                    status: "failed",
                    error: errorInfo("PROCESS_ERROR", err instanceof Error ? err.message : String(err)),
                };
            }
        },
    };
}
/** Renders an MCP tools/call result ({ content: [{type, text}] }) to text. */
function renderMcpResult(result) {
    if (result === undefined)
        return "(no result)";
    if (!Array.isArray(result.content))
        return JSON.stringify(result);
    const parts = result.content.map((block) => {
        if (block.text !== undefined)
            return block.text;
        return JSON.stringify(block);
    });
    return parts.join("\n");
}
//# sourceMappingURL=mcp-transport.js.map