import { describe, expect, it } from "vitest";
import type { McpServerConfig, ToolDefinition } from "@ar/contracts";
import type { McpServerConnection } from "./mcp-transport.js";
import { McpServerCatalog } from "./catalog.js";
import { McpDependencyResolver, buildMcpBindingSnapshot } from "./mcp-binding.js";
import { McpConnectionManager } from "./connection-manager.js";

function serverConfig(id: string, kind: McpServerConfig["kind"] = "stdio"): McpServerConfig {
  return {
    id,
    kind,
    ...(kind === "stdio" ? { command: "node", commandArgs: [id] } : { url: `http://127.0.0.1/${id}` }),
  };
}

function toolDef(name: string): ToolDefinition {
  return {
    name,
    description: `mcp ${name}`,
    inputSchema: { safeParse: () => ({ success: true, data: {} }) } as never,
    risk: "readonly",
    metadata: { name, version: "1.0.0", sideEffect: false, network: false, filesystem: false, process: false, interactive: false },
    execute: async () => ({ status: "success", output: "ok" }),
  };
}

function fakeConnection(serverId: string, toolNames: string[]): McpServerConnection {
  return { serverId, tools: toolNames.map(toolDef), close: async () => {} };
}

describe("P24-1 McpServerCatalog (declaration only, never connects)", () => {
  it("constructing the catalog with 10 servers performs ZERO connects", () => {
    const configs = Array.from({ length: 10 }, (_, i) => serverConfig(`srv-${i}`));
    const catalog = McpServerCatalog.fromConfig(configs);
    expect(catalog.size).toBe(10);
    expect(catalog.eagerServers()).toHaveLength(0);
    // descriptor is pure data — no connection object exists anywhere
    expect(catalog.get("srv-0")!.config.id).toBe("srv-0");
  });

  it("eager/requiredByDefault are opt-in per server", () => {
    const catalog = McpServerCatalog.fromConfig([
      serverConfig("a"),
      { ...serverConfig("b"), eager: true },
      { ...serverConfig("c"), requiredByDefault: true },
    ]);
    expect(catalog.eagerServers().map((d) => d.id)).toEqual(["b"]);
    expect(catalog.requiredByDefault().map((d) => d.id)).toEqual(["c"]);
  });
});

