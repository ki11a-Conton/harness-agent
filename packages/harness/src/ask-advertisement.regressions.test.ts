import { createServer } from "node:http";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { OpenAICompatibleProvider } from "@ar/model";
import { findSerializedWireIssues, type ToolSpec } from "@ar/contracts";
import { createHarness } from "./create-harness.js";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const action of cleanup.splice(0).reverse()) await action(); });
async function actualHost(args: Record<string, unknown>, durable = true) {
  const requests: Array<{ tools: Array<{ function: ToolSpec & { parameters: Record<string, unknown> } }>; messages: Array<Record<string, unknown>> }> = [];
  const server = createServer(async (request, response) => {
    let raw = ""; for await (const chunk of request) raw += String(chunk);
    const body = JSON.parse(raw); requests.push(body);
    const delta = requests.length === 1
      ? { tool_calls: [{ index: 0, id: "formal_actual_ask", type: "function", function: { name: "ask_user", arguments: JSON.stringify(args) } }] }
      : { content: "The supplied target is accepted" };
    response.writeHead(200, { "content-type": "text/event-stream" }); response.end(`data: ${JSON.stringify({ choices: [{ delta }] })}\n\ndata: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: requests.length === 1 ? "tool_calls" : "stop" }] })}\n\ndata: [DONE]\n\n`);
  });
  await new Promise<void>(done => server.listen(0, "127.0.0.1", done)); cleanup.push(() => new Promise<void>((done, reject) => server.close(error => error ? reject(error) : done())));
  const root = await mkdtemp(join(tmpdir(), "formal-ask-production-")); cleanup.push(() => rm(root, { recursive: true, force: true }));
  const cwd = join(root, "project"); await mkdir(cwd);
  const provider = new OpenAICompatibleProvider({ baseUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`, apiKey: "loopback-formal-ask-only", modelId: "formal-coding", requestPolicy: { maxProviderRetries: 0, retryDelayMs: 0, requestTimeoutMs: 10000 } });
  const harness = await createHarness({ cwd, ...(durable ? { dataDir: join(root, "data") } : {}), profile: "interactive", modelProvider: provider, model: { providerId: provider.id, modelId: "formal-coding" } }); cleanup.push(() => harness.close());
  const session = await harness.runtime.createSession({ agent: harness.agents[0]!, cwd }), actor = await harness.sessions.load(session.id);
  const turn = await actor.createTurn({ sessionId: session.id, text: "Ask me for the missing target" });
  return { harness, session, actor, turn, requests };
}

it("the actual production HTTP request advertises the frozen formal ask gate and the same native turn resumes with a bound answer", async () => {
  const s = await actualHost({ question: "Which target?", reason: "choice_required", options: ["a", "b"] });
  const outcome = await s.actor.runTurn(s.turn.id); expect(outcome.status).toBe("waiting_for_user");
  const advertised = s.requests[0]!.tools.find(tool => tool.function.name === "ask_user");
  expect(advertised).toBeDefined(); expect(advertised!.function.parameters).toMatchObject({ type: "object", required: ["question", "reason"], additionalProperties: false });
  expect(s.harness.registry.has("ask_user")).toBe(false);
  const pending = (await s.harness.askUserStore!.listPending(s.session.id))[0]!; expect(pending).toMatchObject({ turnId: s.turn.id, question: "Which target?" });
  const other = await s.harness.runtime.createSession({ agent: s.harness.agents[0]!, cwd: s.session.cwd });
  expect((await s.harness.runtime.submitUserAnswer(other.id, s.turn.id, pending.id, "a")).resumed).toBe(false);
  expect((await s.harness.askUserStore!.get(pending.id))?.status).toBe("pending");
  await s.harness.runtime.submitUserAnswer(s.session.id, s.turn.id, pending.id, "b");
  expect((await s.actor.runTurn(s.turn.id)).status).toBe("completed"); expect(s.requests).toHaveLength(2);
  expect(findSerializedWireIssues(s.requests[1]!.messages as never)).toEqual([]);
  expect(s.requests[1]!.messages.filter(message => message.role === "user" && String(message.content).includes("b"))).toHaveLength(1);
  const journal = await s.harness.events.list(s.session.id);
  expect(journal.some(event => event.type === "tool.started" && event.payload.tool === "ask_user")).toBe(false);
  expect(journal.filter(event => event.type === "model.started").every(event => typeof event.payload.stepId === "string")).toBe(true);
});

it("a malformed formal gate settles the protocol and fails without fabricating a durable question", async () => {
  const s = await actualHost({ question: "", reason: "not-a-reason", options: [42], path: "/unexpected" });
  const outcome = await s.actor.runTurn(s.turn.id); expect(outcome.status).toBe("failed"); expect(outcome.error?.code).toBe("TOOL_SCHEMA_ERROR");
  expect(await s.harness.askUserStore!.listPending(s.session.id)).toEqual([]); expect(s.requests).toHaveLength(1);
  const messages = await s.harness.store.listMessages(s.session.id);
  expect(messages.filter(message => message.role === "tool" && message.toolCallId === "formal_actual_ask")).toHaveLength(1);
  expect((await s.harness.events.list(s.session.id)).some(event => event.type === "ask.user_asked")).toBe(false);
});

it("a host without a durable ask store never advertises or parks a forged formal gate", async () => {
  const s = await actualHost({ question: "Unavailable question?", reason: "missing_critical_input" }, false);
  expect(s.harness.askUserStore).toBeUndefined(); const outcome = await s.actor.runTurn(s.turn.id);
  expect(s.requests[0]!.tools.some(tool => tool.function.name === "ask_user")).toBe(false);
  expect(outcome.status).toBe("failed"); expect(outcome.error?.code).toBe("TOOL_NOT_IN_STEP");
  expect((await s.harness.events.list(s.session.id)).some(event => event.type === "ask.user_asked")).toBe(false);
});
