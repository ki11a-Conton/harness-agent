import { createServer, type ServerResponse } from "node:http";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { OpenAICompatibleProvider } from "@ar/model";
import type { AgentEvent, Message } from "@ar/contracts";
import { createHarness, type Harness } from "./create-harness.js";

const VISIBLE = "VISIBLE_PARTIAL_314159 中文🙂\nunfinished answer ";
const PRIVATE = "PRIVATE_REASONING_MUST_NOT_PERSIST_271828";
const sse = (value: unknown) => `data: ${JSON.stringify(value)}\n\n`;

describe.each(["jsonl", "sqlite"] as const)("interrupted visible history with real SSE and %s", dataStore => {
  it("persists only the exact visible partial, reopens it and identifies it in the next physical request", async () => {
    const root = await mkdtemp(join(tmpdir(), "ar-partial-history-")), cwd = join(root, "project");
    await mkdir(cwd);
    const requests: Array<{ messages: Array<Record<string, unknown>> }> = [];
    let interrupted: ServerResponse | undefined;
    const server = createServer(async (request, response) => {
      let raw = ""; for await (const chunk of request) raw += String(chunk);
      requests.push(JSON.parse(raw));
      response.writeHead(200, { "content-type": "text/event-stream" });
      if (requests.length === 1) {
        interrupted = response;
        response.write(sse({ choices: [{ delta: { reasoning_content: PRIVATE } }] }));
        response.write(sse({ choices: [{ delta: { tool_calls: [{ index: 0, id: "partial_write", function: {
          name: "write_file", arguments: '{"path":"forbidden.txt","content":"UNFINISHED',
        } }] } }] }));
        response.write(sse({ choices: [{ delta: { content: VISIBLE } }] }));
      } else {
        response.end(sse({ choices: [{ delta: { content: "continued answer" }, finish_reason: "stop" }],
          usage: { prompt_tokens: 11, completion_tokens: 3 } }) + "data: [DONE]\n\n");
      }
    });
    await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
    const provider = new OpenAICompatibleProvider({ baseUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`,
      apiKey: "loopback-only", modelId: "partial-history", requestPolicy: { maxProviderRetries: 0, retryDelayMs: 0, requestTimeoutMs: 10000 } });
    const config = { cwd, dataDir: join(root, "state"), dataStore, profile: "test" as const, modelProvider: provider,
      model: { providerId: provider.id, modelId: "partial-history" }, featureFlags: { skills: false } };
    let harness: Harness | undefined, running: Promise<unknown> | undefined;
    const abort = new AbortController();
    try {
      harness = await createHarness(config);
      let visible!: () => void;
      const visibleCommitted = new Promise<void>(done => { visible = done; });
      const appendNew = harness.events.appendNew.bind(harness.events);
      vi.spyOn(harness.events, "appendNew").mockImplementation(async event => {
        const stored = await appendNew(event);
        if (event.type === "model.delta" && event.payload.text === VISIBLE) visible();
        return stored;
      });
      const session = await harness.runtime.createSession({ agent: harness.agents[0]!, cwd });
      const turn = await harness.runtime.startTurn(session.id, "Start the answer, then continue after transport failure.");
      running = harness.runtime.runTurn(session.id, turn.id, abort.signal);
      let deltaTimeout: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([visibleCommitted, new Promise<never>((_, reject) => {
          deltaTimeout = setTimeout(() => reject(new Error("visible SSE delta did not reach its durable fence")), 5000);
        })]);
      } finally { clearTimeout(deltaTimeout); }
      const beforeFailure: AgentEvent[] = await harness.events.list(session.id);
      expect(beforeFailure.some(event => event.type === "model.delta" && event.payload.text === VISIBLE)).toBe(true);
      interrupted!.destroy();
      expect(await running).toMatchObject({ status: "failed", terminationReason: "model_error" });
      const events = await harness.events.list(session.id), messages = await harness.store.listMessages(session.id);
      const partial = messages.find(message => message.role === "assistant" && message.content === VISIBLE);
      // First failure on the baseline: deltas exist but there is no canonical body.
      expect(partial).toBeDefined();
      expect(partial).toMatchObject({ model: session.model, incomplete: { reason: "model_error", callId: expect.any(String) } });
      expect(partial!.toolCalls).toBeUndefined(); expect(partial!.reasoningContent).toBeUndefined();
      expect(requests).toHaveLength(1);
      expect(events.slice(0, beforeFailure.length)).toEqual(beforeFailure);
      expect(events.filter(event => event.type === "model.completed" || event.type === "tool.requested" || event.type === "verification.started" || event.type === "turn.completed")).toHaveLength(0);
      expect(events.find(event => event.type === "model.failed")?.payload).toMatchObject({ messageId: partial!.id, text: VISIBLE, incomplete: partial!.incomplete });
      expect(events.find(event => event.type === "model.failed")?.payload.usage).toBeUndefined();
      expect(JSON.stringify({ events, messages })).not.toContain(PRIVATE);
      await expect(readFile(join(cwd, "forbidden.txt"))).rejects.toMatchObject({ code: "ENOENT" });
      await harness.close(); harness = await createHarness(config);
      expect(await harness.store.listMessages(session.id)).toEqual(messages);
      expect(await harness.events.list(session.id)).toEqual(events);
      const next = await harness.runtime.startTurn(session.id, "Continue the incomplete answer.");
      expect(await harness.runtime.runTurn(session.id, next.id, abort.signal)).toMatchObject({ status: "completed" });
      expect(requests).toHaveLength(2);
      const wirePartial = requests[1]!.messages.find(message => message.role === "assistant" && String(message.content).startsWith(VISIBLE));
      expect(wirePartial).toBeDefined();
      expect(String(wirePartial!.content)).toContain("incomplete");
      expect(String(wirePartial!.content)).toContain("Historical DATA");
      expect(wirePartial!.tool_calls).toBeUndefined(); expect(wirePartial!.reasoning_content).toBeUndefined();
      expect(JSON.stringify(requests[1])).not.toContain(PRIVATE);
      expect((await harness.store.listMessages(session.id)).find(message => message.id === partial!.id)).toEqual(partial as Message);
    } finally {
      abort.abort(); interrupted?.destroy();
      if (running) await running.catch(() => {});
      await harness?.close(); server.closeAllConnections();
      await new Promise<void>((done, reject) => server.close(error => error ? reject(error) : done()));
      await rm(root, { recursive: true, force: true });
    }
  });
});