describe("P24-2 McpConnectionManager", () => {
  it("100 concurrent getOrConnect(A) → exactly ONE transport connect", async () => {
    let connects = 0;
    const catalog = McpServerCatalog.fromConfig([serverConfig("A")]);
    const manager = new McpConnectionManager({
      catalog,
      connect: async (d) => {
        connects += 1;
        await new Promise((r) => setTimeout(r, 5));
        return fakeConnection(d.id, ["tool_a"]);
      },
    });
    const results = await Promise.all(Array.from({ length: 100 }, () => manager.getOrConnect("A")));
    expect(connects).toBe(1);
    const ids = new Set(results.map((g) => g.id));
    expect(ids.size).toBe(1); // the SAME shared generation
    expect(manager.getState("A").kind).toBe("ready");
    await manager.closeAll();
  });

  it("a failed connect is typed and cached as failed; retry reconnects", async () => {
    let attempts = 0;
    const catalog = McpServerCatalog.fromConfig([serverConfig("B")]);
    const manager = new McpConnectionManager({
      catalog,
      connect: async (d) => {
        attempts += 1;
        if (attempts === 1) throw new Error("MCP_CONNECT_FAILED: boom");
        return fakeConnection(d.id, ["tool_b"]);
      },
    });
    await expect(manager.getOrConnect("B")).rejects.toThrow(/MCP_CONNECT_FAILED/);
    expect(manager.getState("B").kind).toBe("failed");
    // a later need retries
    const gen = await manager.getOrConnect("B");
    expect(gen.tools).toHaveLength(1);
    await manager.closeAll();
  });

  it("refresh produces a NEW generation; the old generation's tools are never mutated", async () => {
    const catalog = McpServerCatalog.fromConfig([serverConfig("C")]);
    const manager = new McpConnectionManager({
      catalog,
      connect: async (d) => fakeConnection(d.id, ["v1_tool"]),
    });
    const g1 = await manager.getOrConnect("C");
    expect(g1.id).toMatch(/^g/);
    // swap the underlying tools and refresh
    const manager2 = new McpConnectionManager({
      catalog,
      connect: async (d) => fakeConnection(d.id, ["v2_tool"]),
    });
    const g2 = await manager2.refresh("C");
    expect(g2.id).not.toBe(g1.id);
    expect(g1.tools.map((t) => t.name)).toEqual(["v1_tool"]); // untouched
    expect(g2.tools.map((t) => t.name)).toEqual(["v2_tool"]);
    await manager.closeAll();
    await manager2.closeAll();
  });

  it("idleClose closes connections past idleTtlMs (injected timer)", async () => {
    let now = 1_000;
    let closed: string[] = [];
    const catalog = McpServerCatalog.fromConfig([{ ...serverConfig("D"), policy: { idleTtlMs: 500 } }]);
    const manager = new McpConnectionManager({
      catalog,
      now: () => now,
      connect: async (d) => fakeConnection(d.id, ["d"]),
    });
    await manager.getOrConnect("D"); // used at t=1000
    now = 1_600; // 600ms idle > 500ms ttl
    closed = await manager.idleClose(now);
    expect(closed).toEqual(["D"]);
    expect(manager.getState("D").kind).toBe("disconnected");
  });

  it("closeAll closes every connected generation (no orphans)", async () => {
    let closedCount = 0;
    const catalog = McpServerCatalog.fromConfig([serverConfig("X"), serverConfig("Y")]);
    const manager = new McpConnectionManager({
      catalog,
      connect: async (d) => ({
        ...fakeConnection(d.id, [d.id]),
        close: async () => {
          closedCount += 1;
        },
      }),
    });
    await manager.getOrConnect("X");
    await manager.getOrConnect("Y");
    await manager.closeAll();
    expect(closedCount).toBe(2);
    expect(manager.getState("X").kind).toBe("disconnected");
  });

  it("connect timeout honors policy.connectTimeoutMs (injected timer)", async () => {
    const catalog = McpServerCatalog.fromConfig([{ ...serverConfig("T"), policy: { connectTimeoutMs: 10 } }]);
    const manager = new McpConnectionManager({
      catalog,
      connect: async () => {
        await new Promise((r) => setTimeout(r, 50)); // slower than the timeout
        return fakeConnection("T", ["t"]);
      },
    });
    await expect(manager.getOrConnect("T")).rejects.toThrow(/connect timeout/);
  });
});
describe("P24-3 need-driven dependency resolver", () => {
  it("a config existing is NEVER a reason to connect (no mention → empty)", () => {
    const resolver = new McpDependencyResolver();
    const needed = resolver.resolve({ goal: "fix the parser" });
    expect(needed.size).toBe(0);
  });

  it("mcp:<serverId> mention resolves the server", () => {
    const resolver = new McpDependencyResolver();
    const needed = resolver.resolve({ goal: "use mcp:weather to fetch the forecast" });
    expect([...needed]).toEqual(["weather"]);
  });

  it("explicit tool name matching a known MCP tool resolves its server", () => {
    const resolver = new McpDependencyResolver({
      knownTools: { db: ["query_sql"], web: ["fetch_page"] },
    });
    const needed = resolver.resolve({ explicitToolNames: ["query_sql"] });
    expect([...needed]).toEqual(["db"]);
  });

  it("skill/plugin declared mcpServers and requiredByDefault resolve", () => {
    const resolver = new McpDependencyResolver({
      requiredByDefault: () => ["core"],
    });
    const needed = resolver.resolve({
      selectedSkills: [{ id: "data", mcpServers: ["warehouse"] }],
      selectedPlugins: [{ id: "p", mcpServers: ["metrics"] }],
    });
    expect([...needed].sort()).toEqual(["core", "metrics", "warehouse"]);
  });
});

describe("P24-4 immutable McpBindingSnapshot", () => {
  it("fingerprint covers generation + schema; refresh produces a NEW snapshot", () => {
    const s1 = buildMcpBindingSnapshot(
      [{ serverId: "A", generation: "g1", tools: [{ name: "t", schemaHash: "h1", definition: toolDef("t") }], trust: "untrusted" }],
      () => 1,
    );
    const s2 = buildMcpBindingSnapshot(
      [{ serverId: "A", generation: "g2", tools: [{ name: "t", schemaHash: "h2", definition: toolDef("t") }], trust: "untrusted" }],
      () => 2,
    );
    expect(s1.fingerprint).not.toBe(s2.fingerprint);
    expect(s1.generations.get("A")).toBe("g1");
    expect(s2.generations.get("A")).toBe("g2");
    // each binding carries serverId + generation + schemaHash + definition ref
    expect(s1.tools[0]!.serverId).toBe("A");
    expect(s1.tools[0]!.generation).toBe("g1");
    expect(s1.tools[0]!.schemaHash).toBe("h1");
    expect(s1.tools[0]!.definition).toBeDefined();
  });
});
