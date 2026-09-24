import type {
  EventSink,
  McpServerConfig,
  NetworkBoundary,
  ToolDefinition,
  ToolExecutionContext,
  ToolResult,
  TrustLevel,
} from "@ar/contracts";
import { AgentError, errorInfo } from "@ar/contracts";
import { McpClient } from "./mcp-client.js";
import { createMcpToolAdapter, type McpToolSource, type ToolLike } from "./mcp-tool-adapter.js";
import { StdioMcpClient } from "./stdio-client.js";
import { jsonSchemaToZod } from "./json-schema-zod.js";

/**
 * P0-3 MCP transport wiring: connects an McpServerConfig (http or stdio) over
 * the REAL transport (fetch-based JSON-RPC for http, spawned child process with
 * line-delimited JSON-RPC for stdio), adapts the advertised tools into
 * registrable ToolDefinitions, and returns a closeable connection.
 *
 * The tools flow through the normal ToolOrchestrator pipeline — permission,
 * approval, sandbox and audit events all apply unchanged. Tool descriptions
 * are scanned for prompt injection at registration (fail-closed, P0-8); a
 * rejected server surfaces the rejection on the event stream when an EventSink
 * is wired (security.mcp_denied) and the harness registration aborts.
 */

export interface McpTransportOptions {
  /** Event sink for security.mcp_denied / retry.mcpReconnect observability. */
  events?: EventSink;
  /**
   * Local-only provenance trust for the server (operator configuration, never
   * remote content). Default "untrusted" — MCP tool output is low-trust data.
   */
  trust?: TrustLevel;
  /** Network boundary override. Defaults: stdio → "loopback", http → "internet". */
  networkBoundary?: NetworkBoundary;
  /**
   * Tool risk for the adapted tools. MCP tools are remote/opaque; the host
   * declares the risk from its knowledge of the server. P18-4 default
   * "side_effect" — FAIL-CLOSED: the host cannot prove a remote tool is
   * read-only, so it is treated as side-effecting until the operator
   * explicitly declares "readonly" (trusted-local). The orchestrator's
   * permission/sandbox/reconciliation pipeline under-classifies otherwise.
   */
  risk?: "readonly" | "side_effect" | "elevated" | "critical";
}

export interface McpServerConnection {
  serverId: string;
  /** Advertised tools as registrable ToolDefinitions. */
  tools: ToolDefinition[];
  /** Closes the transport (HTTP: disconnects; stdio: kills the child). */
  close(): Promise<void>;
}

export async function connectMcpServer(
  config: McpServerConfig,
  opts: McpTransportOptions = {},
): Promise<McpServerConnection> {
  const risk = opts.risk ?? "side_effect";
  const networkBoundary = opts.networkBoundary ?? (config.kind === "stdio" ? "loopback" : "internet");
  const provenance = { serverId: config.id, trust: opts.trust ?? "untrusted", networkBoundary };
  const events = opts.events;

  const adapt = async (source: McpToolSource) => {
    const toolLikes = await createMcpToolAdapter(source, { events, provenance });
    // P14-4 MCP boundary: the server's advertised tools are the DECLARED
    // capability; the host's config.allowedTools is the CONFERED bound.
    // EffectiveCapability = Conferred ∩ Declared — a tool the host did not
    // confer is a widening and is denied fail-closed (the registration of the
    // whole server fails; no tool outside the bound is ever registered).
    if (config.allowedTools !== undefined) {
      const declared = toolLikes.map((t) => t.name);
      const missing = declared.filter((name) => !config.allowedTools!.includes(name));
      if (missing.length > 0) {
        throw new AgentError(
          errorInfo(
            "MCP_DENIED",
            `mcp server "${config.id}" denied: advertised tools outside the host's conferred allow-list (${missing.join(", ")})`,
            { evidence: JSON.stringify({ serverId: config.id, declared, conferred: config.allowedTools }) },
          ),
        );
      }
    }
    // stdio is a local child-process IPC channel — no network boundary is
    // crossed; http crosses the real network (and the sandbox must admit it).
    // P18-4: a stdio MCP server is a SPAWNED PROCESS — that is a process
    // capability, never implicitly trusted just because it is "local".
    const network = config.kind === "http";
    const processCapability = config.kind === "stdio";
    return toolLikes.map((tool) => toToolDefinition(tool, config.id, risk, network, processCapability));
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
  } catch (cause) {
    await client.close();
    throw cause;
  }
}

function toToolDefinition(
  tool: ToolLike,
  serverId: string,
  risk: NonNullable<McpTransportOptions["risk"]>,
  network: boolean,
  processCapability: boolean,
): ToolDefinition {
  const schema = (tool.schema ?? {}) as Record<string, unknown> | undefined;
  return {
    name: tool.name,
    description: tool.description ?? `MCP tool ${serverId}/${tool.name}`,
    inputSchema: jsonSchemaToZod(schema),
    risk,
    metadata: {
      name: tool.name,
      version: "1.0.0",
      // P18-4: MCP calls cross a process boundary (stdio spawn) or the network
      // (http); side effects are UNKNOWN from the host side, so the adapted
      // tool is side-effecting by default (risk "side_effect"), never
      // auto-retried and serial. stdio is a process capability — being local
      // does not make it trusted.
      sideEffect: risk !== "readonly",
      network,
      filesystem: false,
      process: processCapability,
      interactive: false,
      retry: "unknown",
      concurrencySafe: false,
      // Adapter provenance rides along so a result can always be traced back
      // to its server and the exact schema that produced it.
      ...(tool.provenance !== undefined ? { mcpProvenance: tool.provenance } : {}),
    },
    async execute(input: unknown, context: ToolExecutionContext): Promise<ToolResult<unknown>> {
      try {
        const result = (await tool.handler({ args: input, ...(context.signal !== undefined ? { signal: context.signal } : {}) })) as
          | { content?: Array<{ type?: string; text?: string }>; isError?: boolean }
          | undefined;
        const rendered = renderMcpResult(result);
        if (result?.isError === true) {
          return {
            status: "failed",
            error: errorInfo("PROCESS_ERROR", rendered),
          };
        }
        return { status: "success", output: rendered };
      } catch (err) {
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
function renderMcpResult(
  result: { content?: Array<{ type?: string; text?: string }>; isError?: boolean } | undefined,
): string {
  if (result === undefined) return "(no result)";
  if (!Array.isArray(result.content)) return JSON.stringify(result);
  const parts = result.content.map((block) => {
    if (block.text !== undefined) return block.text;
    return JSON.stringify(block);
  });
  return parts.join("\n");
}
