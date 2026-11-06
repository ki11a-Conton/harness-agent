import { createServer } from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { OpenAICompatibleProvider } from "@ar/model";
import { createHarness } from "./index.js";

it("executes indexed streamed write/edit intent in model order and passes real file verification", async () => {
  let requests = 0;
  const frame = (value: unknown) => `data: ${JSON.stringify(value)}\n\n`;
  const server = createServer(async (request, response) => {
    for await (const _chunk of request) { /* Drain the real provider POST. */ }
    response.writeHead(200, { "content-type": "text/event-stream" });
    if (++requests === 1) {
      for (const call of [
        { index: 1, id: "call_edit", function: { name: "edit_file", arguments: JSON.stringify({ path: "result.ts", oldText: "= 1", newText: "= 2" }) } },
        { index: 0, id: "call_write", function: { name: "write_file", arguments: JSON.stringify({ path: "result.ts", content: "export const result = 1;\n" }) } },
      ]) response.write(frame({ choices: [{ delta: { tool_calls: [call] }, finish_reason: null }] }));
      response.end(frame({ choices: [{ delta: {}, finish_reason: "tool_calls" }], usage: { prompt_tokens: 10, completion_tokens: 10 } }) + "data: [DONE]\n\n");
    } else response.end(frame({ choices: [{ delta: { content: "File changes completed." }, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 10 } }) + "data: [DONE]\n\n");
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); if (address === null || typeof address === "string") throw new Error("fixture not listening");
  const cwd = await mkdtemp(join(tmpdir(), "stream-tool-order-"));
  const provider = new OpenAICompatibleProvider({ apiKey: "local-only", baseUrl: `http://127.0.0.1:${address.port}/v1`, modelId: "fixture",
    requestPolicy: { maxProviderRetries: 0, retryDelayMs: 0, requestTimeoutMs: 10000 } });
  const harness = await createHarness({ cwd, profile: "test", modelProvider: provider, model: { providerId: "openai", modelId: "fixture" },
    maxIterationsPerTurn: 4, limits: { maxToolCalls: 4, maxDurationMs: 30000 },
    task: { id: "stream-order", goal: "create then edit result.ts", completionPolicy: { requiresVerification: true },
      verification: [{ kind: "command", command: process.execPath, args: ["-e", "require('node:assert/strict').match(require('node:fs').readFileSync('result.ts','utf8'),/= 2/)"] }] } });
  try {
    const session = await harness.runtime.createSession({ agent: harness.agents[0]!, cwd });
    const turn = await harness.runtime.startTurn(session.id, "Create result.ts with result=1, then edit it to result=2 and verify.");
    const outcome = await harness.runtime.runTurn(session.id, turn.id, new AbortController().signal);
    const actual = await readFile(join(cwd, "result.ts"), "utf8");
    const events = await harness.events.list(session.id);
    expect(actual).toBe("export const result = 2;\n");
    expect(events.filter(event => event.type === "tool.requested").map(event => event.payload.name)).toEqual(["write_file", "edit_file"]);
    expect(outcome.status).toBe("completed");
    expect(events.some(event => event.type === "verification.step_completed" && event.payload.passed === true)).toBe(true);
    expect(requests).toBe(2);
  } finally {
    await harness.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(cwd, { recursive: true, force: true });
  }
});
