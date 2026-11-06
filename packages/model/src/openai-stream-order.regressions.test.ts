import { afterEach, expect, it, vi } from "vitest";
import type { ModelEvent } from "@ar/contracts";
import { OpenAICompatibleProvider } from "./openai.js";
const frame = (value: unknown) => `data: ${JSON.stringify(value)}\n\n`;
afterEach(() => vi.restoreAllMocks());
async function collect(chunks: unknown[]) {
  vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(chunks.map(frame).join("") + "data: [DONE]\n\n"));
  const client = new OpenAICompatibleProvider().createClient({ providerId: "openai", modelId: "offline-order" }, {
    apiKey: "local-only", baseUrl: "https://offline.invalid/v1", maxProviderRetries: 0, requestTimeoutMs: 0,
  });
  const events: ModelEvent[] = [];
  for await (const event of client.generate({ messages: [] }, new AbortController().signal)) events.push(event);
  return events;
}
const finish = { choices: [{ delta: {}, finish_reason: "tool_calls" }], usage: { prompt_tokens: 1, completion_tokens: 1 } };
it.each([[1, 0], [2, 0, 1], [10, 2], [0, 1]])("keeps provider tool index order independent of arrival %j", async (...indexes) => {
  const events = await collect([...indexes.map(index => ({ choices: [{ delta: { tool_calls: [{
    index, id: `call_${index}`, function: { name: "read_file", arguments: JSON.stringify({ path: `${index}.ts` }) },
  }] } }] })), finish]);
  const expected = [...indexes].sort((a, b) => a - b).map(index => `call_${index}`);
  expect(events.filter(event => event.type === "tool_call_delta").map(event => event.toolCall.id)).toEqual(expected);
  const result = events.findLast(event => event.type === "completed")!;
  expect(result.type).toBe("completed");
  if (result.type === "completed") {
    expect(result.result.finishReason).toBe("tool_calls");
    expect(result.result.toolCalls?.map(call => call.id)).toEqual(expected);
  }
});

it("keeps interleaved argument/name fragments attached to their original indexed call", async () => {
  const delta = (tool: unknown) => ({ choices: [{ delta: { tool_calls: [tool] } }] });
  const events = await collect([
    delta({ index: 1, id: "call_write", function: { name: "write_", arguments: '{"path":' } }),
    delta({ index: 0, id: "call_read", function: { name: "read_file", arguments: '{"path":"source.ts"}' } }),
    delta({ index: 1, function: { name: "file", arguments: '"target.ts","content":"updated"}' } }), finish,
  ]);
  const terminal = events.findLast(event => event.type === "completed")!;
  expect(terminal).toMatchObject({ result: { toolCalls: [
    { id: "call_read", name: "read_file", args: { path: "source.ts" } },
    { id: "call_write", name: "write_file", args: { path: "target.ts", content: "updated" } },
  ] } });
});
