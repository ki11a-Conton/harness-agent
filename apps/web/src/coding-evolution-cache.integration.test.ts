import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { createHarness, type HarnessConfig } from "@ar/harness";
import { OpenAICompatibleProvider } from "@ar/model";
import { projectSessionHistory } from "./deepseek/projections.js";

it("C1 preserves cache usage through real provider, Runtime, durable reload and browser projection", async () => {
  const dir = await mkdtemp(join(tmpdir(), "coding-cache-chain-"));
  const server = createServer(async (req, res) => {
    for await (const _ of req) { /* consume real request */ }
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end([
      { choices: [{ delta: { content: "complete" }, finish_reason: "stop" }] },
      { choices: [], usage: { prompt_tokens: 200, completion_tokens: 20, prompt_cache_hit_tokens: 128, prompt_cache_miss_tokens: 72 } },
    ].map(value => `data: ${JSON.stringify(value)}\n\n`).join("") + "data: [DONE]\n\n");
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  let harness: Awaited<ReturnType<typeof createHarness>> | undefined;
  try {
    const address = server.address(); if (!address || typeof address === "string") throw new Error("missing port");
    const config: HarnessConfig = { cwd: dir, dataDir: join(dir, "state"), profile: "test",
      model: { providerId: "openai", modelId: "offline" },
      modelProvider: new OpenAICompatibleProvider({ apiKey: "offline", baseUrl: `http://127.0.0.1:${address.port}/v1` }),
      featureFlags: { skills: false, learning: false, memory: false, mcp: false, delegation: false } };
    harness = await createHarness(config);
    const session = await harness.runtime.createSession({ agent: harness.agents[0]!, cwd: dir });
    const turn = await harness.runtime.startTurn(session.id, "offline observation");
    const result = await harness.runtime.runTurn(session.id, turn.id, AbortSignal.timeout(15000));
    expect(result.status).toBe("completed");
    await harness.close(); harness = await createHarness(config);
    const events = await harness.events.list(session.id);
    const completed = events.filter(event => event.type === "model.completed");
    expect(completed).toHaveLength(1);
    expect(completed[0]!.payload.usage).toMatchObject({ inputTokens: 200, outputTokens: 20,
      cacheReadTokens: 128, cacheUsageSource: "deepseek", source: "measured" });
    const stored = await harness.store.getSession(session.id); expect(stored).toBeDefined();
    const projected = projectSessionHistory({ session: stored!, events, messages: await harness.store.listMessages(session.id) });
    const assistant = projected.records.find(record => record.event.type === "assistant/message");
    expect(assistant?.event.data).toMatchObject({ usage: { inputTokens: 72, outputTokens: 20, cacheReadTokens: 128, totalTokens: 220 } });
    expect(JSON.stringify([...projected.framesBySourceSequence.values()])).toContain('"cacheReadTokens":128');
  } finally {
    await harness?.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(dir, { recursive: true, force: true });
  }
});
