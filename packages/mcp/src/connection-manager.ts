import type { McpRuntimePolicy, McpServerDescriptor, ToolDefinition } from "@ar/contracts";
import { connectMcpServer, type McpServerConnection } from "./mcp-transport.js";

/**
 * P24-2 — McpConnectionManager.
 *
 * Owns the MCP connection lifecycle:
 *   - getOrConnect: lazy, ONE shared connect promise per server (two
 *     concurrent steps needing the same disconnected server share the
 *     transport connect — never two stdio children);
 *   - connection generation: every (re)connect produces a NEW generation id;
 *     a refresh never mutates an active generation's tools in place;
 *   - idle close / close all: bounded lifecycle, no orphan stdio processes.
 */

export interface McpConnectionGeneration {
  readonly id: string;
  readonly serverId: string;
  readonly connection: McpServerConnection;
  readonly tools: readonly ToolDefinition[];
  readonly connectedAt: number;
  /** Tools are NEVER mutated after a generation is published (P24-6). */
  readonly frozen: true;
}

export type McpConnectionState =
  | { kind: "disconnected" }
  | { kind: "connecting"; promise: Promise<McpConnectionGeneration> }
  | { kind: "ready"; generation: McpConnectionGeneration }
  | { kind: "failed"; error: unknown; retryAfterMs?: number };

export interface McpConnectionManagerOptions {
  catalog: { get(id: string): McpServerDescriptor | undefined };
  /** Transport factory — injectable for tests. Defaults to the real client. */
  connect?: (descriptor: McpServerDescriptor) => Promise<McpServerConnection>;
  now?: () => number;
  timer?: { setTimeout(fn: () => void, ms: number): unknown; clearTimeout(t: unknown): void };
  /** Emit observability (e.g. retry.mcpReconnect / mcp.connect_failed). */
  onEvent?: (event: { type: string; serverId: string; error?: unknown }) => void;
}

let generationCounter = 0;

export class McpConnectionManager {
  private readonly states = new Map<string, McpConnectionState>();
  private readonly options: Required<Pick<McpConnectionManagerOptions, "now" | "timer">> & McpConnectionManagerOptions;
  private idleTimers = new Map<string, unknown>();
  private lastUsedAt = new Map<string, number>();

  constructor(opts: McpConnectionManagerOptions) {
    this.options = {
      ...opts,
      now: opts.now ?? Date.now,
      timer: opts.timer ?? { setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: (t) => clearTimeout(t as ReturnType<typeof setTimeout>) },
    };
  }

  getState(serverId: string): McpConnectionState {
    return this.states.get(serverId) ?? { kind: "disconnected" };
  }

  getGeneration(serverId: string): McpConnectionGeneration | undefined {
    const state = this.states.get(serverId);
    return state?.kind === "ready" ? state.generation : undefined;
  }

  /** Lazy connect with a SHARED promise. Exactly one transport connect per
   *  disconnected server, regardless of concurrent demanders. */
  async getOrConnect(serverId: string): Promise<McpConnectionGeneration> {
    const existing = this.states.get(serverId);
    if (existing?.kind === "ready") {
      this.lastUsedAt.set(serverId, this.options.now());
      this.scheduleIdle(serverId);
      return existing.generation;
    }
    if (existing?.kind === "connecting") {
      return existing.promise;
    }
    const descriptor = this.options.catalog.get(serverId);
    if (descriptor === undefined) {
      throw new Error(`MCP_CONNECT_FAILED: unknown server "${serverId}"`);
    }
    const promise = this.connect(descriptor);
    this.states.set(serverId, { kind: "connecting", promise });
    try {
      const generation = await promise;
      this.states.set(serverId, { kind: "ready", generation });
      this.lastUsedAt.set(serverId, this.options.now());
      this.scheduleIdle(serverId);
      return generation;
    } catch (err) {
      this.states.set(serverId, { kind: "failed", error: err });
      this.options.onEvent?.({ type: "mcp.connect_failed", serverId, error: err });
      throw err;
    }
  }

