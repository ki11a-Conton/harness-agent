import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "@ar/harness";
import type { AgentEvent, ModelEvent, ModelProvider } from "@ar/contracts";
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
  rpc: ReturnType<typeof createRuntimeRpc>;
}

async function makeStack(dataDir?: string, modelProvider: ModelProvider = provider): Promise<TestWebStack> {
  const harness = await createHarness({
    cwd: process.cwd(),
    ...(dataDir !== undefined ? { dataDir } : {}),
    profile: "interactive",
    modelProvider,
    model: { providerId: modelProvider.id, modelId: "scripted-model" },
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
  return { harness, server, gateway, base: `http://127.0.0.1:${port}`, bindings, rpc: registry };
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

  it("U3 cancels a genuinely blocked production turn through HTTP and Gateway", { timeout: 10_000 }, async () => {
    let entered!: () => void;
    const blocked = new Promise<void>((resolve) => { entered = resolve; });
    let observedAbort = false;
    const blockingProvider: ModelProvider = {
      id: "web-cancellation-probe",
      listModels: async () => [],
      createClient: () => ({
        async *generate(_request, signal): AsyncGenerator<ModelEvent, void, void> {
          yield { type: "started", timestamp: Date.now() };
          entered();
          await new Promise<void>((resolve) => {
            if (signal.aborted) resolve();
            else signal.addEventListener("abort", () => resolve(), { once: true });
          });
          observedAbort = signal.aborted;
          yield { type: "completed", result: { finishReason: "stop", text: "" }, timestamp: Date.now() };
        },
      }),
    };
    const stack = await makeStack(undefined, blockingProvider);
    let turnId: string | undefined;
    let sessionId: string | undefined;
    try {
      const message = await fetch(`${stack.base}/api/messages`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ from: USER, text: "block until cancelled" }),
      });
      expect(message.status).toBe(200);
      const session = (await stack.harness.store.listSessions())[0]!;
      const turn = (await stack.harness.store.listTurns(session.id))[0]!;
      sessionId = session.id;
      turnId = turn.id;
      await blocked;
      expect(turn.status).toBe("running");
      const cancel = await fetch(`${stack.base}/api/commands`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ from: USER, text: "cancel" }),
      });
      expect(cancel.status).toBe(200);
      const deadline = Date.now() + 5_000;
      while (Date.now() < deadline) {
        if ((await stack.harness.store.getTurn(turn.id))?.status === "cancelled") break;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(observedAbort).toBe(true);
      expect((await stack.harness.store.getTurn(turn.id))?.status).toBe("cancelled");
      const events = await stack.harness.events.list(session.id);
      expect(events.filter((e) => e.type === "turn.cancelled")).toHaveLength(1);
      expect(events.filter((e) => e.type === "turn.completed")).toHaveLength(0);
      expect(events.find((e) => e.type === "human.cancel")?.payload).toMatchObject({ turnId: turn.id, text: "cancel" });
    } finally {
      // Release the controlled model even if an assertion before the HTTP
      // cancellation fails, so this regression cannot park the test process.
      if (sessionId !== undefined && turnId !== undefined) {
        await stack.rpc.invoke("session.cancel", { sessionId, turnId });
      }
      await teardown(stack);
    }
  });

  it("U4 stops the active queued follow-up through HTTP without cancelling another sender's session", { timeout: 10_000 }, async () => {
    let firstEntered!: () => void;
    let releaseFirst!: () => void;
    let followupEntered!: () => void;
    const firstStarted = new Promise<void>((resolve) => { firstEntered = resolve; });
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const followupStarted = new Promise<void>((resolve) => { followupEntered = resolve; });
    let observedFollowupAbort = false;
    const queuedProvider: ModelProvider = {
      id: "web-queued-followup-stop-probe",
      listModels: async () => [],
      createClient: () => ({
        async *generate(request, signal): AsyncGenerator<ModelEvent, void, void> {
          const text = request.messages.findLast((message) => message.role === "user")?.content;
          yield { type: "started", timestamp: Date.now() };
          if (text === "first gated turn") {
            firstEntered();
            await firstGate;
            yield { type: "text_delta", text: "first completed", timestamp: Date.now() };
            yield { type: "completed", result: { finishReason: "stop", text: "first completed" }, timestamp: Date.now() };
            return;
          }
          followupEntered();
          await new Promise<void>((resolve) => {
            if (signal.aborted) resolve();
            else signal.addEventListener("abort", () => resolve(), { once: true });
          });
          observedFollowupAbort = signal.aborted;
          yield { type: "completed", result: { finishReason: "stop", text: "" }, timestamp: Date.now() };
        },
      }),
    };
    const dataDir = await tempDir();
    const stack = await makeStack(dataDir, queuedProvider);
    let sessionId: string | undefined;
    let followupTurnId: string | undefined;
    const post = (path: string, from: string, text: string) => fetch(`${stack.base}${path}`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ from, text }),
    });
    try {
      expect((await post("/api/messages", USER, "first gated turn")).status).toBe(200);
      await firstStarted;
      const session = (await stack.harness.store.listSessions())[0]!;
      sessionId = session.id;
      const firstTurn = (await stack.harness.store.listTurns(session.id))[0]!;
      expect((await post("/api/messages", USER, "queued blocked follow-up")).status).toBe(200);
      releaseFirst();
      await followupStarted;
      const followupTurn = (await stack.harness.store.listTurns(session.id)).find((turn) => turn.id !== firstTurn.id)!;
      expect(followupTurn).toBeDefined();
      followupTurnId = followupTurn.id;
      expect((await stack.harness.store.getTurn(firstTurn.id))?.status).toBe("completed");
      expect(followupTurn.status).toBe("running");

      // A different browser identity cannot stop the owner's active follow-up.
      expect((await post("/api/commands", "web-foreign-sender", "cancel")).status).toBe(200);
      expect(observedFollowupAbort).toBe(false);
      expect(stack.bindings.get("web-foreign-sender")).toBeUndefined();
      expect((await stack.rpc.invoke("session.status", { sessionId })) as { activeTurn?: { turnId: string } }).toMatchObject({ activeTurn: { turnId: followupTurn.id } });

      expect((await post("/api/commands", USER, "cancel")).status).toBe(200);
      const deadline = Date.now() + 1_000;
      while (Date.now() < deadline) {
        if ((await stack.harness.store.getTurn(followupTurn.id))?.status === "cancelled") break;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(observedFollowupAbort).toBe(true);
      expect((await stack.harness.store.getTurn(followupTurn.id))?.status).toBe("cancelled");
      expect((await stack.harness.store.getTurn(firstTurn.id))?.status).toBe("completed");
      const events = await stack.harness.events.list(session.id);
      expect(events.filter((event) => event.type === "turn.cancelled").map((event) => event.turnId)).toEqual([followupTurn.id]);
      expect(events.filter((event) => event.type === "human.cancel").map((event) => event.payload.turnId)).toEqual([followupTurn.id]);
    } finally {
      releaseFirst();
      // Cleanup uses the real follow-up id even when the HTTP stop regression fails.
      if (sessionId !== undefined && followupTurnId !== undefined) {
        await stack.rpc.invoke("session.cancel", { sessionId, turnId: followupTurnId });
        // The actor acknowledges the durable inbox after its turn outcome.
        // Wait for that write before afterEach removes the temporary directory.
        const deadline = Date.now() + 1_000;
        while (Date.now() < deadline) {
          const records = (await readFile(join(dataDir, "inbox.jsonl"), "utf8")).trim().split("\n").map((line) => JSON.parse(line) as { prompt: { promotedTurnId?: string; status: string } });
          if (records.some(({ prompt }) => prompt.promotedTurnId === followupTurnId && prompt.status === "consumed")) break;
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
      }
      await teardown(stack);
    }
  });
});
