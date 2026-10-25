import { createServer } from "node:http";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { OpenAICompatibleProvider } from "@ar/model";
import type { Session } from "@ar/contracts";
import { createHarness } from "./create-harness.js";

interface WireMessage { role: string; content?: string }
interface WireRequest { messages: WireMessage[] }
function workspace(system: string): string {
  const match = /<workspace_context>\n([^\n]*)\n<\/workspace_context>/u.exec(system);
  expect(match, "actual HTTP system carries exactly the host workspace JSON").not.toBeNull();
  return (JSON.parse(match![1]!) as { cwd: string }).cwd;
}

it.each([false, true])("real HTTP keeps per-session cwd across tools, compaction, and reopen (path-scoped=%s)", async scoped => {
  const root = await mkdtemp(join(tmpdir(), "workspace-wire-"));
  const project = join(root, "project"), a = join(project, "A with spaces"), b = join(project, "B with spaces"), gateway = join(root, "gateway");
  await Promise.all([mkdir(a, { recursive: true }), mkdir(b, { recursive: true }), mkdir(gateway)]);
  await Promise.all([writeFile(join(a, "identity.txt"), "SESSION_A_ONLY"), writeFile(join(b, "identity.txt"), "SESSION_B_ONLY"), writeFile(join(gateway, "identity.txt"), "GATEWAY_ONLY")]);
  const requests: WireRequest[] = [];
  const server = createServer(async (req, res) => {
    let raw = ""; for await (const bytes of req) raw += bytes;
    const request = JSON.parse(raw) as WireRequest; requests.push(request);
    const compact = request.messages.some(message => message.role === "system" && message.content?.includes("CONTEXT CHECKPOINT COMPACTION"));
    const index = request.messages.findLastIndex(message => message.role === "user");
    const text = request.messages[index]?.content ?? "";
    const call = !compact && text.includes("READ_") && !request.messages.slice(index + 1).some(message => message.role === "tool");
    const delta = call ? { tool_calls: [{ index: 0, id: `read-${requests.length}`, type: "function", function: { name: "read_file",
      arguments: JSON.stringify({ path: text.includes("READ_OUTSIDE") ? join(gateway, "identity.txt") : "identity.txt" }) } }] }
      : { content: compact ? "Earlier conversation summarized. Keep the active user task and consult original tool evidence." : "Hello. Recorded the request." };
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end(`data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: call ? "tool_calls" : "stop" }] })}\n\ndata: [DONE]\n\n`);
  });
  await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
  const provider = new OpenAICompatibleProvider({ apiKey: "loopback-only", baseUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`, modelId: "workspace-wire",
    requestPolicy: { requestTimeoutMs: 10_000, maxProviderRetries: 0, retryDelayMs: 0 } });
  const config = { cwd: project, dataDir: join(root, "data"), profile: "interactive" as const, modelProvider: provider,
    model: { providerId: provider.id, modelId: "workspace-wire" }, featureFlags: { skills: false, memory: false },
    contextBudget: { maxTokens: 5000, reserved: { system: 0, task: 0, output: 500 }, dynamic: 0 },
    ...(scoped ? { instructionDiscovery: { strategy: "path_scoped_instructions_v1" as const } } : {}) };
  let harness: Awaited<ReturnType<typeof createHarness>> | undefined;
  const requestFor = (text: string) => {
    const request = requests.find(item => item.messages.some(message => message.role === "user" && message.content === text));
    expect(request, `actual HTTP request for ${text.slice(0, 30)}`).toBeDefined(); return request!;
  };
  const systemFor = (text: string) => requestFor(text).messages.filter(message => message.role === "system").map(message => message.content).join("\n");
  const repliesFor = (text: string) => requests.filter(item => item.messages.some(message => message.role === "user" && message.content === text))
    .flatMap(item => item.messages.slice(item.messages.findLastIndex(message => message.role === "user") + 1).filter(message => message.role === "tool").map(message => message.content ?? ""));
  const run = async (session: Session, text: string) => {
    const actor = await harness!.sessions.load(session.id);
    const handle = await actor.startTurn({ sessionId: session.id, text });
    expect((await handle.outcome).status).toBe("completed");
    expect(workspace(systemFor(text))).toBe(session.cwd);
  };
  try {
    harness = await createHarness(config);
    const originalPolicy = harness.agents[0]!.systemPrompt;
    const sa = await harness.runtime.createSession({ agent: harness.agents[0]!, cwd: a });
    const sb = await harness.runtime.createSession({ agent: harness.agents[0]!, cwd: b });
    await Promise.all([run(sa, "HELLO_A"), run(sb, "HELLO_B")]);
    expect(systemFor("HELLO_A")).not.toContain(JSON.stringify({ cwd: b }));
    expect(systemFor("HELLO_B")).not.toContain(JSON.stringify({ cwd: a }));
    await run(sa, "READ_MARKER_A"); await run(sb, "READ_MARKER_B");
    expect(repliesFor("READ_MARKER_A").some(value => value.includes("SESSION_A_ONLY"))).toBe(true);
    expect(repliesFor("READ_MARKER_B").some(value => value.includes("SESSION_B_ONLY"))).toBe(true);
    await run(sa, "READ_OUTSIDE");
    expect(repliesFor("READ_OUTSIDE").join("\n")).not.toContain("GATEWAY_ONLY");
    expect(repliesFor("READ_OUTSIDE").join("\n")).toMatch(/denied|outside|not allowed|sandbox/iu);
    await run(sa, "LIFECYCLE_OLD " + "Earlier coding details. ".repeat(500));
    await run(sa, "LIFECYCLE_CURRENT " + "Continue project work. ".repeat(500));
    harness.context.pipeline.requestCompaction(sa.id); await run(sa, "AFTER_MANUAL_COMPACTION");
    const events = await harness.events.list(sa.id);
    expect(events.some(event => event.type === "context.compacted" && event.payload.phase === "started" && event.payload.manual === false)).toBe(true);
    expect(events.some(event => event.type === "context.compacted" && event.payload.phase === "started" && event.payload.manual === true)).toBe(true);
    expect(harness.agents[0]!.systemPrompt).toBe(originalPolicy);
    await harness.close(); harness = await createHarness(config);
    const stored = await harness.store.getSession(sb.id); expect(stored?.cwd).toBe(b);
    await run(stored!, "AFTER_DURABLE_RESUME");
  } finally {
    await harness?.close(); await new Promise<void>(done => server.close(() => done())); await rm(root, { recursive: true, force: true });
  }
});
