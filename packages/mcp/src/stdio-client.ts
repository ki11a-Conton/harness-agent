import { spawn, type ChildProcess } from "node:child_process";
import type { AgentErrorInfo, McpToolInfo } from "@ar/contracts";
import { AgentError, errorInfo } from "@ar/contracts";

const PROTOCOL_VERSION = "2025-03-26";
const CLIENT_NAME = "@ar/mcp";
const CLIENT_VERSION = "0.1.0";

/**
 * Real stdio MCP transport (the second of the two official MCP transports,
 * next to Streamable HTTP). Spawns the configured server process and speaks
 * line-delimited JSON-RPC 2.0 over its stdin/stdout:
 *
 *   - initialize   : handshake; the client is "connected" only after it passes
 *                    (same connection-state semantics as the HTTP McpClient).
 *   - tools/list   : advertised tool set.
 *   - tools/call   : invoke a tool; an optional AbortSignal aborts the pending
 *                    request (the response is discarded, USER_CANCELLED).
 *   - request cap  : a pending request without a caller signal is bounded by
 *                    `requestTimeoutMs`; a hung server surfaces as NETWORK_ERROR
 *                    and the connection is marked disconnected.
 *   - reconnect    : ensureReconnected() re-spawns the process and re-runs the
 *                    handshake (bounded by the mcpReconnect retry spec).
 *
 * The server is a trusted operator-configured child process, but its stdout is
 * still untrusted content: JSON-RPC responses are parsed defensively and every
 * error is structured (NETWORK_ERROR / USER_CANCELLED), never a raw throw.
 */

export interface StdioMcpClientOptions {
  connectTimeoutMs?: number;
  requestTimeoutMs?: number;
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: AgentError) => void;
  method: string;
  timer: ReturnType<typeof setTimeout>;
  signal?: AbortSignal;
  onAbort?: () => void;
}

export class StdioMcpClient {
  readonly serverId: string;

  private readonly command: string;
  private readonly args: string[];
  private readonly connectTimeoutMs: number;
  private readonly requestTimeoutMs: number;

  private child: ChildProcess | undefined;
  private nextId = 1;
  private pending = new Map<number, PendingRequest>();
  private lineBuffer = "";
  private connected = false;
  private hasConnected = false;
  private closed = false;

  constructor(serverId: string, command: string, args: string[] = [], opts: StdioMcpClientOptions = {}) {
    this.serverId = serverId;
    this.command = command;
    this.args = args;
    this.connectTimeoutMs = opts.connectTimeoutMs ?? 10_000;
    this.requestTimeoutMs = opts.requestTimeoutMs ?? 30_000;
  }

  isConnected(): boolean {
    return this.connected;
  }

  hasConnectedAtLeastOnce(): boolean {
    return this.hasConnected;
  }

