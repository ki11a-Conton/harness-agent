import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import type { AgentEvent } from "@ar/contracts";
import { ProtocolEventMapper } from "@ar/protocol";
import { HarnessClient } from "./client.js";
import { MemoryHarnessTransport } from "./transport.js";

it.each([false, true])("SDK run completes a real read_file coding turn with 4300 deltas (yield each event: %s)", async yieldEvents => {
  // Test-only composition leaves the production SDK dependent only on protocol.
  const harnessModule = new URL("../../harness/src/index.js", import.meta.url).href;
  const gatewayModule = new URL("../../gateway/src/index.js", import.meta.url).href;
  const modelModule = new URL("../../model/src/index.js", import.meta.url).href;
  const { createHarness } = await import(harnessModule);
  const { AppServer } = await import(gatewayModule);
  const { ScriptedModelProvider } = await import(modelModule);
  const cwd = await mkdtemp(join(tmpdir(), "ar-sdk-long-stream-"));
  const count = 4300;
  const text = "x".repeat(count);
  await writeFile(join(cwd, "source.ts"), "export const answer = 42;\n");
  const provider = new ScriptedModelProvider([
    ScriptedModelProvider.toolCall("read_file", { path: "source.ts" }),
    [{ type: "started", timestamp: 0 },
      ...Array.from({ length: count }, () => ({ type: "text_delta", text: "x", timestamp: 0 })),
      { type: "completed", result: { finishReason: "stop", text }, timestamp: 0 }],
  ]);
  const harness = await createHarness({ cwd, profile: "test", modelProvider: provider, model: { providerId: provider.id, modelId: "scripted-model" } });
  const server = new AppServer({ runtime: harness.runtime, sessions: harness.sessions, sessionService: harness.sessionService,
    approvalStore: harness.approvalStore, events: harness.events, listAgents: () => harness.agents });
  const mapper = new ProtocolEventMapper();
  let mappedEvents = 0;
  let transport: MemoryHarnessTransport;
  transport = new MemoryHarnessTransport(async (method, params) => {
    const result = await server.invoke(method, params);
    if (method === "turn/run") for (const event of await harness.events.list(params.threadId)) {
      if (event.turnId !== params.turnId) continue;
      const mapped = mapper.mapSafe(event, String(params.threadId));
      if (mapped === null) continue;
      mappedEvents++;
      transport.emit(mapped);
      if (yieldEvents) await new Promise<void>(resolve => setImmediate(resolve));
    }
    return result;
  });
  try {
    const client = await HarnessClient.connect(transport);
    const thread = await client.startThread({ agentName: harness.agents[0].name, cwd });
    const result = await thread.run("Read source.ts and report the coding investigation.");
    const turns = await harness.store.listTurns(thread.threadId);
    const events = await harness.events.list(thread.threadId);
    // Independently establish actual server/tool completion, then SDK parity.
    expect(turns.at(-1)?.status).toBe("completed");
    expect(events.some((event: AgentEvent) => event.type === "tool.completed" && event.payload.tool === "read_file")).toBe(true);
    expect(provider.calls).toHaveLength(2);
    expect(mappedEvents).toBeGreaterThan(4096);
    expect(result.status).toBe("completed");
    expect(result.finalResponse).toBe(text);
    expect(result.items.some(item => item.kind === "tool_result" && item.tool === "read_file" && item.ok)).toBe(true);
    expect(transport.subscriberCount()).toBe(0);
    expect(transport.closeHandlerCount()).toBe(0);
    await client.close();
  } finally { await transport.close(); await harness.close(); await rm(cwd, { recursive: true, force: true }); }
});
