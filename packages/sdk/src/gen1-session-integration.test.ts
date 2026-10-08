import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { HarnessClient } from "./client.js";
import { MemoryHarnessTransport } from "./transport.js";
import { ProtocolEventMapper } from "@ar/protocol";

it("GEN1 SDK lists, resumes and forks actual persisted Harness/AppServer sessions", async () => {
  // Test-only dynamic composition keeps the SDK's production graph restricted
  // to @ar/protocol; the server below is the real composition, not a DTO fake.
  const harnessModule = new URL("../../harness/src/index.js", import.meta.url).href;
  const gatewayModule = new URL("../../gateway/src/index.js", import.meta.url).href;
  const modelModule = new URL("../../model/src/index.js", import.meta.url).href;
  const { createHarness, createCodingPromptPolicy } = await import(harnessModule);
  const { AppServer } = await import(gatewayModule);
  const { ScriptedModelProvider } = await import(modelModule);
  const cwd = await mkdtemp(join(tmpdir(), "ar-gen1-sdk-"));
  const makeProvider = () => new ScriptedModelProvider([
    ScriptedModelProvider.text("Original response"),
    ScriptedModelProvider.text("Branch response"),
    ScriptedModelProvider.text("Resumed response"),
  ]);
  const provider = makeProvider();
  const config = { cwd, dataDir: join(cwd, "data"), profile: "test", modelProvider: provider, model: { providerId: provider.id, modelId: "scripted-model" } };
  let harness = await createHarness(config);
  let transport: MemoryHarnessTransport | undefined;
  const connect = async () => {
    const server = new AppServer({ runtime: harness.runtime, sessions: harness.sessions, sessionService: harness.sessionService,
      approvalStore: harness.approvalStore, events: harness.events, listAgents: () => harness.agents });
    const mapper = new ProtocolEventMapper();
    transport = new MemoryHarnessTransport(async (method, params) => {
      const result = await server.invoke(method, params);
      if (method === "turn/run" && result.error === undefined) {
        const events = await harness.events.list(params.threadId);
        for (const event of events) {
          if (event.turnId !== params.turnId) continue;
          const mapped = mapper.mapSafe(event, String(params.threadId));
          if (mapped !== null) transport!.emit(mapped);
        }
      }
      return result;
    });
    return HarnessClient.connect(transport);
  };
  try {
    let client = await connect();
    const parent = await client.startThread({ agentName: harness.agents[0].name, cwd });
    expect((await parent.run("Original coding request")).finalResponse).toBe("Original response");
    const listed = await client.listThreads();
    expect(listed).toEqual([expect.objectContaining({ threadId: parent.threadId, createdAt: expect.any(Number), status: "active", itemCount: expect.any(Number), lastSequence: expect.any(Number) })]);
    const branch = await client.forkThread(parent.threadId, { idempotencyKey: "branch-request" });
    const retry = await client.forkThread(parent.threadId, { idempotencyKey: "branch-request" });
    expect(retry.threadId).toBe(branch.threadId);
    expect(branch.threadId).not.toBe(parent.threadId);
    expect((await branch.read()).filter(item => item.kind === "user_message")).toEqual([expect.objectContaining({ text: "Original coding request" })]);
    expect((await parent.run("Continue original")).status).toBe("completed");
    const parentMessages = await harness.store.listMessages(parent.threadId);
    const branchMessages = await harness.store.listMessages(branch.threadId);
    expect(branchMessages.map((message: { content: string }) => message.content)).toContain("Original coding request");
    expect(branchMessages.map((message: { content: string }) => message.content)).not.toContain("Continue original");
    expect(parentMessages.map((message: { content: string }) => message.content)).toContain("Continue original");
    await harness.sessions.unload(parent.threadId);
    expect((await client.listThreads()).some(thread => thread.threadId === parent.threadId)).toBe(false);
    expect((await client.listStoredThreads()).map(thread => thread.threadId)).toEqual(expect.arrayContaining([parent.threadId, branch.threadId]));
    await client.close(); await harness.close();
    harness = await createHarness({ ...config, modelProvider: makeProvider() });
    client = await connect();
    expect(await client.listThreads()).toEqual([]);
    const resumed = await client.resumeThread(parent.threadId);
    expect(resumed.threadId).toBe(parent.threadId);
    // A process restart reconstructs a fresh provider from identical config.
    expect((await resumed.run("Continue after restart")).finalResponse).toBe("Original response");
    expect((await client.listThreads()).map(thread => thread.threadId)).toEqual([parent.threadId]);
    expect((await client.listStoredThreads()).length).toBe(2);
    await expect(client.resumeThread("session_unknown")).rejects.toThrow(/unknown/);
    expect((await client.listStoredThreads()).length).toBe(2);
    await client.close();
    await harness.close();
    harness = await createHarness({ ...config, modelProvider: makeProvider(), agentPromptPolicy: createCodingPromptPolicy() });
    client = await connect();
    await expect(client.resumeThread(parent.threadId)).rejects.toMatchObject({ code: "CONFIG_DRIFT_REJECTED" });
    await expect(client.forkThread(parent.threadId)).rejects.toMatchObject({ code: "CONFIG_DRIFT_REJECTED" });
    expect((await client.listStoredThreads()).length).toBe(2);
    await client.close();
  } finally { await transport?.close(); await harness.close(); await rm(cwd, { recursive: true, force: true }); }
});

