import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentError } from "@ar/contracts";
import { McpClient } from "./mcp-client.js";

const MCP_URL = "http://mcp.local";

let mockFetch: ReturnType<typeof vi.fn>;

function stubFetch(): void {
  mockFetch = vi.fn();
  vi.stubGlobal("fetch", mockFetch);
}

function jsonResponse(body: unknown, ok = true, status = 200): Response {
  return { ok, status, json: () => Promise.resolve(body) } as Response;
}

function rpcResult(result: unknown): unknown {
  return { jsonrpc: "2.0", id: 1, result };
}

function okResponse(): Response {
  return jsonResponse(
    rpcResult({
      protocolVersion: "2025-03-26",
      capabilities: {},
      serverInfo: { name: "test-server", version: "1.0.0" },
    }),
  );
}

function fetchOptions(callIndex = 0): RequestInit {
  return mockFetch.mock.calls[callIndex]![1] as RequestInit;
}

function requestBody(callIndex = 0): Record<string, unknown> {
  return JSON.parse(String(fetchOptions(callIndex).body)) as Record<string, unknown>;
}

/** Awaits a rejected promise and returns the AgentError (fails the test if it resolved). */
async function rejectError(promise: Promise<unknown>): Promise<AgentError> {
  try {
    await promise;
  } catch (error) {
    return error as AgentError;
  }
  throw new Error("expected the promise to reject");
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("McpClient", () => {
  it("runs an initialize handshake on connect", async () => {
    stubFetch();
    mockFetch.mockResolvedValueOnce(okResponse());
    const client = new McpClient();

    await client.connect(MCP_URL);

    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(mockFetch.mock.calls[0]![0]).toBe(MCP_URL);
    expect(fetchOptions().method).toBe("POST");
    expect(requestBody()).toMatchObject({
      jsonrpc: "2.0",
      method: "initialize",
      params: { protocolVersion: "2025-03-26" },
    });
  });

  it("sends a Bearer token header when a token is provided", async () => {
    stubFetch();
    mockFetch.mockResolvedValueOnce(okResponse());

    await new McpClient().connect(MCP_URL, "sekret");

    const headers = fetchOptions().headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer sekret");
  });

  it("omits the Authorization header when no token is provided", async () => {
    stubFetch();
    mockFetch.mockResolvedValueOnce(okResponse());

    await new McpClient().connect(MCP_URL);

    const headers = fetchOptions().headers as Record<string, string>;
    expect(headers.Authorization).toBeUndefined();
  });

  it("throws a coded error when the initialize handshake returns a JSON-RPC error", async () => {
    stubFetch();
    mockFetch.mockResolvedValueOnce(
      jsonResponse({ jsonrpc: "2.0", id: 1, error: { code: -32601, message: "Method not found" } }),
    );

    await expect(new McpClient().connect(MCP_URL)).rejects.toMatchObject({
      info: { code: "NETWORK_ERROR", message: "MCP initialize error: Method not found" },
    });
  });

  it("throws a coded error when the server responds with a non-2xx status", async () => {
    stubFetch();
    mockFetch.mockResolvedValueOnce(jsonResponse({}, false, 500));

    const error = await rejectError(new McpClient().connect(MCP_URL));

    expect(error).toBeInstanceOf(AgentError);
    expect(error.info.code).toBe("NETWORK_ERROR");
    expect(error.info.message).toContain("HTTP 500");
  });

  it("throws a coded error when the network request fails", async () => {
    stubFetch();
    mockFetch.mockRejectedValueOnce(new Error("connection refused"));

    const error = await rejectError(new McpClient().connect(MCP_URL));

    expect(error).toBeInstanceOf(AgentError);
    expect(error.info.code).toBe("NETWORK_ERROR");
  });

  it("rejects file: URLs as an unsupported transport without calling fetch", async () => {
    stubFetch();

    const error = await rejectError(new McpClient().connect("file:///tmp/mcp.sock"));

    expect(error).toBeInstanceOf(AgentError);
    expect(error.info.code).toBe("NETWORK_ERROR");
    expect(error.info.message).toContain("file:");
    expect(error.info.message).toContain("not supported");
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("rejects URLs with an unsupported scheme", async () => {
    stubFetch();

    const error = await rejectError(new McpClient().connect("ftp://mcp.local"));

    expect(error).toBeInstanceOf(AgentError);
    expect(error.info.code).toBe("NETWORK_ERROR");
    expect(error.info.message).toContain("ftp");
  });

  it("lists tools from a tools/list response", async () => {
    stubFetch();
    mockFetch
      .mockResolvedValueOnce(okResponse())
      .mockResolvedValueOnce(
        jsonResponse(
          rpcResult({
            tools: [
              { name: "echo", description: "Echo back", inputSchema: { type: "object" } },
              { name: "bare" },
            ],
          }),
        ),
      );
    const client = new McpClient();
    await client.connect(MCP_URL);

    const tools = await client.listTools();

    expect(requestBody(1).method).toBe("tools/list");
    expect(tools).toEqual([
      { name: "echo", description: "Echo back", inputSchema: { type: "object" } },
      { name: "bare" },
    ]);
  });

  it("throws when tools/list response is missing the tools array", async () => {
    stubFetch();
    mockFetch
      .mockResolvedValueOnce(okResponse())
      .mockResolvedValueOnce(jsonResponse(rpcResult({})));
    const client = new McpClient();
    await client.connect(MCP_URL);

    const error = await rejectError(client.listTools());

    expect(error).toBeInstanceOf(AgentError);
    expect(error.info.code).toBe("NETWORK_ERROR");
    expect(error.info.message).toContain("tools array");
  });

  it("calls a tool with its arguments and returns the result", async () => {
    stubFetch();
    const callResult = { content: [{ type: "text", text: "hi back" }] };
    mockFetch
      .mockResolvedValueOnce(okResponse())
      .mockResolvedValueOnce(jsonResponse(rpcResult(callResult)));
    const client = new McpClient();
    await client.connect(MCP_URL);

    const result = await client.callTool("echo", { msg: "hi" });

    expect(requestBody(1).method).toBe("tools/call");
    expect(requestBody(1).params).toEqual({ name: "echo", arguments: { msg: "hi" } });
    expect(result).toEqual(callResult);
  });

  it("P1-10: an aborted call surfaces as USER_CANCELLED and forwards the signal to fetch", async () => {
    stubFetch();
    mockFetch
      .mockResolvedValueOnce(okResponse())
      .mockImplementationOnce((_url: unknown, init: RequestInit) =>
        Promise.reject(new DOMException("aborted", "AbortError")),
      );
    const client = new McpClient();
    await client.connect(MCP_URL);
    const controller = new AbortController();

    const promise = client.callTool("echo", { msg: "hi" }, controller.signal);
    controller.abort();
    const error = await rejectError(promise);

    expect(error).toBeInstanceOf(AgentError);
    expect(error.info.code).toBe("USER_CANCELLED");
    // The abort signal reached the transport request.
    expect(fetchOptions(1).signal).toBe(controller.signal);
  });

  it("throws a coded error when tools/call returns a JSON-RPC error", async () => {
    stubFetch();
    mockFetch
      .mockResolvedValueOnce(okResponse())
      .mockResolvedValueOnce(jsonResponse({ jsonrpc: "2.0", id: 2, error: { code: -32602, message: "Invalid params" } }));
    const client = new McpClient();
    await client.connect(MCP_URL);

    const error = await rejectError(client.callTool("echo", {}));

    expect(error).toBeInstanceOf(AgentError);
    expect(error.info.code).toBe("NETWORK_ERROR");
    expect(error.info.cause).toMatchObject({ code: -32602 });
  });

  it("throws when used before connect", async () => {
    stubFetch();
    const client = new McpClient();

    const listError = await rejectError(client.listTools());
    const callError = await rejectError(client.callTool("echo", {}));

    expect(listError).toBeInstanceOf(AgentError);
    expect(listError.info.code).toBe("INTERNAL_ERROR");
    expect(callError.info.code).toBe("INTERNAL_ERROR");
  });

  it("close disconnects and a later connect starts a fresh handshake without the token", async () => {
    stubFetch();
    mockFetch
      .mockResolvedValueOnce(okResponse())
      .mockResolvedValueOnce(okResponse());
    const client = new McpClient();
    await client.connect(MCP_URL, "sekret");

    await client.close();

    const closedError = await rejectError(client.listTools());
    expect(closedError.info.code).toBe("INTERNAL_ERROR");

    await client.connect(MCP_URL);
    const headers = fetchOptions(1).headers as Record<string, string>;
    expect(headers.Authorization).toBeUndefined();
  });
});
