import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "@ar/harness";
import type { AgentEvent } from "@ar/contracts";
import { createRuntimeRpc, Gateway } from "@ar/gateway";
import { ScriptedModelProvider } from "@ar/model";
import { WebChannelAdapter } from "./adapter.js";
import { SessionBindings, TrackingRegistry } from "./bindings.js";
import { WebServer } from "./server.js";

let tempDirs: string[] = [];
async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "ar-web-harness-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.map((d) => rm(d, { recursive: true, force: true })));
  tempDirs = [];
});

const provider = new ScriptedModelProvider([
  ScriptedModelProvider.text("hello from the harness runtime"),
  ScriptedModelProvider.text("hello from the harness runtime"),
  ScriptedModelProvider.text("hello from the harness runtime"),
  ScriptedModelProvider.text("hello from the harness runtime"),
]);

interface TestWebStack {
  harness: Harness;
  server: WebServer;
  gateway: Gateway;
  base: string;
  bindings: SessionBindings;
}

async function makeStack(dataDir?: string): Promise<TestWebStack> {
  const harness = await createHarness({
    cwd: process.cwd(),
    ...(dataDir !== undefined ? { dataDir } : {}),
    profile: "interactive",
    modelProvider: provider,
    model: { providerId: provider.id, modelId: "scripted-model" },
  });
  const bindings = new SessionBindings();
  const registry = createRuntimeRpc(harness.runtime, {
    sessionService: harness.sessionService,
    sessions: harness.sessions,
    approvalStore: harness.approvalStore,
    events: harness.events,
  });
  const gatewayRpc = new TrackingRegistry(registry, (session) => bindings.onSessionCreated(session));
  const adapter = new WebChannelAdapter();
  const gateway = new Gateway({
    rpc: gatewayRpc,
    channels: [adapter],
    sessionService: harness.sessionService,
    approvalStore: harness.approvalStore,
    events: harness.events,
    sessionDefaults: { agentId: harness.agents[0]!.id, cwd: process.cwd() },
    pollDelayMs: 5,
  });
  await gateway.start();
  const server = new WebServer({
    adapter,
    bindings,
    events: harness.events,
    store: harness.store,
    approvalStore: harness.approvalStore,
    host: "127.0.0.1",
    port: 0,
    pollDelayMs: 10,
  });
  const { port } = await server.start();
  return { harness, server, gateway, base: `http://127.0.0.1:${port}`, bindings };
}

async function teardown(stack: TestWebStack): Promise<void> {
  await stack.server.stop();
  await stack.gateway.stop();
  await stack.harness.close();
}

const USER = "web-harness-user";

describe("P0-3: web host on the production harness composition root", () => {
  it("wires the interactive profile with the full tool set and durable stores when a dataDir is set", async () => {
    const dataDir = await tempDir();
    const stack = await makeStack(dataDir);
    try {
      const info = stack.harness.introspect();
      expect(info.features.context).toBe(true); // ContextPipeline wired
      expect(info.features.artifacts).toBe(true);
      expect(info.features.skills).toBe(true);
      expect(info.features.checkpoint).toBe(true); // Checkpoint = true when dataDir
      expect(info.features.memory).toBe(false); // not enabled by default
      expect(info.features.delegation).toBe(false); // not enabled by default
      expect(info.registeredTools).toHaveLength(12);
      for (const tool of ["grep_search", "repo_tree", "symbol_search", "repo_map", "discover_commands", "env_snapshot"]) {
        expect(info.registeredTools).toContain(tool);
      }
      expect(info.stores.session).toBe("JSONLSessionStore");
      expect(info.stores.events).toBe("JSONLEventStore");
      expect(info.stores.checkpoint).toBe("DurableCheckpointStore");
      expect(info.stores.approval).toBe("DurableApprovalStore");
      expect(info.stores.artifacts).toBe("InMemoryArtifactStore");
    } finally {
      await teardown(stack);
    }
  });

  it("uses in-memory stores without a dataDir (checkpoint absent)", async () => {
    const stack = await makeStack();
    try {
      const info = stack.harness.introspect();
      expect(info.features.checkpoint).toBe(false);
      expect(info.stores.session).toBe("MemSessionStore");
      expect(info.stores.events).toBe("MemEventStore");
      expect(info.stores.approval).toBe("InMemoryApprovalStore");
    } finally {
      await teardown(stack);
    }
  });

  it("serves a full turn end-to-end through the harness runtime", async () => {
    const stack = await makeStack();
    try {
      const res = await fetch(`${stack.base}/api/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ from: USER, text: "hello agent" }),
      });
      expect(res.status).toBe(200);

      const sessions = await stack.harness.store.listSessions();
      expect(sessions).toHaveLength(1);
      const sessionId = sessions[0]!.id;

      const deadline = Date.now() + 8000;
      while (Date.now() < deadline) {
        const events = await stack.harness.events.list(sessionId);
        if (events.some((e) => e.type === "turn.completed")) break;
        await new Promise((r) => setTimeout(r, 25));
      }
      const events = await stack.harness.events.list(sessionId);
      expect(events.map((e) => e.type)).toEqual(
        expect.arrayContaining(["session.created", "turn.started", "model.started", "model.completed", "turn.completed"]),
      );
      const messages = await stack.harness.store.listMessages(sessionId);
      const assistant = messages.find((m) => m.role === "assistant");
      expect(assistant).toBeDefined();
      expect(JSON.stringify(assistant)).toContain("hello from the harness runtime");
    } finally {
      await teardown(stack);
    }
  });

  it("creates a session and routes it through bindings for a new sender", async () => {
    const stack = await makeStack();
    try {
      const res = await fetch(`${stack.base}/api/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ from: USER, text: "hi" }),
      });
      expect(res.status).toBe(200);
      const sessions = await stack.harness.store.listSessions();
      expect(sessions).toHaveLength(1);
      expect(stack.bindings.get(USER)).toBe(sessions[0]!.id);
    } finally {
      await teardown(stack);
    }
  });
});