  async initialize(): Promise<void> {
    if (this.closed) {
      throw new AgentError(errorInfo("INTERNAL_ERROR", "StdioMcpClient is closed"));
    }
    if (this.connected) return;
    this.spawnChild();
    await this.request("initialize", {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: CLIENT_NAME, version: CLIENT_VERSION },
    }, undefined, this.connectTimeoutMs);
    this.connected = true;
    this.hasConnected = true;
  }

  /** Force a fresh spawn + handshake (P2-20 reconnect semantics). */
  async reconnect(): Promise<void> {
    this.teardownChild();
    await this.initialize();
  }

  /** Re-initialize when disconnected (host-side reconnect policy). */
  async ensureConnected(): Promise<void> {
    if (!this.connected) await this.reconnect();
  }

  /**
   * P2-40 bounded auto-reconnect with the same contract as the HTTP client:
   * maxAttempts + backoffMs from the mcpReconnect retry-kind spec; budget
   * exhaustion surfaces the last NETWORK_ERROR family error.
   */
  async ensureReconnected(opts?: { maxAttempts?: number; backoffMs?: number }): Promise<boolean> {
    if (this.connected) return false;
    const spec = { maxAttempts: opts?.maxAttempts ?? 3, backoffMs: opts?.backoffMs ?? 0 };
    let lastErr: unknown;
    for (let attempt = 1; attempt <= spec.maxAttempts; attempt += 1) {
      try {
        await this.reconnect();
        return true;
      } catch (err) {
        lastErr = err;
        if (attempt < spec.maxAttempts && spec.backoffMs > 0) {
          await delay(spec.backoffMs);
        }
      }
    }
    if (lastErr instanceof AgentError) throw lastErr;
    throw new AgentError(
      errorInfo("NETWORK_ERROR", `MCP stdio reconnect budget exhausted (${spec.maxAttempts} attempts)`),
    );
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

  async callTool(name: string, args: unknown, signal?: AbortSignal): Promise<unknown> {
    return this.request("tools/call", { name, arguments: args }, signal, this.requestTimeoutMs);
  }

  async close(): Promise<void> {
    this.closed = true;
    this.teardownChild();
  }

  private spawnChild(): void {
    const child = spawn(this.command, this.args, {
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child = child;
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => this.onStdout(chunk));
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", () => {
      // stderr is informational; MCP traffic is line-delimited JSON on stdout.
    });
    child.on("error", (err) => {
      this.rejectAll(errorInfo("NETWORK_ERROR", `MCP stdio server failed to start: ${err.message}`));
    });
    child.on("exit", (code) => {
      this.connected = false;
      if (!this.closed) {
        this.rejectAll(
          errorInfo("NETWORK_ERROR", `MCP stdio server exited unexpectedly (code ${code ?? "signal"})`),
        );
      }
    });
  }

  private onStdout(chunk: string): void {
    this.lineBuffer += chunk;
    const lines = this.lineBuffer.split("\n");
    this.lineBuffer = lines.pop() ?? "";
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.length === 0) continue;
      let message: unknown;
      try {
        message = JSON.parse(trimmed);
      } catch {
        // Malformed server output is untrusted content — a structured failure
        // for the pending request (never a silent drop).
        this.rejectAll(errorInfo("NETWORK_ERROR", "MCP stdio server returned malformed JSON"));
        continue;
      }
      if (isRecord(message) && typeof message.id === "number") {
        const pending = this.pending.get(message.id);
        if (pending === undefined) continue;
        this.pending.delete(message.id);
        clearTimeout(pending.timer);
        if (pending.signal !== undefined) pending.signal.removeEventListener("abort", pending.onAbort!);
        if (message.error !== undefined) {
          const err = message.error as { code?: number; message?: string; data?: unknown };
          pending.reject(
            new AgentError(
              errorInfo("NETWORK_ERROR", `MCP ${pending.method} error: ${err?.message ?? "unknown"}`, {
                cause: { code: err?.code, message: err?.message, ...(err?.data !== undefined ? { data: err.data } : {}) },
              }),
            ),
          );
        } else {
          pending.resolve(message.result);
        }
      }
    }
  }

  private request(
    method: string,
    params: Record<string, unknown>,
    signal?: AbortSignal,
    timeoutMs?: number,
  ): Promise<unknown> {
    if (this.closed || this.child === undefined || !this.child.stdin?.writable) {
      return Promise.reject(
        new AgentError(errorInfo("INTERNAL_ERROR", "StdioMcpClient is not connected")),
      );
    }
    const id = this.nextId++;
    return new Promise<unknown>((resolve, reject) => {
      let onAbort: (() => void) | undefined;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        if (signal !== undefined) signal.removeEventListener("abort", onAbort!);
        this.connected = false;
        reject(new AgentError(errorInfo("NETWORK_ERROR", `MCP ${method} timed out after ${timeoutMs}ms`)));
      }, timeoutMs ?? 30_000);
      const pending: PendingRequest = {
        resolve,
        reject,
        method,
        timer,
        ...(signal !== undefined ? { signal, onAbort } : {}),
      };
      if (signal !== undefined) {
        onAbort = () => {
          this.pending.delete(id);
          clearTimeout(timer);
          this.connected = false;
          reject(new AgentError(errorInfo("USER_CANCELLED", `MCP ${method} aborted`)));
        };
        signal.addEventListener("abort", onAbort, { once: true });
        pending.onAbort = onAbort;
      }
      this.pending.set(id, pending);
      try {
        this.child!.stdin!.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
      } catch (cause) {
        this.pending.delete(id);
        clearTimeout(timer);
        this.connected = false;
        reject(
          new AgentError(errorInfo("NETWORK_ERROR", `MCP stdio write failed: ${method}`, { cause })),
        );
      }
    });
  }

  private rejectAll(info: AgentErrorInfo): void {
    for (const [, pending] of this.pending) {
      clearTimeout(pending.timer);
      if (pending.signal !== undefined) pending.signal.removeEventListener("abort", pending.onAbort!);
      pending.reject(new AgentError(info));
    }
    this.pending.clear();
  }

  private teardownChild(): void {
    this.connected = false;
    for (const [, pending] of this.pending) {
      clearTimeout(pending.timer);
      if (pending.signal !== undefined) pending.signal.removeEventListener("abort", pending.onAbort!);
      pending.reject(new AgentError(errorInfo("INTERNAL_ERROR", "MCP stdio client closed")));
    }
    this.pending.clear();
    const child = this.child;
    this.child = undefined;
    if (child !== undefined && child.exitCode === null) {
      child.kill("SIGTERM");
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
