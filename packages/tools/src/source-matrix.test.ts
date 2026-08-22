import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import type { PermissionPolicy, SandboxPolicy, ToolDefinition, ToolResult } from "@ar/contracts";
import { newAgentId, newSessionId, newToolCallId, newTurnId } from "@ar/contracts";
import { ToolRegistry, capabilityOf, semanticsOf } from "./registry.js";
import { toToolCapability } from "@ar/contracts";
import { ToolOrchestrator } from "./orchestrator.js";

// ---- P0-2: unified tool-source matrix --------------------------------------
// Every tool source (builtin / dynamic / mcp / plugin / subagent-restricted)
// must traverse the SAME decision chain: registry lookup → tool policy
// (session/runtime) → permission → approval → sandbox → bounded execution.
// Nothing may bypass permission or sandbox based on where the tool came from.
// Subagent-restricted sessions are gated upstream by the runtime tool-policy
// gate (covered in packages/core effective-config + packages/agents delegator
// tests); this matrix covers the orchestrator chain for the other sources.

let ws = "";

beforeAll(() => {
  ws = mkdtempSync(join(tmpdir(), "ar-source-matrix-"));
});

afterAll(() => rmSync(ws, { recursive: true, force: true }));

function policy(rules: NonNullable<PermissionPolicy["rules"]>, defaultEffect?: "allow" | "ask" | "deny"): PermissionPolicy {
  return { rules, ...(defaultEffect !== undefined ? { defaultEffect } : {}) };
}

const sandbox: SandboxPolicy = {
  filesystem: { mode: "workspace-write", allowedPaths: [ws] },
  network: { mode: "deny" },
  process: { timeoutMs: 500, maxOutputBytes: 1024, allowedCommands: ["safe-cmd"] },
};

const AID = newAgentId();
const SID = newSessionId();
const TID = newTurnId();

function ctx(over: Partial<Parameters<ToolOrchestrator["execute"]>[1]> = {}): Parameters<ToolOrchestrator["execute"]>[1] {
  return {
    sessionId: SID,
    turnId: TID,
    agentId: AID,
    cwd: ws,
    signal: new AbortController().signal,
    permissions: policy([{ action: "*", resource: "*", effect: "allow" }]),
    sandboxPolicy: sandbox,
    ...over,
  };
}

function req(name: string, args: Record<string, unknown>) {
  return { id: newToolCallId(), sessionId: SID, turnId: TID, agentId: AID, call: { id: newToolCallId(), name, args } };
}

// Tool stubs per source flavor. All are plain ToolDefinitions — the source is
// defined by how they are registered and what their metadata declares.
const builtinFs: ToolDefinition = {
  name: "src_fs_read",
  description: "builtin read tool",
  inputSchema: z.object({ path: z.string() }),
  risk: "readonly",
  metadata: { name: "src_fs_read", version: "1.0.0", sideEffect: false, network: false, filesystem: true, process: false, interactive: false },
  execute: async () => ({ status: "success", output: "builtin-ok" }),
};

const dynamicTool: ToolDefinition = {
  name: "src_dynamic",
  description: "runtime-registered tool",
  inputSchema: z.object({ value: z.string().optional() }),
  risk: "critical",
  metadata: { name: "src_dynamic", version: "1.0.0", sideEffect: true, network: false, filesystem: false, process: false, interactive: false },
  execute: async () => ({ status: "success", output: "dynamic-ok" }),
};

const dynamicFs: ToolDefinition = {
  name: "src_dynamic_fs",
  description: "runtime-registered filesystem tool",
  inputSchema: z.object({ path: z.string() }),
  risk: "readonly",
  metadata: { name: "src_dynamic_fs", version: "1.0.0", sideEffect: false, network: false, filesystem: true, process: false, interactive: false },
  execute: async () => ({ status: "success", output: "dynamic-fs-ok" }),
};

// MCP-style: metadata declares NO surfaces, NO retry/concurrencySafe, and the
// tool arrives from an external server — it must still traverse permission and
// get conservative capability defaults, never special privileges.
const mcpTool: ToolDefinition = {
  name: "src_mcp_thing",
  description: "remote tool",
  inputSchema: z.object({ anything: z.unknown().optional() }),
  risk: "side_effect",
  metadata: { name: "src_mcp_thing", version: "0.0.0", sideEffect: true, network: false, filesystem: false, process: false, interactive: false },
  execute: async () => ({ status: "success", output: "mcp-ok" }),
};

const mcpNetworkTool: ToolDefinition = {
  name: "src_mcp_fetch",
  description: "remote network tool",
  inputSchema: z.object({ url: z.string() }),
  risk: "side_effect",
  metadata: { name: "src_mcp_fetch", version: "0.0.0", sideEffect: true, network: true, filesystem: false, process: false, interactive: false },
  execute: async () => ({ status: "success", output: "mcp-net-ok" }),
};