  /** Force a NEW generation (refresh). Never mutates the active one. */
  async refresh(serverId: string): Promise<McpConnectionGeneration> {
    const descriptor = this.options.catalog.get(serverId);
    if (descriptor === undefined) throw new Error(`MCP_CONNECT_FAILED: unknown server "${serverId}"`);
    const generation = await this.connect(descriptor);
    this.states.set(serverId, { kind: "ready", generation });
    this.lastUsedAt.set(serverId, this.options.now());
    this.scheduleIdle(serverId);
    return generation;
  }

  /** P24-8: close connections idle longer than policy.idleTtlMs. */
  async idleClose(nowMs = this.options.now()): Promise<string[]> {
    const closed: string[] = [];
    for (const [serverId, state] of this.states) {
      if (state.kind !== "ready") continue;
      const descriptor = this.options.catalog.get(serverId);
      const ttl = descriptor?.policy?.idleTtlMs;
      if (ttl === undefined) continue;
      const lastUsed = this.lastUsedAt.get(serverId) ?? state.generation.connectedAt;
      if (nowMs - lastUsed >= ttl) {
        await state.generation.connection.close();
        this.states.set(serverId, { kind: "disconnected" });
        this.clearIdle(serverId);
        closed.push(serverId);
      }
    }
    return closed;
  }

  /** Close every connected generation — no orphan stdio processes. */
  async closeAll(): Promise<void> {
    const ready: McpConnectionGeneration[] = [];
    for (const state of this.states.values()) {
      if (state.kind === "ready") ready.push(state.generation);
    }
    this.states.clear();
    this.lastUsedAt.clear();
    for (const t of this.idleTimers.values()) this.options.timer.clearTimeout(t);
    this.idleTimers.clear();
    await Promise.all(ready.map((g) => g.connection.close()));
  }

  private async connect(descriptor: McpServerDescriptor): Promise<McpConnectionGeneration> {
    const connect = this.options.connect ?? ((d) => connectMcpServer(d.config, { trust: d.trust === "trusted" ? "trusted" : "untrusted", networkBoundary: d.networkBoundary }));
    const timeoutMs = descriptor.policy?.connectTimeoutMs;
    let connection: McpServerConnection;
    const run = async () => connect(descriptor);
    if (timeoutMs !== undefined) {
      connection = await withTimeout(run, timeoutMs, this.options.timer);
    } else {
      connection = await run();
    }
    generationCounter += 1;
    return {
      id: `g${generationCounter}`,
      serverId: descriptor.id,
      connection,
      tools: Object.freeze([...connection.tools]),
      connectedAt: this.options.now(),
      frozen: true,
    };
  }

  private scheduleIdle(serverId: string): void {
    const descriptor = this.options.catalog.get(serverId);
    const ttl = descriptor?.policy?.idleTtlMs;
    this.clearIdle(serverId);
    if (ttl === undefined) return;
    const handle = this.options.timer.setTimeout(() => {
      // P14-6: idle close failures are surfaced on the degraded channel —
      // never swallowed silently.
      void this.idleClose().catch((cause) => {
        process.stderr.write(
          `[degraded] mcp idle close failed: ${cause instanceof Error ? cause.message : String(cause)}\n`,
        );
      });
    }, ttl);
    this.idleTimers.set(serverId, handle);
  }

  private clearIdle(serverId: string): void {
    const handle = this.idleTimers.get(serverId);
    if (handle !== undefined) {
      this.options.timer.clearTimeout(handle);
      this.idleTimers.delete(serverId);
    }
  }
}

async function withTimeout<T>(
  run: () => Promise<T>,
  timeoutMs: number,
  timer: { setTimeout(fn: () => void, ms: number): unknown; clearTimeout(t: unknown): void },
): Promise<T> {
  let timerHandle: unknown;
  const timeout = new Promise<never>((_, reject) => {
    timerHandle = timer.setTimeout(() => reject(new Error(`MCP_CONNECT_FAILED: connect timeout after ${timeoutMs}ms`)), timeoutMs);
  });
  try {
    return await Promise.race([run(), timeout]);
  } finally {
    if (timerHandle !== undefined) timer.clearTimeout(timerHandle);
  }
}