it("GEN1 real SDK receives actual partial text and preserves a failed stream without fake final output", async () => {
  const harnessModule = new URL("../../harness/src/index.js", import.meta.url).href;
  const gatewayModule = new URL("../../gateway/src/index.js", import.meta.url).href;
  const modelModule = new URL("../../model/src/index.js", import.meta.url).href;
  const contractsModule = new URL("../../contracts/src/index.js", import.meta.url).href;
  const { createHarness } = await import(harnessModule);
  const { AppServer } = await import(gatewayModule);
  const { ScriptedModelProvider } = await import(modelModule);
  const { errorInfo } = await import(contractsModule);
  const cwd = await mkdtemp(join(tmpdir(), "ar-gen1-sdk-error-"));
  const provider = new ScriptedModelProvider([[{ type: "started", timestamp: 0 }, { type: "text_delta", text: "Partial answer", timestamp: 1 },
    { type: "reasoning_delta", text: "PRIVATE_THINKING_MUST_NOT_LEAK", timestamp: 2 },
    { type: "error", error: errorInfo("PERMISSION_DENIED", "Actual provider stream failure"), timestamp: 3 }]]);
  const harness = await createHarness({ cwd, profile: "test", modelProvider: provider, model: { providerId: provider.id, modelId: "scripted-model" } });
  const server = new AppServer({ runtime: harness.runtime, sessions: harness.sessions, sessionService: harness.sessionService,
    approvalStore: harness.approvalStore, events: harness.events, listAgents: () => harness.agents });
  const mapper = new ProtocolEventMapper();
  let transport: MemoryHarnessTransport;
  transport = new MemoryHarnessTransport(async (method, params) => {
    const result = await server.invoke(method, params);
    if (method === "turn/run") for (const event of await harness.events.list(params.threadId)) {
      if (event.turnId !== params.turnId) continue;
      const mapped = mapper.mapSafe(event, String(params.threadId));
      if (mapped !== null) transport.emit(mapped);
    }
    return result;
  });
  try {
    const client = await HarnessClient.connect(transport);
    const thread = await client.startThread({ agentName: harness.agents[0].name, cwd });
    const stream = await thread.runStreamed("Complete this coding request");
    const visible = [];
    for await (const event of stream.events) visible.push(event);
    const result = await stream.done;
    expect(result.status).toBe("failed");
    expect(result.error).toMatchObject({ code: "PERMISSION_DENIED", message: "Actual provider stream failure", retryable: false });
    expect(result.finalResponse).toBeUndefined();
    expect(visible.some(event => event.type === "item/delta" && event.delta?.text === "Partial answer")).toBe(true);
    expect(JSON.stringify(visible)).not.toContain("PRIVATE_THINKING_MUST_NOT_LEAK");
    expect((await harness.events.list(thread.threadId)).some((event: { type: string }) => event.type === "model.completed")).toBe(false);
    await client.close();
  } finally { await transport!.close(); await harness.close(); await rm(cwd, { recursive: true, force: true }); }
});