const pluginExec: ToolDefinition = {
  name: "src_plugin_run",
  description: "plugin shell-out tool",
  inputSchema: z.object({ command: z.string() }),
  risk: "elevated",
  metadata: { name: "src_plugin_run", version: "1.0.0", sideEffect: true, network: false, filesystem: false, process: true, interactive: false },
  execute: async () => ({ status: "success", output: "plugin-ok" }),
};
class Sink {
  events: Array<{ type: string; tool?: string; payload: Record<string, unknown> }> = [];

  async emit(_sessionId: string, type: string, payload: Record<string, unknown>): Promise<void> {
    this.events.push({ type, tool: typeof payload.tool === "string" ? payload.tool : undefined, payload });
  }
}

describe("P0-2 tool source matrix", () => {
  const sources = [
    { label: "builtin", tool: builtinFs },
    { label: "dynamic", tool: dynamicTool },
    { label: "mcp", tool: mcpTool },
    { label: "plugin", tool: pluginExec },
  ];

  for (const src of sources) {
    describe(`source: ${src.label}`, () => {
      function makeOrchestrator(dynamic = false) {
        const registry = new ToolRegistry();
        if (dynamic) registry.register(src.tool);
        return {
          registry,
          orchestrator: new ToolOrchestrator({ registry, events: new Sink(), workspaceRoot: ws }),
        };
      }

      it("permission allow -> executes through the chain", async () => {
        const { orchestrator } = makeOrchestrator(true);
        const args = src.tool.metadata.process
          ? { command: "safe-cmd" }
          : src.tool.metadata.filesystem
            ? { path: join(ws, "ok.txt") }
            : {};
        const result = await orchestrator.execute(req(src.tool.name, args), ctx());
        expect(result.status).toBe("success");
      });

      it("permission deny -> PERMISSION_DENIED and the executor never runs", async () => {
        const { orchestrator } = makeOrchestrator(true);
        let ran = false;
        const guard = { ...src.tool, execute: async (): Promise<ToolResult> => ((ran = true), { status: "success", output: "x" }) };
        const registry = new ToolRegistry();
        registry.register(guard);
        const orch = new ToolOrchestrator({ registry, events: new Sink(), workspaceRoot: ws });
        const result = await orch.execute(
          req(src.tool.name, src.tool.metadata.process ? { command: "safe-cmd" } : src.tool.metadata.filesystem ? { path: join(ws, "ok.txt") } : {}),
          ctx({ permissions: policy([{ action: "*", resource: "*", effect: "deny" }]) }),
        );
        expect(result.status).toBe("denied");
        expect(result.error?.code).toBe("PERMISSION_DENIED");
        expect(ran).toBe(false);
      });

      it("unknown tool (not registered) fails closed regardless of source", async () => {
        const { orchestrator } = makeOrchestrator();
        const result = await orchestrator.execute(req(src.tool.name, {}), ctx());
        expect(result.status).toBe("failed");
        expect(result.error?.code).toBe("TOOL_SCHEMA_ERROR");
        expect(result.error?.message).toContain("unknown tool");
      });

      // Sandbox cells only apply to sources that DECLARE a surface
      // (sandbox binds to metadata); surface-less generic behavior is covered
      // by the dedicated tests below.
      if (src.tool.metadata.process || src.tool.metadata.filesystem || src.tool.metadata.network) {
        it("sandbox deny -> per-dimension SANDBOX_*_DENIED even when permission allows", async () => {
          const { orchestrator } = makeOrchestrator(true);
          const args = src.tool.metadata.process
            ? { command: "rm -rf /" }
            : src.tool.metadata.filesystem
              ? { path: join(ws, "..", "outside.txt") }
              : { url: "https://evil.example.com" };
          const result = await orchestrator.execute(req(src.tool.name, args), ctx());
          expect(result.status).toBe("denied");
          const expected = src.tool.metadata.process
            ? "SANDBOX_PROCESS_DENIED"
            : src.tool.metadata.filesystem
              ? "SANDBOX_FILESYSTEM_DENIED"
              : "SANDBOX_NETWORK_DENIED";
          expect(result.error?.code).toBe(expected);
        });
      }
    });
  }

  it("sandbox binds to DECLARED surfaces: a dynamic filesystem tool outside the workspace is denied", async () => {
    const registry = new ToolRegistry();
    registry.register(dynamicFs);
    const orchestrator = new ToolOrchestrator({ registry, events: new Sink(), workspaceRoot: ws });
    const result = await orchestrator.execute(req(dynamicFs.name, { path: join(ws, "..", "outside.txt") }), ctx());
    expect(result.status).toBe("denied");
    expect(result.error?.code).toBe("SANDBOX_FILESYSTEM_DENIED");
  });

  it("generic tools (no declared surface) traverse permission; sandbox only binds declared surfaces", async () => {
    const registry = new ToolRegistry();
    registry.register(mcpTool);
    const orchestrator = new ToolOrchestrator({ registry, events: new Sink(), workspaceRoot: ws });
    // No declared surface -> no sandbox restriction (documented behavior);
    // permission still gates it: deny via wildcard rule must block.
    const denied = await orchestrator.execute(req(mcpTool.name, {}), ctx({ permissions: policy([{ action: "*", resource: "*", effect: "deny" }]) }));
    expect(denied.status).toBe("denied");
    const allowed = await orchestrator.execute(req(mcpTool.name, {}), ctx());
    expect(allowed.status).toBe("success");
  });

  it("dynamic tools registered after orchestrator construction hit the same chain", async () => {
    const registry = new ToolRegistry();
    const orchestrator = new ToolOrchestrator({ registry, events: new Sink(), workspaceRoot: ws });
    registry.register(dynamicTool); // registered later, at "runtime"
    const denied = await orchestrator.execute(req(dynamicTool.name, {}), ctx({ permissions: policy([{ action: "*", resource: "*", effect: "deny" }]) }));
    expect(denied.status).toBe("denied");
    const allowed = await orchestrator.execute(req(dynamicTool.name, {}), ctx());
    expect(allowed.status).toBe("success");
  });

  it("MCP network tool is denied by the sandbox network gate (no special privilege)", async () => {
    const registry = new ToolRegistry();
    registry.register(mcpNetworkTool);
    const sink = new Sink();
    const orchestrator = new ToolOrchestrator({ registry, events: sink, workspaceRoot: ws });
    const result = await orchestrator.execute(req(mcpNetworkTool.name, { url: "https://evil.example.com" }), ctx());
    expect(result.status).toBe("denied");
    expect(result.error?.code).toBe("SANDBOX_NETWORK_DENIED");
    const sec = sink.events.find((e) => e.type === "security.network_denied" && e.tool === mcpNetworkTool.name);
    expect(sec).toBeDefined();
    expect(sec?.payload.source).toBe("sandbox-network");
    expect(sec?.payload.code).toBe("SANDBOX_NETWORK_DENIED");
  });

  it("MCP-style tools get conservative capability defaults (retry unknown, serial)", () => {
    expect(capabilityOf(mcpTool)).toEqual({ retry: "unknown", concurrencySafe: false });
    expect(capabilityOf(undefined)).toEqual({ retry: "unknown", concurrencySafe: false });
  });

  it("P18-1: capabilityOf is ALWAYS the projection of semanticsOf (single derivation chain)", () => {
    // The legacy capability view can never drift from ToolSemantics: both the
    // registered tool and the unknown fallback must satisfy the identity
    // capabilityOf(x) === toToolCapability(semanticsOf(x)).
    expect(capabilityOf(mcpTool)).toEqual(toToolCapability(semanticsOf(mcpTool)));
    expect(capabilityOf(undefined)).toEqual(toToolCapability(semanticsOf(undefined)));
    // And the projection maps the exact semantics fields.
    const declared = { ...semanticsOf(mcpTool), retrySafety: "safe" as const, concurrencySafety: true };
    expect(toToolCapability(declared)).toEqual({ retry: "safe", concurrencySafe: true });
  });

  it("permission evaluation never auto-falls back to allow on failure", async () => {
    const registry = new ToolRegistry();
    registry.register(mcpTool);
    const orchestrator = new ToolOrchestrator({ registry, events: new Sink(), workspaceRoot: ws });
    // defaultEffect "allow" but an explicit (pattern-less) deny rule must win.
    const result = await orchestrator.execute(
      req(mcpTool.name, {}),
      ctx({ permissions: policy([{ action: "*", resource: "*", effect: "deny" }], "allow") }),
    );
    expect(result.status).toBe("denied");
    expect(result.error?.code).toBe("PERMISSION_DENIED");
  });

describe("P18-5 progress channel", () => {
  it("progress chunks emit tool.progress — separate from the terminal result", async () => {
    const streamingTool: ToolDefinition = {
      name: "stream_progress",
      description: "streams output and progress",
      inputSchema: z.object({}),
      risk: "readonly",
      metadata: { name: "stream_progress", version: "1.0.0", sideEffect: false, network: false, filesystem: false, process: false, interactive: false },
      async execute(_input, ctx) {
        ctx.onOutput?.({ stream: "stdout", text: "partial line" });
        ctx.onOutput?.({ stream: "progress", text: "50%" });
        ctx.onOutput?.({ stream: "progress", text: "100%" });
        return { status: "success", output: "done" };
      },
    };
    const registry = new ToolRegistry();
    registry.register(streamingTool);
    const sink = new Sink();
    const orchestrator = new ToolOrchestrator({ registry, events: sink, workspaceRoot: ws });
    const result = await orchestrator.execute(req("stream_progress", {}), ctx());
    expect(result.status).toBe("success");
    const types = sink.events.map((e) => e.type);
    expect(types).toContain("tool.output");
    expect(types).toContain("tool.progress");
    // P18-5: progress NEVER settles the call — exactly one terminal completion.
    const completions = sink.events.filter((e) => e.type === "tool.completed");
    expect(completions).toHaveLength(1);
    expect(completions[0]?.payload.status).toBe("success");
    const progressEvents = sink.events.filter((e) => e.type === "tool.progress");
    expect(progressEvents.map((e) => e.payload.text)).toEqual(["50%", "100%"]);
  });
});
});
