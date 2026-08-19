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
    rpcResult({ protocolVersion: "2025-03-26", capabilities: {}, serverInfo: { name: "t", version: "1" } }),
  );
}
function callResponse(): Response {
  return jsonResponse(rpcResult({ content: [{ type: "text", text: "ok" }] }));
}
function abortError(): Error {
  return new DOMException("aborted", "AbortError") as unknown as Error;
}
/** A fetch that never settles on its own but rejects when its signal aborts. */
function abortableNever(init?: RequestInit): Promise<Response> {
  return new Promise((_resolve, reject) => {
    const signal: AbortSignal | undefined = init?.signal ?? undefined;
    if (signal === undefined) return;
    if (signal.aborted) {
      reject(abortError());
      return;
    }
    signal.addEventListener("abort", () => reject(abortError()));
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

async function rejectError(promise: Promise<unknown>): Promise<AgentError> {
  try {
    await promise;
  } catch (error) {
    return error as AgentError;
  }
  throw new Error("expected the promise to reject");
}

describe("P2-20 McpClient — timeouts, state & reconnect", () => {
  it("connect times out when the server never answers (NETWORK_ERROR)", async () => {
    stubFetch();
    mockFetch.mockImplementationOnce((_u: unknown, init: RequestInit) => abortableNever(init));
    const client = new McpClient({ connectTimeoutMs: 15 });
    const error = await rejectError(client.connect(MCP_URL));
    expect(error).toBeInstanceOf(AgentError);
    expect(error.info.code).toBe("NETWORK_ERROR");
    // Handshake failed → marked disconnected, not a dead-connected session.
    expect(client.isConnected()).toBe(false);
  });

  it("a call with no caller signal is bounded by requestTimeoutMs", async () => {
    stubFetch();
    mockFetch.mockResolvedValueOnce(okResponse());
    mockFetch.mockImplementationOnce((_u: unknown, init: RequestInit) => abortableNever(init));
    const client = new McpClient({ requestTimeoutMs: 15 });
    await client.connect(MCP_URL);
    const error = await rejectError(client.callTool("echo", {}));
    expect(error.info.code).toBe("NETWORK_ERROR");
    expect(error.info.message).toContain("timed out");
    // Timeout marks the connection stale so the next use re-handshakes.
    expect(client.isConnected()).toBe(false);
  });

  it("a caller signal is still forwarded unchanged and surfaces as USER_CANCELLED", async () => {
    stubFetch();
    mockFetch.mockResolvedValueOnce(okResponse());
    mockFetch.mockImplementationOnce((_u: unknown, init: RequestInit) => {
      return Promise.reject(abortError());
    });
    const client = new McpClient({ requestTimeoutMs: 30_000 });
    await client.connect(MCP_URL);
    const controller = new AbortController();
    const promise = client.callTool("echo", {}, controller.signal);
    controller.abort();
    const error = await rejectError(promise);
    expect(error.info.code).toBe("USER_CANCELLED");
    expect(mockFetch.mock.calls[1]![1]!.signal).toBe(controller.signal);
  });

  it("connect failure marks disconnected; ensureConnected re-runs the handshake", async () => {
    stubFetch();
    mockFetch.mockRejectedValueOnce(new Error("net down"));
    const client = new McpClient();
    await expect(client.connect(MCP_URL)).rejects.toThrow(AgentError);
    expect(client.isConnected()).toBe(false);
    // Server is back: a reconnect re-initializes and marks connected.
    mockFetch.mockResolvedValueOnce(okResponse());
    await client.reconnect();
    expect(client.isConnected()).toBe(true);
  });

  it("hasConnectedAtLeastOnce tracks connectivity history across cycles", async () => {
    stubFetch();
    mockFetch.mockRejectedValueOnce(new Error("down"));
    const client = new McpClient();
    await expect(client.connect(MCP_URL)).rejects.toThrow(AgentError);
    expect(client.hasConnectedAtLeastOnce()).toBe(false);
    mockFetch.mockResolvedValueOnce(okResponse());
    await client.reconnect();
    expect(client.hasConnectedAtLeastOnce()).toBe(true);
    expect(client.isConnected()).toBe(true);
  });

  it("ensureConnected is a no-op when already connected", async () => {
    stubFetch();
    mockFetch.mockResolvedValueOnce(okResponse());
    const client = new McpClient();
    await client.connect(MCP_URL);
    mockFetch.mockClear();
    await client.ensureConnected();
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("P2-40: ensureReconnected is a no-op when already connected", async () => {
    stubFetch();
    mockFetch.mockResolvedValueOnce(okResponse());
    const client = new McpClient();
    await client.connect(MCP_URL);
    mockFetch.mockClear();
    await expect(client.ensureReconnected()).resolves.toBe(false);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("P2-40: ensureReconnected re-handshakes a disconnected client and reports true", async () => {
    stubFetch();
    mockFetch.mockRejectedValueOnce(new Error("net down"));
    const client = new McpClient();
    await expect(client.connect(MCP_URL)).rejects.toThrow(AgentError);
    mockFetch.mockResolvedValueOnce(okResponse());
    await expect(client.ensureReconnected({ maxAttempts: 2, backoffMs: 0 })).resolves.toBe(true);
    expect(client.isConnected()).toBe(true);
  });

  it("P2-40: ensureReconnected fails after its attempt budget is exhausted", async () => {
    stubFetch();
    mockFetch.mockRejectedValueOnce(new Error("down"));
    const client = new McpClient();
    await expect(client.connect(MCP_URL)).rejects.toThrow(AgentError);
    mockFetch.mockRejectedValue(new Error("still down"));
    mockFetch.mockClear();
    const error = await rejectError(client.ensureReconnected({ maxAttempts: 2, backoffMs: 0 }));
    expect(mockFetch).toHaveBeenCalledTimes(2); // the bounded budget, not infinite
    expect(error.info.code).toBe("NETWORK_ERROR");
    expect(client.isConnected()).toBe(false);
  });

  it("a degenerate response body (partial response) is a structured failure", async () => {
    stubFetch();
    mockFetch
      .mockResolvedValueOnce(okResponse())
      .mockResolvedValueOnce({ ok: true, status: 200, json: () => Promise.reject(new Error("bad JSON")) } as unknown as Response);
    const client = new McpClient();
    await client.connect(MCP_URL);
    const error = await rejectError(client.callTool("echo", {}));
    expect(error.info.code).toBe("NETWORK_ERROR");
    expect(error.info.message).toContain("invalid JSON");
  });
});