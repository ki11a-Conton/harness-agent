import type { McpServerConfig, ToolDefinition } from "@ar/contracts";
import type { McpServerConnection } from "../mcp-transport.js";

/**
 * P34-4 — MCP chaos fixtures.
 *
 * Each chaos scenario is built from two primitives:
 *   - a `connect()` function injected into McpConnectionManager;
 *   - small combinators (`hang`, `once`) that give a scenario different
 *     behavior across connect attempts.
 * Nothing here spawns a real process or opens a real socket — chaos is
 * injected exactly at the transport boundary.
 */

/** Server config for a chaos server (never actually spawned). */
export function chaosServer(id: string, overrides: Partial<McpServerConfig> = {}): McpServerConfig {
  return {
    id,
    kind: "stdio",
    command: "node",
    commandArgs: [id],
    ...overrides,
  };
}

/** Tool definition used inside chaos connections. */
export function chaosTool(name: string): ToolDefinition {
  return {
    name,
    description: `chaos ${name}`,
    inputSchema: { safeParse: () => ({ success: true, data: {} }) } as never,
    risk: "readonly",
    metadata: {
      name,
      version: "1.0.0",
      sideEffect: false,
      network: false,
      filesystem: false,
      process: false,
      interactive: false,
    },
    execute: async () => ({ status: "success", output: "ok" }),
  };
}

/** Tool definition with a visible `schema` attribute, so a test can
 *  distinguish the schema generation is bound to from a later one. */
export function chaosToolWithSchema(name: string, marker: string): ToolDefinition & { schema: Record<string, unknown> } {
  return {
    ...chaosTool(name),
    schema: { marker },
  };
}

/** A forged connection. `closed` receives the serverId when closed. */
export function chaosConnection(
  serverName: string,
  toolNames: string[],
  closed: string[],
  onClose?: (serverId: string) => void,
): McpServerConnection {
  return {
    serverId: serverName,
    tools: toolNames.map((n) => chaosTool(n)),
    close: async () => {
      closed.push(serverName);
      onClose?.(serverName);
    },
  };
}

/** A connect fn that never resolves (a hung transport handshake). */
export function hang(): Promise<McpServerConnection> {
  return new Promise<McpServerConnection>(() => {});
}

/** A connect fn that rejects after `ms`. */
export function connectTimeout(ms: number, reason: string): () => Promise<McpServerConnection> {
  return async () => {
    await new Promise((r) => setTimeout(r, ms));
    throw new Error(reason);
  };
}

/**
 * Behave like `first` on the FIRST connect attempt, `rest` afterwards
 * (used to fail once then succeed, or to hang once then recover).
 */
export function firstThen<T>(
  first: () => Promise<T>,
  rest: () => Promise<T>,
): () => Promise<T> {
  let isFirst = true;
  return () => {
    if (isFirst) {
      isFirst = false;
      return first();
    }
    return rest();
  };
}