import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { HarnessClient } from "./client.js";
import { MemoryHarnessTransport } from "./transport.js";
import { ProtocolEventMapper } from "@ar/protocol";

it.each([undefined, 23])("SDK obeys server budget %s even when wire parameters request a larger ceiling", async ceiling => {
  // Test-only dynamic composition preserves the SDK's client-only production graph.
  const { createHarness } = await import(new URL("../../harness/src/index.js", import.meta.url).href);
  const { AppServer } = await import(new URL("../../gateway/src/index.js", import.meta.url).href);
  const { ScriptedModelProvider } = await import(new URL("../../model/src/index.js", import.meta.url).href);
  const cwd = await mkdtemp(join(tmpdir(), "ar-sdk-iterations-"));
  for (let i = 0; i < 22; i++) await writeFile(join(cwd, `file-${i}.txt`), `evidence ${i}`);
  const provider = new ScriptedModelProvider([...Array.from({ length: 22 }, (_, i) => ScriptedModelProvider.toolCall("read_file", { path: `file-${i}.txt` })), ScriptedModelProvider.text("All twenty-two reads complete.")]);
  const harness = await createHarness({ cwd, profile: "test", modelProvider: provider, model: { providerId: provider.id, modelId: "scripted-model" }, ...(ceiling === undefined ? {} : { maxIterationsPerTurn: ceiling }) });
  const server = new AppServer({ runtime: harness.runtime, sessions: harness.sessions, sessionService: harness.sessionService, approvalStore: harness.approvalStore, events: harness.events, listAgents: () => harness.agents });
  const mapper = new ProtocolEventMapper();
  const transport: MemoryHarnessTransport = new MemoryHarnessTransport(async (method, params) => {
    // Simulate an untrusted transport client sending extra budget parameters;
    // only the host's frozen configuration may choose this runtime ceiling.
    const result = await server.invoke(method, { ...params, maxIterationsPerTurn: 100 });
    if (method === "turn/run") for (const event of await harness.events.list(params.threadId)) {
      if (event.turnId !== params.turnId) continue;
      const mapped = mapper.mapSafe(event, String(params.threadId)); if (mapped !== null) transport.emit(mapped);
    }
    return result;
  });
  try {
    const client = await HarnessClient.connect(transport);
    const thread = await client.startThread({ agentName: harness.agents[0].name, cwd });
    const result = await thread.run("Read the files and report");
    if (ceiling === undefined) {
      expect(result.status).toBe("failed");
      expect(result.error?.message).toContain("maxIterationsPerTurn (20)");
    } else expect(result).toMatchObject({ status: "completed", finalResponse: "All twenty-two reads complete." });
    expect((await harness.events.list(thread.threadId)).filter((event: { type: string }) => event.type === "model.started")).toHaveLength(ceiling ?? 20);
    await client.close();
  } finally { await transport.close(); await harness.close(); await rm(cwd, { recursive: true, force: true }); }
});
