import type { McpToolInfo } from "@ar/contracts";
import { AgentError, errorInfo } from "@ar/contracts";

const PROTOCOL_VERSION = "2025-03-26";
const CLIENT_NAME = "@ar/mcp";
const CLIENT_VERSION = "0.1.0";

interface JsonRpcError {
  code: number;
  message: string;
  data?: unknown;
}

interface JsonRpcResponse {
  result?: unknown;
  error?: JsonRpcError;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Minimal MCP (Model Context Protocol) client over HTTP, speaking JSON-RPC 2.0.
 *
 * connect() performs the initialize handshake; all requests carry an
 * incrementing id and, when a token was given, an Authorization: Bearer
 * header. Transport/protocol failures surface as AgentError with a
 * canonical error code (NETWORK_ERROR), preserving the server JSON-RPC
 * error code in the cause.
 */
export class McpClient {
  private url: string | undefined;
  private token: string | undefined;
  private nextId = 1;

  async connect(url: string, token?: string): Promise<void> {
    const scheme = url.match(/^([a-zA-Z][a-zA-Z0-9+.-]*):/)?.[1];
    if (scheme === "file") {
      throw new AgentError(errorInfo("NETWORK_ERROR", "file: transport is not supported"));
    }
    if (scheme !== "http" && scheme !== "https") {
      throw new AgentError(
        errorInfo("NETWORK_ERROR", `unsupported MCP transport scheme: ${scheme ?? "<none>"}`),
      );
    }
    this.url = url;
    this.token = token;
    this.nextId = 1;
    await this.request("initialize", {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: CLIENT_NAME, version: CLIENT_VERSION },
    });
  }

  async close(): Promise<void> {
    this.url = undefined;
    this.token = undefined;
  }

  async listTools(): Promise<McpToolInfo[]> {
    const result = await this.request("tools/list", {});
    if (!isRecord(result) || !Array.isArray(result.tools)) {
      throw new AgentError(
        errorInfo("NETWORK_ERROR", "tools/list response is missing a tools array"),
      );
    }
    return result.tools.map((tool) => {
      if (!isRecord(tool) || typeof tool.name !== "string" || tool.name === "") {
        throw new AgentError(
          errorInfo("NETWORK_ERROR", "tools/list returned a tool without a name"),
        );
      }
      const info: McpToolInfo = { name: tool.name };
      if (typeof tool.description === "string") info.description = tool.description;
      if (tool.inputSchema !== undefined) {
        info.inputSchema = tool.inputSchema as Record<string, unknown>;
      }
      return info;
    });
  }

  /** P1-10: an optional AbortSignal aborts the in-flight HTTP call; an
   *  abort surfaces as USER_CANCELLED, not NETWORK_ERROR. */
  async callTool(name: string, args: unknown, signal?: AbortSignal): Promise<unknown> {
    return this.request("tools/call", { name, arguments: args }, signal);
  }

  private async request(
    method: string,
    params: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<unknown> {
    const url = this.url;
    if (url === undefined) {
      throw new AgentError(errorInfo("INTERNAL_ERROR", "McpClient is not connected"));
    }
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
    };
    if (this.token !== undefined) headers.Authorization = `Bearer ${this.token}`;
    const id = this.nextId++;
    let response: Response;
    try {
      response = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
        ...(signal !== undefined ? { signal } : {}),
      });
    } catch (cause) {
      if (signal?.aborted === true) {
        throw new AgentError(errorInfo("USER_CANCELLED", `MCP ${method} aborted`));
      }
      throw new AgentError(errorInfo("NETWORK_ERROR", `MCP request failed: ${method}`, { cause }));
    }
    if (!response.ok) {
      throw new AgentError(
        errorInfo("NETWORK_ERROR", `MCP request failed with HTTP ${response.status}: ${method}`),
      );
    }
    let body: JsonRpcResponse;
    try {
      body = (await response.json()) as JsonRpcResponse;
    } catch (cause) {
      throw new AgentError(
        errorInfo("NETWORK_ERROR", `MCP server returned invalid JSON for ${method}`, { cause }),
      );
    }
    if (body.error !== undefined) {
      throw new AgentError(
        errorInfo("NETWORK_ERROR", `MCP ${method} error: ${body.error.message}`, {
          cause: {
            code: body.error.code,
            message: body.error.message,
            ...(body.error.data !== undefined ? { data: body.error.data } : {}),
          },
        }),
      );
    }
    return body.result;
  }
}
